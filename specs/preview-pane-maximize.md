# 预览面板铺满（Preview Pane Maximize）

文件预览（`code-viewer` tab）新增「扩大面板 / 恢复面板宽度」切换：铺满时预览覆盖整个内容区，
左侧文件树保持可见可点，形似 VS Code 一类编辑器的「看图/看文档铺满」体验。

本功能只放大**呈现层**，不改分栏比例，也不改 tab/source 身份。

## 产品规则

- 入口：预览头部按钮簇内一枚图标按钮，位于「更多」菜单与「用编辑器打开」之间。
  仅在 `code-viewer` tab 且面板可见时渲染（沿用 `PreviewPane` 只在 `code-viewer` 分支挂载的现状）。
- 铺满几何：预览 `<aside>` 变为 `fixed`，上/下/右贴窗口边，**左边界锚定侧栏宽度**，
  因此左侧文件树始终可见可点——这是本功能与「关闭侧栏再看文件」的区别所在。
- 退出方式二选一：再点同一按钮；或按 `Esc`。
- 铺满不改变用户拖拽出的分栏比例：退出后恢复到进入前的实际宽度。实现上靠「不动布局」自然满足，
  不额外保存/恢复尺寸。
- 放大态是**会话级 UI 呈现状态**，不持久化、不进 store、不进协议：刷新或重启后回到普通宽度。
- 以下任一情况自动复位为普通宽度：切到非 `code-viewer` tab、侧栏收起、关闭预览 tab、切 workspace。
- 铺满期间点左侧文件：正常开/复用 tab（复用规则见 `workspaceSidePane.ts` 的 `openCodeViewerSidePane`），
  **放大态保持**。不复用逻辑做任何分支——同一文件在两种宽度下必须是同一条写入路径。
- 复用既有 i18n key：`sidePane.maximize`（扩大面板 / Expand panel）与
  `sidePane.restoreSize`（恢复面板宽度 / Restore panel width）。**不新增 key**：
  这两个 key 是上游遗留、当前代码零引用的，复用可避免将来上游恢复同名功能时出现重复 key。

## 状态所有者

- 唯一持有者：`AnimatedSidePanePanel` 的本地 `useState`（面板呈现状态，非业务状态）。
- 有效态由纯函数派生，不做第二份存储：

  ```text
  isMaximized (面板本地 state)
        └─ shouldApplyPreviewPaneMaximized(isMaximized ∧ 面板可见 ∧ active tab 是 code-viewer)
              └─ 生效值 → PreviewPane 的 isMaximized prop
  ```

- 派生失效（切走 tab / 收起面板）时由 effect 把本地 state 复位为 `false`，
  避免「切回来莫名又铺满」。
- 与既有 `revealSidePaneForCurrentOwner`（点文件时强制 `isSidePaneCollapsed = false`）**无耦合**：
  放大态不落在折叠态上，所以点文件不会顶掉放大。这也是本方案不改布局的直接收益。

## 接口

- `packages/ui/src/app-shell/animatedSidePanePanelModel.ts`：新增纯判定
  `shouldApplyPreviewPaneMaximized({ isMaximized, isSidePaneVisible, activeTabType })`。
- `packages/ui/src/PreviewPane.tsx`：新增可选 props `isMaximized` / `onToggleMaximized`。
  铺满时 `<aside>` 追加 `fixed inset-y-0 right-0 left-[var(--workspace-sidebar-panel-width,0px)] z-30`
  并输出 `data-preview-pane-maximized`；`Esc` 监听仅在放大态挂载，且 `event.defaultPrevented`
  时不抢（不打断已打开的 DropdownMenu/Dialog）。
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`：持有 state、派生生效值、复位 effect，
  经 `code-viewer` 分支把两个 props 传给 `PreviewPane`。
- 左边界 CSS 变量由 `WorkspaceShellLayout` 的 `workspaceShellSplitStyle` 下发，
  组件内以 `var(...,0px)` 带兜底引用——与既有 `var(--workspace-panel-radius,...)` 同一种用法。
- 不新增 i18n key；不改 `resolveAnimatedSidePanePanelLayout` 的 `minSize`/`maxSize` 约束；
  不改 `useAnimatedResizablePanel` 签名（三者都是上游恢复同类功能的必改点，避开以缩小冲突面）。

## 验收场景

1. 打开任一文件预览：头部出现「扩大面板」按钮。
2. 点击：预览铺满内容区，左侧文件树仍可见、仍可点击切换文件；按钮变为「恢复面板宽度」。
3. 铺满态点左侧另一个未打开过的文件：新开 tab 并保持铺满；点回已打开过的文件：复用切回，仍铺满。
4. `Esc` 或再点按钮：恢复为进入前的宽度，用户此前拖拽出的分栏比例未被改写。
5. 铺满态切到浏览器/终端等非预览 tab，或收起侧栏、关闭预览 tab、切 workspace：放大态复位。
