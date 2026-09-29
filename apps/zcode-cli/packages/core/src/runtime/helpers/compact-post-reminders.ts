import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import type { ReadFileStateEntry, ReadFileStateMap } from "../deps.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { type ModelMessageContent, modelMessageContentToText } from "@zcode/contracts";
import { ANCHOR_HASH_LENGTH, ANCHOR_SEPARATOR, normalizeAnchorHash } from "../../tool/anchor-hash.js";
import { createReadFileStateKey } from "../../tool/read-file-state.js";

/** 能从结果正文里解析出锚点的工具；与 hydrator 的恢复名单一致（`read-file-state-hydrator.ts`）。 */
const ANCHOR_BEARING_TOOLS = new Set(["Read", "EditAnchored"]);

/**
 * 锚点行前缀：`22:AB3F│...`，可带 `>>> ` 标记。
 * 整行匹配而非子串扫描，但必须容忍标记——错误信息会用 `>>>` 标出问题行，
 * 那些行同样是「展示给模型看过的」，漏掉它们会让 served 凭空少一块。
 */
const ANCHOR_LINE_PATTERN = new RegExp(
  `^(?:>>> )?(\\d+):([0-9A-Za-z]{${ANCHOR_HASH_LENGTH}})${ANCHOR_SEPARATOR}`,
);

/**
 * 压缩后重建 served 集合。见 specs/edit-anchored-verification.md §7.7.2。
 *
 * compact 原本直接 `clear()` 整个 `readFileState`，但压缩按设计会**原样保留最近若干轮**，
 * 于是模型上下文里还留着带锚点的 Read 结果，served 集合却已归零——模型照抄眼前看得见的
 * 锚点会被判 unserved。这与 `anchor-served.ts` 写下的「只增不减」不变量直接冲突。
 *
 * **只重建 served，不重建门禁字段**：压缩不等于重新读盘。拿条目的旧 mtime 当
 * stale 基准，会把「压缩后文件已被外部改过」判成「未变」，等于凭一次未发生的读拿到写权限。
 *
 * 入参 `entries` 必须传**压缩后实际发给模型的集合**（`postCompactEntries`），
 * 而不是压缩前的 `preservedEntries`：只有前者能证明「模型现在手里看得见这些锚点」。
 *
 * 返回重建的文件数，供调用方观测。
 */
export function rebuildServedAnchorsAfterCompact(input: {
  entries: readonly RuntimeMessageEntry[];
  readFileState: ReadFileStateMap;
}): number {
  const filePathByToolCallId = collectToolCallFilePaths(input.entries);
  const hashesByPath = new Map<string, string[]>();

  for (const entry of input.entries) {
    if (entry.kind === "attachment") continue;
    const message = entry.message;
    if (message.role !== "tool") continue;
    if (!message.toolName || !ANCHOR_BEARING_TOOLS.has(message.toolName)) continue;
    if (!message.toolCallId) continue;

    const filePath = filePathByToolCallId.get(message.toolCallId);
    if (!filePath) continue;
    const hashes = parseRenderedAnchorHashes(message.content);
    if (hashes.length === 0) continue;

    hashesByPath.set(filePath, [...(hashesByPath.get(filePath) ?? []), ...hashes]);
  }

  let rebuilt = 0;
  for (const [filePath, hashes] of hashesByPath) {
    const existing = findReadStateEntryForPath(input.readFileState, filePath);
    if (existing) {
      existing.servedAnchors = mergeHashes(existing.servedAnchors, hashes);
      rebuilt += 1;
      continue;
    }

    // 没有读状态时 served 需要有地方放。与 edit-anchored 的拒绝路径同一形状：
    // 门禁字段一律按「没读全」处理，不提供任何 Edit/Write 可用的依据。
    input.readFileState.set(createReadFileStateKey(filePath, 1, undefined), {
      path: filePath,
      content: "",
      offset: undefined,
      limit: undefined,
      isPartialView: true,
      readAt: new Date(),
      servedAnchors: mergeHashes(undefined, hashes),
    });
    rebuilt += 1;
  }
  return rebuilt;
}

/** 工具结果的 `file_path` 在 assistant 的 `toolCalls[].input` 上，不在结果正文里。 */
function collectToolCallFilePaths(
  entries: readonly RuntimeMessageEntry[],
): Map<string, string> {
  const byToolCallId = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    const message = entry.message;
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const toolCall of message.toolCalls) {
      if (toolCall.name !== undefined && !ANCHOR_BEARING_TOOLS.has(toolCall.name)) continue;
      const filePath = readToolCallFilePath(toolCall.input);
      if (filePath) byToolCallId.set(toolCall.id, filePath);
    }
  }
  return byToolCallId;
}

function readToolCallFilePath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const filePath = (input as { file_path?: unknown }).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

/** 该路径的读状态条目：可能落在不同 key（offset/limit）上，取任一即可。 */
function findReadStateEntryForPath(
  readFileState: ReadFileStateMap,
  filePath: string,
): ReadFileStateEntry | undefined {
  for (const entry of readFileState.values()) {
    if (entry.path === filePath) return entry;
  }
  return undefined;
}

function mergeHashes(
  existing: readonly string[] | undefined,
  incoming: readonly string[],
): string[] {
  return [...new Set([...(existing ?? []), ...incoming])];
}

/**
 * 从已渲染的工具结果正文里抽出锚点哈希。
 *
 * 必须整行匹配 `formatAnchorPrefix` 的产物 `N:HASH│`：只把「行首就是锚点」当锚点，
 * 正文里引用了锚点格式的代码（本仓库自己的测试字符串、spec）不会被当成真的展示过。
 * 已被 microcompact 清空的条目没有锚点，这里自然得空，不需特判。
 */
function parseRenderedAnchorHashes(content: ModelMessageContent): string[] {
  const text = modelMessageContentToText(content);
  if (text.length === 0) return [];
  const hashes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = ANCHOR_LINE_PATTERN.exec(line);
    if (!match) continue;
    const hash = normalizeAnchorHash(match[2]!);
    if (hash) hashes.push(hash);
  }
  return hashes;
}

export function buildPostCompactReadStateReminderEntries(input: {
  maxFileApproxTokens?: number;
  maxFiles?: number;
  maxTotalApproxTokens?: number;
  preservedEntries?: readonly RuntimeMessageEntry[];
  readFileState?: ReadFileStateMap;
}): RuntimeMessageEntry[] {
  const readFileState = input.readFileState;
  if (!readFileState || readFileState.size === 0) {
    return [];
  }

  const maxFiles = input.maxFiles ?? 5;
  const maxFileApproxTokens = input.maxFileApproxTokens ?? 5_000;
  const maxTotalApproxTokens = input.maxTotalApproxTokens ?? 50_000;
  const selected: RuntimeMessageEntry[] = [];
  let totalApproxTokens = 0;
  const preservedReadFilePaths = collectPreservedReadFilePaths(input.preservedEntries ?? []);

  const candidates = Array.from(readFileState.values())
    .filter(isPostCompactReadReminderCandidate)
    .filter((entry) => !shouldSkipPostCompactReadStatePath(entry.path))
    .filter((entry) => !preservedReadFilePaths.has(normalizePostCompactReadStatePath(entry.path)))
    .sort((left, right) => right.readAt.getTime() - left.readAt.getTime());

  for (const entry of candidates) {
    if (selected.length >= maxFiles) break;

    const approxTokens = Math.ceil(entry.content.length / ESTIMATED_TOKEN_CHAR_DIVISOR);
    if (approxTokens > maxFileApproxTokens) {
      selected.push(buildPostCompactReadStateEntry(formatCompactFileReference(entry)));
      continue;
    }
    if (totalApproxTokens + approxTokens > maxTotalApproxTokens) {
      selected.push(buildPostCompactReadStateEntry(formatCompactFileReference(entry)));
      continue;
    }

    totalApproxTokens += approxTokens;
    selected.push(buildPostCompactReadStateEntry(formatReadStateProjection(entry)));
  }

  return selected;
}

function buildPostCompactReadStateEntry(content: string): RuntimeMessageEntry {
  return systemReminderAttachmentEntry("resume_referenced_session_context", content);
}

function formatCompactFileReference(entry: ReadFileStateEntry): string {
  return `Note: ${entry.path} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`;
}

function formatReadStateProjection(entry: ReadFileStateEntry): string {
  const content = addReadLineNumbers(entry.content, readStateStartLine(entry.offset));
  return [
    `Called the Read tool with the following input: ${formatFileStateInput(entry)}`,
    "Result of calling the Read tool:",
    content,
  ].join("\n");
}

function isPostCompactReadReminderCandidate(entry: ReadFileStateEntry): boolean {
  return entry.sourceTool === undefined || entry.sourceTool === "Read";
}

function collectPreservedReadFilePaths(entries: readonly RuntimeMessageEntry[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!("message" in entry)) continue;
    if (entry.message.role !== "assistant" || !entry.message.toolCalls) continue;
    for (const toolCall of entry.message.toolCalls) {
      if (toolCall.name !== "Read") continue;
      const filePath = readToolCallFilePath(toolCall.input);
      if (filePath) paths.add(normalizePostCompactReadStatePath(filePath));
    }
  }
  return paths;
}

function formatFileStateInput(entry: ReadFileStateEntry): string {
  return JSON.stringify({
    file_path: entry.path,
    ...(entry.offset === undefined ? {} : { offset: entry.offset }),
    ...(entry.limit === undefined ? {} : { limit: entry.limit }),
  });
}

function readStateStartLine(offset: number | undefined): number {
  if (offset === 0) return 0;
  if (offset !== undefined && offset > 1) return Math.trunc(offset);
  return 1;
}

function addReadLineNumbers(content: string, startLine: number): string {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + startLine}\t${line}`)
    .join("\n");
}

function shouldSkipPostCompactReadStatePath(filePath: string): boolean {
  const normalized = normalizePostCompactReadStatePath(filePath);
  return normalized.includes("/.git/");
}

function normalizePostCompactReadStatePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
