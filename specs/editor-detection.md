# 编辑器检测与「本地打开」

Workspace 顶部「在本地打开」（`WorkspaceEditorButtonGroup` / `PreviewPane` / 文件树右键）下拉里
列出的是本机已安装的编辑器、终端与文件管理器。本文只约束**主进程如何判定「已安装」**，
以及由此决定的候选路径与打开方式。

## 1. 问题：JetBrains IDE 扫描不到

macOS 上 `MAC_EDITOR_DEFS` 曾经只登记 `/Applications/<bundle>.app` 一条路径，
而 `resolveEditorDefAppPath()` 只用 `existsSync` 校验这份静态清单（macOS 分支不会走
`resolveWindowsCommandPaths()`，因为它只对 `win32` 生效）。

JetBrains Toolbox 以及「把 .app 拖进用户目录」的手动安装，默认落点是 `~/Applications`。
这类安装的 IDE 因此永远进不了候选列表，UI 下拉里就只剩 VS Code / Terminal / iTerm。

同一份清单还漏了 JetBrains 的另一种 bundle 命名：官网直装与 Toolbox 会分别使用
`IntelliJ IDEA Ultimate.app` / `PyCharm Professional.app` / `IntelliJ IDEA CE.app` 等名称，
只登记 `IntelliJ IDEA.app` / `PyCharm.app` 同样匹配不到。

DSH 的 `dsh-host-open-in-app` 对这两点的处理是：`applicationRoots = ['/Applications', join(home, 'Applications')]`，
且每个 JetBrains 条目声明多个 `fsNames`。本 fork 对齐该行为。

## 2. 产品规则

- 收录范围 = 代码编辑器、终端、文件管理器。数据库专用工具（DataGrip）不收录：它不是代码编辑器，
  出现在「在本地打开」里没有意义（DSH 的目录同样没有它）。
- 列表内容 = 本机真实存在（`existsSync` 通过）的候选应用；不存在的不进列表。
- 列表顺序 = 目录表声明顺序；UI 侧只把文件管理器（`finder` / `qspace` / `qspace-pro` / `explorer`）提到最前，
  其余保持主进程返回顺序（`sortInstalledEditorsForOpenWith`）。
- 图标 = `.icns` 解析（`@fiahfy/icns` → `sips` → Electron `app.getFileIcon`）三级降级；
  图标解析失败的应用**不进列表**（既有行为，未改动）。
- 检测结果在应用生命周期内缓存（`cachedEditors`），改动后需重启应用生效。

## 3. 状态所有者与接口

| 关注点               | 所有者                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| 候选目录表与路径解析 | `packages/desktop/src/main/editorCatalog.ts`（纯数据 + 纯函数，不依赖 Electron） |
| 图标提取与已安装列表 | `packages/desktop/src/main/editors.ts` → `getInstalledEditors()`                 |
| 打开动作             | `packages/desktop/src/main/openInEditor.ts` → `openInEditor(editorId, path)`     |
| 列表展示与选中态     | `packages/ui`（`useInstalledEditors` / `workspaceEditorSelection`）              |

`editorCatalog.ts` 从 `editors.ts` 拆出，是为了让「目录表 + 路径解析」可以脱离 Electron 进程做单测，
同时让 `editors.ts` 不再需要 `max-lines` 豁免；两者与 DSH 的
「catalog 是数据 / resolver 做平台解析 / icons 提图标」分层一致。

导出接口：

```ts
getEditorDefsForCurrentPlatform(): EditorDef[]        // darwin → MAC_EDITOR_DEFS，win32 → WINDOWS_*，其它 → []
resolveEditorDefAppPathCandidates(def): string[]      // 纯函数，按优先级展开候选
resolveEditorDefAppPath(def): string | null           // 候选里第一个 existsSync 命中的
```

`openInEditor()` 在打开时重新解析一次，因此列表与打开走同一条解析链路。

## 4. macOS 检测规则

候选 = **安装根目录 × bundle 名称**，根目录顺序即优先级：

```
/Applications/<name>   →   ~/Applications/<name>
```

- 安装根目录统一由 `MAC_APP_ROOTS` 提供，新增编辑器只需声明 bundle 名称，不再手写绝对路径。
- 系统自带应用（Finder、Terminal）位置固定，继续用单一绝对路径，不参与用户目录扫描。
- JetBrains 条目声明多个 bundle 名称：

| id        | bundle 名称                                                                          |
| --------- | ------------------------------------------------------------------------------------ |
| `idea`    | `IntelliJ IDEA.app`、`IntelliJ IDEA Ultimate.app`                                    |
| `idea-ce` | `IntelliJ IDEA CE.app`、`IntelliJ IDEA Community Edition.app`                        |
| `pycharm` | `PyCharm.app`、`PyCharm Professional.app`、`PyCharm CE.app`、`PyCharm Community.app` |
| `rider`   | `Rider.app`、`JetBrains Rider.app`                                                   |

`idea` 与 `idea-ce` 保持两个独立 id，避免已持久化的选中编辑器 id 失效。

## 5. 打开方式

不变：`def.command` 存在则先执行 CLI（如 `idea <path>`），失败后降级 `open -a <appPath> <path>`；
无 CLI 的（Finder / Terminal / QSpace / Warp 等）直接 `open -a`。
`appPath` 取候选列表首项，命中项由 `resolveEditorDefAppPath()` 决定。

## 6. 验收场景

1. IDE 装在 `~/Applications/IntelliJ IDEA.app`、`~/Applications/PyCharm.app` 时，
   「在本地打开」下拉出现 IntelliJ IDEA 与 PyCharm，图标为应用真实图标。
2. IDE 同时存在于 `/Applications` 与 `~/Applications` 时，选中 `/Applications` 下那份（根目录优先级）。
3. 只有 `IntelliJ IDEA Ultimate.app` / `PyCharm Professional.app` 时同样能识别。
4. 两个根目录都没有的应用不出现在下拉里。
5. 下拉里选中 IDE 后打开目录，能在该 IDE 中打开 workspace。
6. `getEditorDefsForCurrentPlatform()` 在 darwin 下每个可用户安装条目的候选里都包含
   `~/Applications/<bundle>`，且 `/Applications/<bundle>` 排在其前。

## 7. 已知限制

- bundle 被重命名，或安装到 `/Applications`、`~/Applications` 之外的目录（例如自定义 Toolbox 安装位置），
  仍然检测不到；与 DSH 的 Known Limitations 一致。
- Linux 未支持（`getEditorDefsForCurrentPlatform()` 返回空列表）。
- 检测结果按应用生命周期缓存，新增安装的 IDE 需要重启应用才会出现。

## 8. 验证记录

单测 `packages/desktop/test/editorCatalog.test.ts`：6/6 通过（候选展开、根目录优先级、JetBrains 命名变体、
系统应用不参与用户目录扫描、id 稳定性、候选去重）。

`packages/desktop/src/main/editorCatalog.ts` 直接解析本机结果：

```
vscode   -> /Applications/Visual Studio Code.app
idea     -> /Users/<user>/Applications/IntelliJ IDEA.app
pycharm  -> /Users/<user>/Applications/PyCharm.app
```

真机（打包后 `ZCode Preview-3.14.0-mac-arm64` + CDP）：

- `getInstalledEditors()` 返回 7 项，新增 `idea` / `pycharm` / `datagrip`，图标均解析成功。
- 「选择打开方式」下拉实际渲染顺序：Finder、VS Code、IntelliJ IDEA、PyCharm、DataGrip、Terminal（选中）、iTerm。
- 随后按 §2 移除 DataGrip，当前列表为 6 项：Finder、VS Code、IntelliJ IDEA、PyCharm、Terminal、iTerm。
- 移除 DataGrip 后未重新做真机验证（产品决定，改动仅是从目录表删掉一行定义）。
- 三个 `~/Applications` 下的 bundle 均通过 `open -Ra` 校验，`open -a` 降级链路可用。

未执行：实际启动 IDE 打开 workspace（会拉起完整 IDE 进程），只验证到路径解析与 LaunchServices 解析成功。
