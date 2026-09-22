# 项目重命名（显示名）

## 产品规则

- 侧栏「项目」行「…」菜单在「移除」上方新增「重命名」：点击弹出输入框，确认后该项目行显示新名字。
- **只改显示名**：磁盘文件夹名、workspacePath、workspaceIdentity、会话与任务索引、git 引用一律不变；
  因此本地与远程（SSH）项目行为一致，也不会影响正在运行的会话。
- 显示名按 workspace 身份 key（`workspaceIdentity?.trim() || workspacePath`）持久化到本地偏好，
  重启后保留；输入留空并确认表示清除覆盖，回退显示文件夹名。
- 显示名生效范围：侧栏项目行标签、窗口头部项目名（同一工作区）；工具提示仍展示真实路径。
  其余引用 `tab.label` 的逻辑（如任务默认标题）保持用文件夹名，避免显示名泄漏进业务数据。
- 显示名只影响展示，不参与去重、路由、缓存与请求关联（这些继续用身份 key）。

## 状态所有者与接口

- 持久化：`packages/ui/src/lib/workspaceDisplayNamePreference.ts`
  （localStorage key `zcode-workspace-display-names`，`Record<workspaceKey, string>`，trim + 长度上限，
  空值即删除条目）。
- 内存态：`packages/ui/src/store/workspaceDisplayNameStore.ts`（zustand：`names` / `setName` / `clearName`；
  创建时从偏好读取，写入时同步持久化）；选择器 `useWorkspaceDisplayName(workspaceKey)`。
- 入口：`WorkspaceSidebarItem` 菜单项 + 复用 `TaskRenameDialog`（新增可选 `titleId` / `placeholderId`，
  默认仍为任务重命名文案）。
- 头部：`App.tsx` 的 `projectName` 优先取显示名，回退 `getPathLeaf(workspaceAbsPath)`。
- i18n：`workspaceSidebar.rename`、`workspaceSidebar.renamePlaceholder`（zh-CN / en-US 同步）。

## 验收场景

1. 项目「…」菜单里「重命名」在「移除」上方；点击弹出对话框，输入新名字确认后该行立即改名。
2. 重启应用后显示名保留；头部项目名与侧栏一致。
3. 输入清空并确认 → 恢复显示文件夹名。
4. 重命名不影响任务列表、会话、路径与远程连接；磁盘目录名不变。
5. 取消/ESC 不改动显示名。
