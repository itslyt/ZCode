import assert from "node:assert/strict";
import test from "node:test";
import { resolveRunningWorkElapsedMs } from "../src/v4/conversationRunningElapsedModel.js";
import type { ConversationTurnWorkSegment } from "../src/v4/conversationTurnWorkSegments.js";

/**
 * 执行中底部时长条与轮顶「工作中 N 秒」必须同源同值。
 *
 * 这里锁定取数口径：只有最后一个 unit 的最后一个段是活的才给值，
 * 否则底部条会残留、或者显示一个和轮顶对不上的数。
 */

function segment(durationMs: number | undefined): ConversationTurnWorkSegment {
  return {
    key: "seg",
    flowItems: [],
    assistantWorkRows: [],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantHistoryDefaultOpen: false,
    workStatus: { state: "running", ...(durationMs === undefined ? {} : { durationMs }) },
  };
}

test("运行中的末段给出耗时", () => {
  assert.equal(
    resolveRunningWorkElapsedMs({ isRunning: true, workSegments: [segment(65_000)] }),
    65_000,
  );
});

test("完成轮不给值，底部条必须消失", () => {
  assert.equal(
    resolveRunningWorkElapsedMs({
      isRunning: false,
      workSegments: [
        { ...segment(65_000), workStatus: { state: "completed", durationMs: 65_000 } },
      ],
    }),
    undefined,
  );
});

test("末段非 running 不给值（只读尾窗或已收口）", () => {
  assert.equal(
    resolveRunningWorkElapsedMs({
      isRunning: true,
      workSegments: [{ ...segment(1_000), workStatus: { state: "completed", durationMs: 1_000 } }],
    }),
    undefined,
  );
});

test("缺 durationMs 不给假读数", () => {
  assert.equal(
    resolveRunningWorkElapsedMs({ isRunning: true, workSegments: [segment(undefined)] }),
    undefined,
  );
});

test("无 workSegments 不给值（旧投影 / timelineOnly）", () => {
  assert.equal(resolveRunningWorkElapsedMs({ isRunning: true }), undefined);
  assert.equal(resolveRunningWorkElapsedMs({ isRunning: true, workSegments: [] }), undefined);
});

test("guide 多段取末段：前段已冻结，不能显示整轮累计", () => {
  const frozen = segment(30_000);
  frozen.workStatus = { state: "completed", durationMs: 30_000 };
  assert.equal(
    resolveRunningWorkElapsedMs({ isRunning: true, workSegments: [frozen, segment(12_000)] }),
    12_000,
  );
});
