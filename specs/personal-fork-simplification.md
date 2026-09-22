# 个人化精简：去掉更新/引导/自动化入口/建议胶囊，默认完全访问

状态：已实现。背景：`custom` 分支是自用 fork，用户明确"这个 zcode 就我自己在用"，要求按个人使用习惯改造：
只保留编程模式相关的入口，去掉会覆盖自建包、以及用不到的引导与推荐。

## 1. 去掉自动更新检测与更新入口

产品规则：

1. 不再自动检查更新（自建 Preview 包被官方更新覆盖会丢掉本 fork 的改动）。
2. 不再出现更新入口（标题栏更新徽标、帮助菜单"检查更新"）。
3. 不触发远端强制升级拦截（`maybeBlockStartupForForceUpdate`）。

实现：`packages/desktop/src/main/index.ts` 的 `initAutoUpdater({ enabled })` 改为常量 `AUTO_UPDATE_ENABLED = false`；
UI 侧移除 `DesktopTopOverlay` 的 `UpdateStatusButton` 与帮助菜单里的检查更新项。
更新模块本身保留（不删上游代码，恢复只需把常量改回 true）。

## 2. 去掉系统设置里的引导入口

`packages/ui/src/SettingsPage.tsx` 侧栏底部的"引导"按钮（`Rocket` 图标 → `open_onboarding`）移除。
`OccupationOnboarding` 组件保留（首次启动流程不受影响，用户已走过）。

## 3. 侧边栏去掉自动化入口

`packages/ui/src/WorkspaceSidebar.tsx` 的"自动化"按钮（`TID_AUTOMATIONS_OPEN` → `handleOpenAutomationsMain`）移除。
自动化页面本体保留在路由里（未注册工具面已使其不可用），只去掉入口。

## 4. 新建任务默认权限改为完全访问

`permission.mode` 默认值 `"build"`（界面文案"变更前确认"）→ `"yolo"`（"完全访问"），
位于 `apps/zcode-cli/packages/contracts/src/config/index.ts` 的 `DefaultRuntimeConfig`。

注意：项目级"上次选择"（session DB `local_setting`）优先于默认值，所以**已存在且切过模式的项目仍用其持久值**；
新项目、以及没有持久值的项目走新默认。要全局统一需在界面里切一次，或清掉 `local_setting` 里的对应行。

## 5. 去掉空态建议胶囊（周报总结 / 报错修复 / PPT 制作 / 闲时任务）

原理（用户提问）：

- 胶囊列表来自 **Client Scenes 的 `draft-suggestion` 远端场景配置**，本地 `featureSuggestedPrompts` 是回退语料。
- 点前三个只是把一段**预置提示词**填进输入框（`resolveDraftSuggestedPromptText`），本身不含任何自动化能力；
  文案由服务端下发，所以本地 i18n 里搜不到"周报总结""报错修复"。
- "闲时任务"是带 `DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK` 动作的导航项，点了跳自动化页。
- 结论：前三个是纯提示词模板（可自己手打），第四个是导航捷径——对"只写代码"的场景都没用。

实现：`packages/ui/src/v4/SessionPane.tsx` 不再挂载 `ConversationDraftSuggestedPromptsContainer`（同时去掉主动推荐区）。
容器组件保留（上游代码），只取消挂载点。

## 验收

1. 启动后标题栏无更新徽标、帮助菜单无"检查更新"；`~/.zcode` 日志无 `[auto-update]` 检查记录。
2. 设置侧栏无"引导"入口。
3. 侧边栏无"自动化"入口。
4. 新项目新建任务，输入框权限显示"完全访问"。
5. 空态无四个建议胶囊。
6. `pnpm typecheck` / `pnpm lint` / `pnpm fmt:check` / `pnpm architecture:check --changed` 全绿。
