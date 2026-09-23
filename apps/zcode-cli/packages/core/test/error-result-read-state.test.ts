import assert from "node:assert/strict";
import test from "node:test";
import { createErrorResult } from "../src/tool/executor/errors.js";
import { readFileStateMetadataField } from "../src/runtime/methods/tool-part-metadata.js";
import type { PersistedReadFileStateMetadata } from "../src/tool/read-file-state-metadata.js";

/**
 * 失败结果必须能带上 handler 已上报的读状态。
 *
 * 读状态是「模型对文件的视图」，由产生它的那次调用决定，与那次调用成功还是失败无关。
 * `EditAnchored` 的 stale / ambiguous 拒绝会把当前锚点渲染给模型（reject-and-serve）并把
 * 它们并进 served——这份信息如果因为「那次调用失败了」而丢掉，resume 后模型照抄错误信息里
 * 的锚点重发就会撞 unserved，跨会话的 reject-and-serve 断开。
 *
 * 这里盯的是链路的前半段：`createErrorResult` → `ToolExecutionResult.readFileStateMetadata`
 * → tool part metadata 的 `readFileState`。后半段（hydrator 从 error 部件恢复）见
 * `read-file-state-hydrator.test.ts`。
 */

const PATH = "/tmp/error-result.ts";

function metadata(): PersistedReadFileStateMetadata {
  return {
    schemaVersion: 1,
    tool: "EditAnchored",
    path: PATH,
    content: "const a = 1;",
    isPartialView: true,
    readAtMs: 1_700_000_000_000,
    revisionId: "rev-1",
    mtimeMs: 1_700_000_000_000,
    sizeBytes: 12,
    servedAnchors: ["AAAA", "BBBB"],
  };
}

function toolCall() {
  return { id: "call_1", name: "EditAnchored", input: {} } as never;
}

test("失败结果默认不带读状态", () => {
  const result = createErrorResult(toolCall(), new Error("boom"));
  assert.equal(result.success, false);
  assert.equal(result.readFileStateMetadata, undefined);
  assert.deepEqual(readFileStateMetadataField(result), {});
});

test("失败结果可以带上读状态，并落到 tool part metadata 的 readFileState", () => {
  const readFileStateMetadata = metadata();
  const result = createErrorResult(toolCall(), new Error("boom"), 5, { readFileStateMetadata });

  assert.equal(result.success, false, "仍然是失败结果，不能因为带了读状态就变成成功");
  assert.deepEqual(result.readFileStateMetadata, readFileStateMetadata);
  // 失败分支与成功分支共用这一个投影，否则「带上了但写不出去」等于没带
  assert.deepEqual(readFileStateMetadataField(result), { readFileState: readFileStateMetadata });
});

test("成功路径的投影不受影响", () => {
  const readFileStateMetadata = metadata();
  const result = createErrorResult(toolCall(), new Error("boom"), 5, { readFileStateMetadata });
  // 反向：没有 readFileStateMetadata 的结果不能凭空多出 readFileState 字段
  assert.deepEqual(readFileStateMetadataField({ ...result, readFileStateMetadata: undefined }), {});
});
