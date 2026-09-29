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
  formatAnchorPrefix,
  hashLineContent,
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

const REGION_CONTEXT_LINES = 3;

/** 渲染结果：文本 + 这次实际展示给模型的行哈希。只有后者算「模型看过了」。 */
export interface RenderedAnchors {
  text: string;
  servedHashes: string[];
}

/**
 * 内容被清空时不能再渲染任何锚点。
 *
 * 坑：`splitLines("")` 返回 `[""]`（一个空行）而不是空数组，所以
 * `lines.length === 0` 这种判据在空内容上不成立，会凭空渲染出「第 1 行」。
 * 后果不是显示问题：那个假行的哈希就是 `hashLineContent("")`，并进 served 之后
 * 文件里任意空行都变成「已读」。
 */
function isEmptyContent(content: string): boolean {
  return content === "";
}

/**
 * 渲染一段带锚点的区域，供拒绝信息与编辑结果使用。
 * 这是 reject-and-serve：模型拿到它就能继续，不必重新读整个文件。
 *
 * 返回的 `servedHashes` 必须被调用方并进 served 集合——否则模型照抄这里给出的锚点
 * 会被判 unserved，reject-and-serve 就成了死循环。
 */
export function formatAnchorRegion(
  content: string,
  centerLine: number,
  contextLines = REGION_CONTEXT_LINES,
  /** 要标 `>>>` 的行（hintLine 通常就是它）。只影响可读性，不改变 served。 */
  markedLine = centerLine,
): RenderedAnchors {
  if (isEmptyContent(content)) return { text: "(file is empty)", servedHashes: [] };
  const lines = splitLines(content);

  const from = Math.max(1, centerLine - contextLines);
  const to = Math.min(lines.length, centerLine + contextLines);
  const rendered = renderAnchorLines(lines, from, to, markedLine);
  const marksLine = markedLine >= from && markedLine <= to;

  return {
    text: `Current anchors (lines ${from}-${to})${marksLine ? `, >>> marks line ${markedLine}` : ""}:\n${rendered.text}`,
    servedHashes: rendered.servedHashes,
  };
}

function renderAnchorLines(
  lines: readonly string[],
  from: number,
  to: number,
  markedLine?: number,
): RenderedAnchors {
  const servedHashes: string[] = [];
  const text = lines
    .slice(from - 1, to)
    .map((line, offset) => {
      const lineNumber = from + offset;
      const hash = hashLineContent(line);
      servedHashes.push(hash);
      // `>>>` 标出「你指的那一行」：只给范围不够，模型要在 7 行里自己找。
      // 两个参考实现（hashline 用 >>>、oh-my-pi 用 *）收敛到同一做法。
      const marker = lineNumber === markedLine ? ">>> " : "";
      return `${marker}${formatAnchorPrefix(lineNumber, hash)}${line}`;
    })
    .join("\n");

  return { text, servedHashes };
}

/**
 * 编辑成功后回传受影响区域的新锚点，省掉一次重新读取。
 *
 * `changedRanges` 必须是**新内容**里的行区间（见 `applyAnchorEdits` 的返回值）。
 * 传原始内容的索引会在靠前的编辑改变行数后指向别处。
 */
export function buildUpdatedAnchors(
  content: string,
  changedRanges: readonly { start: number; end: number }[],
  contextLines = REGION_CONTEXT_LINES,
): RenderedAnchors {
  if (isEmptyContent(content)) return { text: "", servedHashes: [] };
  const lines = splitLines(content);

  const windows = changedRanges
    .map((range) => ({
      from: Math.max(1, range.start + 1 - contextLines),
      to: Math.min(lines.length, range.end + 1 + contextLines),
    }))
    .sort((left, right) => left.from - right.from);

  // 合并重叠或相接的窗口。只判断「起点是否被覆盖」会把后一个区块整个 continue 掉：
  // 它的起点落在前一个窗口内、尾部却超出前一个窗口，于是它要服务的行从未回传。
  const merged: { from: number; to: number }[] = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window.from <= last.to + 1) {
      last.to = Math.max(last.to, window.to);
      continue;
    }
    merged.push({ ...window });
  }

  const blocks = merged.map((window) => ({
    window,
    rendered: renderAnchorLines(lines, window.from, window.to),
  }));
  // 窗口之间的间隔必须显式标出并写明行号范围：裸 `...` 会被模型当成文件里的省略号，
  // 甚至按它推「中间大概还有几行」。这里直接说清「哪些行没显示、不能编辑」。
  const parts: string[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (index > 0) {
      const previous = blocks[index - 1]!.window;
      const missing = block.window.from - previous.to - 1;
      parts.push(
        missing > 0
          ? `... lines ${previous.to + 1}-${block.window.from - 1} omitted (${missing} lines not shown — do not edit there) ...`
          : "...",
      );
    }
    parts.push(block.rendered.text);
  }

  return {
    text: parts.join("\n"),
    servedHashes: blocks.flatMap((block) => block.rendered.servedHashes),
  };
}

/**
 * 当模型给的行号上其实不是它给的哈希时，把这件事**明说出来**。
 *
 * 依据：sess_8a4f7e90 里模型把两次失败归因成「4 位哈希空间小、短行天然碰撞」，
 * 而真实原因是「行号来自编辑前、哈希来自编辑后」。不点明的话它会朝错方向修
 * （去调哈希位宽，而那是无效且有害的）。见 §7.10。
 *
 * 只在该行号确实存在于本次内容里、且哈希对不上时给出；否则不猜。
 */
function formatLineNumberMismatchHint(
  content: string,
  failure: AnchorResolveFailure,
): string[] {
  const token = parseAnchorToken(failure.anchor);
  if (token.kind !== "explicit") return [];
  const lines = splitLines(content);
  const index = token.line - 1;
  if (index < 0 || index >= lines.length) return [];
  const actual = hashLineContent(lines[index]!);
  if (actual === token.hash) return [];
  return [
    `Note: line ${token.line} currently carries a different hash (\`${actual}\`), not \`${token.hash}\` — your line number and hash are from different versions of the file.`,
  ];
}

export function createAnchorFailureMessage(input: {
  content: string;
  failure: AnchorResolveFailure;
  total: number;
}): RenderedAnchors {
  const { failure, total, content } = input;
  const position = `Edit ${failure.editIndex + 1} of ${total}`;
  const hintLine = Math.min(Math.max(failure.hintLine, 1), splitLines(content).length || 1);

  switch (failure.reason) {
    case "malformed_anchor":
      return plain([
        `${position} has a malformed anchor: ${JSON.stringify(failure.anchor)}.`,
        "Anchors look like `22:AB3F` (line number, colon, 4-character hash). Copy them verbatim from a Read result.",
        "No edits were applied.",
      ]);

    case "unserved": {
      // 拒绝回传区域，模型这一步就能改对，不必先 Read 再重发。
      // 没有行号可用时（裸哈希零命中）无从指路，不猜区域；但必须说清
      // 「你的行号/哈希都不在已展示的范围内」，否则模型只会继续猜。
      if (failure.hintLine < 1) {
        return plain([
          `${position} references anchor ${failure.anchor}, which was never shown to you for this file.`,
          "The hash was never printed for this file, and no line currently carries it — guessing another anchor will fail the same way. Read the range you want to edit, then copy an anchor from that Read result.",
          "No edits were applied.",
        ]);
      }
      const region = formatAnchorRegion(content, hintLine);
      return {
        text: [
          `${position} references anchor ${failure.anchor}, which was never shown to you for this file.`,
          "The current anchors around that line are below — copy one verbatim and resend.",
          "No edits were applied.",
          region.text,
        ].join("\n"),
        servedHashes: region.servedHashes,
      };
    }

    case "ambiguous": {
      // 同样要 serve：只叫模型“再读一次”等于把 reject-and-serve 省下的往返又还回去。
      const region = formatAnchorRegion(content, hintLine);
      return {
        text: [
          `${position} anchor ${failure.anchor} matches ${failure.matchCount} lines in the current file,`,
          "so it cannot be resolved to one place. Pick the line you meant from the anchors below and resend.",
          ...formatLineNumberMismatchHint(content, failure),
          "No edits were applied.",
          region.text,
        ].join("\n"),
        servedHashes: region.servedHashes,
      };
    }

    case "reversed_range":
      return plain([
        `${position} has remove_from after remove_to.`,
        "remove_from must be the anchor of the first line and remove_to the anchor of the last line.",
        "No edits were applied.",
      ]);

    case "stale": {
      // 与 unserved 分开：这里哈希**展示过**，只是内容被改。模型拿新锚点重发即可，不必重读。
      const region = formatAnchorRegion(content, hintLine);
      return {
        text: [
          `${position} anchor ${failure.anchor} no longer exists in the file — the line was shown to you, but its content has since changed (an edit or an external change).`,
          // 点明最常见的成因：行号与哈希来自不同版本。见 §7.10（模型曾把它误判成「哈希空间小」）。
          "If you assembled this pair yourself — a line number from one Read and a hash from another, or a line number from before your own edit — the two halves come from different versions. Copy the whole `N:HASH` pair from a single Read result.",
          "No edits were applied. Resend with an updated anchor from the region below — no need to re-read the whole file.",
          region.text,
        ].join("\n"),
        servedHashes: region.servedHashes,
      };
    }
  }
}

function plain(lines: readonly string[]): RenderedAnchors {
  return { text: lines.join("\n"), servedHashes: [] };
}
