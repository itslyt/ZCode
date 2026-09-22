import assert from "node:assert/strict";
import test from "node:test";
import { resolveToolCallIdentity, isFileDiffToolCall } from "../src/lib/toolIdentity.js";
import { readRawToolCallFileSummaries } from "../src/ToolCallBlocks/fileSummaries.js";

/**
 * `EditAnchored` 必须被 UI 认成写文件类工具。
 *
 * 不登记的话 identity 落到 unknown，工具卡退化成原始 JSON 兜底卡：没有 diff 预览，
 * 文件摘要与 treemap 活动统计也不计入——即使 call-runner 已经产出了 file_diff。
 */

const patch = [
  {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: ["-const a = 1;", "+const a = 2;"],
  },
];

const output = {
  filePath: "/tmp/x.ts",
  editCount: 1,
  originalFile: "const a = 1;",
  structuredPatch: patch,
  userModified: false,
  updatedAnchors: "1:ABCD│const a = 2;",
};

const display = {
  kind: "file_diff",
  filePath: "/tmp/x.ts",
  additions: 1,
  deletions: 1,
  structuredPatch: patch,
};

function sourceFor(toolName: string) {
  // 生产形态：结构化 diff 在 raw.rawOutput.display（file_diff）里。
  const raw = {
    toolName,
    tool_name: toolName,
    rawOutput: { display },
    output: { display },
    result: { display },
  };
  return {
    toolName,
    kind: toolName,
    title: toolName,
    input: { file_path: "/tmp/x.ts" },
    output,
    raw,
  };
}

test("EditAnchored 被识别为 file-write", () => {
  const identity = resolveToolCallIdentity(sourceFor("EditAnchored") as never);
  assert.equal(identity.family, "file-write");
  assert.equal(identity.toolName, "EditAnchored");
});

test("EditAnchored 走 diff 工具卡，而不是 raw 兜底卡", () => {
  assert.equal(isFileDiffToolCall(sourceFor("EditAnchored") as never), true);
});

test("EditAnchored 的调用能产出文件摘要", () => {
  const source = sourceFor("EditAnchored");
  assert.equal(readRawToolCallFileSummaries(source.raw as never, source as never).length, 1);
});

test("对照：Edit 的行为不变", () => {
  const identity = resolveToolCallIdentity(sourceFor("Edit") as never);
  assert.equal(identity.family, "file-write");
  assert.equal(isFileDiffToolCall(sourceFor("Edit") as never), true);
});
