import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAnchorEdits,
} from "../src/tool/anchor-resolve.js";
import {
  createAnchorFailureMessage,
} from "../src/tool/anchor-render.js";
import { hashLineContent } from "../src/tool/anchor-hash.js";
import { editAnchoredToolEntry } from "../src/tool/handlers/edit-anchored.js";

/**
 * 第八轮：自愈必须说出来 + 点明「行号与哈希来自不同版本」。
 * 见 specs/edit-anchored-verification.md §7.10。
 *
 * 依据：sess_8a4f7e90 里模型把两次 ambiguous 失败误判成「4 位哈希空间小、容易碰撞」，
 * 而原始数据显示那 6 处/5 处命中全部是同一个字符串 `continue`——是哈希正确工作。
 * 真实原因是它把上一版的哈希配到了这一版的行号上。
 */

/** 含大量重复行的文件（模拟真实源码里的 `continue`）。 */
const DUP_LINES = [
  "def f():",
  "    continue",
  "x = 1",
  "    continue",
  "y = 2",
  "    continue",
  "z = 3",
];
const DUP_CONTENT = DUP_LINES.join("\n");
const DUP_HASH = hashLineContent("    continue");
const servedAll = new Set(DUP_LINES.map(hashLineContent));

// ---------------------------------------------------------------
// 验收 1：重复行的哈希相同是正常行为，行号+哈希都对必须成功
// ---------------------------------------------------------------

test("哈希相同且出现多处时，行号+哈希都对应成功（不报错）", () => {
  // 这是模型自述里误判的那一点：它以为「哈希相同多处」必然失败。
  for (const line of [2, 4, 6]) {
    const result = resolveAnchorEdits(DUP_CONTENT, servedAll, [
      { removeFrom: `${line}:${DUP_HASH}`, removeTo: `${line}:${DUP_HASH}`, replacementText: "    pass" },
    ]);
    assert.equal(result.status, "resolved", `行 ${line} 的行号+哈希都对，必须成功`);
    if (result.status !== "resolved") return;
    assert.equal(result.edits[0]!.start + 1, line, "必须落在模型指定的那一行");
    assert.equal(result.edits[0]!.shifted, false, "行号命中时不算位移");
  }
});

test("重复行共用一个哈希（不是碰撞）：3 处命中只有 1 种内容", () => {
  const contents = new Set(DUP_LINES.filter((line) => hashLineContent(line) === DUP_HASH));
  assert.equal(contents.size, 1, "同一字符串当然算出同一哈希——哈希在正确工作");
});

// ---------------------------------------------------------------
// 验收 2/3：自愈必须说出来
// ---------------------------------------------------------------

const MOVED_CONTENT = ["aaa;", "bbb;", "ccc;", "ddd;"].join("\n");
const MOVED_HASH = hashLineContent("ddd;");

test("自愈发生时，结果携带 requestedLine 与 shifted（供上层说出位移）", () => {
  const result = resolveAnchorEdits(MOVED_CONTENT, new Set([MOVED_HASH]), [
    { removeFrom: `2:${MOVED_HASH}`, removeTo: `2:${MOVED_HASH}`, replacementText: "DDD;" },
  ]);
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  const edit = result.edits[0]!;
  assert.equal(edit.shifted, true, "哈希唯一命中在别处 → 自愈");
  assert.equal(edit.requestedLine, 2, "记下模型声称的行号");
  assert.equal(edit.start + 1, 4, "实际落在第 4 行");
});

test("行号命中时不标记位移（不留噪音）", () => {
  const result = resolveAnchorEdits(MOVED_CONTENT, new Set([MOVED_HASH]), [
    { removeFrom: `4:${MOVED_HASH}`, removeTo: `4:${MOVED_HASH}`, replacementText: "DDD;" },
  ]);
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.equal(result.edits[0]!.shifted, false);
});

// ---------------------------------------------------------------
// 验收 4/5：ambiguous 点明行号错配（点 A）
// ---------------------------------------------------------------

test("ambiguous 且行号存在但哈希对不上时，点明「该行现在是别的哈希」", () => {
  const result = resolveAnchorEdits(DUP_CONTENT, servedAll, [
    { removeFrom: `5:${DUP_HASH}`, removeTo: `5:${DUP_HASH}`, replacementText: "    pass" },
  ]);
  assert.equal(result.status, "failed");
  assert.equal((result as { reason: string }).reason, "ambiguous");

  const msg = createAnchorFailureMessage({ content: DUP_CONTENT, failure: result, total: 1 });
  const actualHash = hashLineContent("y = 2");
  assert.ok(
    msg.text.includes(`line 5 currently carries a different hash (\`${actualHash}\`)`),
    "要点明该行真实的哈希，模型才知道是行号过期而非哈希冲突",
  );
  assert.ok(/from different versions of the file/.test(msg.text), "明说两半来自不同版本");
});

test("ambiguous 且行号越界时不给该提示（信息不足不猜）", () => {
  const result = resolveAnchorEdits(DUP_CONTENT, servedAll, [
    { removeFrom: `999:${DUP_HASH}`, removeTo: `999:${DUP_HASH}`, replacementText: "    pass" },
  ]);
  assert.equal(result.status, "failed");
  const msg = createAnchorFailureMessage({ content: DUP_CONTENT, failure: result, total: 1 });
  assert.ok(!/currently carries a different hash/.test(msg.text), "越界时无从判断，不该输出");
});

// ---------------------------------------------------------------
// 验收 6：stale 点明「自行拼接」这一成因（点 B）
// ---------------------------------------------------------------

test("stale 点明「自己拼接两半」这个成因", () => {
  const revised = ["aaa;", "CHANGED", "ccc;", "ddd;"].join("\n");
  const goneHash = hashLineContent("bbb;");
  const result = resolveAnchorEdits(revised, new Set([goneHash]), [
    { removeFrom: `2:${goneHash}`, removeTo: `2:${goneHash}`, replacementText: "X;" },
  ]);
  assert.equal(result.status, "failed");
  assert.equal((result as { reason: string }).reason, "stale");

  const msg = createAnchorFailureMessage({ content: revised, failure: result, total: 1 });
  assert.ok(/assembled this pair yourself/i.test(msg.text), "直指「自己拼的」这一成因");
  assert.ok(/different versions/.test(msg.text));
  assert.ok(/Copy the whole `N:HASH` pair from a single Read/i.test(msg.text), "给出正确做法");
});

// ---------------------------------------------------------------
// 验收 7：描述里的两条事前约束（点 1）
// ---------------------------------------------------------------

test("描述禁止凭记忆拼接锚点", () => {
  const d = editAnchoredToolEntry.metadata.description ?? "";
  assert.ok(/Never splice an anchor together from memory/i.test(d));
  assert.ok(/line number from one Read, a hash from another/i.test(d));
  assert.ok(/before an edit plus a hash from after it/i.test(d));
});

test("描述讲清「重复行共用一个哈希是正常的，行号才是选行依据」", () => {
  const d = editAnchoredToolEntry.metadata.description ?? "";
  assert.ok(/share one hash/i.test(d));
  assert.ok(/the hash working, not a collision/i.test(d), "必须打断「以为哈希太短」的误判");
  assert.ok(/the line number is what picks the line/i.test(d));
});
