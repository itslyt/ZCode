import assert from "node:assert/strict";
import test from "node:test";
import type { V4ConversationUsageResult } from "@zcode/shared/zcode-protocol-v4";
import {
  buildSessionStatsView,
  buildTurnStatsView,
  formatSessionStatsDuration,
  formatSessionStatsTokenCount,
} from "../src/v4/sessionStatsView.js";

function usage(overrides: Partial<V4ConversationUsageResult> = {}): V4ConversationUsageResult {
  return {
    sessionId: "s1",
    totalTokens: 1000,
    inputTokens: 100,
    outputTokens: 200,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 900,
    modelRequestCount: 2,
    modelErrorCount: 0,
    inputBaselineBySource: {},
    modelDurationMs: 30_000,
    toolDurationMs: 12_000,
    ttftTotalMs: 3_000,
    ttftSampleCount: 2,
    decodeWindowMs: 10_000,
    rawInputTokens: 100,
    rawCacheReadTokens: 900,
    turnCount: 3,
    toolCallCount: 7,
    ...overrides,
  };
}

test("派生：TTFT 均值与 TPS 由聚合字段计算", () => {
  const view = buildSessionStatsView(usage());
  assert.equal(view.ttftAvgMs, 1500);
  assert.equal(view.tokensPerSecond, 20);
  assert.equal(view.hasActivity, true);
});

test("派生：缓存命中率按 cacheRead / (cacheRead + 未缓存输入)", () => {
  const view = buildSessionStatsView(usage());
  assert.equal(view.cacheHitRate, 0.9);
  assert.equal(view.totalTokens, 1200);
  assert.equal(view.uncachedInputTokens, 100);
  assert.equal(view.turnCount, 3);
  assert.equal(view.toolCallCount, 7);
});

test("派生：无样本/零窗口时对应项为 null，无活动会话 hasActivity=false", () => {
  const empty = buildSessionStatsView(
    usage({
      modelRequestCount: 0,
      totalTokens: 0,
      ttftSampleCount: 0,
      ttftTotalMs: 0,
      decodeWindowMs: 0,
      outputTokens: 0,
      rawInputTokens: 0,
      rawCacheReadTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
    }),
  );
  assert.equal(empty.hasActivity, false);
  assert.equal(empty.ttftAvgMs, null);
  assert.equal(empty.tokensPerSecond, null);
  assert.equal(empty.cacheHitRate, null);
});

test("时长格式化：zh 分秒与小数秒", () => {
  assert.equal(formatSessionStatsDuration("zh-CN", 42 * 60_000 + 57_000), "42分57秒");
  assert.equal(formatSessionStatsDuration("zh-CN", 6_500), "6.5秒");
  assert.equal(formatSessionStatsDuration("zh-CN", 8_000), "8秒");
  assert.equal(formatSessionStatsDuration("zh-CN", 120_000), "2分");
});

test("时长格式化：en 单位", () => {
  assert.equal(formatSessionStatsDuration("en-US", 42 * 60_000 + 57_000), "42m 57s");
  assert.equal(formatSessionStatsDuration("en-US", 6_500), "6.5s");
  assert.equal(formatSessionStatsDuration("en-US", 120_000), "2m");
});

test("token 数量走本地化千分位", () => {
  assert.equal(formatSessionStatsTokenCount("en-US", 12_207_726), "12,207,726");
});

test("逐轮派生：总量与缓存命中走 turn_usage 原始口径", () => {
  const view = buildTurnStatsView({
    turnId: "t1",
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    timeToFirstTokenMs: 700,
    modelDurationMs: 3000,
    toolDurationMs: 900,
    inputTokens: 1280,
    outputTokens: 312,
    cacheCreationTokens: 0,
    cacheReadTokens: 590_848,
    totalTokens: 592_440,
    modelRequestCount: 2,
    toolCallCount: 4,
    providerId: "local",
    modelId: "QWEN_3_8_MAX",
  });
  assert.equal(view.totalTokens, 592_440);
  assert.ok(view.cacheHitRate !== null && view.cacheHitRate > 0.99);
  assert.equal(view.providerModel, "local/QWEN_3_8_MAX");
  assert.equal(view.ttftMs, 700);
  assert.equal(view.durationMs, 4000);
});
