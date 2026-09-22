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

/** 把一段内容变成「模型看过的锚点集合」——等价于 Read 的副作用。 */
function servedOf(content: string): Set<string> {
  return new Set(computeLineHashes(splitLines(content)));
}

/** 取第 line 行（1 起始）的锚点字符串。 */
function anchorAt(content: string, line: number): string {
  const lines = splitLines(content);
  return formatAnchor(line, hashLineContent(lines[line - 1]!));
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
  // Crockford：I/L→1、O→0
  assert.equal(normalizeAnchorHash("ABIF"), normalizeAnchorHash("AB1F"));
  assert.equal(normalizeAnchorHash("ABOF"), normalizeAnchorHash("AB0F"));
  // 长度不对或含非法字符一律拒绝
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
  const served = servedOf(CONTENT);
  const resolved = resolveAnchorEdits(CONTENT, served, [
    {
      removeFrom: anchorAt(CONTENT, 2),
      removeTo: anchorAt(CONTENT, 2),
      replacementText: '  const msg = `hi ${name}`;',
    },
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.equal(resolved.edits.length, 1);
  assert.equal(resolved.edits[0]!.start, 1);
  assert.equal(resolved.edits[0]!.end, 1);
  assert.equal(resolved.edits[0]!.shifted, false);

  assert.equal(
    applyAnchorEdits(CONTENT, resolved.edits),
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
  const served = servedOf(CONTENT);
  // 模型拿到的是原文的锚点
  const staleFrom = anchorAt(CONTENT, 7);

  // 文件被外部（或模型自己上一步）改过：顶部插入了 3 行
  const shifted = ["// 新注释 1", "// 新注释 2", "// 新注释 3", CONTENT].join("\n");

  const resolved = resolveAnchorEdits(shifted, served, [
    { removeFrom: staleFrom, removeTo: staleFrom, replacementText: '  return "goodbye " + name;' },
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  // 原第 7 行现在在第 10 行
  assert.equal(resolved.edits[0]!.start, 9);
  assert.equal(resolved.edits[0]!.shifted, true);
});

test("自愈合遇到多处命中时拒绝，绝不错行", () => {
  const content = ["  return 1;", "  return 1;", "  return 1;"].join("\n");
  const served = servedOf(content);

  const resolved = resolveAnchorEdits(content, served, [
    // 引用一个不存在的行号，迫使走哈希搜索路径；哈希在文件里出现 3 次
    { removeFrom: `99:${hashLineContent("  return 1;")}`, removeTo: `99:${hashLineContent("  return 1;")}`, replacementText: "  return 2;" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") {
    assert.equal(resolved.reason, "ambiguous");
    assert.equal(resolved.matchCount, 3);
  }
});

test("内容已变化时拒绝，并回传该区域当前锚点", () => {
  const served = servedOf(CONTENT);
  const staleFrom = anchorAt(CONTENT, 3);

  const changed = CONTENT.replace("  return msg;", "  return msg.trim();");
  const resolved = resolveAnchorEdits(changed, served, [
    { removeFrom: staleFrom, removeTo: staleFrom, replacementText: "  return msg;" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status !== "failed") return;
  assert.equal(resolved.reason, "stale");

  const message = createAnchorFailureMessage({ content: changed, failure: resolved, total: 1 });
  assert.match(message, /no longer exists/);
  assert.match(message, /No edits were applied/);
  // reject-and-serve：带上当前锚点，模型不必重读整个文件
  assert.match(message, /Current anchors/);
  assert.match(message, /return msg\.trim\(\);/);
});

test("未展示过的锚点被拒绝", () => {
  const resolved = resolveAnchorEdits(CONTENT, new Set(), [
    { removeFrom: anchorAt(CONTENT, 1), removeTo: anchorAt(CONTENT, 1), replacementText: "x" },
  ]);

  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") assert.equal(resolved.reason, "unserved");
});

test("锚点格式错误与区间反向都给出可修正的提示", () => {
  const served = servedOf(CONTENT);

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
  const served = servedOf(CONTENT);

  const deleted = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 5), removeTo: anchorAt(CONTENT, 5), replacementText: "" },
  ]);
  assert.equal(deleted.status, "resolved");
  if (deleted.status === "resolved") {
    const result = applyAnchorEdits(CONTENT, deleted.edits);
    assert.equal(splitLines(result).length, splitLines(CONTENT).length - 1);
    assert.ok(!result.includes("\n\n\n"));
  }

  const inserted = resolveAnchorEdits(CONTENT, served, [
    {
      removeFrom: anchorAt(CONTENT, 4),
      removeTo: anchorAt(CONTENT, 4),
      replacementText: "}\n\nexport const VERSION = 1;",
    },
  ]);
  assert.equal(inserted.status, "resolved");
  if (inserted.status === "resolved") {
    assert.match(applyAnchorEdits(CONTENT, inserted.edits), /VERSION = 1;/);
  }
});

test("批量锚点编辑按倒序应用，前一条不移动后一条", () => {
  const served = servedOf(CONTENT);
  const resolved = resolveAnchorEdits(CONTENT, served, [
    {
      removeFrom: anchorAt(CONTENT, 1),
      removeTo: anchorAt(CONTENT, 1),
      replacementText: "function greet(name) {\n  // 头部注释",
    },
    { removeFrom: anchorAt(CONTENT, 7), removeTo: anchorAt(CONTENT, 7), replacementText: '  return "bye!";' },
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;

  const result = applyAnchorEdits(CONTENT, resolved.edits);
  assert.match(result, /\/\/ 头部注释/);
  assert.match(result, /return "bye!";/);
});

test("重叠区间被显式拒绝", () => {
  const served = servedOf(CONTENT);
  const resolved = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 1), removeTo: anchorAt(CONTENT, 3), replacementText: "a" },
    { removeFrom: anchorAt(CONTENT, 2), removeTo: anchorAt(CONTENT, 4), replacementText: "b" },
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.deepEqual(findOverlappingAnchorEdits(resolved.edits), [0, 1]);
});

test("相邻但不重叠的锚点区间不算冲突", () => {
  const served = servedOf(CONTENT);
  const resolved = resolveAnchorEdits(CONTENT, served, [
    { removeFrom: anchorAt(CONTENT, 1), removeTo: anchorAt(CONTENT, 1), replacementText: "a" },
    { removeFrom: anchorAt(CONTENT, 2), removeTo: anchorAt(CONTENT, 2), replacementText: "b" },
  ]);
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.equal(findOverlappingAnchorEdits(resolved.edits), null);
});

test("编辑结果回传受影响区域的新锚点", () => {
  const updated = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
  const anchors = buildUpdatedAnchors(updated, [{ start: 1, end: 1 }]);

  assert.match(anchors, /1:[0-9A-Z]{4}│const a = 1;/);
  assert.match(anchors, /2:[0-9A-Z]{4}│const b = 2;/);
  // 回传的锚点必须能被解析回同一行
  const secondLine = splitLines(anchors).find((line) => line.includes("const b = 2;"))!;
  const parsed = parseAnchor(secondLine.slice(0, secondLine.indexOf("│")));
  assert.equal(parsed?.line, 2);
  assert.equal(parsed?.hash, hashLineContent("const b = 2;"));
});

test("formatAnchorRegion 渲染带锚点的区域", () => {
  const region = formatAnchorRegion(CONTENT, 2, 1);
  assert.match(region, /Current anchors \(lines 1-3\)/);
  assert.match(region, /2:[0-9A-Z]{4}│  const msg = "hi " \+ name;/);
});
