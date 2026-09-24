import assert from "node:assert/strict";
import test from "node:test";
import {
  getAutoCompactThreshold,
  getAutoCompactThresholdPercent,
  getEffectiveContextWindowSize,
} from "../src/compact/policy.js";

// thresholdPercentOverride 之前只在 config 类型里声明、从未被读取，
// 阈值恒等于 effectiveWindow - buffer。声明窗口大于网关真实输入上限时，
// 这个阈值可能高于上限，压缩永远不触发。见 specs/context-compaction-optimization.md §3.6。

test("未配置时不改变既有阈值（默认 100% 等价于 effectiveWindow - buffer）", () => {
  const config = { contextWindow: 450_000, maxOutputTokens: 384_000 };
  assert.equal(getAutoCompactThresholdPercent(config), 100);
  assert.equal(getAutoCompactThreshold(config), getEffectiveContextWindowSize(config) - 13_000);
});

test("显式百分比会把阈值压到有效窗口的比例上限内", () => {
  const config = { contextWindow: 450_000, maxOutputTokens: 384_000, thresholdPercentOverride: 80 };
  const effective = getEffectiveContextWindowSize(config);
  assert.equal(getAutoCompactThreshold(config), Math.floor((effective * 80) / 100));
  assert.ok(getAutoCompactThreshold(config) < effective - 13_000);
});

test("百分比高于 100 时退化为按 buffer 计算，不放大阈值", () => {
  const base = { contextWindow: 450_000, maxOutputTokens: 384_000 };
  const boosted = { ...base, thresholdPercentOverride: 500 };
  assert.equal(getAutoCompactThresholdPercent(boosted), 100);
  assert.equal(getAutoCompactThreshold(boosted), getAutoCompactThreshold(base));
});

test("百分比被夹到 1..100：0 不会退化成每轮都压缩", () => {
  const config = { contextWindow: 450_000, maxOutputTokens: 384_000, thresholdPercentOverride: 0 };
  assert.equal(getAutoCompactThresholdPercent(config), 100);
  assert.equal(getAutoCompactThreshold(config), getAutoCompactThreshold({ contextWindow: 450_000, maxOutputTokens: 384_000 }));
});
