import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateTextTokens,
  resolveTurnStatsDisplay,
  resolveWindowTokensPerSecond,
} from "../src/v4/composer/composerTurnStats.js";

test("文本 token 估算：CJK 一字一 token，其余四字符一 token", () => {
  assert.equal(estimateTextTokens("你好世界"), 4);
  assert.equal(estimateTextTokens("abcdefgh"), 2);
  assert.equal(estimateTextTokens("你好ab"), 3);
  assert.equal(estimateTextTokens(""), 0);
});

test("滑动窗口速度取窗口内首尾增量", () => {
  const speed = resolveWindowTokensPerSecond(
    [
      { at: 0, tokens: 0 },
      { at: 2000, tokens: 60 },
    ],
    2000,
  );
  assert.equal(speed, 30);
});

test("滑动窗口排除窗口外采样", () => {
  const speed = resolveWindowTokensPerSecond(
    [
      { at: 0, tokens: 0 },
      { at: 1000, tokens: 100 },
      { at: 5000, tokens: 110 },
    ],
    5000,
  );
  assert.equal(speed, 2.5);
});

test("窗口内无增长或采样不足返回 null（静默期由调用方保持最近值）", () => {
  assert.equal(
    resolveWindowTokensPerSecond(
      [
        { at: 1000, tokens: 50 },
        { at: 2000, tokens: 50 },
      ],
      2000,
    ),
    null,
  );
  assert.equal(resolveWindowTokensPerSecond([{ at: 1000, tokens: 50 }], 2000), null);
});

test("历史轮无精确基线：不展示 out 与速度", () => {
  const display = resolveTurnStatsDisplay({
    streaming: false,
    exactOutTokens: null,
    estimatedOutTokens: 999,
    windowTokensPerSecond: null,
    heldTokensPerSecond: null,
    endedAt: 5000,
    firstTextAt: 1000,
  });
  assert.equal(display.outTokens, null);
  assert.equal(display.tokensPerSecond, null);
});

test("流式轮：out 取精确差值与估算的较大者，速度取窗口值或保持值", () => {
  const withWindow = resolveTurnStatsDisplay({
    streaming: true,
    exactOutTokens: 100,
    estimatedOutTokens: 120,
    windowTokensPerSecond: 42,
    heldTokensPerSecond: 30,
    endedAt: null,
    firstTextAt: 1000,
  });
  assert.equal(withWindow.outTokens, 120);
  assert.equal(withWindow.tokensPerSecond, 42);

  const silent = resolveTurnStatsDisplay({
    streaming: true,
    exactOutTokens: 100,
    estimatedOutTokens: 100,
    windowTokensPerSecond: null,
    heldTokensPerSecond: 30,
    endedAt: null,
    firstTextAt: 1000,
  });
  assert.equal(silent.outTokens, 100);
  assert.equal(silent.tokensPerSecond, 30);
});

test("结束轮：out 用精确值，速度用首文本到轮结束的解码窗口", () => {
  const display = resolveTurnStatsDisplay({
    streaming: false,
    exactOutTokens: 200,
    estimatedOutTokens: 190,
    windowTokensPerSecond: 999,
    heldTokensPerSecond: 999,
    endedAt: 3000,
    firstTextAt: 1000,
  });
  assert.equal(display.outTokens, 200);
  assert.equal(display.tokensPerSecond, 100);

  const noText = resolveTurnStatsDisplay({
    streaming: false,
    exactOutTokens: 200,
    estimatedOutTokens: 0,
    windowTokensPerSecond: null,
    heldTokensPerSecond: null,
    endedAt: 3000,
    firstTextAt: null,
  });
  assert.equal(noText.outTokens, 200);
  assert.equal(noText.tokensPerSecond, null);
});
