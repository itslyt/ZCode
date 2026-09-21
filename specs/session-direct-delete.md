# 会话直接删除（右键彻底删除 = 物理删除）

## 产品规则

- 侧栏任务右键菜单新增「删除任务」项（分组列表），点击后弹确认框；确认后该任务**彻底删除**：
  不再需要"先归档 → 归档列表 → 删除"两步。
- **彻底删除 = 物理删除**：CLI 会话库中该 session 的全部数据（session / message / part / session_entry /
  session_input / session_target / session_task_link / todo / model_usage / tool_usage / turn_usage）
  单事务删除，释放磁盘空间；同时 task index 写 deleted tombstone，列表与索引不再返回、重启不复活。
- 删除顺序：先 tombstone（归档 guard 与写入同事务，防"确认框停留期间被恢复"竞态）→ 再 purge CLI 物理删除；
  purge 失败仅 error 日志（列表语义已完成，空间问题留痕可查）；purge 按 session_id 删除、0 行视为成功，幂等。
- **既有删除链路同语义升级**：「归档列表删除单个 / 删除所有归档」原为仅 tombstone（CLI 内容保留），现统一在 tombstone 后追加物理删除；确认文案同步改为物理删除表述。
- 确认框为破坏性操作二次确认：标题「删除这个任务？」，描述明示"会话数据将被永久删除、释放磁盘空间、无法恢复"。
- 进行中/已读/未读/置顶状态不影响可删除性；删除当前打开的 task 不强制关 tab（tab 再读取按会话不存在处理）。
- 子会话（session_task_link 关联）不级联删除内容，仅删除 link 行；父会话删除后子会话仍独立存在。

## 状态所有者与接口

- 物理删除：`SessionStorePort.deleteSession({ sessionID })`（adapters `repositories/sessions.ts` 单事务）；
  经新 RPC `v4/conversation/delete`（params `{sessionId}`，result `{sessionId}`）暴露，handler 走 sessionStore。
- 列表隐藏：task index tombstone（既有 `updateIndexedTaskState(deleted:true)` / `taskIndexRepo.deleteArchivedTask`）。
- 编排：`zcodeTaskServiceAdapter` 的 `deleteTask` / `deleteArchivedTask(s)` 改为先
  `zcodeAgentService.deleteConversation`（existing-only）再 tombstone。
- UI 持有者：`WorkspaceGroupedTasksSection.handleDeleteTask`（confirm + 调用 service + 缓存/membership 后处理）；
- 菜单展示（两处 surface）：分组视图 `workspace-grouped-tasks/task-context-menu-content.tsx`；项目平铺列表
  `TaskActionMenuContent.tsx`（经 TaskListItemContextMenu / TaskListItemContextMenuContent / TaskList 钻链，
  handler 由 `useTaskPermanentDelete` hook 提供，WorkspaceSidebarItem 注入）。置顶区与会话头部菜单暂不注入
  （onDeleteTask 缺省时不渲染删除项）。
- i18n：`taskList.delete`、`taskList.deleteFailed`、`confirmDialog.taskDeleteTitle`、
  `confirmDialog.taskDeleteDescription`；`confirmDialog.archivedTaskDeleteDescription` 文案改物理删除表述。

## 验收场景

1. 右键活跃会话 → 菜单含「删除任务」→ 取消 → 列表与数据不变。
2. 确认 → 行立即从列表消失、重启不复活；DB 直查该 session 在 session/message/part/usage 各表 0 行；磁盘占用下降。
3. 归档列表单个删除 / 删除所有归档：同样物理删除（DB 0 行）。
4. 删除失败（如 host 不可用）→ toast 失败，任务保持可见，数据不变。
5. Web 端与桌面端行为一致（同一 UI 与 service 链）。
