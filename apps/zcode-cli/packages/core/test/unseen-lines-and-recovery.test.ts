import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAnchorEdits,
} from "../src/tool/anchor-resolve.js";
import {
  buildUpdatedAnchors,
  createAnchorFailureMessage,
} from "../src/tool/anchor-render.js";
import { hashLineContent } from "../src/tool/anchor-hash.js";
import { editAnchoredToolEntry } from "../src/tool/handlers/edit-anchored.js";
import { formatUnseenLinesNotice } from "../src/tool/handlers/read-text.js";

/**
 * 第七轮：三条事前硬约束 + 两种失配的恢复动作 + 未看见行显式化。
 * 见 specs/edit-anchored-verification.md §7.9。
 *
 * 依据（全库实测）：unserved 66 次是最大失败源；范围读占 85%，且
 * 1996 次命中 limit 的读里 1969 次完全不告诉模型「后面还有行」。
 */

const CONTENT = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;"].join(
  "\n",
);

// ---------------------------------------------------------------
// ① 描述里的三条事前硬约束
// ---------------------------------------------------------------

test("EditAnchored 描述点明「未看见的行不可编辑」", () => {
  const d = editAnchoredToolEntry.metadata.description ?? "";
  assert.ok(d.includes("UNSEEN"), "需要 UNSEEN 这个概念");
  assert.ok(/outside that window/i.test(d), "说清窗口外的行");
  assert.ok(/never write an anchor for a line the Read did not print/i.test(d));
});

test("EditAnchored 描述点明「行号是原始行号，不被自己的编辑移位」", () => {
  const d = editAnchoredToolEntry.metadata.description ?? "";
  assert.ok(/original ones from your latest Read/i.test(d));
  assert.ok(/never shifted by your own edits/i.test(d));
});

test("EditAnchored 描述点明「省略标记不是内容」", () => {
  const d = editAnchoredToolEntry.metadata.description ?? "";
  assert.ok(/elision marker/i.test(d));
  assert.ok(/is NOT content/i.test(d));
});

test("EditAnchored 描述把两种拒绝的恢复动作分开", () => {
  const d = editAnchoredToolEntry.metadata.description ?? "";
  assert.ok(d.includes("no longer exists"), "stale 的恢复动作");
  assert.ok(d.includes("was never shown to you"), "unserved 的恢复动作");
  assert.ok(
    /Read the range instead of guessing/i.test(d),
    "unserved 必须导向 Read（不能猜），这是最大失败源的治本动作",
  );
});

// ---------------------------------------------------------------
// ② 两种失配的恢复动作不同
// ---------------------------------------------------------------

const servedAll = new Set([
  "const a = 1;",
  "const b = 2;",
  "const c = 3;",
  "const d = 4;",
  "const e = 5;",
].map(hashLineContent));

test("stale：告知「展示过但已变」，导向拿新锚点重发（不必重读）", () => {
  // 真正的 stale：该哈希**展示过**（在 served 里），但文件里已找不到它
  // （内容被改掉了）→ 候选 0 个。
  const revised = ["const a = 1;", "CHANGED LINE", "const c = 3;", "const d = 4;", "const e = 5;"].join(
    "\n",
  );
  const goneHash = hashLineContent("const b = 2;");
  const stale = resolveAnchorEdits(revised, new Set([goneHash]), [
    { removeFrom: `2:${goneHash}`, removeTo: `2:${goneHash}`, replacementText: "X" },
  ]);
  assert.equal(stale.status, "failed");
  assert.equal((stale as { reason: string }).reason, "stale", "展示过但已不存在 → stale");

  const msg = createAnchorFailureMessage({ content: revised, failure: stale, total: 1 });
  assert.ok(/was shown to you, but its content has since changed/i.test(msg.text), "说明「展示过但变了」");
  assert.ok(/no need to re-read/i.test(msg.text), "stale 不必重读");
  assert.ok(/Current anchors/.test(msg.text), "仍然回传当前锚点，模型可直接抄");
});

test("unserved 且无从指路时，明说「再猜也会同样失败」", () => {
  // 裸哈希、零候选 → hintLine = 0
  const r = resolveAnchorEdits(CONTENT, servedAll, [
    { removeFrom: "ZZZZ", removeTo: "ZZZZ", replacementText: "X" },
  ]);
  assert.equal(r.status, "failed");
  const msg = createAnchorFailureMessage({ content: CONTENT, failure: r, total: 1 });
  assert.ok(/never shown to you/i.test(msg.text));
  assert.ok(
    /guessing another anchor will fail the same way/i.test(msg.text),
    "必须打断「继续猜」这条路——那是自拼哈希的温床",
  );
  assert.ok(/Read the range/i.test(msg.text), "导向 Read");
});

// ---------------------------------------------------------------
// ③ 未看见的行显式化
// ---------------------------------------------------------------

test("buildUpdatedAnchors 的窗口间隔是显式标记，不是裸 ...", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `const l${i} = ${i};`);
  const content = lines.join("\n");
  // 两处相隔很远的改动 → 两个窗口
  const rendered = buildUpdatedAnchors(content, [
    { start: 1, end: 1 },
    { start: 35, end: 35 },
  ], 1);
  assert.ok(!/\n\.\.\.\n/.test(rendered.text), "不能是裸 ...");
  assert.ok(/omitted/.test(rendered.text), "要说清省略了什么");
  assert.ok(/\((\d+) lines not shown/.test(rendered.text), "要给出省了多少行");
  assert.ok(/do not edit there/i.test(rendered.text), "要禁止在省略区编辑");
});

test("相邻窗口不产生省略标记", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `const l${i} = ${i};`);
  const rendered = buildUpdatedAnchors(lines.join("\n"), [
    { start: 8, end: 8 },
    { start: 10, end: 10 },
  ], 3);
  assert.ok(!/omitted/.test(rendered.text), "窗口相接时中间没有看不见的行");
});

test("Read 的未看见声明：给出上下方行数与继续读的 offset", () => {
  const notice = formatUnseenLinesNotice(
    { content: "", lineCount: 21, startLine: 40, totalLines: 900 } as never,
    40,
  );
  assert.ok(notice, "900 行只读 40-60 时必须声明");
  assert.ok(/lines 40-60 of 900/.test(notice!), "要给出范围与总数");
  assert.ok(/39 above/.test(notice!), "上方的未看见行数");
  assert.ok(/840 below/.test(notice!), "下方的未看见行数");
  assert.ok(/UNSEEN/.test(notice!));
  assert.ok(/offset 61/.test(notice!), "给出继续读的起点");
});

test("读到文件尾、或从头读整份时不给声明", () => {
  // 读到底
  assert.equal(
    formatUnseenLinesNotice({ content: "", lineCount: 900, startLine: 1, totalLines: 900 } as never, 1),
    undefined,
  );
  // 文件比窗口短
  assert.equal(
    formatUnseenLinesNotice({ content: "", lineCount: 10, startLine: 1, totalLines: 10 } as never, 1),
    undefined,
  );
});
