// ============================================================
// Edit Batch — 同文件原子批量编辑
// ============================================================
//
// 批量语义有两条硬约束：
//
// 1. **每条编辑都钉在原文的绝对偏移上**。如果按顺序把上一条的结果写回工作副本，
//    下一条的匹配位置就会被上一条的增删行挤走——dsh-better-edit 的
//    `E_BATCH_DISPLACED` 就是这类失败。这里先把所有编辑在**原内容**上定位完，
//    再按偏移倒序应用，批内因此没有顺序耦合，模型也不必推理"这两条独立吗"。
// 2. **全有或全无**。任一条定位失败或区间重叠，整批拒绝、文件零改动，错误里带
//    失败下标与就近片段，模型改一个字段就能重发，不需要重读整个文件。

import {
  collectOccurrenceOffsets,
  findClosestEditRegion,
  findEditMatch,
  normalizeReplacementForMatch,
  preserveQuoteStyle,
  type EditMatchStrategy,
} from "./edit-matchers.js";

export interface BatchEditRequest {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export interface ResolvedBatchEdit {
  /** 原内容中的命中区间，左闭右开 */
  start: number;
  end: number;
  replacement: string;
  strategy: EditMatchStrategy;
}

export type BatchResolveFailureReason = "not_found" | "ambiguous" | "no_change";

export type BatchResolveResult =
  | { status: "resolved"; edits: ResolvedBatchEdit[] }
  | {
      status: "failed";
      failedIndex: number;
      reason: BatchResolveFailureReason;
      /** not_found 时用于生成就近片段 */
      oldString: string;
      candidateCount: number;
    };

/**
 * 在**原内容**上定位所有编辑。不做任何写入。
 */
export function resolveBatchEdits(
  content: string,
  requests: readonly BatchEditRequest[],
): BatchResolveResult {
  const resolved: ResolvedBatchEdit[] = [];

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    const oldString = request.oldString;
    const newString = request.newString;

    if (oldString === newString) {
      return {
        status: "failed",
        failedIndex: index,
        reason: "no_change",
        oldString,
        candidateCount: 0,
      };
    }

    const match = findEditMatch({ content, search: oldString, replaceAll: request.replaceAll });
    if (match.status === "not_found") {
      return {
        status: "failed",
        failedIndex: index,
        reason: "not_found",
        oldString,
        candidateCount: 0,
      };
    }
    if (match.status === "ambiguous") {
      return {
        status: "failed",
        failedIndex: index,
        reason: "ambiguous",
        oldString,
        candidateCount: match.candidateCount,
      };
    }

    const actualOldString = match.actualString;
    const offsets = collectOccurrenceOffsets(content, actualOldString);
    if (!request.replaceAll && offsets.length > 1) {
      return {
        status: "failed",
        failedIndex: index,
        reason: "ambiguous",
        oldString,
        candidateCount: offsets.length,
      };
    }

    const normalizedNewString = normalizeReplacementForMatch(match.strategy, newString);
    const actualNewString = preserveQuoteStyle(oldString, actualOldString, normalizedNewString);
    const targets = request.replaceAll ? offsets : [match.index];

    for (const start of targets) {
      resolved.push({
        start,
        end: start + actualOldString.length,
        replacement: actualNewString,
        strategy: match.strategy,
      });
    }
  }

  return { status: "resolved", edits: resolved };
}

/**
 * 按偏移倒序写回，保证前面区间的替换不会移动后面区间的坐标。
 * 调用前必须已通过 {@link findOverlappingBatchEdits} 校验。
 */
export function applyResolvedBatchEdits(
  content: string,
  edits: readonly ResolvedBatchEdit[],
): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let result = content;
  for (const edit of ordered) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

/**
 * 返回第一对重叠编辑的下标（按 `edits` 原始顺序），无重叠返回 null。
 *
 * 重叠无法定义应用顺序，且几乎总是模型把两条编辑写到了同一段代码上——
 * 这种情况必须显式拒绝，不能靠排序猜一个顺序。
 */
export function findOverlappingBatchEdits(
  edits: readonly ResolvedBatchEdit[],
): [number, number] | null {
  const indexed = edits.map((edit, index) => ({ edit, index }));
  indexed.sort((left, right) => left.edit.start - right.edit.start || left.edit.end - right.edit.end);

  for (let position = 1; position < indexed.length; position += 1) {
    const previous = indexed[position - 1]!;
    const current = indexed[position]!;
    if (current.edit.start < previous.edit.end) {
      return [previous.index, current.index];
    }
  }
  return null;
}

/**
 * 把「最接近的区域」渲染成带行号的片段，附在失败信息里。
 *
 * 模型拿到它可以直接改 `old_string` 重发；没有它就只能重读整个文件重新构造。
 */
export function createNearbyRegionSnippet(
  content: string,
  search: string,
  contextLines = 5,
): string | null {
  const region = findClosestEditRegion(content, search);
  if (!region) return null;

  const lines = content.split("\n");
  const from = Math.max(1, region.startLine - contextLines);
  const to = Math.min(lines.length, region.endLine + contextLines);

  const body = lines
    .slice(from - 1, to)
    .map((line, offset) => `${from + offset}\t${line}`)
    .join("\n");

  const similarity = Math.round(region.similarity * 100);
  return [
    `Closest current content (lines ${from}-${to}, ${similarity}% similar — copy from here, do not retype from memory):`,
    body,
  ].join("\n");
}

/**
 * 构造批量失败信息：说明是第几条失败、原因，并附可就地修正的材料。
 */
export function createBatchEditFailureMessage(input: {
  content: string;
  failure: Extract<BatchResolveResult, { status: "failed" }>;
  total: number;
}): string {
  const { failure, total, content } = input;
  const position = `Edit ${failure.failedIndex + 1} of ${total}`;

  if (failure.reason === "no_change") {
    return `${position} is a no-op: old_string and new_string are exactly the same. No edits were applied.`;
  }

  if (failure.reason === "ambiguous") {
    return [
      `${position} is ambiguous: found ${failure.candidateCount} matches, but replace_all is false.`,
      "Add surrounding context to make it unique, or set replace_all to true for that entry.",
      `String: ${failure.oldString}`,
      "No edits were applied.",
    ].join("\n");
  }

  const parts = [`${position} did not match anything in the file. No edits were applied.`];
  const snippet = createNearbyRegionSnippet(content, failure.oldString);
  if (snippet) {
    parts.push(snippet);
  } else {
    parts.push("No similar region found — re-read the file to locate the target.");
  }
  parts.push(`String: ${failure.oldString}`);
  return parts.join("\n");
}
