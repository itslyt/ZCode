import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalMicrocompactConfig } from "../src/runtime/methods/microcompact.js";
import { buildDefaultMicrocompactThreshold } from "../src/compact/microcompact.js";
import { getAutoCompactThreshold } from "../src/compact/policy.js";

// 本 fork 默认开启 microcompact，但**只压可重取的类别**（Read/Grep/Glob），
// 见 specs/context-compaction-optimization.md §3.5。

test("未配置时 microcompact 默认开启", () => {
  assert.equal(resolveLocalMicrocompactConfig({}).enabled, true);
});

test("未配置 microcompact 字段时也默认开启", () => {
  assert.equal(resolveLocalMicrocompactConfig({ contextWindow: 450_000 }).enabled, true);
});

test("显式 enabled:false 仍然关闭（保留关闭开关）", () => {
  const config = resolveLocalMicrocompactConfig({ microcompact: { enabled: false } });
  assert.equal(config.enabled, false);
});

test("显式 enabled:true 时开启，且显式配置项被透传", () => {
  const config = resolveLocalMicrocompactConfig({
    microcompact: { enabled: true, keepRecentToolResults: 3 },
  });
  assert.equal(config.enabled, true);
  assert.equal(config.keepRecentToolResults, 3);
});

test("未指定阈值时用默认值（低于全量压缩阈值，先它一步生效）", () => {
  const config = { contextWindow: 450_000, maxOutputTokens: 384_000 };
  const resolved = resolveLocalMicrocompactConfig(config);
  const fullThreshold = getAutoCompactThreshold(config);
  assert.equal(resolved.thresholdTokens, buildDefaultMicrocompactThreshold(fullThreshold));
  assert.ok(
    (resolved.thresholdTokens ?? 0) < fullThreshold,
    "microcompact 阈值必须低于全量压缩阈值",
  );
});
