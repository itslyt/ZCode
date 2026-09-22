// ============================================================
// Anchor Resolve — 把行锚点解析成可应用的区间
// ============================================================
//
// 解析优先级（每一步都宁可拒绝也不猜）：
//
// 1. 锚点必须语法合法（`行号:哈希`）；
// 2. 哈希必须出现在 served 集合里——没给模型看过的行不允许编辑；
// 3. 行号处的哈希对得上 → 直接用（快路径，没有位移）；
// 4. 对不上 → 在全文里按哈希找，**唯一命中**才移动（自愈合，模型不必重新定位）；
// 5. 找不到或多处命中 → 拒绝，并回传该区域当前的锚点（reject-and-serve）。
//
// 第 4 步是相对参考实现的改进：dsh-better-edit 靠持久化锚点表避免位移，
// oh-my-pi 让模型每次重新取标签（它自己的提示词把 RE-GROUND AFTER EVERY EDIT
// 列为头号规则）。这里让解析器自己修，并把位移结果回传给模型。

import {
  computeLineHashes,
  formatAnchorPrefix,
  hashLineContent,
  parseAnchor,
  splitLines,
  type ParsedAnchor,
} from "./anchor-hash.js";

export interface AnchorEditRequest {
  removeFrom: string;
  removeTo: string;
  replacementText: string;
}

export type AnchorFailureReason =
  | "malformed_anchor"
  | "unserved"
  | "stale"
  | "ambiguous"
  | "reversed_range";

export interface AnchorResolveFailure {
  status: "failed";
  editIndex: number;
  reason: AnchorFailureReason;
  /** 出问题的锚点原文（reversed_range 时为空串） */
  anchor: string;
  /** ambiguous 时的命中数 */
  matchCount: number;
  /** 用于生成「该区域当前锚点」的参考行号（1 起始，可能越界） */
  hintLine: number;
}

export interface ResolvedAnchorEdit {
  /** 0 起始、闭区间 */
  start: number;
  end: number;
  replacementText: string;
  /** 行号发生了位移（自愈合命中） */
  shifted: boolean;
}

export type AnchorResolveResult =
  | { status: "resolved"; edits: ResolvedAnchorEdit[] }
  | AnchorResolveFailure;

interface EndpointResolution {
  index: number;
  shifted: boolean;
}

function resolveEndpoint(input: {
  anchor: ParsedAnchor;
  rawAnchor: string;
  editIndex: number;
  lineHashes: readonly string[];
  servedHashes: ReadonlySet<string>;
}): EndpointResolution | AnchorResolveFailure {
  const { anchor, rawAnchor, editIndex, lineHashes, servedHashes } = input;

  if (!servedHashes.has(anchor.hash)) {
    return {
      status: "failed",
      editIndex,
      reason: "unserved",
      anchor: rawAnchor,
      matchCount: 0,
      hintLine: anchor.line,
    };
  }

  const expectedIndex = anchor.line - 1;
  if (expectedIndex >= 0 && expectedIndex < lineHashes.length) {
    if (lineHashes[expectedIndex] === anchor.hash) {
      return { index: expectedIndex, shifted: false };
    }
  }

  const candidates: number[] = [];
  for (let index = 0; index < lineHashes.length; index += 1) {
    if (lineHashes[index] === anchor.hash) candidates.push(index);
  }

  if (candidates.length === 0) {
    return {
      status: "failed",
      editIndex,
      reason: "stale",
      anchor: rawAnchor,
      matchCount: 0,
      hintLine: anchor.line,
    };
  }

  if (candidates.length === 1) {
    return { index: candidates[0]!, shifted: true };
  }

  // 多处命中：行号本身没对上，无法判断指向哪一处。绝不猜。
  return {
    status: "failed",
    editIndex,
    reason: "ambiguous",
    anchor: rawAnchor,
    matchCount: candidates.length,
    hintLine: anchor.line,
  };
}

export function resolveAnchorEdits(
  content: string,
  servedHashes: ReadonlySet<string>,
  requests: readonly AnchorEditRequest[],
): AnchorResolveResult {
  const lines = splitLines(content);
  const lineHashes = computeLineHashes(lines);
  const resolved: ResolvedAnchorEdit[] = [];

  for (let editIndex = 0; editIndex < requests.length; editIndex += 1) {
    const request = requests[editIndex]!;

    const from = parseAnchor(request.removeFrom);
    if (from === null) {
      return {
        status: "failed",
        editIndex,
        reason: "malformed_anchor",
        anchor: request.removeFrom,
        matchCount: 0,
        hintLine: 0,
      };
    }
    const to = parseAnchor(request.removeTo);
    if (to === null) {
      return {
        status: "failed",
        editIndex,
        reason: "malformed_anchor",
        anchor: request.removeTo,
        matchCount: 0,
        hintLine: from.line,
      };
    }

    const startResolution = resolveEndpoint({
      anchor: from,
      rawAnchor: request.removeFrom,
      editIndex,
      lineHashes,
      servedHashes,
    });
    if ("status" in startResolution) return startResolution;

    const endResolution = resolveEndpoint({
      anchor: to,
      rawAnchor: request.removeTo,
      editIndex,
      lineHashes,
      servedHashes,
    });
    if ("status" in endResolution) return endResolution;

    if (startResolution.index > endResolution.index) {
      return {
        status: "failed",
        editIndex,
        reason: "reversed_range",
        anchor: "",
        matchCount: 0,
        hintLine: from.line,
      };
    }

    resolved.push({
      start: startResolution.index,
      end: endResolution.index,
      replacementText: request.replacementText,
      shifted: startResolution.shifted || endResolution.shifted,
    });
  }

  return { status: "resolved", edits: resolved };
}

export function findOverlappingAnchorEdits(
  edits: readonly ResolvedAnchorEdit[],
): [number, number] | null {
  const indexed = edits.map((edit, index) => ({ edit, index }));
  indexed.sort((left, right) => left.edit.start - right.edit.start || left.edit.end - right.edit.end);

  for (let position = 1; position < indexed.length; position += 1) {
    const previous = indexed[position - 1]!;
    const current = indexed[position]!;
    if (current.edit.start <= previous.edit.end) {
      return [previous.index, current.index];
    }
  }
  return null;
}

/** 按起始行倒序应用，避免前面的编辑移动后面区间的行号。 */
export function applyAnchorEdits(
  content: string,
  edits: readonly ResolvedAnchorEdit[],
): string {
  const lines = splitLines(content);
  const ordered = [...edits].sort((left, right) => right.start - left.start);

  for (const edit of ordered) {
    const replacementLines =
      edit.replacementText === "" ? [] : splitLines(edit.replacementText);
    lines.splice(edit.start, edit.end - edit.start + 1, ...replacementLines);
  }

  return lines.join("\n");
}

const REGION_CONTEXT_LINES = 3;

/**
 * 渲染一段带锚点的区域，供拒绝信息与编辑结果使用。
 * 这是 reject-and-serve：模型拿到它就能继续，不必重新读整个文件。
 */
export function formatAnchorRegion(
  content: string,
  centerLine: number,
  contextLines = REGION_CONTEXT_LINES,
): string {
  const lines = splitLines(content);
  if (lines.length === 0) return "(file is empty)";

  const from = Math.max(1, centerLine - contextLines);
  const to = Math.min(lines.length, centerLine + contextLines);

  const body = lines
    .slice(from - 1, to)
    .map((line, offset) => {
      const lineNumber = from + offset;
      return `${formatAnchorPrefix(lineNumber, hashLineContent(line))}${line}`;
    })
    .join("\n");

  return `Current anchors (lines ${from}-${to}):\n${body}`;
}

/** 编辑成功后回传受影响区域的新锚点，省掉一次重新读取。 */
export function buildUpdatedAnchors(
  content: string,
  changedRanges: readonly { start: number; end: number }[],
  contextLines = REGION_CONTEXT_LINES,
): string {
  const lines = splitLines(content);
  if (lines.length === 0) return "";

  const blocks: string[] = [];
  const covered = new Set<number>();

  for (const range of changedRanges) {
    const from = Math.max(1, range.start + 1 - contextLines);
    const to = Math.min(lines.length, range.end + 1 + contextLines);
    if (covered.has(from)) continue;
    for (let line = from; line <= to; line += 1) covered.add(line);

    blocks.push(
      lines
        .slice(from - 1, to)
        .map((line, offset) => {
          const lineNumber = from + offset;
          return `${formatAnchorPrefix(lineNumber, hashLineContent(line))}${line}`;
        })
        .join("\n"),
    );
  }

  return blocks.join("\n...\n");
}

export function createAnchorFailureMessage(input: {
  content: string;
  failure: AnchorResolveFailure;
  total: number;
}): string {
  const { failure, total, content } = input;
  const position = `Edit ${failure.editIndex + 1} of ${total}`;
  const hintLine = Math.min(Math.max(failure.hintLine, 1), splitLines(content).length || 1);

  switch (failure.reason) {
    case "malformed_anchor":
      return [
        `${position} has a malformed anchor: ${JSON.stringify(failure.anchor)}.`,
        "Anchors look like `22:AB3F` (line number, colon, 4-character hash). Copy them verbatim from a Read result.",
        "No edits were applied.",
      ].join("\n");

    case "unserved":
      return [
        `${position} references anchor ${failure.anchor}, which was never shown to you for this file.`,
        "Read the region first, then copy the anchor from that Read result.",
        "No edits were applied.",
      ].join("\n");

    case "ambiguous":
      return [
        `${position} anchor ${failure.anchor} matches ${failure.matchCount} lines in the current file,`,
        "so it cannot be resolved to one place. Read the region again and copy fresh anchors.",
        "No edits were applied.",
      ].join("\n");

    case "reversed_range":
      return [
        `${position} has remove_from after remove_to.`,
        "remove_from must be the anchor of the first line and remove_to the anchor of the last line.",
        "No edits were applied.",
      ].join("\n");

    case "stale":
      return [
        `${position} anchor ${failure.anchor} no longer exists in the file — the content it pointed at changed.`,
        "No edits were applied.",
        formatAnchorRegion(content, hintLine),
      ].join("\n");
  }
}
