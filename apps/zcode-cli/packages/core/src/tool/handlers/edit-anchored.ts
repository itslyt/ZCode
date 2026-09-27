// ============================================================
// EditAnchored Tool Handler
// ============================================================
//
// 用 Read 回显的行锚点定位要改的行，模型不必重抄原文。
//
// 与 Edit 的关键差别在「怎么证明模型改的是它看过的内容」：
//
// - Edit 靠 mtime/revision 判断文件是否变过（文件级新鲜度）；
// - EditAnchored 靠**锚点里的内容哈希**逐行见证。行号对不上时先在文件里按哈希
//   重新定位（唯一命中才移动），找不到或多处命中就拒绝并回传该区域当前锚点。
//
// 因此这里不需要 Edit 那套 mtime stale guard：锚点见证比时间戳更精确，且模型
// 自己上一步编辑造成的行号位移会被自愈合吸收，而不是变成一次失败。

import { extname } from "node:path";
import {
  CoreErrorType,
  EditAnchoredInputJsonSchema,
  EditAnchoredInputSchema,
  EditAnchoredOutputJsonSchema,
  EditAnchoredOutputSchema,
  createCoreError,
  type EditAnchoredInput,
  type EditAnchoredOutput,
  type FileSystemReadTextResult,
  type TraceContext,
} from "@zcode/contracts";
import {
  applyAnchorEdits,
  buildUpdatedAnchors,
  createAnchorFailureMessage,
  findOverlappingAnchorEdits,
  resolveAnchorEdits,
  type AnchorEditRequest,
  type AnchorFailureReason,
} from "../anchor-resolve.js";
import { collectServedAnchors, mergeServedAnchors } from "../anchor-served.js";
import {
  ANCHOR_FAILURE_ERROR_CODE,
  createEditAnchoredFailure,
  EDIT_ANCHORED_ERROR_CODE,
} from "../edit-anchored-errors.js";
import { createStructuredPatch } from "../diff.js";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  createReadFileStateKey,
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import type {
  ReadFileStateEntry,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";

const TOOL_NAME = "EditAnchored";

const EDIT_ANCHORED_PROVIDER_DESCRIPTION = [
  "Replace line ranges in a file addressed by the anchors that Read prints. This is the default way to edit a file you have already read.",
  "",
  "Read prefixes every line with an anchor `N:HASH│`. Pass those anchors here instead of retyping the old text:",
  "",
  "```json",
  '{ "file_path": "/abs/path/file.ts", "edits": [{ "remove_from": "22:AB3F", "remove_to": "22:AB3F", "replacement_text": "new content" }] }',
  "```",
  "",
  "- `remove_from`/`remove_to` bound the range to replace; for a single line pass the same anchor twice.",
  "- The 4-character hash alone (`AB3F`) is accepted when it uniquely identifies a line — no line number needed.",
  "- `replacement_text` replaces the range; use `\"\"` to delete it.",
  "- Every entry is resolved against the file's original content, so entries never displace each other. All-or-nothing.",
  "- Anchors stay valid after edits elsewhere in the file: if line numbers moved, the anchor's hash re-locates it. The result returns fresh anchors for the changed region.",
  "- Only lines you have already read can be edited. If an anchor is rejected, the error includes the region's current anchors.",
  "",
  "Use `Edit` instead when the target line was never shown to you (for example you only found it with Grep), for `.ipynb` / binary / non-UTF-8 files, or after two `EditAnchored` failures on the same file.",
].join("\n");

const NOTEBOOK_FILE_MESSAGE =
  "Notebook files (.ipynb) must be edited as JSON. Read the file and use Edit with old_string/new_string.";

// -----------------------------------------------
// Model-facing result
// -----------------------------------------------

function formatEditAnchoredModelContent(output: unknown): string {
  if (!isRecord(output)) return "The file has been updated successfully.";

  const filePath = typeof output.filePath === "string" ? output.filePath : "the file";
  const editCount = typeof output.editCount === "number" ? output.editCount : 0;
  const updatedAnchors = typeof output.updatedAnchors === "string" ? output.updatedAnchors : "";

  const head = `The file ${filePath} has been updated successfully. ${editCount} edit(s) were applied atomically.`;
  if (updatedAnchors === "") return head;

  return `${head}\nCurrent anchors for the changed region:\n${updatedAnchors}`;
}

// -----------------------------------------------
// Handler
// -----------------------------------------------

const editAnchoredHandler: ToolHandler = async (input, context) => {
  const { file_path, edits } = EditAnchoredInputSchema.parse(input) as EditAnchoredInput;

  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `FileSystemPort is not configured for ${TOOL_NAME} tool`,
      {
        context: { toolCallId: context.toolCallId, toolName: TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  if (extname(filePath).toLowerCase() === ".ipynb") {
    return createEditAnchoredFailure(EDIT_ANCHORED_ERROR_CODE.NOTEBOOK_FILE, NOTEBOOK_FILE_MESSAGE);
  }

  const read = await fileSystemPort.readTextFile(
    { path: filePath, trace: createEditAnchoredTrace(context) },
    { signal: context.abortSignal },
  );

  const content = read.content;
  const requests: AnchorEditRequest[] = edits.map((edit) => ({
    removeFrom: edit.remove_from,
    removeTo: edit.remove_to,
    replacementText: edit.replacement_text,
  }));

  const servedHashes = collectServedAnchors(context.readFileState, filePath);
  const resolved = resolveAnchorEdits(content, servedHashes, requests);
  if (resolved.status === "failed") {
    const failure = createAnchorFailureMessage({
      content,
      failure: resolved,
      total: requests.length,
    });
    // 拒绝路径同样要落 served：错误信息里刚把该区域的新锚点展示给模型了，
    // 不并进去的话，模型照抄这些锚点重发会被判 unserved——reject-and-serve 变死循环。
    //
    // 只并 served，不碰门禁字段：拒绝是零副作用的，模型并没有因此读到更多内容。
    // unserved 现在也会渲染「该行附近」的当前锚点，所以这三类都要并。
    if (failure.servedHashes.length > 0) {
      mergeServedAnchorsAfterRejection({
        context,
        filePath,
        servedHashes: failure.servedHashes,
      });
    }
    return createEditAnchoredFailure(ANCHOR_FAILURE_ERROR_CODE[resolved.reason], failure.text);
  }

  const overlap = findOverlappingAnchorEdits(resolved.edits);
  if (overlap) {
    return createEditAnchoredFailure(
      EDIT_ANCHORED_ERROR_CODE.OVERLAPPING_EDITS,
      [
        `Edit ${overlap[0] + 1} and edit ${overlap[1] + 1} target overlapping line ranges.`,
        "Merge them into one entry, or make each range narrower. No edits were applied.",
      ].join("\n"),
    );
  }

  const applied = applyAnchorEdits(content, resolved.edits);
  const newContent = applied.content;

  const writeResult = await fileSystemPort.writeTextFile(
    {
      path: filePath,
      content: newContent,
      encoding: read.encoding,
      lineEndings: read.lineEndings,
      atomic: true,
      expectedRevision: read.revision,
      trace: createEditAnchoredTrace(context),
    },
    { signal: context.abortSignal },
  );

  const updatedAnchors = buildUpdatedAnchors(newContent, applied.changedRanges);

  // 只并「回传里实际渲染给模型的行」。把整个文件的哈希都灌进 served 会让
  // 「只允许改看过的行」这条硬约束在首次编辑之后彻底失效。
  writeReadStateAfterAnchoredEdit({
    context,
    filePath,
    content: newContent,
    revision: writeResult.revision,
    servedHashes: updatedAnchors.servedHashes,
  });

  return {
    filePath: file_path,
    editCount: resolved.edits.length,
    originalFile: content,
    structuredPatch: createStructuredPatch({
      filePath: file_path,
      oldContent: content,
      newContent,
    }),
    userModified: false,
    updatedAnchors: updatedAnchors.text,
  } satisfies EditAnchoredOutput;
};

// -----------------------------------------------
// Read state
// -----------------------------------------------

/**
 * 成功路径：刷新读状态，并把这次渲染给模型的行并进 served。
 *
 * `isPartialView` 沿用旧值而不强行置 false。`Edit`/`Write` 的「先读后写」门禁就是
 * `!lastRead || lastRead.isPartialView`（`edit.ts:494`、`write.ts:284`），而锚点编辑可以
 * 在一个只读了部分内容的文件上成功（锚点是内容见证的，不需要整文件视图）。强行置 false
 * 等于把模型没读过的部分也标成「已读」，让 `Edit`/`Write` 能改它从未看过的位置。
 * 旧值来自门禁实际会选中的那条（同路径 readAt 最新的条目），所以行为与改动前一致。
 */
function writeReadStateAfterAnchoredEdit(input: {
  context: ToolExecutionContext;
  filePath: string;
  content: string;
  revision: FileSystemReadTextResult["revision"] | undefined;
  servedHashes: readonly string[];
}): void {
  const readFileState = input.context.readFileState;
  if (!readFileState) return;

  const key = createReadFileStateKey(input.filePath, 1, undefined);
  const previous = readFileState.get(key);
  const gateEntry = findLatestReadFileState(readFileState, input.filePath);

  const entry: ReadFileStateEntry = {
    path: input.filePath,
    content: input.content,
    offset: undefined,
    limit: undefined,
    isPartialView: gateEntry?.isPartialView ?? true,
    readAt: new Date(),
    sourceTool: TOOL_NAME,
    revisionId: input.revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(input.revision?.mtimeMs),
    sizeBytes: input.revision?.sizeBytes ?? Buffer.byteLength(input.content, "utf8"),
    // 只并这次渲染给模型的行；旧哈希保留，否则模型手里那些「行号位移但内容没变」
    // 的锚点会被误判为没看过。
    servedAnchors: mergeServedAnchors(previous?.servedAnchors, input.servedHashes),
  };

  readFileState.set(key, entry);
  recordReadFileStateMetadata(input.context, entry);
}

/**
 * 拒绝路径：**只**把这次渲染给模型的行并进 served，不碰任何门禁字段。
 *
 * 拒绝是零副作用的：模型只是被拒绝了一次，并没有因此读到更多内容。早先这里复用了成功
 * 路径的写法，把 `content` 换成整文件、`isPartialView` 翻成 false，于是模型对一个只读了
 * 30 行的 3000 行文件，只要先做一次**会被拒绝**的锚点编辑（stale 很常见——外部 formatter、
 * 手动保存都会触发），就拿到了「整文件已读」，随后能用 `Edit`/`Write` 覆盖任意位置。
 *
 * 这里也不刷新 `readAt`：门禁按同路径 readAt 最新的条目选基准，刷新它等于替模型把
 * 「基准」推到一次它并未读取的动作上。
 */
function mergeServedAnchorsAfterRejection(input: {
  context: ToolExecutionContext;
  filePath: string;
  servedHashes: readonly string[];
}): void {
  const readFileState = input.context.readFileState;
  if (!readFileState) return;

  const existing = findLatestReadFileState(readFileState, input.filePath);
  if (existing) {
    existing.servedAnchors = mergeServedAnchors(existing.servedAnchors, input.servedHashes);
    recordReadFileStateMetadata(input.context, existing);
    return;
  }

  // 没有任何读状态时，served 需要有地方放。建一条保守条目：门禁字段一律按「没读全」处理，
  // 不提供任何 Edit/Write 可用的依据。
  //
  // 进入本函数要求 `servedHashes.length > 0`，而渲染非空只发生在
  // stale / ambiguous / 带行号的 unserved；三者都要求同路径已有读状态条目
  // （unserved 的语义就是「不在已读集合里」），所以正常应当有值。
  //
  // 保留而不是删掉：这是本函数对「served 必须有地方放」这个契约的完整行为，
  // 删掉会让未来其它调用方在本状态下静默丢掉 served（表现为模型重发撞 unserved）。
  const entry: ReadFileStateEntry = {
    path: input.filePath,
    content: "",
    offset: undefined,
    limit: undefined,
    isPartialView: true,
    readAt: new Date(),
    sourceTool: TOOL_NAME,
    servedAnchors: mergeServedAnchors(undefined, input.servedHashes),
  };
  readFileState.set(createReadFileStateKey(input.filePath, 1, undefined), entry);
}

function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  entry: ReadFileStateEntry | undefined,
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: TOOL_NAME,
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

function createEditAnchoredTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const editAnchoredToolEntry: ToolEntry = {
  capability: "Replace line ranges in a file through the file-system adapter using line anchors",
  metadata: {
    name: TOOL_NAME,
    description: EDIT_ANCHORED_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: editAnchoredHandler,
  formatModelContent: formatEditAnchoredModelContent,
  inputSchema: EditAnchoredInputJsonSchema,
  outputSchema: EditAnchoredOutputJsonSchema,
  runtimeInputSchema: EditAnchoredInputSchema,
  runtimeOutputSchema: EditAnchoredOutputSchema,
  permission: {
    permission: "edit",
    reason: "EditAnchored modifies file contents through the file-system adapter",
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
    preview: { maxBytes: 100_000, direction: "head" },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "EditAnchored was cancelled before the file operation completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

