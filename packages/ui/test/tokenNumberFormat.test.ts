import assert from "node:assert/strict";
import test from "node:test";
import { formatTokenCountK } from "../src/lib/tokenNumberFormat.js";
import { formatSessionStatsPercent } from "../src/v4/sessionStatsView.js";

test("容量单位固定 K：千位以上保留一位小数，去掉多余的 .0", () => {
  assert.equal(formatTokenCountK(450_000, 0), "450K");
  assert.equal(formatTokenCountK(234_000, 0), "234K");
  assert.equal(formatTokenCountK(3_800), "3.8K");
  assert.equal(formatTokenCountK(11_000), "11K");
  assert.equal(formatTokenCountK(883), "883");
});

test("缓存命中率保留一位小数（胶囊与面板同精度）", () => {
  assert.equal(formatSessionStatsPercent(0.903), "90.3");
  assert.equal(formatSessionStatsPercent(0.866), "86.6");
  assert.equal(formatSessionStatsPercent(0.957), "95.7");
  assert.equal(formatSessionStatsPercent(1), "100.0");
});
