# 会话底部统计条（Session Stats Bar）

取代已被删除的 composer TPS 胶囊（specs/composer-tps-capsule.md 随功能删除）。

## 产品规则

composer 卡片内底行居中展示两枚可点击胶囊（DSH 式），详情在浮层中：

- 模型用时：会话内模型请求 `duration_ms` 之和
- 工具调用用时：`tool_usage.duration_ms` 之和
- 首 token 平均（TTFT）：`time_to_first_token_ms` 均值（无样本时不展示）
- 输出速度（TPS）：`outputTokens × 1000 ÷ Σ(duration_ms − time_to_first_token_ms)`（解码窗口为 0 时不展示）
- Token 用量：提供商原始口径 `未缓存输入 + 缓存读取 + 输出`（与 DSH 总量口径一致），括号内拆分缓存命中百分比（read/(read+uncached)）、未缓存输入、缓存读取、输出；不使用增量消耗口径字段
- 时长格式：1 分钟内秒带 1 位小数（`6.5秒`），满 1 分钟取整分秒（`42分57秒`；en `42m 57s`）
- 无活动会话（无模型请求且 totalTokens=0）不渲染；查询失败保留旧值不闪零
- 切会话展示目标会话自己的统计（按 sessionId 查询，scopeKey 挡旧结果）

## 状态所有者

- 权威数据：CLI 侧 DB 聚合。`model_usage` / `tool_usage` 表持久化每请求/每工具时长与 TTFT；
  `queryTaskUsage`（adapters repositories/usage.ts）聚合后经 `v4/conversation/usage`
  （`V4ConversationUsageResult` 新增 modelDurationMs / toolDurationMs / ttftTotalMs /
  ttftSampleCount / decodeWindowMs / rawInputTokens / rawCacheReadTokens 七个字段）下发。无窗口、无条数上限。
- UI 侧唯一持有者：`useSessionStats` hook（1s 轮询，仿 useSessionDebug 的完成节拍与 scope 防护）；
  展示模型由纯函数 `buildSessionStatsView` 派生；不新建 store、不落盘。

## 接口

- `packages/ui/src/v4/sessionStatsView.ts`：纯派生 + 时长/数量格式化
- `packages/ui/src/hooks/useSessionStats.ts`：轮询 hook
- `packages/ui/src/v4/SessionStatsCapsules.tsx`：DSH 式双胶囊（轮步+速度 / Token+缓存命中），点击开 Popover 详情；经 ChatPromptEditor `toolbarCenterNode` 插槽置于工具栏行左右控件簇之间（与 +/权限/模型/发送 同一行）
- 协议：`packages/shared/src/zcode-protocol-v4/transport.ts` 的 `v4ConversationUsageResultSchema`
  增补七个非负数值字段；contracts `TaskUsageQueryResult` 同步；handler 无 usageStore 时回退全 0

## 验收场景

1. 会话有模型请求：统计条展示模型用时/工具用时/TTFT/TPS/Token 用量五组。
2. 无 TTFT 样本或解码窗口为 0：对应项不渲染，其余正常。
3. 切到另一会话：展示该会话统计；切到无活动会话：不渲染。
4. 查询失败：保留上一次成功值。
5. 单测：`packages/ui/test/sessionStatsView.test.ts` 覆盖派生计算与时长格式化（zh/en）。

## 逐轮胶囊（DSH 式每轮用量/用时）

- 每轮 assistant 动作行（复制/点赞/时间戳行）追加两枚胶囊：`本轮用量 X tok` 与 `用时 X`，点击开浮层：
  用量浮层 = 本轮用量 / 提供方·模型 / 缓存命中 / 未缓存输入 / 缓存读取 / 输出；用时浮层 = 模型用时 / 工具调用用时 / 首 token。
- 数据：新 RPC `v4/conversation/turnUsage`（`queryTurnUsage`：turn_usage 主表 + model_usage/tool_usage 按 turn 补时长与模型归属）；
  不改行/消息结构，不做迁移；历史会话因 turn_usage 已有持久化而天然有数据。
- UI 持有者：`ConversationTimeline` 内单次 `useTurnStats` 轮询（1s），经 `TurnStatsContext` 下发 turnId→聚合行 map；行级胶囊只读 map，不各自轮询。
- 兼容：host 无 `queryTurnUsage` 时 handler 回退空 turns，胶囊不渲染。
