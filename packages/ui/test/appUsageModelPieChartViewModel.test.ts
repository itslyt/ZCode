import assert from "node:assert/strict";
import test from "node:test";
import type { AppUsageSnapshot } from "@zcode/shared";
import { buildAppUsageModelPieChartViewModel } from "../src/settings/usage-stats/appUsageModelPieChartViewModel.js";

const intl = {
  formatMessage: (descriptor: { id: string }) => descriptor.id,
};

function snapshotWithModels(models: Array<{ modelId: string | null; totalTokens: number }>) {
  return { models } as unknown as AppUsageSnapshot;
}

test("饼图展示全部用量大于 0 的模型，不截断也不合并其他模型", () => {
  const models = Array.from({ length: 8 }, (_, index) => ({
    modelId: `model-${index}`,
    totalTokens: (index + 1) * 100,
  }));
  const { chartData } = buildAppUsageModelPieChartViewModel({
    intl,
    snapshot: snapshotWithModels(models),
  });

  assert.equal(chartData.length, 8);
  assert.ok(chartData.every((slice) => slice.label !== "settings.usage.modelChart.other"));
  const shareSum = chartData.reduce((sum, slice) => sum + slice.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
});

test("调色板 6 色循环：第 7 个切片复用第 1 个切片的颜色", () => {
  const models = Array.from({ length: 8 }, (_, index) => ({
    modelId: `model-${index}`,
    totalTokens: 100,
  }));
  const { chartData } = buildAppUsageModelPieChartViewModel({
    intl,
    snapshot: snapshotWithModels(models),
  });

  assert.equal(chartData[6]?.color, chartData[0]?.color);
  assert.notEqual(chartData[1]?.color, chartData[0]?.color);
});

test("模型数不超过 6 时逐个出块", () => {
  const models = Array.from({ length: 3 }, (_, index) => ({
    modelId: `model-${index}`,
    totalTokens: 50,
  }));
  const { chartData } = buildAppUsageModelPieChartViewModel({
    intl,
    snapshot: snapshotWithModels(models),
  });

  assert.equal(chartData.length, 3);
});

test("用量为 0 的模型不出块", () => {
  const { chartData, totalModelTokens } = buildAppUsageModelPieChartViewModel({
    intl,
    snapshot: snapshotWithModels([
      { modelId: "used", totalTokens: 10 },
      { modelId: "unused", totalTokens: 0 },
    ]),
  });

  assert.equal(chartData.length, 1);
  assert.equal(chartData[0]?.label, "used");
  assert.equal(totalModelTokens, 10);
});

test("未知模型 id 走 unknownModel 标签", () => {
  const { chartData } = buildAppUsageModelPieChartViewModel({
    intl,
    snapshot: snapshotWithModels([{ modelId: null, totalTokens: 5 }]),
  });

  assert.equal(chartData[0]?.label, "settings.usage.unknownModel");
});
