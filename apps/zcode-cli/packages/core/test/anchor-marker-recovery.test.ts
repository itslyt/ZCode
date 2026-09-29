import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnchorFailureMessage,
  formatAnchorRegion,
  resolveAnchorEdits,
} from "../src/tool/anchor-resolve.js";
import { hashLineContent, parseAnchor, parseAnchorToken } from "../src/tool/anchor-hash.js";

/**
 * `>>>` 问题行标记 + 解析器对标记/正文后缀的容错。
 *
 * 背景：错误信息原本只给「该行附近的当前锚点」范围，
 * 模型要在 7 行里自己找哪一行才是它指的那行。两个参考实现
 * （hashline 用 `>>>`、oh-my-pi 用 `*`）收敛到同一做法。
 *
 * 关键约束：**标记是排版，不是语义**——模型会连标记和正文一起抄回来
 * （`>>> 73:ZF8K│## 4. 真机验证`），解析器必须容忍，否则一次无意义的往返。
 */

const CONTENT = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");

// ---------------------------------------------------------------
// 渲染侧：标出问题行
// ---------------------------------------------------------------

test("formatAnchorRegion 用 >>> 标出指定行，并声明标了哪一行", () => {
  const region = formatAnchorRegion(CONTENT, 2, 1, 2);
  const marked = region.text.split("\n").filter((line) => line.startsWith(">>> "));
  assert.equal(marked.length, 1, "恰好标一行");
  assert.ok(marked[0]!.includes("2:"), "标的是第 2 行");
  assert.ok(region.text.includes(">>> marks line 2"), "文本里声明标了哪一行");
});

test("标出的行仍是渲染过的锚点，必须进 served（否则照抄必被拒）", () => {
  const region = formatAnchorRegion(CONTENT, 2, 1, 2);
  const markedHash = hashLineContent("const b = 2;");
  assert.ok(region.servedHashes.includes(markedHash), "带标记的行也算展示过");
});

test("目标行不在上下文窗口内时不标，也不谎称标了", () => {
  const region = formatAnchorRegion(CONTENT, 1, 1, 999);
  assert.equal(region.text.split("\n").filter((l) => l.startsWith(">>> ")).length, 0);
  assert.ok(!region.text.includes("marks line"), "没标就不该声明");
});

// ---------------------------------------------------------------
// 解析侧：容忍标记与正文后缀
// ---------------------------------------------------------------

test("解析器容忍 >>> 标记（模型会连标记一起抄回来）", () => {
  const t = parseAnchorToken(">>> 73:ZF8K");
  assert.deepEqual(t, { kind: "explicit", line: 73, hash: "ZF8K" });
});

test("解析器容忍行内正文后缀（`73:ZF8K│## 4. 真机验证`）", () => {
  const t = parseAnchorToken("73:ZF8K│## 4. 真机验证");
  assert.deepEqual(t, { kind: "explicit", line: 73, hash: "ZF8K" });
});

test("解析器容忍标记 + 正文后缀同时出现", () => {
  const t = parseAnchorToken(">>> 73:ZF8K│## 4. 真机验证");
  assert.deepEqual(t, { kind: "explicit", line: 73, hash: "ZF8K" });
});

test("hash-only 也能带后缀", () => {
  assert.deepEqual(parseAnchorToken("ZF8K│some text"), { kind: "hash-only", hash: "ZF8K" });
});

test("剥装饰不影响裸锚点与异常输入", () => {
  assert.deepEqual(parseAnchorToken("73:ZF8K"), { kind: "explicit", line: 73, hash: "ZF8K" });
  assert.equal(parseAnchorToken("").kind, "malformed");
  assert.equal(parseAnchorToken("not-an-anchor").kind, "malformed");
  // 源码正文仍必须被判非法——容错只针对排版，不是放行垃圾
  assert.equal(parseAnchorToken("return normalizeThemePreference(x);").kind, "malformed");
});

test("parseAnchor（Edit 的粘贴剥离用）同样容忍标记", () => {
  assert.deepEqual(parseAnchor(">>> 22:AB3F"), { line: 22, hash: "AB3F" });
  assert.deepEqual(parseAnchor("22:AB3F│const x = 1;"), { line: 22, hash: "AB3F" });
});

// ---------------------------------------------------------------
// 端到端：照抄带标记的锚点必须能成功
// ---------------------------------------------------------------

test("端到端：模型照抄错误信息里带 >>> 的锚点，重发即成功", () => {
  const served = new Set([hashLineContent("const a = 1;")]);
  // 先用一个没读过的哈希触发 unserved，拿到回传区域
  const first = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: "2:ZZZZ", removeTo: "2:ZZZZ", replacementText: "X" },
  ]);
  assert.equal(first.status, "failed");

  const failure = createAnchorFailureMessage({ content: CONTENT, failure: first, total: 1 });
  const markedLine = failure.text.split("\n").find((line) => line.startsWith(">>> "));
  assert.ok(markedLine, "错误信息里应有 >>> 标记的行");

  // 模型把整行（含标记）抄回来
  const copied = markedLine!.replace(/^>>> /, ">>> ").split("│")[0]!.trim();
  const retry = resolveAnchorEdits(CONTENT, new Set(failure.servedHashes), [
    { removeFrom: copied, removeTo: copied, replacementText: "const b = 99;" },
  ]);
  assert.equal(retry.status, "resolved", `照抄 ${copied} 应成功`);
});
