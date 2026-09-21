# Composer TPS 统计胶囊

## 产品规则

输入框工具栏行水平居中展示一枚统计胶囊（宽度上限 50%，超宽截断），展示**当前会话最新一轮**的生成指标：

- 流式生成中：`● 21:03 · 32 tok/s · out 410`（out 为估算值，tok/s 为 4s 滑动窗口即时速度）
- 轮次结束后：`● 21:03 · 首 token 37s · out 1.7k`（out 为精确值，tok/s 为首文本→轮结束的解码速度）
- 绿点与时间常驻：存在可展示轮次即渲染；流式中绿点发亮，空闲静态。
- 分隔符 `·`；标签灰、数值白、tok/s 橙、`font-mono tabular-nums`。
- 轮次切换（含编辑重发/重试产生的新 turn）清零重算，杜绝「时间变新、指标是旧的」。
- 静默期（工具执行、文本停止增长）tok/s 保持最近值不消失。
- 切换会话：胶囊只从当前会话 snapshot 派生，天然零残留。
- 历史轮次（挂载前已开始）：无精确用量基线，只展示 `● 时间 · 首 token Xs`（首 token 可由行时间戳推导），不展示 out/tok/s，绝不拿估算冒充精确。
- 无可展示轮次（草稿态）不渲染；无假时钟。

## 状态所有者

唯一事实源为会话投影 store（`ConversationProjectionStore`，经 `useConversationProjection`/composer 已有 snapshot）：

- 轮次事实：最后一个 `TurnHeaderRow`（`startedAt` / `endedAt` / `state`）与其 `assistantTextRows`（流式 `text`、`createdAt`）。
- 精确 out：`snapshot.usage.cumulative.outputTokens` 在轮次边界的差值（轮开始时记录基线）。
- 流式估算：回答文本 token 估算（CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token），仅填充精确值到达前的空窗；精确值到达后以精确值为准。
- 派生状态（基线、滑动窗口采样、1s tick）只存在于 hook 的 ref/state 中，不新建 store、不落盘、不进协议。

## 接口

- `packages/ui/src/v4/composer/composerTurnStats.ts`：纯函数（文本 token 估算、滑动窗口速度、展示模型选择）+ `useComposerTurnStats(snapshot)` hook，返回 `ComposerTurnStatsView | null`。
- `packages/ui/src/v4/composer/ComposerTpsCapsule.tsx`：纯展示组件，props 为展示模型 + intl/locale。
- `ChatPromptEditor` 新增可选 prop `toolbarCenterNode`，在工具栏行（加 `relative`）绝对居中渲染；不参与 `useComposerToolbarFit` 测量（与补丁版同样的窄宽度重叠取舍，靠 50% 上限缓解）。
- `ConversationComposer` 用自有 snapshot 计算并传入该 node。
- i18n：`chat.toolbar.tpsStats.firstToken`、`chat.toolbar.tpsStats.out`（zh-CN / en-US 同键）。

## 事件顺序与幂等

```
row.delta / usage 更新 → projection store 通知 → composer 重渲染
   └→ hook 派生：turnId 变化？记录基线并重置窗口
        └→ 展示模型 = f(轮次行, cumulative 差值, 文本估算, 窗口采样, now)
1s tick（仅 running 时）→ 刷新估算展示（无新数据时展示模型签名不变，零 DOM 写）
```

- 基线按 turnId 幂等记录（同 turnId 重复渲染不重置）。
- 轮次结束以 `TurnHeaderRow.state !== "running"` 为准；结束后停止 tick。

## 验收场景

1. 流式轮：胶囊显示绿点亮 + 时间 + tok/s + 估算 out；文本停止增长期间 tok/s 保持最近值。
2. 轮结束：out 切换为精确 cumulative 差值；tok/s = 精确 out ÷（endedAt − 首文本 createdAt）。
3. 编辑重发产生新 turn：指标清零重算，不残留旧轮数值。
4. 切到历史会话：仅 `● 时间 · 首 token Xs`。
5. 草稿态/无轮次：不渲染。
6. 单测：`packages/ui/test/composerTurnStats.test.ts` 覆盖 token 估算、滑动窗口速度（含静默期保持）、展示模型选择（流式/结束/历史/空）。
