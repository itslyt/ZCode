# 对话执行中底部时长条（Conversation Running Elapsed）

自用 fork 新增：长轮次下轮顶的「工作中 N 秒」会被滚出视口，用户必须往上拉回问题处才能看到执行了多久。

## 产品规则

- 最后一个 render unit 仍在运行时，在 composer（及其上方的队列面板 / 横幅）**之上**、同一条内容列宽内，左对齐显示一条常驻时长文案。
- 文案与轮顶同段标签**逐字一致**：同一个 i18n key `chat.history.workingFor`（`工作中 {duration}` / `Working for {duration}`），
  同一个 `formatConversationWorkDuration` 时长写法，同一个 `workStatus.durationMs` 事实。两处必须是同一个数，
  否则用户面对两个时钟（同一个耗时在两处显示成两个值）。
- 取「最后一个仍在运行的视觉工作段」的耗时：guide 切出多段时只有最后一段是活的，前段已冻结；
  显示活段耗时，不是整轮累计。
- 只在以下条件同时成立时渲染，其余情况一律不渲染（不显示空壳、不显示 0）：
  - 最后一个 render unit `isRunning`；
  - 该 unit 最后一段 `workStatus.state === "running"`；
  - 该段 `durationMs` 有值（缺 `startedAt` 的旧投影不给假读数）。
- 不渲染的场景：完成/中断轮、只读 subagent pane（无 composer dock）、分享态（dock 被确认区替换）、草稿态（无 row）。
- 视觉：`text-ui-base text-foreground-subtle` + `tabular-nums`，不引入新的动画与图标；位置与队列面板的顺序对齐 DSH
  （时长在上、任务/队列条在下）。

## 状态所有者

- **唯一时钟仍是 `ConversationTimeline` 的 `liveNowMs` + `renderUnits`**（运行中每 1s 重建一次，完成态拒绝吃当前时钟）。
  新组件是纯展示：不新建 `setInterval`、不新建 store、不新增轮询、不从 SessionPane 复制一份 running 判断。
- 新逻辑只有一个纯派生函数 `resolveRunningWorkElapsedMs`，输入 render unit 的 `{isRunning, workSegments}` 子集，
  因此可单测且不依赖 DOM。

## 接口

- `packages/ui/src/v4/conversationRunningElapsedModel.ts`：纯派生 `resolveRunningWorkElapsedMs`
  （文件名带 `Model` 后缀：与组件 `ConversationRunningElapsed.tsx` 只差首字母大小写会触发 TS1261）
- `packages/ui/src/v4/ConversationRunningElapsed.tsx`：展示组件（读 `chat.history.workingFor`）
- `packages/ui/src/v4/ConversationTimeline.tsx`：在 `data-v4-composer-dock-content` 内、`data-v4-back-to-bottom-anchor` 之前渲染；
  同时把消息渐隐 mask 的透明起点从固定 96px 改为实测 dock 高度（见下）
- `packages/shared/src/test-ids.ts`：`TID_V4_RUNNING_ELAPSED = "v4-running-elapsed"`
- 协议、CLI、DB 均不改动：数据本来就随 `turnHeader.startedAt/activeMs` 下发。

## 验收场景

1. 长轮次执行中：滚到页面底部也能看到「工作中 N 秒」，每秒推进；数字与轮顶该段标签相同。
2. 轮次完成：底部条消失（不残留「工作中」），轮顶改为「已工作 N 秒」。
3. 有 guide 的多段轮：底部显示活段耗时；前段仍冻结在轮顶各自标签里。
4. 只读 subagent pane / 分享态 / 草稿态：不出现该条。
5. 单测：`packages/ui/test/conversationRunningElapsed.test.ts` 覆盖 running / 完成 / 缺段 / 缺 durationMs / 多段取末段。

## 顺带修掉的旧缺陷（消息渐隐 mask）

时间线的消息渐隐 mask 把透明起点写成固定 `COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96`，
等于假设 dock 就是 96px 高。新时长条把 dock 顶到 151px，比 96px 高出的那 29px 不在透明区内，
离底上滚时消息文字会直接透在时长条后面（真机截图确认两串字叠在一起、都不可读）。

队列面板、quota 横幅、Hook 审核横幅本来就会改变 dock 高度，所以这是既有缺陷，
只是时长条把它推到了肉眼可见。修法：透明起点取 `composerDockRef` 的实测高度（拿不到时回退旧常量），
并让已有的 ResizeObserver 同时观察 dock，高度变化时重算 mask。
