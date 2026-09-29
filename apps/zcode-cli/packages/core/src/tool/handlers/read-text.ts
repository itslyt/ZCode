import {
  CoreErrorType,
  READ_DEFAULT_MAX_LINES,
  READ_MAX_FILE_SIZE_BYTES,
  READ_MAX_OUTPUT_TOKENS,
  createCoreError,
  type FileSystemPort,
  type FileSystemReadTextRangeResult,
  type ReadTextOutput,
  type TraceContext,
} from "@zcode/contracts";

import { formatAnchorPrefix, hashLineContent } from "../anchor-hash.js";
import { estimateTokens } from "../../context/utils.js";

const EMPTY_FILE_REMINDER = formatReadToolResultWarning(
  "Warning: the file exists but the contents are empty.",
);
const READ_TOKEN_BUDGET_PARTIAL_TARGET = Math.floor(READ_MAX_OUTPUT_TOKENS * 0.85);

interface ReadTextFileForModelOptions {
  abortSignal?: AbortSignal;
  allowPartialFallback?: boolean;
  filePath: string;
  fileSystemPort: FileSystemPort;
  limit?: number;
  onRead?: (read: FileSystemReadTextRangeResult) => void;
  offset?: number;
  trace?: TraceContext;
}

export async function readTextFileForModel({
  abortSignal,
  allowPartialFallback,
  filePath,
  fileSystemPort,
  limit,
  onRead,
  offset,
  trace,
}: ReadTextFileForModelOptions): Promise<ReadTextOutput> {
  const limitProvided = limit !== undefined;
  const read = await fileSystemPort.readTextFileRange(
    {
      path: filePath,
      offsetLine: toRangeOffsetLine(offset),
      limitLines: limit,
      maxBytes: limitProvided ? undefined : READ_MAX_FILE_SIZE_BYTES,
      trace,
    },
    { signal: abortSignal },
  );
  onRead?.(read);

  return readTextRangeResultToOutput({
    allowPartialFallback: allowPartialFallback ?? isInitialWholeFileRead(offset, limit),
    filePath,
    offset,
    read,
  });
}

export function formatReadTextOutput(
  output: ReadTextOutput,
  options: { includeAnchors?: boolean } = {},
): string {
  const partialViewPrefix = output.partialViewNotice
    ? `${formatReadToolResultWarning(output.partialViewNotice)}\n\n`
    : "";

  if (!output.content) {
    const warning =
      output.totalLines === 0
        ? EMPTY_FILE_REMINDER
        : formatReadToolResultWarning(
            `Warning: the file exists but is shorter than the provided offset (${output.startLine}). The file has ${output.totalLines} lines.`,
          );
    return `${partialViewPrefix}${warning}`;
  }

  // 成功文本结果的模型可见契约只包含条件提醒与带行号正文；
  // 历史安全提醒不属于当前 tool result 路径。
  //
  // includeAnchors: false 供「不是 Read 却复用了本渲染器」的调用方（目前只有用户附件
  // 提醒，见 specs/edit-anchored-verification.md §7.7.1）。那种路径不写 served 集合，
  // 渲染锚点等于给模型一个它用不了的可编辑承诺；保留行号是为了定位，不是承诺。
  const numbered =
    options.includeAnchors === false
      ? addPlainLineNumbers({ content: output.content, startLine: output.startLine })
      : addReadLineNumbers({ content: output.content, startLine: output.startLine });
  return `${partialViewPrefix}${numbered}`;
}

export function addReadLineNumbers({
  content,
  startLine,
}: {
  content: string;
  startLine: number;
}): string {
  // startLine 为 0 只出现在「调用方显式传 offset=0」的路径（见 formatReadTextOutput 的
  // `offset === 0 ? 0 : read.startLine`）。那种情况下内容仍然是从文件第 1 行开始的，
  // 直接拿 0 当行号会让首行渲染成 `0:HASH│`，既与工具描述「line numbers starting at 1」
  // 矛盾，又会让行号在 offset=0 / offset=1 两次读取之间不一致（真机验证踩到过）。
  const firstLineNumber = startLine <= 0 ? 1 : startLine;

  return content
    .split(/\r?\n/)
    .map((line, index) => {
      const lineNumber = index + firstLineNumber;
      return `${formatAnchorPrefix(lineNumber, hashLineContent(line))}${line}`;
    })
    .join("\n");
}

function formatReadToolResultWarning(body: string): string {
  return `<system-reminder>${body}</system-reminder>`;
}

/** 只加行号、不加锚点。给「不是 Read 却复用渲染器」的路径用，见上面 includeAnchors 的说明。 */
function addPlainLineNumbers({
  content,
  startLine,
}: {
  content: string;
  startLine: number;
}): string {
  const firstLineNumber = startLine <= 0 ? 1 : startLine;

  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + firstLineNumber}\t${line}`)
    .join("\n");
}

function toRangeOffsetLine(offset: number | undefined): number {
  if (offset === undefined || offset <= 1) return 0;
  return offset - 1;
}

function isInitialWholeFileRead(offset: number | undefined, limit: number | undefined): boolean {
  return (offset === undefined || offset <= 1) && limit === undefined;
}

function readTextRangeResultToOutput({
  allowPartialFallback,
  filePath,
  offset,
  read,
}: {
  allowPartialFallback: boolean;
  filePath: string;
  offset?: number;
  read: FileSystemReadTextRangeResult;
}): ReadTextOutput {
  const tokenCount = estimateTokens(read.content);
  if (tokenCount > READ_MAX_OUTPUT_TOKENS) {
    if (!allowPartialFallback) {
      throwReadOutputTokenBudgetError(tokenCount, filePath);
    }
    const fallback = createTokenCapPartialView(read, tokenCount);
    if (fallback) return { filePath, type: "text", ...fallback };
    throwReadOutputTokenBudgetError(tokenCount, filePath);
  }

  const unseenNotice = formatUnseenLinesNotice(read, offset);
  return normalizeReadTextOutput({
    type: "text",
    filePath,
    content: read.content,
    numLines: read.lineCount,
    startLine: offset === 0 ? 0 : read.startLine,
    totalLines: read.totalLines,
    sizeBytes: read.sizeBytes,
    bytesRead: read.bytesRead,
    truncated: read.truncated,
    // 范围读没读到底时必须说清「还有多少行没看见」。实测 1996 次命中 limit 的读里
    // 1969 次完全静默——模型据此以为文件只有 200 行，随后按记忆写行号 → unserved。
    // 复用 partialViewNotice（同一个渲染出口，不新增字段、不动 contracts）。见 §7.9.4。
    ...(unseenNotice === undefined ? {} : { partialViewNotice: unseenNotice }),
  });
}

/**
 * 只在该次读取确实没覆盖到文件尾部时给提示。
 *
 * 判据用 `totalLines`（文件真实行数）与本次显示的末行比对，而不是 `truncated`：
 * 后者表达的是「单行超预算」那类截断，范围读的正常分页它并不为真。
 */
export function formatUnseenLinesNotice(
  read: FileSystemReadTextRangeResult,
  offset: number | undefined,
): string | undefined {
  const shownFrom = offset === 0 ? 1 : read.startLine <= 0 ? 1 : read.startLine;
  const shownTo = shownFrom + read.lineCount - 1;
  const total = read.totalLines;
  if (total <= 0 || shownTo >= total) return undefined;

  const unseen = total - shownTo;
  const above = shownFrom > 1 ? shownFrom - 1 : 0;
  const scope =
    above > 0
      ? `lines ${shownFrom}-${shownTo} of ${total} (${above} above, ${unseen} below are NOT shown)`
      : `lines ${shownFrom}-${shownTo} of ${total} (${unseen} below are NOT shown)`;
  return [
    `Showing ${scope}.`,
    `Lines outside this window are UNSEEN — never edit them from guessed line numbers, and Read the range first.`,
    `Use Read with offset ${shownTo + 1} and limit ${READ_DEFAULT_MAX_LINES} to see more.`,
  ].join(" ");
}

function normalizeReadTextOutput(output: ReadTextOutput): ReadTextOutput {
  if (
    output.content.length === 0 &&
    output.numLines === 0 &&
    output.startLine === 1 &&
    output.totalLines === 0
  ) {
    return {
      ...output,
      numLines: 1,
      totalLines: 1,
    };
  }
  return output;
}

function createTokenCapPartialView(
  read: FileSystemReadTextRangeResult,
  tokenCount: number,
): Omit<ReadTextOutput, "filePath" | "type"> | undefined {
  const lines = read.content.split(/\r?\n/);
  if (lines.length === 0) return undefined;

  const lineCount = findLargestPrefixWithinTokenBudget(lines);
  if (lineCount > 0) {
    const content = lines.slice(0, lineCount).join("\n");
    const startLine = read.startLine;
    const endLine = startLine + lineCount - 1;
    const nextOffset = endLine + 1;
    return {
      content,
      numLines: lineCount,
      startLine,
      totalLines: read.totalLines,
      sizeBytes: read.sizeBytes,
      bytesRead: read.bytesRead,
      truncated: true,
      truncatedByTokenCap: true,
      partialViewNotice: [
        `The file is too large to display in full (${tokenCount} estimated tokens, limit ${READ_MAX_OUTPUT_TOKENS}).`,
        `Showing a partial view of lines ${startLine}-${endLine} of ${read.totalLines}.`,
        `Use Read with offset ${nextOffset} and limit ${READ_DEFAULT_MAX_LINES} to continue, or use a search tool to find a specific section.`,
      ].join(" "),
    };
  }

  const charCount = findLargestPrefixCharsWithinTokenBudget(read.content);
  if (charCount <= 0) return undefined;
  return {
    content: read.content.slice(0, charCount),
    numLines: 1,
    startLine: read.startLine,
    totalLines: read.totalLines,
    sizeBytes: read.sizeBytes,
    bytesRead: read.bytesRead,
    truncated: true,
    truncatedByTokenCap: true,
    partialViewNotice: [
      `The file is too large to display in full (${tokenCount} estimated tokens, limit ${READ_MAX_OUTPUT_TOKENS}).`,
      "Showing a partial view of the first line because the first line alone exceeds the token budget.",
      "Use Read with a smaller range or use a search tool to find a specific section.",
    ].join(" "),
  };
}

function findLargestPrefixWithinTokenBudget(lines: readonly string[]): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(lines.slice(0, mid).join("\n")) <= READ_TOKEN_BUDGET_PARTIAL_TARGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function findLargestPrefixCharsWithinTokenBudget(content: string): number {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(content.slice(0, mid)) <= READ_TOKEN_BUDGET_PARTIAL_TARGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function throwReadOutputTokenBudgetError(tokenCount: number, filePath: string): never {
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${READ_MAX_OUTPUT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    {
      context: {
        code: "read_output_too_many_tokens",
        filePath,
        maxTokens: READ_MAX_OUTPUT_TOKENS,
        tokenCount,
      },
      recoverable: true,
    },
  );
}
