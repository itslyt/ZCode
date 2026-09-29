# 界面主题默认值：首次启动跟随系统

## 背景

界面主题的持久化键是 localStorage `zcode-theme`。历史上"没有该键时的兜底值"是 `zai-dark`，
但这个默认值不是一处而是散落在 7 个入口里各自写死字面量（store、`useTheme` hook、桌面 renderer 首屏、
资源管理器窗口、Web 种子、`web/index.html` 内联脚本、Web 入口）。设置页下拉把「系统」排在第一位，
但选中项是 `zai-dark`，因此首屏看起来"默认就是深色"。

本次把默认值改成「系统」（跟随操作系统亮暗），并把默认值与偏好解析收敛到唯一所有者。

## 产品规则

- 首次启动（`zcode-theme` 不存在或值非法）时，界面主题为「系统」：按 `prefers-color-scheme` 解析为亮/暗，
  并随系统偏好变化实时切换。
- 已有用户偏好优先：`zcode-theme` 是合法值时继续沿用，新默认不覆盖老偏好。
- legacy 别名保留：存储值 `dark → zai-dark`、`light → zai-light`（沿用现有归一逻辑，不改语义）。
- 会话分享落地页例外保持不变：无本地偏好时仍用浅色（`zai-light`），不跟随系统。
- 主题选项集合、设置页与侧栏下拉的取值、CSS token、代码预览主题（`Minimal Light/Dark`）均不变，
  变化的只是"当前选中项"与首屏结果。

## 状态所有者与接口

**唯一所有者：`packages/ui/src/useTheme.ts`**（既有模块，已拥有 `Theme` 类型、`resolveTheme`、`applyTheme`）。
新增两个导出，其余入口一律改为引用它，不再各写 `|| "zai-dark"`：

| 导出                                                          | 语义                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `DEFAULT_THEME_PREFERENCE: Theme = "system"`                  | 无本地偏好时的默认主题                                             |
| `isTheme(value: string \| null \| undefined): value is Theme` | 运行时字面量校验（原为模块内私有 `isTheme`，改为导出）             |
| `resolveStoredThemePreference(stored): Theme`                 | 合法存储值优先并经 `normalizeThemePreference` 归一，否则返回默认值 |
| `applyTheme(theme)`（既有，新增外曝）                         | 应用亮暗 class 与浏览器主题面；各入口首屏统一调它                  |

`normalizeThemePreference` 保持原地不动（`dark/light → zai-*`），避免跨文件搬动造成循环依赖。

读取路径（全部收敛到同一 helper）：

```text
localStorage["zcode-theme"]
        │
        ├─ resolveStoredThemePreference ──► Zustand store.theme        (packages/ui/src/store/index.ts)
        ├─ resolveStoredThemePreference ──► useTheme() hook            (packages/ui/src/useTheme.ts)
        ├─ DEFAULT_THEME_PREFERENCE     ──► 桌面 renderer 首屏脚本     (packages/desktop/.../main.tsx)
        ├─ DEFAULT_THEME_PREFERENCE     ──► 资源管理器首屏脚本         (packages/desktop/.../resource-manager.tsx)
        ├─ WEB_DEFAULT_THEME 委托       ──► Web 入口                   (packages/web/src/webThemeSeed.ts)
        └─ THEME_STORAGE_KEY / resolveStoredThemePreference（复用 UI 所有者）
                                          ──► web / desktop 首屏内联脚本无法 import，见下方"同步约束"
```

组件级兜底：`useZCodeStoreWithDefault(state => state.theme, ...)` 的第二参（无 StoreProvider 时使用）
改为 `DEFAULT_THEME_PREFERENCE`：`ProviderLogo.tsx`、`CodingPlanEmbeddedWebviewDialog.tsx`。

原生窗口底色：`packages/desktop/src/main/resourceManagerWindow.ts` 的 `backgroundColor` 由固定 `#1e1e1e`
改为按 `nativeTheme.shouldUseDarkColors` 取 `#1e1e1e` / `#f8f8f8`。原因：该窗口是不透明的，
renderer 脚本执行前会先显示原生底色，默认改为跟随系统后，浅色系统下开窗会闪一下深色。
`nativeTheme.themeSource` 已由 `useDesktopNativeThemeSync → SetTitleBarTheme` 跟随用户偏好，
所以这里读到的就是"当前生效亮暗"，与 `applyWindowsTitleBarTheme` 用法一致。

## 同步约束（无法 import 的两处内联脚本）

`packages/web/index.html` 的 `<head>` 内联脚本必须在 JS bundle 执行前决定首屏底色，因此不能 import TS 常量，
只能保留字面量 `DEFAULT_THEME`。约束：该字面量必须与 `DEFAULT_THEME_PREFERENCE` 保持一致，
并在注释里标注所有者路径。桌面 renderer 首屏同理（`main.tsx` 内联块），但该文件可以 import，
所以只用常量、不再写字面量。

## 事件顺序（跟随系统的实时切换）

1. 用户选择「系统」→ `store.setTheme("system")` → 写 `zcode-theme` → `syncSystemThemeListener("system")`
   注册 `matchMedia("(prefers-color-scheme: dark)")` 监听 → `applyTheme("system")`。
2. 系统切换亮/暗 → 监听回调先校验 `store.theme === "system"`（防止切走后仍被旧监听改写）→ `applyTheme("system")`。
3. 原生壳：`useDesktopNativeThemeSync` 把 `"system"` 原样传给 `platform.setTitleBarTheme`，
   Main 侧 `nativeTheme.themeSource = "system"`，由 Electron 跟随系统。

首屏（React 挂载前）与挂载后使用同一解析规则，因此不存在"先深后亮"的翻转。

## 验收场景

1. 清空 `zcode-theme` 后启动桌面应用与 Web：界面跟随系统（浅色系统为浅色，深色系统为深色）。
2. 系统在亮/暗之间切换时，界面实时跟随（仍走 `matchMedia` 变更监听，非仅初始化一次）。
3. 手动选「深色」后重启：仍为深色，不被新默认覆盖。
4. 清空 `zcode-theme` 打开会话分享页：仍为浅色。
5. 设置页「外观 → 界面主题」显示当前值＝「系统」。
6. 清空 `zcode-theme` 打开资源管理器窗口：首帧底色与系统亮暗一致，无深色闪屏。

## 不在范围

- 不改主题选项、CSS token、代码预览主题默认值、CLI/TUI 主题（`ui.theme` 默认仍是 `auto`，语义等价）。
- 强制更新窗口（`packages/desktop/src/main/index.ts` 的 `#ffffff` 底色）不调整：本 fork 已关闭自动更新。
- 不消除 `packages/web/index.html` 的字面量形式（内联脚本不能 import TS 常量）。

## 验证

静态检查（最终工作区，全部通过）：

| 命令                                                                | 结果                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| `node --import tsx --test packages/ui/test/themePreference.test.ts` | 6 pass / 0 fail                                       |
| `pnpm typecheck`                                                    | 无输出（全绿）                                        |
| `pnpm lint`                                                         | 75 warnings / 0 errors，与改动前基线同为 75（未新增） |
| `pnpm fmt:check`                                                    | 改动文件均通过（其余报错为改动前既有）                |
| `pnpm architecture:check --changed`                                 | violations 0 / baseline 0 / new 0                     |

桌面端不在根 `pnpm typecheck` 覆盖范围内，单独跑了 `tsc -b`：`main + renderer` 改动前后同为 212 个错误，
加 `preload + scheduler` 同为 216 个。均为构建产物未就绪的既有错误（`@zcode/ui/styles.css` 无类型声明、
`Window.zcode` 缺声明、`@zcode/shared` 未重建），位置不在本次改动行上，属既有基线。

### 真机验证（Web 端 + agent-browser，`~/.zcode-verify` 隔离数据副本）

用 CDP `set media light|dark` 模拟系统亮暗，逐个核对 `html.dark` / `theme-zai-*` / `data-zcode-bootstrap-theme`：

| 场景                            | `localStorage['zcode-theme']` | 系统   | 结果                                                                |
| ------------------------------- | ----------------------------- | ------ | ------------------------------------------------------------------- |
| 无偏好 + 浅色系统               | `null`                        | light  | `bootstrap=light`、`theme-zai-light` ✓                              |
| 无偏好 + 深色系统               | `null`                        | dark   | `bootstrap=dark`、`html.dark`、`theme-zai-dark` ✓                   |
| 无偏好，运行中切亮→暗→亮        | `null`                        | 来回切 | `matchMedia` 监听实时翻转，无需刷新 ✓                               |
| 已有偏好 `zai-light` + 深色系统 | `zai-light`                   | dark   | 仍为浅色，未被新默认覆盖 ✓                                          |
| legacy 别名 `dark` + 浅色系统   | `dark`                        | light  | 归一为 `zai-dark`，界面深色 ✓                                       |
| 设置页「外观 → 界面主题」       | 清空后                        | dark   | 下拉显示「系统」，`window.__testActions.getTheme()` 返回 `system` ✓ |
| 会话分享页 + 深色系统           | `null`                        | dark   | 仍为浅色（分享页例外保持）✓                                         |

未验证：桌面端（Electron）原生窗口壳的首帧与资源管理器窗口背景色。该部分改动（`resourceManagerWindow.ts`）
只影响窗口构造参数，需打包后在真机安装才能核对；本次仅通过静态检查。
