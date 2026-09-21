# 移除反馈入口（自构建版不需要）

## 产品规则

- 侧栏/会话右键菜单不再提供「反馈问题」入口：分组视图菜单、项目平铺/时间线/置顶区共用的
  `TaskActionMenuContent`、会话头部菜单三处一并移除。
- 每轮 assistant 消息操作行不再提供「赞 / 踩」：只保留复制、（可用时）分支等操作。
- 协议与服务层保持不动：`setAssistantFeedback` 命令、`AssistantMessageFeedback` 投影字段与
  V4 row 字段继续存在（仅 UI 不再产生调用），避免影响旧客户端与后续恢复。
- 移除后不留死代码：不再可达的 handler、props 钻链、i18n key、test-id 导出与相关 import 一并清理。

## 状态所有者与接口

- 菜单：`TaskActionMenuContent`（共享）与 `workspace-grouped-tasks/task-context-menu-content.tsx`（分组）
  删除反馈项及其 `onOpenTaskFeedback` prop；`TaskListItem`、`WorkspaceHeaderSections`、`task-row`
  删除本地构造的反馈 handler（`openFeedbackSubmit` / `buildTaskFeedbackDescription` / toast）。
- 消息操作行：`v4/ConversationRowView.tsx` 的 `ConversationAssistantTextActions` 删除赞踩按钮及其
  `feedback` / `onFeedbackChange` props、`localFeedback` 本地态、`handleFeedback` 与遥测上报；
  钻链 `ConversationTurnRow` / `ConversationTurnGroup` / `ConversationTimeline` / `SessionPane`
  同步删除 `onFeedbackChange`，`SessionPane.handleAssistantFeedback` 一并删除。
- i18n：删除 `taskList.feedback`、`taskList.feedbackOpened`、`chat.message.like`、`chat.message.liked`、
  `chat.message.dislike`、`chat.message.disliked`（zh-CN 与 en-US 同步）。
- test-id：删除 `TID_V4_FEEDBACK_LIKE` / `TID_V4_FEEDBACK_DISLIKE` 导出。

## 验收场景

1. 右键任意会话（平铺/时间线/置顶/分组）菜单底部只有「删除任务」，没有「反馈问题」。
2. 会话头部菜单同样没有「反馈问题」。
3. 每轮 assistant 消息操作行没有赞/踩按钮，复制等其余操作正常。
4. `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check` 通过；无残留 import 或未使用导出报错。
