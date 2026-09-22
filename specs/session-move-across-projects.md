# 会话移动到其他项目（re-key 移动）

## 产品规则

- 侧栏任务右键菜单新增「移动到项目…」：弹出项目选择对话框，选中目标项目即执行移动（选择即确认）。
- 移动是**真·re-key**：同一个会话（session id 不变、历史消息不变、usage 不变），只改它的项目/工作区绑定；
  移动后该任务出现在目标项目列表，源项目列表不再显示；后续 resume 的 cwd 与提示词根目录变为目标项目路径。
- 候选项目：仅**本地**项目（远程 SSH 项目既不能作为源也不能作为目标），排除当前项目，排除不可用目录。
- v1 边界：
  - **运行中的任务禁止移动**（对话框内该任务不可选/给出禁用原因）。
  - **远程 workspace 的任务禁止移动**（入口可见，对话框给出「远程项目暂不支持移动会话」提示）。
  - **运行中的任务禁止移动**（对话框给出原因）：运行中的会话 cwd 已绑定源目录；持久化 running 可能滞后，有本地 runtime 状态时以它为准。
  - 任务当前在 pane 中打开**不**阻止移动：移动成功后**清掉源项目里该任务的打开态**（pane 绑的是源 workspace，留着会继续用旧根目录与旧 Environment 提示词），从目标项目重新打开即按新根 resume。
  - **提示词里的根目录必须跟着走**：resume 时若持久化 env 快照的 `cwd` 与 `session.directory` 不一致（移动后的正常情况），丢弃该快照、让 context source 按新目录重新探测，否则 Primary working directory / git 事实会停在源项目。
  - **目标项目只列本地可用目录**（远程项目不作为目标）。
  - 移动后该任务的 git checkpoint 留在源工作区目录（按 `getWorkspaceHash(workspacePath)` 存放），从新项目不可达，不主动删除。
  - 不迁移工作区记忆、不改写历史消息里的绝对路径、不处理分享链接（用户不使用这些能力）。
  - 自动化/闲时任务关联不迁移（v1 该能力将下线；若索引行带 `cron_automation_id`/`off_peak_task_id`，移动后这些关联保持在源 workspace，不阻断移动）。
- 失败不静默：任一步失败则提示失败原因，并保证可重试（re-key 幂等：目标绑定已生效时重复执行无副作用）。

## 状态所有者与接口

数据层有两处绑定必须一起改，顺序固定：**先会话行，后任务索引**（会话行是 resume 根目录的权威来源）。

管理类 RPC（移动、物理删除）不得使用 `existing-only` client 策略：agent 空闲被回收后它会直接抛 runtime unavailable，
导致「项目当前没在跑」时移动/删除全部失败（现象是通用失败提示，索引已 tombstone 但磁盘数据没删）。两者都改为按需拉起只读 client。

1. **会话行（CLI 会话库，权威）**
   - 新增 `SessionStorePort.moveSession({ sessionID, projectID, workspaceID?, directory })`；
     单事务更新 `session.project_id / workspace_id / directory`（`updateSession` 目前不覆盖 project/workspace 列）。
   - `projectID = projectIdFromDirectory(targetWorkspacePath)`（`bootstrap/src/app/paths.ts:29`）；
     `workspaceID = targetWorkspaceIdentity`（本地为 null）。
   - 暴露为 v4 RPC `v4/conversation/move`（params `{ sessionId, targetWorkspacePath, targetWorkspaceIdentity? }`），
     handler 走 sessionStore（existing-only，不拉起 runtime）。
2. **任务索引（tasks-index.sqlite）**
   - 新增 `taskIndexRepo.moveTask({ taskId, workspacePath, workspaceIdentity, targetWorkspacePath, targetWorkspaceIdentity })`：
     按源 `workspace_key` 定位并改写 `workspace_key / workspace_path / workspace_identity`，保留 pinned/unread/archived/title 等状态。
   - `IZCodeTaskService.moveTask(...)`（`packages/services/src/zcode-agent/zcodeTask.ts` + adapter）负责编排：
     先 `zcodeAgentService.moveConversation(...)`（会话行），成功后 index re-key，再删该任务 checkpoint，最后广播事件。
3. **事件与缓存**
   - 源 workspace 发 `task_deleted` 语义的移除事件，目标 workspace 发 `task_meta_changed` 语义的新增事件；
     UI 侧清源项目缓存（membership / pinned / timeline store）并把任务加入目标项目。
   - 任务若在标签页/分屏中打开：移动前关闭该任务的标签（避免"任务在新项目、面板仍在旧项目"的错位）。
4. **UI**
   - 入口：`TaskActionMenuContent`（平铺/时间线/置顶共用）与分组菜单 `task-context-menu-content.tsx` 各加一项。
   - 对话框：新增共享 `TaskMoveToProjectDialog` + `taskMoveToProjectStore`（pending 任务 + 候选项目列表来自 tab store 的本地项目），
     在 App 层挂载一次；选择项目后执行移动、toast 结果。
   - i18n：`taskList.moveToProject`、`taskList.moveToProjectTitle`、`taskList.moveToProjectEmpty`、
     `taskList.moveToProjectFailed`、`taskList.movedToProject`（zh-CN / en-US 同步）。

## 验收场景

1. 右键任务 →「移动到项目…」→ 对话框列出其他本地项目（不含当前项目、不含远程、不含不可用目录）。
2. 选择目标项目 → 任务从源项目列表消失、出现在目标项目列表；重启后仍在目标项目。
3. DB 直查：`session.project_id/workspace_id/directory` 与 `tasks.workspace_key/workspace_path/workspace_identity` 均已指向目标；session id 与消息、usage 行不变。
4. 在目标项目打开该会话 → 正常恢复，且 cwd/提示词根目录为目标项目路径。
5. 运行中任务：对话框内给出禁用原因，不可移动；远程项目任务不显示该入口。
6. 移动后设置里的总用量统计不减少（usage 行未动）。

## 实测记录

- 真机（`pnpm dev:desktop` + CDP）：任务右键菜单出现「移动到项目…」；对话框只列其他本地项目（排除当前项目）；
  选中目标后 toast「已移动到目标项目」，任务从源项目列表消失并出现在目标项目下。
- DB 直查：`tasks.workspace_key/workspace_path` 已指向目标；`session.project_id/directory` 同步改写；
  `turn_usage`/`model_usage`/`message` 行数移动前后一致（15/48/70）。
- 单测：`packages/services/test/taskIndexMove.test.ts` 覆盖 re-key 后状态保留（unread/pinned）、源列表清空、目标列表出现与幂等重试。
- 坑位：dev 桌面里 Agent 进程不继承 `ZCODE_DATA_BASE_DIR`（Host 继承、Agent 落回 `~/.zcode`），
  隔离验证时会把移动写进真实会话库；验证后已把真实库改回原绑定。详见 `CUSTOM_DEV_WORKFLOW.md`。
- 回归修复实测（真实数据，验证后已回滚）：置顶区里属于 default（无文件夹工作区）的任务
  `sess_44959a56` 移到 LLMentor 成功（session/index 双写、pinned 保留）；刚打开成为 active 的任务
  再次打开对话框只列候选项目、不再出现「正在打开」拦截。
- 根目录跟随实测（用户提供的测试会话）：`sess_2e1f925c` 的持久化 env 快照 cwd 仍是 default，移到 server 后冷开问目录，答 `…/packages/server`（新根）；
  `sess_88d90c26` 在 server pane 中问得 `…/packages/server` → 移动到 LLMentor 后源 pane 被清空 → 从 LLMentor 重开再问得 `…/Work/LLMentor`。
