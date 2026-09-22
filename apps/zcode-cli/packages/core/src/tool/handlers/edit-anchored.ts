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
import { computeLineHashes } from "../anchor-hash.js";
import {
  applyAnchorEdits,
  buildUpdatedAnchors,
  createAnchorFailureMessage,
  findOverlappingAnchorEdits,
  resolveAnchorEdits,
  type AnchorEditRequest,
} from "../anchor-resolve.js";
import { collectServedAnchors, mergeServedAnchors } from "../anchor-served.js";
import { createStructuredPatch } from "../diff.js";
import { resolveWorkspacePath } from "../path-policy.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";

const TOOL_NAME = "EditAnchored";

const EDIT_ANCHORED_PROVIDER_DESCRIPTION = [
  "Replace line ranges in a file addressed by the anchors that Read prints.",
  "",
  "Read prefixes every line with an anchor `N:HASH│`. Pass those anchors here instead of retyping the old text:",
  "",
  "```json",
  '{ "file_path": "/abs/path/file.ts", "edits": [{ "remove_from": "22:AB3F", "remove_to": "24:XY12", "replacement_text": "new content" }] }',
  "```",
  "",
  "- `remove_from` / `remove_to` are the first and last line of the range; use the same anchor for a single line.",
  "- `replacement_text` replaces the whole range; use `\"\"` to delete it.",
  "- Every entry is resolved against the file's original content, so entries never displace each other. All-or-nothing.",
  "- Anchors stay valid after edits elsewhere in the file: if line numbers moved, the anchor's hash re-locates it. The result returns fresh anchors for the changed region.",
  "- Only lines you have already read can be edited. If an anchor is rejected, the error includes the region's current anchors.",
  "",
  "Use `Edit` instead when you want to select an occurrence by its text rather than by position.",
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
    return editAnchoredFailure(NOTEBOOK_FILE_MESSAGE);
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
    return editAnchoredFailure(
      createAnchorFailureMessage({ content, failure: resolved, total: requests.length }),
    );
  }

  const overlap = findOverlappingAnchorEdits(resolved.edits);
  if (overlap) {
    return editAnchoredFailure(
      [
        `Edit ${overlap[0] + 1} and edit ${overlap[1] + 1} target overlapping line ranges.`,
        "Merge them into one entry, or make each range narrower. No edits were applied.",
      ].join("\n"),
    );
  }

  const newContent = applyAnchorEdits(content, resolved.edits);

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

  const updatedAnchors = buildUpdatedAnchors(
    newContent,
    resolved.edits.map((edit) => ({ start: edit.start, end: edit.start })),
  );

  const entry = updateReadFileStateAfterAnchoredEdit({
    readFileState: context.readFileState,
    filePath,
    content: newContent,
    revision: writeResult.revision,
    servedAnchors: computeLineHashes(newContent.split("\n")),
  });
  recordReadFileStateMetadata(context, entry);

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
    updatedAnchors,
  } satisfies EditAnchoredOutput;
};

// -----------------------------------------------
// Failure helper
// -----------------------------------------------

function editAnchoredFailure(message: string): ToolHandlerFailure {
  return { result: false, errorCode: 1, message };
}

// -----------------------------------------------
// Read state
// -----------------------------------------------

function updateReadFileStateAfterAnchoredEdit(input: {
  readFileState: ReadFileStateMap | undefined;
  filePath: string;
  content: string;
  revision: FileSystemReadTextResult["revision"] | undefined;
  servedAnchors: string[];
}): ReadFileStateEntry | undefined {
  if (!input.readFileState) return undefined;

  const key = createReadFileStateKey(input.filePath, 1, undefined);
  const previous = input.readFileState.get(key);

  const entry: ReadFileStateEntry = {
    path: input.filePath,
    content: input.content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: "Edit",
    revisionId: input.revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(input.revision?.mtimeMs),
    sizeBytes: input.revision?.sizeBytes ?? Buffer.byteLength(input.content, "utf8"),
    // 编辑结果里回传了新锚点，模型看过了，所以并进 served；同时保留旧哈希，
    // 否则模型手里那些「行号位移但内容没变」的锚点会被误判为没看过。
    servedAnchors: mergeServedAnchors(previous?.servedAnchors, input.servedAnchors),
  };

  input.readFileState.set(key, entry);
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

