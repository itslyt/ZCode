import assert from "node:assert/strict";
import test from "node:test";
import {
  computeLineHashes,
  formatAnchor,
  hashLineContent,
  normalizeAnchorHash,
  parseAnchor,
  splitLines,
} from "../src/tool/anchor-hash.js";
import {
  applyAnchorEdits,
  buildUpdatedAnchors,
  createAnchorFailureMessage,
  findOverlappingAnchorEdits,
  formatAnchorRegion,
  resolveAnchorEdits,
} from "../src/tool/anchor-resolve.js";
import { mergeServedAnchors } from "../src/tool/anchor-served.js";

/** 取第 line 行（1 起始）的锚点字符串。 */
function anchorAt(content: string, line: number): string {
  const lines = splitLines(content);
  return formatAnchor(line, hashLineContent(lines[line - 1]!));
}

/** 把一次「展示给模型」的渲染结果并进 served——与 handler 的写入逻辑一致。 */
function withServed(served: ReadonlySet<string>, rendered: readonly string[]): Set<string> {
  return new Set(mergeServedAnchors([...served], rendered));
}

/** 模拟一次成功的锚点编辑，返回新内容、回传的锚点文本与更新后的 served。 */
function editOnce(
  content: string,
  served: ReadonlySet<string>,
  requests: { removeFrom: string; removeTo: string; replacementText: string }[],
): { content: string; updatedText: string; served: Set<string>; changedRanges: { start: number; end: number }[] } {
  const resolved = resolveAnchorEdits(content, served, requests);
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") throw new Error("unreachable");

  const applied = applyAnchorEdits(content, resolved.edits);
  const updated = buildUpdatedAnchors(applied.content, applied.changedRanges);
  return {
    content: applied.content,
    updatedText: updated.text,
    served: withServed(served, updated.servedHashes),
    changedRanges: applied.changedRanges,
  };
}

const CONTENT = [
  "function greet(name) {",
  '  const msg = "hi " + name;',
  "  return msg;",
  "}",
  "",
  "function bye(name) {",
  '  return "bye " + name;',
  "}",
].join("\n");

const servedAll = (content: string) => new Set(computeLineHashes(splitLines(content)));

test("哈希是定长的，且同内容同哈希", () => {
  const hash = hashLineContent("const a = 1;");
  assert.equal(hash.length, 4);
  assert.equal(hash, hashLineContent("const a = 1;"));
  assert.notEqual(hash, hashLineContent("const a = 2;"));
});

test("空行也有哈希，且与普通内容不混淆", () => {
  const hash = hashLineContent("");
  assert.equal(hash.length, 4);
  assert.notEqual(hash, hashLineContent(" "));
});

test("哈希归一化容忍大小写与易混字符", () => {
  assert.equal(normalizeAnchorHash("ab3f"), "AB3F");
  assert.equal(normalizeAnchorHash(" AB3F "), "AB3F");
  assert.equal(normalizeAnchorHash("ABIF"), normalizeAnchorHash("AB1F"));
  assert.equal(normalizeAnchorHash("ABOF"), normalizeAnchorHash("AB0F"));
  assert.equal(normalizeAnchorHash("AB3"), null);
  assert.equal(normalizeAnchorHash("AB3F5"), null);
});

test("parseAnchor 解析行号与哈希，非法输入返回 null", () => {
  assert.deepEqual(parseAnchor("22:AB3F"), { line: 22, hash: "AB3F" });
  assert.deepEqual(parseAnchor("1:ab3f"), { line: 1, hash: "AB3F" });
  assert.equal(parseAnchor("AB3F"), null);
  assert.equal(parseAnchor(":AB3F"), null);
  assert.equal(parseAnchor("0:AB3F"), null);
  assert.equal(parseAnchor("22:"), null);
});

test("快路径：行号未位移时直接命中", () => {
  const served = servedAll(CONTENT);
  const result = editOnce(CONTENT, served, [
    {
      removeFrom: anchorAt(CONTENT, 2),
      removeTo: anchorAt(CONTENT, 2),
      replacementText: '  const msg = `hi ${name}`;',
    },
  ]);

  assert.deepEqual(result.changedRanges, [{ start: 1, end: 1 }]);
  assert.equal(
    result.content,
    [
      "function greet(name) {",
      "  const msg = `hi ${name}`;",
      "  return msg;",
      "}",
      "",
      "function bye(name) {",
      '  return "bye " + name;',
      "}",
    ].join("\n"),
  );
});

test("自愈合：上方插入行后，旧行号对不上但哈希仍能唯一定位", () => {
  const served = servedAll(CONTENT);
  const staleFrom = anchorAt(CONTENT, 7);
  const shifted = ["// 新注释 1", "// 新注释 2", "// 新注释 3", CONTENT].join("\n");

  const resolved = resolveAnchorEdits(shifted, served, [
    { removeFrom: staleFrom, removeTo: staleFrom, replacementText: '  return "goodbye " + name;' },
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.equal(resolved.edits[0]!.start, 9);
  assert.equal(resolved.edits[0]!.shifted, true);
});

test("自愈合遇到多处命中时拒绝，绝不错行", () => {
  const content = ["  return 1;", "  return 1;", "  return 1;"].join("\n");
  const served = servedAll(content);

  const resolved = resolveAnchorEdits(content, served, [
    {
      removeFrom: `99:${hashLineContent("  return 1;")}`,
      removeTo: `99:${hashLineContent("  return 1;")}`,
      replacementText: "  return 2;",
    },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") {
    assert.equal(resolved.reason, "ambiguous");
    assert.equal(resolved.matchCount, 3);
  }
});

test("内容已变化时拒绝，并回传该区域当前锚点", () => {
  const served = servedAll(CONTENT);
  const staleFrom = anchorAt(CONTENT, 3);
  const changed = CONTENT.replace("  return msg;", "  return msg.trim();");

  const resolved = resolveAnchorEdits(changed, served, [
    { removeFrom: staleFrom, removeTo: staleFrom, replacementText: "  return msg;" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status !== "failed") return;
  assert.equal(resolved.reason, "stale");

  const failure = createAnchorFailureMessage({ content: changed, failure: resolved, total: 1 });
  assert.match(failure.text, /no longer exists/);
  assert.match(failure.text, /No edits were applied/);
  assert.match(failure.text, /Current anchors/);
  assert.match(failure.text, /return msg\.trim\(\);/);
});

test("未展示过的锚点被拒绝", () => {
  const resolved = resolveAnchorEdits(CONTENT, new Set(), [
    { removeFrom: anchorAt(CONTENT, 1), removeTo: anchorAt(CONTENT, 1), replacementText: "x" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") assert.equal(resolved.reason, "unserved");
});

test("锚点格式错误与区间反向都给出可修正的提示", () => {
  const served = servedAll(CONTENT);

  const malformed = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: "not-an-anchor", removeTo: "1:AB3F", replacementText: "x" },
  ]);
  assert.equal(malformed.status, "failed");
  if (malformed.status === "failed") assert.equal(malformed.reason, "malformed_anchor");

  const reversed = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 5), removeTo: anchorAt(CONTENT, 2), replacementText: "x" },
  ]);
  assert.equal(reversed.status, "failed");
  if (reversed.status === "failed") assert.equal(reversed.reason, "reversed_range");
});

test("空 replacement 删除行，多行 replacement 插入行", () => {
  const served = servedAll(CONTENT);

  const deleted = editOnce(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 5), removeTo: anchorAt(CONTENT, 5), replacementText: "" },
  ]);
  assert.equal(splitLines(deleted.content).length, splitLines(CONTENT).length - 1);
  assert.ok(!deleted.content.includes("\n\n\n"));

  const inserted = editOnce(CONTENT, served, [
    {
      removeFrom: anchorAt(CONTENT, 4),
      removeTo: anchorAt(CONTENT, 4),
      replacementText: "}\n\nexport const VERSION = 1;",
    },
  ]);
  assert.match(inserted.content, /VERSION = 1;/);
});

test("批量锚点编辑按倒序应用，前一条不移动后一条", () => {
  const served = servedAll(CONTENT);
  const result = editOnce(CONTENT, served, [
    {
      removeFrom: anchorAt(CONTENT, 1),
      removeTo: anchorAt(CONTENT, 1),
      replacementText: "function greet(name) {\n  // 头部注释",
    },
    {
      removeFrom: anchorAt(CONTENT, 7),
      removeTo: anchorAt(CONTENT, 7),
      replacementText: '  return "bye!";',
    },
  ]);

  assert.match(result.content, /\/\/ 头部注释/);
  assert.match(result.content, /return "bye!";/);
});

test("重叠区间被显式拒绝", () => {
  const served = servedAll(CONTENT);
  const resolved = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 1), removeTo: anchorAt(CONTENT, 3), replacementText: "a" },
    { removeFrom: anchorAt(CONTENT, 2), removeTo: anchorAt(CONTENT, 4), replacementText: "b" },
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.deepEqual(findOverlappingAnchorEdits(resolved.edits), [0, 1]);
});

test("相邻但不重叠的锚点区间不算冲突", () => {
  const served = servedAll(CONTENT);
  const resolved = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 1), removeTo: anchorAt(CONTENT, 1), replacementText: "a" },
    { removeFrom: anchorAt(CONTENT, 2), removeTo: anchorAt(CONTENT, 2), replacementText: "b" },
  ]);
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.equal(findOverlappingAnchorEdits(resolved.edits), null);
});

// ============================================================
// served 语义
// ============================================================
//
// 下面这组是回归防线。此前测试的辅助函数把「served = 全文」当成了前提，于是整组测试
// 对「served 被灌全文」这个缺陷结构上就是盲的。

test("§1 一次编辑之后，从未展示过的行仍然被拒绝", () => {
  const lines = Array.from({ length: 120 }, (_, index) => `const item${index + 1} = ${index + 1};`);
  const content = lines.join("\n");

  // Read 只展示了前 5 行
  let served = new Set(computeLineHashes(lines.slice(0, 5)));
  assert.equal(
    resolveAnchorEdits(content, served, [
      {
        removeFrom: anchorAt(content, 100),
        removeTo: anchorAt(content, 100),
        replacementText: "const item100 = 999;",
      },
    ]).status,
    "failed",
  );

  // 编辑第 3 行
  const afterEdit = editOnce(content, served, [
    {
      removeFrom: anchorAt(content, 3),
      removeTo: anchorAt(content, 3),
      replacementText: "const item3 = 333;",
    },
  ]);
  served = afterEdit.served;

  // served 只应增加回传区域那几行，绝不能变成整个文件
  assert.ok(served.size < 20, `served 不应被灌入全文，实际 ${served.size} 个哈希`);

  // 第 100 行依旧没展示过 → 必须继续被拒
  const far = resolveAnchorEdits(afterEdit.content, served, [
    {
      removeFrom: anchorAt(afterEdit.content, 100),
      removeTo: anchorAt(afterEdit.content, 100),
      replacementText: "const item100 = 999;",
    },
  ]);
  assert.equal(far.status, "failed");
  if (far.status === "failed") assert.equal(far.reason, "unserved");
});

test("§1 回传区域内的新锚点立即可用，不必重读", () => {
  const content = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
  const result = editOnce(content, servedAll(content), [
    { removeFrom: anchorAt(content, 1), removeTo: anchorAt(content, 1), replacementText: "const a = 10;" },
  ]);

  const served = result.served;
  const reedit = resolveAnchorEdits(result.content, served, [
    {
      removeFrom: anchorAt(result.content, 1),
      removeTo: anchorAt(result.content, 1),
      replacementText: "const a = 100;",
    },
  ]);
  assert.equal(reedit.status, "resolved");
});

test("§2 stale 拒绝回传的锚点可以直接拿来重发", () => {
  const original = ["const keep = 1;", "const change = 2;", "const tail = 3;"].join("\n");
  const changed = original.replace("const change = 2;", "const change = 999;");
  const servedBefore = servedAll(original);

  const stale = resolveAnchorEdits(changed, servedBefore, [
    {
      removeFrom: anchorAt(original, 2),
      removeTo: anchorAt(original, 2),
      replacementText: "const change = 2;",
    },
  ]);
  assert.equal(stale.status, "failed");
  if (stale.status !== "failed") return;

  const failure = createAnchorFailureMessage({ content: changed, failure: stale, total: 1 });
  // 拒绝路径必须把渲染过的行回报出来，否则这些锚点不算「看过」
  assert.ok(failure.servedHashes.length > 0);

  const offered = failure.text.match(/2:([0-9A-Z]{4})│/)?.[1];
  assert.ok(offered, "错误信息里应当带上第 2 行的当前锚点");

  const servedAfter = withServed(servedBefore, failure.servedHashes);
  const retry = resolveAnchorEdits(changed, servedAfter, [
    { removeFrom: `2:${offered}`, removeTo: `2:${offered}`, replacementText: "const change = 2;" },
  ]);
  assert.equal(retry.status, "resolved");
  if (retry.status === "resolved") {
    assert.equal(applyAnchorEdits(changed, retry.edits).content, original);
  }
});

test("§2 ambiguous 拒绝回传的锚点也可以直接重发", () => {
  const content = ["  return 1;", "  return 1;", "  return 1;"].join("\n");
  const served = servedAll(content);
  const hash = hashLineContent("  return 1;");

  const ambiguous = resolveAnchorEdits(content, served, [
    { removeFrom: `99:${hash}`, removeTo: `99:${hash}`, replacementText: "  return 2;" },
  ]);
  assert.equal(ambiguous.status, "failed");
  if (ambiguous.status !== "failed") return;

  const failure = createAnchorFailureMessage({ content, failure: ambiguous, total: 1 });
  const servedAfter = withServed(served, failure.servedHashes);

  // 从回传里挑第 3 行，按新锚点重发
  const offered = failure.text.match(/3:([0-9A-Z]{4})│/)?.[1];
  assert.ok(offered);
  const retry = resolveAnchorEdits(content, servedAfter, [
    { removeFrom: `3:${offered}`, removeTo: `3:${offered}`, replacementText: "  return 3;" },
  ]);
  assert.equal(retry.status, "resolved");
});

// ============================================================
// 回传锚点的区间正确性
// ============================================================

test("§3a 多行替换时回传区域覆盖全部新插入的行", () => {
  const content = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"].join("\n");
  const result = editOnce(content, servedAll(content), [
    {
      removeFrom: anchorAt(content, 1),
      removeTo: anchorAt(content, 3),
      replacementText: ["L1a", "L1b", "L1c", "L1d", "L1e"].join("\n"),
    },
  ]);

  assert.deepEqual(result.changedRanges, [{ start: 0, end: 4 }]);
  for (const inserted of ["L1a", "L1b", "L1c", "L1d", "L1e"]) {
    assert.match(result.updatedText, new RegExp(inserted), `回传应包含 ${inserted}`);
  }
});

test("§3b 靠前的编辑改变行数后，后面编辑的落点仍按新内容报告", () => {
  const content = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"].join("\n");
  const result = editOnce(content, servedAll(content), [
    // 第一条：1 行换 3 行，净 +2
    { removeFrom: anchorAt(content, 1), removeTo: anchorAt(content, 1), replacementText: "L1a\nL1b\nL1c" },
    // 第二条：原第 7 行，新内容里落在第 9 行
    { removeFrom: anchorAt(content, 7), removeTo: anchorAt(content, 7), replacementText: "L7x" },
  ]);

  const newLines = splitLines(result.content);
  assert.equal(newLines.indexOf("L7x"), 8, "L7x 应落在新内容的第 9 行");
  assert.deepEqual(result.changedRanges[1], { start: 8, end: 8 });

  // 用原始索引 6 会指到 L5 —— 回传里必须出现的是 L7x
  assert.match(result.updatedText, /9:[0-9A-Z]{4}│L7x/);
});

test("§3c 两个编辑的上下文窗口重叠时，两个区块都要回传", () => {
  const content = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;"].join("\n");
  const result = editOnce(content, servedAll(content), [
    {
      removeFrom: anchorAt(content, 1),
      removeTo: anchorAt(content, 1),
      replacementText: "const a = 1;\nconst a2 = 2;\nconst a3 = 3;",
    },
    { removeFrom: anchorAt(content, 5), removeTo: anchorAt(content, 5), replacementText: "const e = 500;" },
  ]);

  // 文件里两条都生效了
  assert.match(result.content, /const e = 500;/);
  // 回传里必须也能看到第二条的新锚点
  assert.match(result.updatedText, /const e = 500;/);
});

test("§3c 相隔很远的两个编辑仍然分成两个区块", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `const row${index + 1} = ${index + 1};`);
  const content = lines.join("\n");
  const result = editOnce(content, servedAll(content), [
    { removeFrom: anchorAt(content, 2), removeTo: anchorAt(content, 2), replacementText: "const row2 = 20;" },
    { removeFrom: anchorAt(content, 30), removeTo: anchorAt(content, 30), replacementText: "const row30 = 300;" },
  ]);

  // §7.9.4 把裸 `...` 换成带行号范围的显式省略标记：裸省略号会被模型
  // 当成文件里的真实内容，而这里必须说清「哪些行没显示、不能编辑」。
  assert.match(result.updatedText, /omitted \(\d+ lines not shown — do not edit there\)/);
  assert.doesNotMatch(result.updatedText, /\n\.\.\.\n/, "不再是裸省略号");
  assert.match(result.updatedText, /const row2 = 20;/);
  assert.match(result.updatedText, /const row30 = 300;/);
});

test("§7.2 内容被清空后不得渲染出假行，也不得把空行哈希当成已读", () => {
  const content = ["A1", "A2", "A3"].join("\n");
  const result = editOnce(content, servedAll(content), [
    {
      removeFrom: anchorAt(content, 1),
      removeTo: anchorAt(content, 3),
      replacementText: "",
    },
  ]);

  assert.equal(result.content, "");
  // splitLines("") 是 [""] 而不是空数组，早期判据 lines.length === 0 在这里不成立
  assert.equal(result.updatedText, "");
  // 原有那几行的哈希仍算「看过」；这里只要求不新增空行哈希
  assert.ok(!result.served.has(hashLineContent("")));
});

test("§7.2 空内容上渲染区域返回空结果，而不是一个假行", () => {
  assert.deepEqual(formatAnchorRegion("", 1), { text: "(file is empty)", servedHashes: [] });
  assert.deepEqual(buildUpdatedAnchors("", [{ start: 0, end: 0 }]), { text: "", servedHashes: [] });
});

test("回传的 servedHashes 恰好等于渲染出来的那些行", () => {
  const content = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
  const rendered = buildUpdatedAnchors(content, [{ start: 1, end: 1 }]);
  const renderedLines = rendered.text.split("\n").map((line) => line.slice(line.indexOf("│") + 1));

  assert.deepEqual(
    rendered.servedHashes,
    renderedLines.map((line) => hashLineContent(line)),
  );
});

test("formatAnchorRegion 渲染带锚点的区域并回报哈希", () => {
  const region = formatAnchorRegion(CONTENT, 2, 1);
  assert.match(region.text, /Current anchors \(lines 1-3\)/);
  assert.match(region.text, /2:[0-9A-Z]{4}│  const msg = "hi " \+ name;/);
  assert.deepEqual(
    region.servedHashes,
    splitLines(CONTENT)
      .slice(0, 3)
      .map((line) => hashLineContent(line)),
  );
});

// -----------------------------------------------
// 裸哈希：模型只给 4 位哈希、省掉行号
// -----------------------------------------------

/** 取第 line 行的哈希（不带行号），即裸哈希写法。 */
function bareAt(content: string, line: number): string {
  return hashLineContent(splitLines(content)[line - 1]!);
}

test("裸哈希在已读集合里且当前文件唯一命中时解析成功", () => {
  const resolved = resolveAnchorEdits(CONTENT, servedAll(CONTENT), [
    { removeFrom: bareAt(CONTENT, 3), removeTo: bareAt(CONTENT, 3), replacementText: "  return msg.trim();" },
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") {
    // 单行编辑：start === end
    assert.equal(resolved.edits[0]!.start, resolved.edits[0]!.end);
    assert.equal(resolved.edits[0]!.start, 2);
  }
});

test("裸哈希容忍大小写与易混字符，归一化后仍能解析", () => {
  const bare = bareAt(CONTENT, 3).toLowerCase();
  const resolved = resolveAnchorEdits(CONTENT, servedAll(CONTENT), [
    { removeFrom: bare, removeTo: bare, replacementText: "x" },
  ]);

  assert.equal(resolved.status, "resolved");
});

test("裸哈希多处命中时按 ambiguous 拒绝，绝不错行", () => {
  const duplicated = ["same line", "other", "same line"].join("\n");
  const hashes = computeLineHashes(splitLines(duplicated));

  const resolved = resolveAnchorEdits(duplicated, new Set(hashes), [
    { removeFrom: hashes[0]!, removeTo: hashes[0]!, replacementText: "x" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") {
    assert.equal(resolved.reason, "ambiguous");
    assert.equal(resolved.matchCount, 2);
  }
});

test("裸哈希零命中但在已读集合里时判 stale，而不是 unserved", () => {
  const served = servedAll(CONTENT);
  // 内容已换掉，但哈希确实是模型看过的。
  const resolved = resolveAnchorEdits("totally\ndifferent\ncontent\n", served, [
    { removeFrom: bareAt(CONTENT, 3), removeTo: bareAt(CONTENT, 3), replacementText: "x" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") assert.equal(resolved.reason, "stale");
});

test("裸哈希零命中且不在已读集合里时判 unserved", () => {
  const resolved = resolveAnchorEdits(CONTENT, new Set(), [
    { removeFrom: bareAt(CONTENT, 1), removeTo: bareAt(CONTENT, 1), replacementText: "x" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") assert.equal(resolved.reason, "unserved");
});

test("垃圾输入仍然判 malformed，不因裸哈希支持而退化成 unserved", () => {
  const served = servedAll(CONTENT);

  for (const bad of ["abc", "not-an-anchor", ":AB3F", "AB3", "AB3FF"]) {
    const resolved = resolveAnchorEdits(CONTENT, served, [
      { removeFrom: bad, removeTo: bad, replacementText: "x" },
    ]);
    assert.equal(resolved.status, "failed", `input ${JSON.stringify(bad)}`);
    if (resolved.status === "failed") {
      assert.equal(resolved.reason, "malformed_anchor", `input ${JSON.stringify(bad)}`);
    }
  }
});

test("显式锚点的解析行为不受裸哈希支持影响", () => {
  const served = servedAll(CONTENT);
  const explicit = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 2), removeTo: anchorAt(CONTENT, 3), replacementText: "x" },
  ]);

  assert.equal(explicit.status, "resolved");
  if (explicit.status === "resolved") {
    assert.equal(explicit.edits[0]!.start, 1);
    assert.equal(explicit.edits[0]!.end, 2);
    assert.equal(explicit.edits[0]!.shifted, false);
  }
});
test("remove_to 留空时按单行处理（历史行为，不得退化为拒绝）", () => {
  const before = splitLines(CONTENT);
  const result = editOnce(CONTENT, servedAll(CONTENT), [
    { removeFrom: anchorAt(CONTENT, 2), removeTo: "", replacementText: '  const msg = "yo";' },
  ]);
  const after = splitLines(result.content);

  assert.equal(after.length, before.length);
  assert.equal(after[1], '  const msg = "yo";');
  // 相邻行必须原样保留。
  assert.equal(after[0], before[0]);
  assert.equal(after[2], before[2]);
});

test("remove_to 留空时 stale 哈希仍然被拒绝", () => {
  const served = servedAll(CONTENT);
  const resolved = resolveAnchorEdits("totally\ndifferent\n", served, [
    { removeFrom: anchorAt(CONTENT, 3), removeTo: "", replacementText: "x" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") assert.equal(resolved.reason, "stale");
});

test("给出 remove_to 的多行区间行为与改动前一致", () => {
  const result = editOnce(CONTENT, servedAll(CONTENT), [
    { removeFrom: anchorAt(CONTENT, 2), removeTo: anchorAt(CONTENT, 3), replacementText: "  return 1;" },
  ]);

  assert.match(result.content, /function greet\(name\) \{\n  return 1;\n\}/);
});

// -----------------------------------------------
// unserved 也 reject-and-serve
// -----------------------------------------------

test("带行号的 unserved 拒绝时回传该行区域的当前锚点", () => {
  const failure = resolveAnchorEdits(CONTENT, new Set(), [
    { removeFrom: anchorAt(CONTENT, 3), replacementText: "x" },
  ]);
  assert.equal(failure.status, "failed");
  if (failure.status !== "failed") throw new Error("unreachable");
  assert.equal(failure.reason, "unserved");

  const message = createAnchorFailureMessage({ content: CONTENT, failure, total: 1 });
  assert.match(message.text, /Current anchors \(lines /);
  assert.ok(message.servedHashes.length > 0);
});

test("unserved 回传的锚点可以直接拿来重发（不会再次被拒）", () => {
  const empty = new Set<string>();
  const first = resolveAnchorEdits(CONTENT, empty, [
    { removeFrom: anchorAt(CONTENT, 3), removeTo: anchorAt(CONTENT, 3), replacementText: "  return msg.trim();" },
  ]);
  assert.equal(first.status, "failed");
  if (first.status !== "failed") throw new Error("unreachable");

  const message = createAnchorFailureMessage({ content: CONTENT, failure: first, total: 1 });
  // 与 handler 的合流逻辑一致：回传的锚点写入 served。
  const served = withServed(empty, message.servedHashes);

  const retry = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 3), removeTo: anchorAt(CONTENT, 3), replacementText: "  return msg.trim();" },
  ]);
  assert.equal(retry.status, "resolved");
});

test("零命中且无从指路时不渲染区域", () => {
  const failure = resolveAnchorEdits(CONTENT, new Set(), [
    { removeFrom: "ZZZZ", removeTo: "ZZZZ", replacementText: "x" },
  ]);
  assert.equal(failure.status, "failed");
  if (failure.status !== "failed") throw new Error("unreachable");
  assert.equal(failure.reason, "unserved");
  assert.equal(failure.hintLine, 0);

  const message = createAnchorFailureMessage({ content: CONTENT, failure, total: 1 });
  assert.doesNotMatch(message.text, /Current anchors/);
  assert.equal(message.servedHashes.length, 0);
});

test("显式给出 remove_to 时首尾颠倒仍被拒绝（reversed 护栏）", () => {
  const served = servedAll(CONTENT);
  const resolved = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 3), removeTo: anchorAt(CONTENT, 1), replacementText: "x" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") assert.equal(resolved.reason, "reversed_range");
});

