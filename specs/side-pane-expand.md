# 侧边面板铺满（Side Pane Expand）

侧边面板（右侧 tab 栏那一栏）新增「扩大面板 / 恢复面板宽度」切换：铺满时整栏覆盖内容区，
左侧文件树保持可见可点。与「切换面板」按钮同排共用，**对任何 tab 都生效**（文件预览、浏览器、
终端、审查、辅助对话等），不是只给文件预览用的专属功能。

本功能只放大**呈现层**，不改分栏比例，也不改 tab/source 身份。

## 产品规则

- 入口：标签栏右侧按钮组内，位于「切换面板」按钮左侧。
  与「切换面板」同排、同在 `[app-region:no-drag]` 容器里——这是**必需的**，
  见下方「为什么按钮必须在标签栏」。
- 铺满几何：面板帧（`data-workspace-side-frame`）改为 `fixed`，上/下/右贴内容区边，
  **左边界锚定侧栏宽度**，因此左侧文件树始终可见可点。
- **标签栏保持原位不动**：铺满只把「底部内容区」撑满，不替换标签栏，也不改变 tab 的排布。
  这与 MyFlicker 一致：顶部 tab 那一栏不变，只是内容铺开。
- 退出方式二选一：再点同一按钮；或按 `Esc`。
- 铺满不改变用户拖拽出的分栏比例：退出后恢复到进入前的实际宽度。实现上靠「不动布局」自然满足，
  不额外保存/恢复尺寸。
- 放大态是**面板级 UI 呈现状态**，不持久化、不进 store、不进协议：刷新或重启后回到普通宽度。
- 以下情况自动复位为普通宽度：面板收起。
- 切 tab 不退出铺满（能力是面板级的，与当前 tab 类型无关）。
- 复用既有 i18n key：`sidePane.maximize`（扩大面板 / Expand panel）与
  `sidePane.restoreSize`（恢复面板宽度 / Restore panel width）。**不新增 key**。
  这两个 key 是上游遗留、当前代码零引用的。

## 为什么按钮必须在标签栏（实现约束，勿改）

macOS 上标签栏所在的 `TabsList` 带 `[app-region:drag]`（窗口拖拽区）。该区域里的按钮要可点，
必须处在 `no-drag` 子树中：`TabsList` 用 `[&_button]:[app-region:no-drag]` 覆盖自己的后代，
而 `closeSidePaneButton` 那组本身带 `[app-region:no-drag]`。

**历史事故**：第一版把按钮放在预览内容层，铺满后按钮视觉上落到标签栏位置，但不在
`TabsList` 的 DOM 后代里、也不在 `no-drag` 容器中，真实鼠标点击被 OS 当成拖窗口吞掉——
`Esc` 能退出，但按钮点不动。CDP 合成事件绕过 OS 这层，所以自动化验证测不出来，
**只有真实鼠标点击才能发现**。把按钮放进 `closeSidePaneButton` 那一组即天然免疫。

## 状态所有者

- 唯一持有者：`AnimatedSidePanePanel` 的本地 `useState`（面板呈现状态，非业务状态）。
- 有效态由纯函数派生，不做第二份存储：

  ```text
  isSidePaneExpanded (面板本地 state)
        └─ shouldApplySidePaneExpanded(isExpanded ∧ 面板可见)
              └─ 生效值 → 帧样式（fixed 覆盖）
  ```

- 面板收起时由 effect 把本地 state 复位为 `false`，避免「再打开时莫名又是铺满态」。
- 与既有 `revealSidePaneForCurrentOwner`（点文件时强制 `isSidePaneCollapsed = false`）**无耦合**：
  放大态不落在折叠态上，所以点文件不会顶掉铺满。这是不改布局的直接收益。

## 接口

- `packages/ui/src/app-shell/animatedSidePanePanelModel.ts`：纯判定
  `shouldApplySidePaneExpanded({ isExpanded, isSidePaneVisible })`。
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`：持有 state、派生生效值、复位 effect；
  生效时给面板帧加 `fixed` 覆盖样式；标签栏按钮组内渲染切换按钮（`data-testid` =
  `TID_SIDE_PANE_EXPAND`）。
- `packages/shared/src/test-ids.ts`：新增 `TID_SIDE_PANE_EXPAND`。
- `PreviewPane` **不参与**本功能（第一版曾把状态放这里，因上述 app-region 问题与
  「只对 code-viewer 生效」的偏差而回退）。
- 不新增 i18n key；不改 `resolveAnimatedSidePanePanelLayout` 的 `minSize`/`maxSize` 约束；
  不改 `useAnimatedResizablePanel` 签名（三者都是上游恢复同类功能的必改点，避开以缩小冲突面）。

## 验收场景

1. 打开任一 tab（文件预览 / 浏览器 / 终端均可）：标签栏出现「扩大面板」按钮，与「切换面板」同排。
2. 点击：面板铺满内容区，**标签栏留在顶部原位**，左侧文件树仍可见、仍可点击切换文件。
3. 铺满态点左侧另一个文件：新开/复用 tab 并保持铺满。
4. 在浏览器 tab 上同样能铺满（证明与 tab 类型无关）。
5. **再点同一按钮能收回**（真实鼠标点击，不是合成事件）。
6. `Esc` 或再点按钮：恢复为进入前的宽度，用户此前拖拽出的分栏比例未被改写。
7. 收起侧栏：放大态复位。
