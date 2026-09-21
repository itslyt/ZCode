# 用量统计图全模型展示

## 产品规则

- 「设置 → 用量」App Usage 的每日 Token 趋势图与模型用量饼图展示**全部用量大于 0 的模型**，不做 Top-N 截断，不做「其他模型」合并。
- Coding Plan 用量的折线图与柱状图同样放开 Top-6 序列截断，展示全部序列。
- 调色板保持 6 色循环取色：第 7 个及以后的模型/序列颜色重复，靠图例与标签区分（与历史补丁行为一致）。
- 趋势图 Y 轴上限继续只跟随可见序列的单点峰值（既有规则不变）。

## 状态所有者

无新增状态。输入为协议快照（`AppUsageSnapshot` / Coding Plan 用量序列），由纯视图模型函数派生：

- `packages/ui/src/settings/usage-stats/appUsageModelPieChartViewModel.ts`（饼图切片）
- `packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx` 内 `buildAppUsageDailyModelChartViewModel`（趋势图序列）
- `packages/ui/src/settings/usage-stats/CodingPlanUsageLineChart.tsx` / `CodingPlanUsageBarChart.tsx`（可见序列）

## 接口与清理

- 饼图视图模型返回结构不变：`{ chartConfig, chartData, totalModelTokens }`。
- 趋势图视图模型返回字段 `topModels` 更名为 `models`（消费方仅本文件内）。
- locale key `settings.usage.modelChart.other`（zh-CN / en-US）不再被引用，同步删除。

## 验收场景

1. 快照含 8 个用量大于 0 的模型：饼图 8 个切片、无「其他模型」切片，`share` 之和为 1；趋势图 8 条折线。
2. 模型数 ≤ 6：渲染结果与改动前一致。
3. 用量为 0 的模型不出现在饼图切片中（既有过滤保留）。
4. Coding Plan 折线图/柱状图序列数 > 6 时全部绘制。
5. 单测：`packages/ui/test/appUsageModelPieChartViewModel.test.ts`（node:test）覆盖场景 1-3。
