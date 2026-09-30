// ============================================================
// Anchor Render — 把锚点渲染给模型：区域、编辑结果、失败信息
// ============================================================
//
// 与 anchor-resolve.ts 的分工：那边**只做判定**（这一行能不能改、落在哪），
// 这边**只做呈现**（回传给模型的文本 + 这次展示了哪些行哈希）。
//
// 两者共享一条不变量：凡是在文本里出现过的锚点，其哈希都必须出现在返回的
// `servedHashes` 里——否则模型照抄它会被判 unserved，reject-and-serve 变死循环。

import {
  anchorHashOf,
  formatAnchorPrefix,
  hashLineContent,
  parseAnchorToken,
  splitLines,
} from "./anchor-hash.js";
import type { AnchorResolveFailure } from "./anchor-resolve.js";

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

/**
 * `ambiguous` 时把候选行**逐条列出**，而不是只给一个 matchCount。
 *
 * 依据（全库实测）：21 次 ambiguous 的回传区**全部只覆盖部分候选**——
 * 回传区以 hintLine 为中心取 ±3 行，模型看到「命中 6 行」却只看到其中 1 行的
 * 周围内容，只能回去重读。而命中数分布显示绝大多数 ≤ 10 行（2 行 19 次、
 * 6 行 10 次），逐条列出完全可行。
 *
 * 超过 `MAX_LISTED_CANDIDATES` 时退回现状（只给计数）：那种情况下列出上百行
 * 会淹掉上下文，收益为负。被列出的行都算「展示过」，可直接被引用。
 */
const MAX_LISTED_CANDIDATES = 12;

function formatCandidateLines(
  content: string,
  failure: AnchorResolveFailure,
): { text: string[]; servedHashes: string[] } {
  const lines = failure.candidateLines ?? [];
  if (lines.length === 0 || lines.length > MAX_LISTED_CANDIDATES) {
    return { text: [], servedHashes: [] };
  }
  const contentLines = splitLines(content);
  const servedHashes: string[] = [];
  const rows = lines.map((line) => {
    const text = contentLines[line - 1] ?? "";
    const hash = hashLineContent(text);
    servedHashes.push(hash);
    return `  ${line}:${hash}│${text}`;
  });
  return {
    text: [`All ${lines.length} matching lines:`, ...rows],
    servedHashes,
  };
}

/**
 * `unserved` 时区分两种成因：凭空编的，还是从**别的文件**抄来的。
 *
 * 依据 sess_ade8a566：3 次 unserved 全是后者——把 A 文件里看到的 `13:C27G`
 * 用到 B 文件上，而 `C27G` 是 `import {` 这种高频行。笼统的「从未展示过」会让
 * 模型以为自己是编的（于是重读，方向对但慢）；明说「这是别的文件的锚点」
 * 它立刻知道该换来源。见 §7.11。
 */
function formatCrossFileHint(
  failure: AnchorResolveFailure,
  hashServedInOtherFile: boolean | undefined,
): string[] {
  if (!hashServedInOtherFile) return [];
  return [
    `Note: the hash \`${anchorHashOf(failure.anchor)}\` was shown to you in a DIFFERENT file. Anchors are per-file — a hash that is valid elsewhere is not valid here.`,
  ];
}

export function createAnchorFailureMessage(input: {
  content: string;
  failure: AnchorResolveFailure;
  total: number;
  /**
   * 该锚点的哈希是不是「只在别的文件里展示过」。
   * 由调用方（handler）用完整的 readFileState 判定；工具层拿不到跨文件信息。
   */
  hashServedInOtherFile?: boolean;
}): RenderedAnchors {
  const { failure, total, content, hashServedInOtherFile } = input;
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
          ...formatCrossFileHint(failure, hashServedInOtherFile),
          "The hash was never printed for this file, and no line currently carries it — guessing another anchor will fail the same way. Read the range you want to edit, then copy an anchor from that Read result.",
          "No edits were applied.",
        ]);
      }
      const region = formatAnchorRegion(content, hintLine);
      return {
        text: [
          `${position} references anchor ${failure.anchor}, which was never shown to you for this file.`,
          ...formatCrossFileHint(failure, hashServedInOtherFile),
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
      const candidates = formatCandidateLines(content, failure);
      return {
        text: [
          `${position} anchor ${failure.anchor} matches ${failure.matchCount} lines in the current file,`,
          "so it cannot be resolved to one place. Pick the line you meant from the anchors below and resend.",
          ...formatLineNumberMismatchHint(content, failure),
          ...candidates.text,
          "No edits were applied.",
          region.text,
        ].join("\n"),
        servedHashes: [...region.servedHashes, ...candidates.servedHashes],
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
