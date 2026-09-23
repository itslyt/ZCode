/* eslint-disable max-lines -- Edit 工具需要集中维护文本匹配、read-before-edit 与写回状态，避免 bugfix 期间拆分扩大行为面。 */
// ============================================================
// Edit Tool Handler
// ============================================================

import { basename, dirname, extname } from "node:path";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolEntry,
} from "../types.js";
import {
  CoreErrorType,
  EditInputJsonSchema,
  EditInputSchema,
  EditOutputJsonSchema,
  EditOutputSchema,
  EditErrorCode,
  createCoreError,
  isFileSystemPortError,
  type EditInput,
  type EditOutput,
  type FileSystemReadTextResult,
  type FileSystemStatResult,
  type TraceContext,
} from "@zcode/contracts";
import { createStructuredPatch } from "../diff.js";
import { stampMemoryOriginSessionId } from "../../memory/origin-session.js";
import {
  applyResolvedBatchEdits,
  createBatchEditFailureMessage,
  findOverlappingBatchEdits,
  resolveBatchEdits,
  type BatchEditRequest,
} from "../edit-batch.js";
import { mergeServedAnchors } from "../anchor-served.js";
import {
  findEditMatch,
  normalizeLineEndings,
  normalizeReplacementForMatch,
  preserveQuoteStyle,
} from "../edit-matchers.js";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  createReadFileStateKey,
  findEditableReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import {
  attachToolExecutionTelemetry,
  elapsedMsSince,
  fileByteCount,
  workspaceKind,
} from "./tool-perf.js";

const EDIT_PROVIDER_DESCRIPTION = [
  "Performs exact string replacement in a file.",
  "",
  "- You must Read the file in this conversation before editing, or the call will fail.",
  "- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.",
  "- `replace_all: true` replaces every occurrence instead.",
  "- `edits: [{old_string, new_string}]` applies several edits to one file in a single atomic call. Every entry is located against the file's ORIGINAL content, so entries never displace each other; if any entry fails, nothing is written. Prefer it over repeated single-edit calls.",
  "- For a file you have already read, prefer `EditAnchored`: it edits by the anchors Read printed, so you do not retype the old text and the anchors survive line shifts. Fall back to this tool when the target line was never shown to you, for `.ipynb` / binary / non-UTF-8 files, or after two `EditAnchored` failures on the same file.",
].join("\n");
const NON_UNIQUE_OLD_STRING_MESSAGE =
  "old_string is not unique in the file. Provide more surrounding context or set replace_all to true.";
const MAX_EDIT_FILE_SIZE_BYTES = 1024 * 1024 * 1024;
const EDIT_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
const EDIT_STALE_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
const EDIT_FRESHNESS_SUFFIX = " (file state is current in your context — no need to Read it back)";

function formatEditModelContent(output: unknown): string {
  const filePath =
    isRecord(output) && typeof output.filePath === "string" ? output.filePath : "the file";
  const userModified = isRecord(output) && output.userModified === true;
  const replaceAll = isRecord(output) && output.replaceAll === true;
  const batchEditCount =
    isRecord(output) && typeof output.batchEditCount === "number" ? output.batchEditCount : 0;
  const modifiedNote = userModified
    ? ".  The user modified your proposed changes before accepting them. "
    : "";
  const freshnessSuffix = userModified ? "" : EDIT_FRESHNESS_SUFFIX;

  if (batchEditCount > 0) {
    // 同时给了 old_string/new_string 时它们是冗余的，这里必须明说被忽略了，
    // 否则模型会以为自己另外那条单编辑也生效了。
    const ignoredNote =
      isRecord(output) && output.ignoredSingleEditArguments === true
        ? " The old_string/new_string arguments were ignored because edits was provided."
        : "";
    return `The file ${filePath} has been updated successfully${modifiedNote}. ${batchEditCount} edits were applied atomically.${ignoredNote}${freshnessSuffix}`;
  }

  if (replaceAll) {
    return `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.${freshnessSuffix}`;
  }

  return `The file ${filePath} has been updated successfully${modifiedNote}.${freshnessSuffix}`;
}

const editHandler: ToolHandler = async (input, context) => {
  const { file_path, old_string, new_string, replace_all, edits } = EditInputSchema.parse(
    input,
  ) as EditInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Edit tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Edit",
        },
        recoverable: false,
      },
    );
  }

  const batchEdits = edits ?? null;
  const usesBatch = batchEdits !== null;

  // `edits` 优先，同时给出的 old_string/new_string 被忽略——但结果里会明说，不静默。
  //
  // 这里最初做的是“两者同时给出就拒绝”的互斥校验。真机验证证明那是错的：模型会顺手把
  // 可选字段也填上，实测四次尝试里有三次因此被拒（填过真实内容、"unused"、空串三种形态），
  // 白耗三个往返。模型会填满可选字段是结构性行为，用校验去拦它属于“用提示词劝阻失败模式”；
  // 正确做法是让 `edits` 直接赢，并把“忽略了哪几个参数”写进工具结果。
  const ignoredSingleEditArguments = usesBatch && (old_string !== undefined || new_string !== undefined);

  if (usesBatch && batchEdits.length === 0) {
    return editFailure(
      EditErrorCode.INVALID_EDIT_ARGUMENTS,
      "`edits` must contain at least one entry. No edits were applied.",
    );
  }

  if (!usesBatch && (old_string === undefined || new_string === undefined)) {
    return editFailure(
      EditErrorCode.INVALID_EDIT_ARGUMENTS,
      "Provide both old_string and new_string, or use `edits` for a batch. No edits were applied.",
    );
  }

  // 单条路径在下方分支使用；批量路径不读它们。
  const singleOldString = old_string ?? "";
  const singleNewString = new_string ?? "";

  if (!usesBatch && singleOldString === singleNewString) {
    return editFailure(
      EditErrorCode.NO_CHANGE,
      "No changes to make: old_string and new_string are exactly the same.",
    );
  }

  if (!file_path) {
    // 空路径由共享 path-policy 抛出普通异常，绕过了 Edit 自己维护的
    // code + message 失败契约，导致 provider-visible 内容丢失 tool_use_error envelope。
    return editFailure(EditErrorCode.INVALID_PATH, "Tool path must not be empty");
  }

  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  const stat = await statEditableFile(filePath, context);
  if (!stat) {
    if (!usesBatch && singleOldString === "") {
      return writeEditResult({
        context,
        filePath,
        inputFilePath: file_path,
        originalFile: "",
        actualOldString: "",
        actualNewString: singleNewString,
        newContent: singleNewString,
        replaceAll: replace_all,
        fsReadMs: 0,
        patchMatchMs: 0,
        matchAttempts: 0,
      });
    }

    return editFailure(
      EditErrorCode.FILE_NOT_EXIST,
      await createMissingEditFileMessage(filePath, context),
    );
  }

  if (stat.sizeBytes > MAX_EDIT_FILE_SIZE_BYTES) {
    return editFailure(
      EditErrorCode.FILE_TOO_LARGE,
      "File is too large to edit (1GB). Maximum editable file size is 1GB.",
    );
  }

  const readStartedAt = Date.now();
  const read = await fileSystemPort.readTextFile(
    {
      path: filePath,
      trace: createEditTrace(context),
    },
    { signal: context.abortSignal },
  );
  const fsReadMs = elapsedMsSince(readStartedAt);
  const content = normalizeLineEndings(read.content);
  const oldString = normalizeLineEndings(singleOldString);
  const requestedNewString = normalizeLineEndings(singleNewString);

  // 批量路径不读 singleOldString，这里必须门控：否则空串会被当成“新建文件”，
  // 导致 edits 批量在已存在的文件上直接报 FILE_EXISTS_NO_OLD_STRING（真机验证踩到过）。
  if (!usesBatch && singleOldString === "") {
    if (content.trim() !== "") {
      return editFailure(
        EditErrorCode.FILE_EXISTS_NO_OLD_STRING,
        "Cannot create new file - file already exists.",
      );
    }
    const readStateFailure = getEditableReadStateFailure(filePath, read, context.readFileState);
    if (readStateFailure) return readStateFailure;
    return writeEditResult({
      context,
      filePath,
      inputFilePath: file_path,
      originalFile: content,
      actualOldString: "",
      actualNewString: requestedNewString,
      newContent: requestedNewString,
      read,
      replaceAll: replace_all,
      fsReadMs,
      patchMatchMs: 0,
      matchAttempts: 0,
    });
  }

  if (filePath.endsWith(".ipynb")) {
    return editFailure(
      EditErrorCode.NOTEBOOK_FILE,
      "File is a Jupyter Notebook. Use the NotebookEdit to edit this file.",
    );
  }

  const readStateFailure = getEditableReadStateFailure(filePath, read, context.readFileState);
  if (readStateFailure) return readStateFailure;

  if (batchEdits) {
    return applyBatchEdit({
      context,
      filePath,
      inputFilePath: file_path,
      content,
      read,
      edits: batchEdits,
      fsReadMs,
      ignoredSingleEditArguments,
    });
  }

  const patchMatchStartedAt = Date.now();
  const match = findEditMatch({
    content,
    search: oldString,
    replaceAll: replace_all,
  });
  const patchMatchMs = elapsedMsSince(patchMatchStartedAt);
  if (match.status === "not_found") {
    return editFailure(
      EditErrorCode.OLD_STRING_NOT_FOUND,
      `String to replace not found in file.\nString: ${old_string}`,
    );
  }
  if (match.status === "ambiguous") {
    return editFailure(
      EditErrorCode.AMBIGUOUS_REPLACE,
      createAmbiguousEditMessage(match.candidateCount, singleOldString),
    );
  }

  const actualOldString = match.actualString;
  const matchCount = countOccurrences(content, actualOldString);
  if (!replace_all && matchCount > 1) {
    return editFailure(
      EditErrorCode.AMBIGUOUS_REPLACE,
      createAmbiguousEditMessage(matchCount, singleOldString),
    );
  }

  const normalizedNewString = normalizeReplacementForMatch(match.strategy, requestedNewString);
  const actualNewString = preserveQuoteStyle(oldString, actualOldString, normalizedNewString);
  const newContent = applyEditToContent(content, actualOldString, actualNewString, replace_all);

  return writeEditResult({
    context,
    filePath,
    inputFilePath: file_path,
    originalFile: content,
    actualOldString,
    actualNewString,
    newContent,
    read,
    replaceAll: replace_all,
    matchStrategy: match.strategy,
    matchCandidateCount: match.candidateCount,
    fsReadMs,
    patchMatchMs,
    matchAttempts: 1,
  });
};

export const editToolEntry: ToolEntry = {
  capability: "Replace exact text in a file through the file-system adapter",
  metadata: {
    name: "Edit",
    description: EDIT_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: editHandler,
  formatModelContent: formatEditModelContent,
  inputSchema: EditInputJsonSchema,
  outputSchema: EditOutputJsonSchema,
  runtimeInputSchema: EditInputSchema,
  runtimeOutputSchema: EditOutputSchema,
  permission: {
    permission: "edit",
    reason: "Edit modifies file contents through the file-system adapter",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 1_000_000,
    maxModelBytes: 100_000,
    strategy: "truncate",
    preview: {
      maxBytes: 100_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Edit was cancelled before the file operation completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function editFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let position = 0;
  while (position < content.length) {
    const index = content.indexOf(needle, position);
    if (index === -1) break;
    count += 1;
    position = index + needle.length;
  }
  return count;
}

function createEditTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

async function statEditableFile(
  filePath: string,
  context: ToolExecutionContext,
): Promise<FileSystemStatResult | null> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return null;
  try {
    return await fileSystemPort.stat(
      { path: filePath, trace: createEditTrace(context) },
      { signal: context.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return null;
    throw error;
  }
}

async function createMissingEditFileMessage(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string> {
  const suggestion = await findSimilarFilename(filePath, context);
  return [
    `File does not exist. Note: your current working directory is ${context.workingDirectory}.`,
    suggestion ? ` Did you mean ${suggestion}?` : "",
  ].join("");
}

async function findSimilarFilename(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return undefined;

  try {
    const parent = dirname(filePath);
    const targetName = basename(filePath);
    const targetStem = basename(filePath, extname(filePath));
    const listed = await fileSystemPort.listDirectory(
      { path: parent, trace: createEditTrace(context) },
      { signal: context.abortSignal },
    );
    const entries = listed.entries
      .filter((entry) => entry.kind === "file" || entry.kind === "symlink")
      .map((entry) => entry.name)
      .filter((name) => name !== targetName)
      .sort();

    const sameStem = entries.find((name) => basename(name, extname(name)) === targetStem);
    if (sameStem) return sameStem;

    return entries.find((name) => levenshteinDistance(name, targetName) <= 3);
  } catch {
    return undefined;
  }
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index]!;
    }
  }

  return previous[right.length] ?? 0;
}

function getEditableReadStateFailure(
  filePath: string,
  currentRead: FileSystemReadTextResult,
  readFileState: ReadFileStateMap | undefined,
): ToolHandlerFailure | undefined {
  if (!readFileState) return undefined;

  const lastRead = findEditableReadFileState(readFileState, filePath);
  if (!lastRead || lastRead.isPartialView) {
    return editFailure(EditErrorCode.FILE_NOT_READ, EDIT_NOT_READ_MESSAGE);
  }

  if (!hasReadStateChanged(lastRead, currentRead)) return undefined;
  if (isStrictFullRead(lastRead) && lastRead.content === currentRead.content) return undefined;

  return editFailure(EditErrorCode.STALE_FILE, EDIT_STALE_MESSAGE);
}

function isStrictFullRead(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}

function hasReadStateChanged(
  lastRead: ReadFileStateEntry,
  currentRead: FileSystemReadTextResult,
): boolean {
  const currentMtimeMs = currentRead.revision?.mtimeMs;
  if (lastRead.mtimeMs !== undefined && currentMtimeMs !== undefined) {
    // 亚毫秒级精度，只在当前文件的整数毫秒晚于 Read 记录或大小变化时判 stale，减少误报。
    const normalizedCurrentMtimeMs = normalizeReadFileStateMtimeMs(currentMtimeMs);
    const normalizedLastReadMtimeMs = normalizeReadFileStateMtimeMs(lastRead.mtimeMs);
    const mtimeAdvanced =
      normalizedCurrentMtimeMs !== undefined &&
      normalizedLastReadMtimeMs !== undefined &&
      normalizedCurrentMtimeMs > normalizedLastReadMtimeMs;
    return mtimeAdvanced || lastRead.sizeBytes !== currentRead.sizeBytes;
  }

  if (lastRead.sizeBytes !== undefined && lastRead.sizeBytes !== currentRead.sizeBytes) {
    return true;
  }

  const currentRevisionId = currentRead.revision?.id;
  return Boolean(
    lastRead.revisionId && currentRevisionId && lastRead.revisionId !== currentRevisionId,
  );
}

/**
 * `edits` 批量路径：在原文上定位全部编辑 → 校验重叠 → 倒序写回 → 一次落盘。
 *
 * 任一条失败就整批拒绝，文件零改动；错误信息带失败下标与就近片段。
 */
async function applyBatchEdit(input: {
  context: ToolExecutionContext;
  filePath: string;
  inputFilePath: string;
  content: string;
  read?: FileSystemReadTextResult;
  edits: ReadonlyArray<{
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }>;
  fsReadMs: number;
  ignoredSingleEditArguments: boolean;
}): Promise<EditOutput | ToolHandlerFailure> {
  const requests: BatchEditRequest[] = input.edits.map((edit) => ({
    oldString: normalizeLineEndings(edit.old_string),
    newString: normalizeLineEndings(edit.new_string),
    replaceAll: edit.replace_all ?? false,
  }));

  const matchStartedAt = Date.now();
  const resolved = resolveBatchEdits(input.content, requests);
  if (resolved.status === "failed") {
    return editFailure(
      resolved.reason === "no_change" ? EditErrorCode.NO_CHANGE : EditErrorCode.BATCH_EDIT_FAILED,
      createBatchEditFailureMessage({
        content: input.content,
        failure: resolved,
        total: requests.length,
      }),
    );
  }

  const overlap = findOverlappingBatchEdits(resolved.edits);
  if (overlap) {
    return editFailure(
      EditErrorCode.BATCH_EDIT_OVERLAP,
      [
        `Edit ${overlap[0] + 1} and edit ${overlap[1] + 1} target overlapping regions of the file.`,
        "Merge them into one entry, or make each old_string narrower. No edits were applied.",
      ].join("\n"),
    );
  }

  const patchMatchMs = elapsedMsSince(matchStartedAt);

  return writeEditResult({
    context: input.context,
    filePath: input.filePath,
    inputFilePath: input.inputFilePath,
    originalFile: input.content,
    actualOldString: requests.map((request) => request.oldString).join("\n"),
    actualNewString: requests.map((request) => request.newString).join("\n"),
    newContent: applyResolvedBatchEdits(input.content, resolved.edits),
    read: input.read,
    replaceAll: false,
    fsReadMs: input.fsReadMs,
    patchMatchMs,
    matchAttempts: 1,
    batchEditCount: resolved.edits.length,
    ignoredSingleEditArguments: input.ignoredSingleEditArguments,
  });
}

async function writeEditResult(input: {
  context: ToolExecutionContext;
  filePath: string;
  inputFilePath: string;
  originalFile: string;
  actualOldString: string;
  actualNewString: string;
  newContent: string;
  read?: FileSystemReadTextResult;
  replaceAll: boolean;
  fsReadMs: number;
  patchMatchMs: number;
  matchAttempts: number;
  matchStrategy?: string;
  matchCandidateCount?: number;
  batchEditCount?: number;
  ignoredSingleEditArguments?: boolean;
}): Promise<EditOutput> {
  const fileSystemPort = input.context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Edit tool",
      {
        context: {
          toolCallId: input.context.toolCallId,
          toolName: "Edit",
        },
        recoverable: false,
      },
    );
  }

  const contentToWrite = stampMemoryOriginSessionId({
    content: input.newContent,
    filePath: input.filePath,
    memoryRoot: input.context.memoryRoot,
    sessionId: input.context.sessionId,
  });
  const writeStartedAt = Date.now();
  const writeResult = await fileSystemPort.writeTextFile(
    {
      path: input.filePath,
      content: contentToWrite,
      encoding: input.read?.encoding,
      lineEndings: input.read?.lineEndings ?? detectLineEndings(input.originalFile),
      createParents: true,
      atomic: true,
      expectedRevision: input.read?.revision,
      trace: createEditTrace(input.context),
    },
    { signal: input.context.abortSignal },
  );
  const fsWriteMs = elapsedMsSince(writeStartedAt);

  const readFileStateEntry = updateReadFileStateAfterEdit(
    input.context.readFileState,
    input.filePath,
    contentToWrite,
    writeResult.revision,
  );
  recordReadFileStateMetadata(input.context, readFileStateEntry);

  const structuredPatch = createStructuredPatch({
    filePath: input.inputFilePath,
    oldContent: input.originalFile,
    newContent: contentToWrite,
  });
  // perf 里 totalBytes/maxFileBytes 语义相同，缓存结果避免大文件编辑时重复扫描新内容。
  const newContentBytes = fileByteCount(contentToWrite);

  return attachToolExecutionTelemetry(
    {
      filePath: input.inputFilePath,
      oldString: input.actualOldString,
      newString: input.actualNewString,
      originalFile: input.originalFile,
      structuredPatch,
      userModified: false,
      replaceAll: input.replaceAll,
      matchStrategy: input.matchStrategy,
      matchCandidateCount: input.matchCandidateCount,
      batchEditCount: input.batchEditCount,
      ignoredSingleEditArguments: input.ignoredSingleEditArguments,
    } satisfies EditOutput,
    {
      detail: {
        kind: "patch",
        filesystem: {
          readMs: input.fsReadMs,
          writeMs: fsWriteMs,
          fileCount: 1,
          totalBytes: newContentBytes,
          maxFileBytes: newContentBytes,
          workspaceKind: workspaceKind(input.context),
        },
        patch: {
          matchMs: input.patchMatchMs,
          hunkCount: structuredPatch.length,
          matchAttempts: input.matchAttempts,
        },
      },
    },
  );
}

function updateReadFileStateAfterEdit(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  content: string,
  revision: FileSystemReadTextResult["revision"] | undefined,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;
  const key = createReadFileStateKey(filePath, 1, undefined);
  const previous = readFileState.get(key);
  const entry: ReadFileStateEntry = {
    path: filePath,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: "Edit",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs),
    sizeBytes: revision?.sizeBytes ?? Buffer.byteLength(content, "utf8"),
    // served 集合只增不减：编辑不展示新内容给模型，但也不能把之前展示过的锚点抹掉，
    // 否则模型编辑一次后，它手里其余行的锚点就会被误判为“没看过”。
    servedAnchors: mergeServedAnchors(previous?.servedAnchors, []),
  };
  readFileState.set(createReadFileStateKey(filePath, 1, undefined), entry);
  return entry;
}

function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  entry: ReadFileStateEntry | undefined,
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: "Edit",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

function applyEditToContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  const replacement = newString;
  if (replacement !== "") {
    return replaceLiteral(content, oldString, replacement, replaceAll);
  }

  const search =
    !oldString.endsWith("\n") && content.includes(`${oldString}\n`) ? `${oldString}\n` : oldString;

  return replaceLiteral(content, search, replacement, replaceAll);
}

function replaceLiteral(
  content: string,
  search: string,
  replacement: string,
  replaceAll: boolean,
): string {
  // String.replace 的字符串 replacement 会把 $$/$& 当特殊 token；
  return replaceAll
    ? content.replaceAll(search, () => replacement)
    : content.replace(search, () => replacement);
}

function createAmbiguousEditMessage(matchCount: number, oldString: string): string {
  if (matchCount > 0) {
    return `Found ${matchCount} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`;
  }
  return NON_UNIQUE_OLD_STRING_MESSAGE;
}

function detectLineEndings(content: string): "LF" | "CRLF" {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    if (index > 0 && content[index - 1] === "\r") {
      crlfCount += 1;
    } else {
      lfCount += 1;
    }
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}
