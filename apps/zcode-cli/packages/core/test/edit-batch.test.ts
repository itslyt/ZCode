import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResolvedBatchEdits,
  createBatchEditFailureMessage,
  createNearbyRegionSnippet,
  findOverlappingBatchEdits,
  resolveBatchEdits,
} from "../src/tool/edit-batch.js";
import { collectOccurrenceOffsets, findClosestEditRegion } from "../src/tool/edit-matchers.js";

const request = (oldString: string, newString: string, replaceAll = false) => ({
  oldString,
  newString,
  replaceAll,
});

test("批量编辑都定位在原文上：前面的编辑插入行不会挤走后面的编辑", () => {
  // 这是批量语义的核心不变式。如果按顺序把上一条结果写回工作副本，
  // 第二条的匹配位置就会被第一条插入的行挤走（dsh-better-edit 的 E_BATCH_DISPLACED）。
  const content = ["function a() {", "  return 1;", "}", "", "function b() {", "  return 2;", "}"].join(
    "\n",
  );

  const resolved = resolveBatchEdits(content, [
    request("function a() {", "function a() {\n  // 新增注释行\n  // 再来一行"),
    request("  return 2;", "  return 42;"),
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;

  const result = applyResolvedBatchEdits(content, resolved.edits);
  assert.equal(
    result,
    [
      "function a() {",
      "  // 新增注释行",
      "  // 再来一行",
      "  return 1;",
      "}",
      "",
      "function b() {",
      "  return 42;",
      "}",
    ].join("\n"),
  );
});

test("批量编辑按偏移倒序应用，多段替换互不影响", () => {
  const content = "A1\nA2\nB1\nB2\nC1";
  const resolved = resolveBatchEdits(content, [
    request("A1", "A1-changed"),
    request("B1\nB2", "B-merged"),
    request("C1", "C1-changed"),
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;

  assert.equal(
    applyResolvedBatchEdits(content, resolved.edits),
    "A1-changed\nA2\nB-merged\nC1-changed",
  );
});

test("任一条定位失败时整批失败，并带回失败下标", () => {
  const content = "alpha\nbeta\ngamma";

  const notFound = resolveBatchEdits(content, [
    request("alpha", "ALPHA"),
    request("delta", "DELTA"),
    request("gamma", "GAMMA"),
  ]);
  assert.equal(notFound.status, "failed");
  if (notFound.status === "failed") {
    assert.equal(notFound.failedIndex, 1);
    assert.equal(notFound.reason, "not_found");
  }

  const ambiguous = resolveBatchEdits(content, [
    request("alpha", "ALPHA"),
    request("a", "A"),
  ]);
  assert.equal(ambiguous.status, "failed");
  if (ambiguous.status === "failed") {
    assert.equal(ambiguous.failedIndex, 1);
    assert.equal(ambiguous.reason, "ambiguous");
  }
});

test("replace_all 在批量条目里按出现次数展开", () => {
  const content = "x = 1;\ny = 1;\nz = 2;";
  const resolved = resolveBatchEdits(content, [request("1", "10", true), request("z = 2;", "z = 20;")]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;

  // 两处 "1" 各自展开，加上 z 一行，共 3 个区间
  assert.equal(resolved.edits.length, 3);
  assert.equal(applyResolvedBatchEdits(content, resolved.edits), "x = 10;\ny = 10;\nz = 20;");
});

test("重叠区间被显式拒绝，而不是猜一个顺序", () => {
  const content = "function f() {\n  return 1;\n}";
  const resolved = resolveBatchEdits(content, [
    request("function f() {", "function f() { // outer"),
    request("function f() {\n  return 1;", "function f() {\n  return 2;"),
  ]);

  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;

  const overlap = findOverlappingBatchEdits(resolved.edits);
  assert.notEqual(overlap, null);
  assert.deepEqual(overlap, [0, 1]);
});

test("相邻但不重叠的区间不算冲突", () => {
  const content = "aa\nbb\ncc";
  const resolved = resolveBatchEdits(content, [request("aa", "AA"), request("bb", "BB")]);
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.equal(findOverlappingBatchEdits(resolved.edits), null);
});

test("no-op 条目在批量里同样被拒绝", () => {
  const resolved = resolveBatchEdits("alpha", [request("alpha", "alpha")]);
  assert.equal(resolved.status, "failed");
  if (resolved.status === "failed") assert.equal(resolved.reason, "no_change");
});

test("失败信息带就近片段，模型可直接改参数重发", () => {
  const content = ["export function total() {", "  let sum = 0;", "  return sum;", "}"].join("\n");
  const message = createBatchEditFailureMessage({
    content,
    failure: {
      status: "failed",
      failedIndex: 1,
      reason: "not_found",
      oldString: "  let sum = 0;\n  return sum + 1;",
      candidateCount: 0,
    },
    total: 3,
  });

  assert.match(message, /Edit 2 of 3/);
  assert.match(message, /No edits were applied/);
  assert.match(message, /Closest current content/);
  // 片段必须带行号，模型才能定位
  assert.match(message, /1\texport function total\(\) \{/);
});

test("找不到相似区域时明确要求重读，而不是给一个错误的片段", () => {
  const snippet = createNearbyRegionSnippet("aaaa\nbbbb", "completely unrelated text here");
  assert.equal(snippet, null);

  const message = createBatchEditFailureMessage({
    content: "aaaa\nbbbb",
    failure: {
      status: "failed",
      failedIndex: 0,
      reason: "not_found",
      oldString: "zzzzzzzzzzzzzzzzzzzzzzzzzzz",
      candidateCount: 0,
    },
    total: 1,
  });
  assert.match(message, /re-read the file/);
});

test("不唯一的失败信息指出匹配次数并给出两条出路", () => {
  const message = createBatchEditFailureMessage({
    content: "a\na",
    failure: {
      status: "failed",
      failedIndex: 0,
      reason: "ambiguous",
      oldString: "a",
      candidateCount: 2,
    },
    total: 1,
  });

  assert.match(message, /found 2 matches/);
  assert.match(message, /replace_all to true/);
});

test("collectOccurrenceOffsets 返回全部出现位置", () => {
  assert.deepEqual(collectOccurrenceOffsets("abcabc", "abc"), [0, 3]);
  assert.deepEqual(collectOccurrenceOffsets("abc", "z"), []);
  assert.deepEqual(collectOccurrenceOffsets("abc", ""), []);
});

test("findClosestEditRegion 定位最接近的行区间", () => {
  const content = ["line one", "line two", "line three", "line four"].join("\n");
  const region = findClosestEditRegion(content, "line two\nline three");
  assert.notEqual(region, null);
  assert.equal(region?.startLine, 2);
  assert.equal(region?.endLine, 3);
  assert.equal(region?.similarity, 1);
});
