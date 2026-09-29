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
- 修订：动作行调用点必须传 `turnId`（漏传则胶囊恒不渲染）；用时浮层首两行为「本轮用时 / 速度」（速度 = 输出 token ÷ 解码窗，解码窗 = 模型用时 − 首 token）；
  两个统计 RPC 固定 `existing-only`：观察路径不得为已回收会话拉起 runtime（避免重置上下文快照等副作用）。
- 关联键：UI 行 `turnId` 为 msg\_ 值域，等于 `turn_usage.user_message_id`；逐轮 map 以 `userMessageId` 为键（回退 `turn_id`），协议字段 `userMessageId` nullable。

## 展示修订（自用 fork）

1. **命中率精度统一一位小数**：`formatSessionStatsPercent` 导出，状态栏胶囊与会话/逐轮浮层共用；
   之前胶囊 `Math.round` 成整数，和上下文面板的 90.3% 对不上（同口径不同精度也会看起来像两个数）。
2. **上下文面板单位固定 K**：`formatTokenCountK`（`lib/tokenNumberFormat.ts`）不随 locale 变万/亿，
   顶部摘要改为 `11K / 450K (2.4%)`，跟 DSH 与 provider 技术口径一致。
3. **分项行补上估算 token**：协议 breakdown item 新增可选 `tokens`（core 快照 categories 本来就算了 `estimateTokens`，
   以前只传 chars）；面板占比改按 token 算（否则百分比与括号里的 K 不同源、对不上），
   渲染为 `86.5% (~7.8K)`。
   **分项 K 直接展示快照估算 token 原值，不按 `used` 缩放，且带 `~` 前缀标记为估算。**
   占位口径：百分比 = 该项估算 / 各分项估算之和（比值，系统性估算偏差在分子分母间相消，误差约 0.2–1.5pp，可信）；
   K = 该项估算原值（`estimateTokens`），与 DSH 的 `contextBreakdown` 口径一致。
   由此**分项 K 之和不等于顶部已用**——顶部 `used` 是 provider 实测，分项是本地估算，两者本就不同源
   （真机实测工具 schema 估算 20K，而整个请求 provider 只算 9K；DSH README 同样声明其 breakdown “will not sum to”
   占用值）。历史上曾用 `round(used × 占比)` 强行配平，但 `used` 含 output token，用含输出的分母乘纯输入的比例
   会把 output 摊进每个静态项，实测单请求虚高 0.3%–11%；且缩放系数随“实测/估算”比值漂移，
   导致内容一字未变的静态项数值来回跳（如 6.9K ↔ 6.5K）。改为估算原值后静态项稳定，交换代价是不再配平。
   旧快照无 `tokens` 时占比与 K 都退回字符口径。
4. **去掉 78% 展示阈值**：`CACHE_HIT_RATE_DISPLAY_THRESHOLD` 删除，平均缓存命中率恒显示。
   原设计是“低命中不分散注意力”，但表现是同一面板会随数值高低少一行，被当成 bug；用户要求稳定可见。

验收：面板四项（系统工具/系统提示词/消息/其他）都带括号 K 且带 `~` 前缀；分项 K 在内容不变时不随轮次漂移；
平均缓存命中率始终有行；胶囊与面板命中率同值同精度。
