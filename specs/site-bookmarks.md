# 网站收藏（Site Bookmarks）：常用网址收进侧边栏，一点即开

状态：设计中（待实现）。

## 0. 背景与目标

需求来源：参考公司内部 agent 软件 MyFlicker 的「自定义工作台」。用户维护若干网址，
在侧边栏一点就在内置浏览器里打开，省掉每次手动输地址。

**关键前提：浏览器能力已经够了，缺的只是"记住地址"。** 用户在右侧浏览器面板输入内网
工作台地址，展开面板后体验已与 MyFlicker 基本一致——登录态天然复用，因为是同一个
`persist:` 分区。唯一摩擦是每次都要点开面板、手输网址。

所以本功能**不是**移植浏览器，而是**给已有浏览器加一个书签栏**：

- 不做内嵌浏览器宿主（已有 `UnifiedBrowserView` + `persist:zcode-embedded-browser`）；
- 不做自动登录、凭据注入（登录态已由分区持久化天然复用）；
- 只做：侧边栏一点即开 + 设置有地方管理。

逆向取证见附录，用于说明"为何无需移植登录逻辑"。

### 命名

`bookmark`（网站收藏），代码标识用 `siteBookmarks`。
不使用 `workbench`——该词在 ZCode 中已被分屏工作区占用（`WorkbenchPane.tsx`、
`workbenchGroupStore.ts` 等 26 处引用），复用会造成概念冲突。

### 本迭代范围

纯前端、零协议改动。持久化走 localStorage，不新增 `AppSettings` 字段、
不改 zod schema、不动 settings 服务。理由：条目是纯 renderer 展示偏好，
与 workspace / 远程 / agent 无关；参照既有 `sidebarPurposeSectionPreferences`
与 `workbenchGroupStore` 的 localStorage 先例。

## 1. 产品规则

### 1.1 条目模型

| 字段        | 必填 | 说明                        |
| ----------- | ---- | --------------------------- |
| `id`        | 是   | 稳定标识，创建时生成        |
| `name`      | 是   | 展示名；1–40 字符           |
| `url`       | 是   | `http:` / `https:` 绝对 URL |
| `createdAt` | 是   | 创建时间戳，用于默认排序    |

规则：

1. 条目存**本地**（localStorage），不依赖远程服务、市场或审核流。
2. `url` 只校验协议与可解析性，**不限制域名**——这是通用化的关键。
   用户换公司后只需改条目，代码不含任何公司专有域名。
3. 同一 `url` 只保留一条：重复添加时更新既有条目的名称，不产生重复项。
4. 条目上限 50，避免侧边栏与设置项无限增长。
5. 存储不可用时（隐私模式 / WebView 限制）降级为内存态，不阻断使用、不抛错。

### 1.2 打开路径（侧边栏一点即开）

1. 侧边栏「网站收藏」区块列出条目，显示名称，悬停显示完整 URL。
2. 点击条目 → 调既有 `onOpenBrowserUrl(url)` prop，在右侧浏览器面板打开并展开面板。
3. 落点行为与用户手动在地址栏输入完全一致：同分区、同登录态、同 Web 回退语义。
4. 非桌面端无内置浏览器面板，保持既有降级：`handleOpenBrowserUrl` 内部退回
   `window.open`，收藏夹侧不额外分支。

### 1.3 数据归属与解耦

- 条目只存"地址 + 展示名"，**不持有**页面运行时状态（URL、标题、favicon、residency
  由既有 `BrowserSidePaneTab` 负责）。
- 不新增 session 分区，不新建 webview 宿主：证书信任、网络策略、Chrome cookie 导入、
  数据清理全部继承既有实现。
- 已知代价：设置页「清理浏览数据」会连带清掉已收藏站点的登录态。
  这是共享分区的必然结果，在设置页文案中说明，不做特殊豁免。
- localStorage 与 settings 服务的职责边界：**跨窗口/跨设备需要同步的状态必须走 settings**；
  收藏条目只影响本机本窗口的展示，故走 localStorage。若后续需要跨设备同步，
  再迁往 `AppSettings`（见 §7）。

## 2. 状态所有者

| 状态             | 所有者                                              | 持久化                   |
| ---------------- | --------------------------------------------------- | ------------------------ |
| 收藏条目列表     | `siteBookmarkStore`（新增，Zustand + localStorage） | localStorage             |
| 侧边栏区块展开态 | `sidebarPurposeSectionPreferences`（既有）          | localStorage（既有机制） |
| 页面运行时状态   | 既有 `BrowserSidePaneTab`                           | 既有 side pane 持久化    |

单一写入路径：条目只由**设置页**写入（新增 / 编辑 / 删除 / 排序）；侧边栏**只读**，
点击只调用既有打开入口，不直接改列表。本迭代不做「一键收藏当前页」，因此不存在
第二条写入路径（见 §7）。

## 3. 接口

### 3.1 新增存储模块

`packages/ui/src/lib/siteBookmarks.ts`：

```ts
export interface SiteBookmark {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

export const MAX_SITE_BOOKMARKS = 50;
export const SITE_BOOKMARK_NAME_MAX_LENGTH = 40;

/** 校验 URL 可收藏：http/https 绝对地址；返回归一化 URL 或 null。 */
export function normalizeBookmarkUrl(raw: string): string | null;

/** 按 url 判重后写入：已存在则更新 name，返回 { bookmarks, updated }。 */
export function upsertSiteBookmark(
  bookmarks: readonly SiteBookmark[],
  input: { name: string; url: string; id?: string },
): { bookmarks: SiteBookmark[]; updated: boolean; error?: "duplicate" | "limit" | "invalid" };

export function removeSiteBookmark(bookmarks: readonly SiteBookmark[], id: string): SiteBookmark[];
```

持久化读取需容错：解析失败或形状不符时返回空数组，不抛错（参照
`sidebarPurposeSectionPreferences` 的 normalize 做法）。

### 3.2 新增 store

`packages/ui/src/store/siteBookmarkStore.ts`：Zustand store，持有列表与
`addBookmark / removeBookmark / moveBookmark` 三个动作，读写经 §3.1 的纯函数。
store 只做状态与持久化，不含 UI 逻辑。

`addBookmark` 返回 `{ ok: true, updated } | { ok: false, error }`：`updated` 让设置页能区分
「新增」与「命中同 URL 后改名」，分别提示不同文案，而不是让用户以为又加了一条。

### 3.3 复用点（不新造）

| 需求             | 复用                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| 打开网址         | `onOpenBrowserUrl`（`WorkspaceSidebar` 既有 prop，最终接到 `handleOpenBrowserUrl`） |
| 侧边栏可折叠区块 | `WorkspacePurposeSection`（既有组件）                                               |
| 设置页 UI        | `SettingsGroupCard` / `SettingsRow`（既有组件）                                     |
| 拖拽排序         | 侧边栏已有 `@dnd-kit` 排序基建；设置页列表用上/下移按钮                             |

## 4. UI 落点

| 位置     | 改动                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 侧边栏   | 新增「网站收藏」可折叠区块，与「项目」「会话」同级；无条目时不渲染                 |
| 设置页   | 新增「网站收藏」分区（`groupId: "basics"`，位于 `browser` 之后），支持增删改与排序 |
| 设置导航 | `SettingsSectionId` 增加 `"siteBookmarks"`，并登记进 `isSettingsSectionId` 守卫    |
| i18n     | `zh-CN` / `en-US` 同步补 `bookmarks.*` 与 `settings.siteBookmarks.*`               |
| 测试 id  | `packages/shared/src/test-ids.ts` 增加 `TID_BOOKMARK_SECTION`                      |

注意：`sidebarPurposeSectionPreferences` 的 `SIDEBAR_PURPOSE_SECTION_IDS` 是白名单，
且旧 localStorage 数据里只有两个分区。`normalizeSectionOrder` 必须**保留旧顺序并把新分区
追加到末尾**，而不是因长度不符把整组重置——否则老用户排好的顺序会被新增分区打乱。

## 5. 事件顺序

新增收藏：

```
设置页表单提交
  → normalizeBookmarkUrl 校验（http/https 绝对地址）
  → name / 数量上限校验
  → upsertSiteBookmark 按 url 判重（存在则更新 name）
  → store 写入 → localStorage 持久化 → 订阅者广播
  → 设置页与侧边栏同时更新（同一快照，无第二条写入路径）
```

点击条目：

```
侧边栏点击
  → onOpenBrowserUrl(entry.url)          // 既有入口，不绕过
  → 既有流程：地址校验 → webview 导航 → 面板展开
```

## 6. 验收场景

1. **点开即用**：侧边栏点条目 → 右侧面板打开该地址；重启应用后条目仍在。
2. **登录态复用**：在内置浏览器登录某站点后，通过收藏打开同站点，直接是已登录态；
   反向亦然。
3. **通用性**：任意 `https://` 地址（不限域名）均可收藏并打开；
   代码无硬编码域名白名单、SSO 地址或审核流程。
4. **判重**：重复添加同一地址 → 更新既有条目，不产生第二条。
5. **降级**：Web 端 / 手机远控点条目 → 走既有 `window.open` 路径，不报错、不白屏；
   localStorage 不可用时功能仍可用（内存态），仅不持久化。
6. **空态**：无收藏时侧边栏不显示该区块，设置页显示引导文案。
7. **上限与校验**：名称超 40 字符、URL 非 `http(s)`、条目超 50 条 → 明确报错且不写入。
8. **旧数据兼容**：已有 `sidebarPurposeSectionPreferences` 的 localStorage 数据在
   新增 section 后不导致侧边栏顺序错乱或区块消失。
9. **清理数据语义**：清浏览数据后收藏条目仍在，但站点需重新登录；设置页有文案说明。
10. `pnpm typecheck` / `pnpm lint` / `pnpm fmt:check` / `pnpm architecture:check --changed` 全绿。

### 实测记录（桌面端 dev 实例 + CDP 核验）

在 `pnpm dev:desktop:test` 的真实 Electron 实例上，用 CDP 直接探主窗口 DOM：

```json
{
  "webviews": 1,
  "webviewSrc": "http://localhost:5173/",
  "webviewPartition": "persist:zcode-embedded-browser",
  "addressInput": "http://localhost:5173/",
  "bookmarkItems": ["Web 端页面"]
}
```

结论：点侧边栏条目确实创建了内嵌 webview 并加载目标 URL，**分区为
`persist:zcode-embedded-browser`**（即与内置浏览器同一分区，登录态共享），主窗口未被导航走。

已验：设置页新增 / 删除 / 排序、重复 URL 判重并改名、无效 URL 拒绝、localStorage 持久化、
侧边栏区块渲染与点击打开。
未验：跨设备同步（本迭代不做）、手机远控端的点击降级（代码路径已复用既有 `window.open` 分支）。

## 7. 明确的非目标

本迭代不做，避免范围膨胀：

- 不做「一键收藏当前页」（地址栏星标）——需改 `BrowserToolbar` 及其调用方
  （`UnifiedBrowserView` / `AnimatedSidePanePanel`），属独立一小步，后续可加。
  届时写入路径仍是同一个 store，不新增状态所有者。
- 不做市场 / 分享 / 审核 / 可见性——MyFlicker 的服务端能力，与通用化冲突。
- 不做自动登录、凭据注入、跨分区 cookie 拷贝——既无必要也是安全隐患。
- 不做收藏夹专属分区或独立 webview 宿主——复用既有浏览器面板。
- 不做文件夹分组、多级目录、导入导出、云同步。
- 不记录浏览历史：只存显式收藏的条目，不做自动收录。

## 附录：逆向取证记录（MyFlicker 2.260928.2）

支撑 §0 的判断，非本功能实现依据。

- 解包：`/Applications/MyFlicker.app/Contents/Resources/app.asar`（242 MB，33115 文件）。
- 承载：renderer 中 `<webview partition="persist:workbench" allowpopups>`，
  组件 `WorkbenchGuest`；preload 由主进程 `will-attach-webview` 强制替换为
  `workPanelPreload.cjs`（主进程覆盖 renderer 声明，实现时需注意同类边界）。
- 主进程策略：`will-attach-webview` 校验 partition；`did-attach-webview` 中
  `setWindowOpenHandler` 对 workbench 一律 `deny` 并 `shell.openExternal`。
- SSO 兜底常量：`ACCESS_PROXY_SSO_CALLBACK_PATH = "/accessproxy_sso_callback"`、
  `SSO_CAS_LOGIN_HOST = "sso.corp.kuaishou.com"`，10s 卡死超时后回首页。
  这两个常量是本 fork 明确**不**照搬的部分。
- 登录态证据：`~/Library/Application Support/MyFlicker/Partitions/workbench/Cookies`
  含 `.sso.corp.kuaishou.com | TGC`、`.kdev.corp.kuaishou.com | accessproxy_session`；
  而 default session 中无任何 `kuaishou.com` 域 cookie。其 main bundle 中
  `accessproxy_session` / `onBeforeSendHeaders` / `getAllCookies` 命中数均为 0
  → 确认无凭据注入，登录态由站点自身在该分区内写入。
