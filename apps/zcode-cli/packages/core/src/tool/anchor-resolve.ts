// ============================================================
// Anchor Resolve — 把行锚点解析成可应用的区间
// ============================================================
//
// 解析优先级（每一步都宁可拒绝也不猜）：
//
// 1. 锚点必须语法合法（`行号:哈希`，或唯一可定位的裸哈希）；
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
  parseAnchorToken,
  splitLines,
  type ParsedAnchorToken,
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
  /** ambiguous 时的候选行号（1 起始）。只用于枚举候选，不参与定位。 */
  candidateLines?: number[];
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
  /** 模型提交的显式行号（裸哈希时为 undefined）。自愈时用它说明「你以为在第 N 行」。 */
  requestedLine?: number;
}

export type AnchorResolveResult =
  | { status: "resolved"; edits: ResolvedAnchorEdit[] }
  | AnchorResolveFailure;

interface EndpointResolution {
  index: number;
  shifted: boolean;
}

function resolveEndpoint(input: {
  token: ParsedAnchorToken;
  rawAnchor: string;
  editIndex: number;
  lineHashes: readonly string[];
  servedHashes: ReadonlySet<string>;
}): EndpointResolution | AnchorResolveFailure {
  const { token, rawAnchor, editIndex, lineHashes, servedHashes } = input;
  if (token.kind === "malformed") {
    return {
      status: "failed",
      editIndex,
      reason: "malformed_anchor",
      anchor: rawAnchor,
      matchCount: 0,
      hintLine: 0,
    };
  }

  const candidates: number[] = [];
  for (let index = 0; index < lineHashes.length; index += 1) {
    if (lineHashes[index] === token.hash) candidates.push(index);
  }

  // 显式锚点用模型给的行号做提示；裸哈希没有行号，只能拿首个候选行。
  // 零候选时留 0，表示「无从指路」——错误信息据此决定是否回传区域。
  const hintLine =
    token.kind === "explicit" ? token.line : candidates.length > 0 ? candidates[0]! + 1 : 0;
  const fail = (reason: AnchorFailureReason, matchCount: number): AnchorResolveFailure => ({
    status: "failed",
    editIndex,
    reason,
    anchor: rawAnchor,
    matchCount,
    // ambiguous 时把全部候选行号带出去：模型看到「命中 6 行」却只看到其中 1 行的
    // 周围内容，只能回去重读。实测 21/21 次 ambiguous 的回传区都只覆盖部分候选。
    ...(reason === "ambiguous" && candidates.length > 0
      ? { candidateLines: candidates.map((index) => index + 1) }
      : {}),
    hintLine,
  });

  if (!servedHashes.has(token.hash)) return fail("unserved", 0);

  if (token.kind === "explicit") {
    const expectedIndex = token.line - 1;
    if (
      expectedIndex >= 0 &&
      expectedIndex < lineHashes.length &&
      lineHashes[expectedIndex] === token.hash
    ) {
      return { index: expectedIndex, shifted: false };
    }
  }

  if (candidates.length === 0) return fail("stale", 0);
  // 唯一候选才移动。裸哈希本来就没有行号，不存在「位移」。
  if (candidates.length === 1) {
    return { index: candidates[0]!, shifted: token.kind === "explicit" };
  }

  // 多处命中：无法判断指向哪一处。绝不猜。
  return fail("ambiguous", candidates.length);
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

    const from = parseAnchorToken(request.removeFrom);
    if (from.kind === "malformed") {
      return {
        status: "failed",
        editIndex,
        reason: "malformed_anchor",
        anchor: request.removeFrom,
        matchCount: 0,
        hintLine: 0,
      };
    }

    // 首尾写同一个锚点、或 remove_to 留空，都表示单行编辑。留空是模型常见的偷懒写法，
    // 历史上就当作单行处理；即便 schema 已要求该字段，也不要把这种写法改成拒绝。
    const rawEnd = request.removeTo ?? "";
    const singleLine = rawEnd.trim() === "" || rawEnd === request.removeFrom;
    const to = singleLine ? null : parseAnchorToken(rawEnd);
    if (to !== null && to.kind === "malformed") {
      return {
        status: "failed",
        editIndex,
        reason: "malformed_anchor",
        anchor: rawEnd,
        matchCount: 0,
        hintLine: from.kind === "explicit" ? from.line : 0,
      };
    }

    const startResolution = resolveEndpoint({
      token: from,
      rawAnchor: request.removeFrom,
      editIndex,
      lineHashes,
      servedHashes,
    });
    if ("status" in startResolution) return startResolution;

    const endResolution: EndpointResolution | AnchorResolveFailure =
      singleLine
        ? { index: startResolution.index, shifted: false }
        : resolveEndpoint({
            token: to!,
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
        hintLine: from.kind === "explicit" ? from.line : startResolution.index + 1,
      };
    }

    resolved.push({
      start: startResolution.index,
      end: endResolution.index,
      replacementText: request.replacementText,
      shifted: startResolution.shifted || endResolution.shifted,
      // 模型声称的行号（显式形式才有）。自愈发生时用它把「你以为在第 N 行」说清楚。
      requestedLine: from.kind === "explicit" ? from.line : undefined,
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
export interface AppliedAnchorEdits {
  content: string;
  /** 每条编辑在**新内容**里实际落地的行区间（0 起始闭区间），顺序与传入的 edits 一致。 */
  changedRanges: { start: number; end: number }[];
}

/**
 * 按起始行倒序应用，避免前面的编辑移动后面区间的行号。
 *
 * 同时回报每条编辑在新内容里的落点：`ResolvedAnchorEdit.start/end` 是原始内容的索引，
 * 直接拿去渲染回传锚点会在靠前的编辑改变行数后指向别的行。
 */
export function applyAnchorEdits(
  content: string,
  edits: readonly ResolvedAnchorEdit[],
): AppliedAnchorEdits {
  const lines = splitLines(content);
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) => right.edit.start - left.edit.start);

  const changedRanges: { start: number; end: number }[] = new Array(edits.length);

  for (const { edit, index } of ordered) {
    const replacementLines =
      edit.replacementText === "" ? [] : splitLines(edit.replacementText);
    const removedCount = edit.end - edit.start + 1;
    lines.splice(edit.start, removedCount, ...replacementLines);

    // splice 之后 replacement 落在 [edit.start, edit.start + 长度 - 1]；
    // 纯删除没有 replacement，落点是删除位置上的那一行。
    const start = Math.min(edit.start, Math.max(lines.length - 1, 0));
    changedRanges[index] = { start, end: start + Math.max(replacementLines.length, 1) - 1 };

    // 倒序处理，所以已经记录过的落点都在这次 splice 位置之后；
    // 本次行数变化了多少，它们就要整体平移多少，否则会指向错行。
    const delta = replacementLines.length - removedCount;
    if (delta !== 0) {
      for (let done = 0; done < changedRanges.length; done += 1) {
        if (done === index) continue;
        const range = changedRanges[done];
        if (!range || range.start < edit.start) continue;
        range.start += delta;
        range.end += delta;
      }
    }
  }

  return { content: lines.join("\n"), changedRanges };
}
