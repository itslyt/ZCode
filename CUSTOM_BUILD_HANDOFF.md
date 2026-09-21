# 自定义构建交接文档（custom 分支：改码 / 验证 / 打包）

> 面向接手的新会话：本 fork 在源码里自维护了一组 Harness 增强功能，本文记录**怎么改、怎么验、怎么打包**，以及全部已踩过的坑。
> 仓库规范仍以 `AGENTS.md` / `DESIGN.md` / `specs/` 为准；本文只补充 fork 自维护部分与真机验证链路。

## 0. 背景与现状

- Fork：`origin=git@github.com:itslyt/ZCode.git`，`upstream=git@github.com:zai-org/ZCode.git`，工作分支 `custom`。
- 与官方版并存：构建产物身份为 **ZCode Preview**（appId `dev.zcode.app.preview`），与官方 ZCode 共用 `~/.zcode` 数据目录，可同时安装。
- 已完成功能（提交序）：

| 提交 | 内容 |
| --- | --- |
| `d3ac803` | 用量页图表去截断（全量模型切片） |
| `b69ec78` | 会话统计条（后被胶囊取代） |
| `8346162` | 缓存命中改走 provider 原始口径（raw 字段） |
| `5ef02cc` | DSH 式会话级双胶囊（Popover 详情） |
| `11753e0` | 胶囊移入 composer 工具栏行（`toolbarCenterNode` 插槽） |
| `784b286` | 逐轮胶囊（每轮动作行：本轮用量 / 用时） |
| `d1e2048` | 修 turnId 漏传；用时浮层加「本轮用时 / 速度」；统计 RPC 改 `existing-only` |
| `7560492` | 逐轮 map 改以 `userMessageId` 为键（值域错配根因） |

- 验证状态：单测 / typecheck / lint / fmt / architecture 全绿；Web 端真机验过逐轮胶囊与两个浮层；dmg 已出（见 §3）。
- 遗留观察项：上下文容量浮层的 breakdown 详情在**冷/回收会话**可能缺失（数据来自运行时上下文事件，非本 fork 回归）；桌面端 live 会话若仍缺，沿 host 事件持久化查 `product-projection.ts` 的 `payload.contextUsageBreakdown`。

## 1. 怎么改：数据链与组件地图

统计类功能的完整链路（任何一层漏改都会静默失效）：

```
sqlite 表 model_usage / tool_usage / turn_usage
  → apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts   (SQL 聚合)
  → apps/zcode-cli/packages/adapters/.../sqlite-session-store.ts                        (端口实现)
  → apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts              (端口类型)
  → apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts           (handler)
  → apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts                      (V4_METHODS case 分派)
  → packages/shared/src/zcode-protocol-v4/transport.ts                                  (zod schema；V4_METHODS 注册)
  → packages/shared/src/zcode-protocol/index.ts                                         (旧协议 schema，同字段必须同步加)
  → packages/services/src/zcode-agent/zcodeAgentService.ts + zcodeAgent.ts              (service 方法 + 接口)
  → packages/ui/src/hooks/useSessionStats.ts / useTurnStats.ts                          (1s 轮询 hook)
  → packages/ui/src/v4/sessionStatsView.ts                                              (纯派生 + 格式化，单测覆盖)
  → packages/ui/src/v4/SessionStatsCapsules.tsx / TurnStatsCapsules.tsx                 (展示)
```

关键规则（改口径前必读）：

- **缓存口径**：命中率只用 provider 原始字段（`rawInputTokens` / `rawCacheReadTokens`）；增量消耗字段（`inputTokens` 等）是 baseline-delta 会计口径，会被 `source === undefined` 守卫吞掉，不能用于命中率。
- **TPS**：`outputTokens × 1000 ÷ Σ(duration_ms − ttft)`（会话级）；逐轮速度 = `outputTokens × 1000 ÷ (modelDurationMs − ttftMs)`。
- **逐轮关联键**：UI 行 `row.turnId` 是 **msg_ 值域**，等于 `turn_usage.user_message_id`；`turn_usage.turn_id` 是 turn_ 值域，**不能**直接和行 turnId 互查。协议字段 `userMessageId`（nullable）即为此存在。
- **观察者 RPC 必须 `existing-only`**：`getReadOnlyClient` 默认 `start-if-needed` 会为已回收会话拉起 runtime（副作用：重置上下文快照）。会话侧栏索引（`subscribeSessionsIndexV4`）本就是 existing-only 语义——冷 workspace 侧栏为空是平台既有行为，发一条消息拉起 runtime 后即恢复。
- UI 插槽：会话级胶囊经 `ChatPromptEditor` 的 `toolbarCenterNode`（工具栏行左右控件簇之间）；逐轮胶囊在 `ConversationRowView` 的 `ConversationAssistantTextActions` 内、时间戳左侧，**调用点必须传 `turnId={row.turnId}`**。
- 逐轮数据持有者：`ConversationTimeline` 内单次 `useTurnStats` 轮询，经 `TurnStatsContext` 下发 turnId→行 map；行级组件只读 map，禁止每行各自轮询。
- i18n：键都在 `chat.sessionStats.*`（zh/en 两份 locale 同步加）。
- 行为改动先更新 `specs/session-stats-bar.md`（AGENTS.md 强制）。

## 2. 怎么验：三层验证

环境前置：`export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`（mise 未装，node 用 nvm 的 v24）；pnpm 10。

### 2.1 静态（每次改动必跑，报告真实结果）

```bash
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/sessionStatsView.test.ts   # 单测（tsx 别名必须带 TSX_TSCONFIG_PATH）
pnpm typecheck
pnpm lint            # 既有 70 warning / 0 error 为基线
pnpm fmt:check       # 不过时：pnpm exec oxfmt <file>
pnpm architecture:check --changed
```

### 2.2 数据库直查（只读，定位数据问题最快）

```bash
node -e '...new (require("node:sqlite").DatabaseSync)(HOME+"/.zcode/cli/db/db.sqlite",{readOnly:true})...'
```

- 表名/列名坑：会话表叫 `session`（列 `time_updated`、`path`、`title`，**没有** `updated_at/workspace_path`）；`sqlite_master` 查询里字符串用单引号。
- 逐轮覆盖检查：`select count(*) from turn_usage where session_id=?` 与 `user_message_id` 对照行 turnId。

### 2.3 真机 UI（推荐 Web 端 + agent-browser，稳定）

```bash
# 1) 隔离数据副本（含登录态；切勿与在跑实例共用同一数据目录）
cp -a ~/.zcode ~/.zcode-verify
# 2) 起 web（server :3030 + web :5173），后台跑
ZCODE_ENV=production ZCODE_DATA_BASE_DIR=$HOME/.zcode-verify pnpm dev:web
# 3) 浏览器自动化（外部能力：agent-browser CLI，普通浏览器模式）
agent-browser open http://localhost:5173/
agent-browser snapshot -i          # 拿 ref
agent-browser click @eNN
agent-browser eval "<js>"          # 读 DOM / 点 DOM（ref 会因 1s 轮询重渲染失效，稳定做法是 eval 直接 querySelector().click()）
agent-browser screenshot /tmp/x.png
```

Web 循环的必知坑：

- **改 `apps/zcode-cli` 后必须** `node scripts/build-desktop-agent-cli.mjs` **再重启 dev:web**：web server 起的 agent 是预打 bundle `apps/zcode-cli/packages/cli/dist/zcode.cjs`，dev:web 不会重编它（症状：host 日志 `ZodError ... userMessageId ... received undefined` 之类缺字段报错）。
- 冷启动无 runtime：侧栏/会话视图可能空；在 composer 发一条消息拉起 runtime（composer 输入用 `agent-browser keyboard type`，`inserttext` 对 Web 编辑器无效；发送按钮 snapshot 里叫「发送」，禁用态=编辑器空）。
- 验证选择器：会话级胶囊 `[data-testid="session-stats-capsules"]`；逐轮 `[data-testid="turn-stats-capsules"]`；Radix 浮层内容读 `[data-radix-popper-content-wrapper]` 的 innerText。
- 上下文容量触发器 testid `chat-context-usage-trigger`，**仅桌面端渲染**，Web 验不了它。

### 2.4 备用：Electron CDP 直连桌面 dev（坑多，仅 Web 覆盖不到时用）

- dev 版主进程**硬编码 CDP 9229**（`packages/desktop/src/main/index.ts`），可用 `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1` 关并用 `--remote-debugging-port=<port>` 自选。
- **单实例锁绑 userData「ZCode Dev」**，`--user-data-dir` 无效（main 会 setPath 覆盖）→ 与用户正在跑的 dev 互斥，第二个实例静默退出。验证前先确认没有别的 dev 在跑；pkill 签名要精确，**误杀过用户 dev 实例一次**。
- electron 二进制缺失：`node node_modules/electron/install.js`。
- 手动三段式：`pnpm --filter @zcode/desktop exec tsup`（一次构建）→ `pnpm exec vite dev`（:5174）→ `ELECTRON_RENDERER_URL=http://localhost:5174 ZCODE_DATA_BASE_DIR=... <repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=<port>`；再 `agent-browser connect <port>` 走 CDP。
- 判别连上的是哪个实例：eval `location.href` + 侧栏会话对照数据目录；fetch `/src/...` 返回 index.html 是 SPA fallback，**不代表代码旧**。

## 3. 怎么打包

```bash
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 pnpm bundle:desktop   # 后台跑，约 15 分钟
# 产物：packages/desktop/dist/ZCode Preview-3.14.0-mac-arm64.dmg（版本号随 package.json）
```

- 本地 unsigned 构建（签名 identity null），安装：退出 ZCode Preview → dmg 拖入 /Applications 覆盖。
- 构建前确保 electron 二进制在（缺则 `pnpm install` 或 §2.4 的 install.js）。
- 出包前必须：§2.1 全绿 + 提交完毕（提交风格：英文 conventional subject + 中文 body，引用 spec 路径；一个功能一个提交）。

## 4. 与官方同步

`git fetch upstream && git rebase upstream/main`（在 custom 上）；冲突面集中在本 fork 改动文件（见 §1 组件地图）；rebase 后重跑 §2.1 与 §3。

## 5. 编辑工具坑（本仓库会话实测）

- edit 工具锚点必须是 read 返回的 3 字符哈希，不是行内容/行号；同文件批量编辑要么从下往上要么拆单发（`E_BATCH_DISPLACED`）。
- 替换文本若重复包含锚行内容会产生重复行；出现后立即用删除编辑修。
- 参数 JSON 里 edits 必须是数组字面量（多次因换行包裹被拒）。

## 6. 外部能力清单

| 能力 | 用途 | 入口 |
| --- | --- | --- |
| agent-browser CLI | 浏览器自动化（Web 验证）/ Electron CDP（备用） | `agent-browser open/connect/snapshot/click/eval/screenshot` |
| node:sqlite | DB 只读直查 | `node -e` / 临时 .mjs |
| nvm node v24 | 运行检查/测试/构建 | `export PATH=...` |
| 无其他外部服务 | 验证不依赖网络（登录态来自数据目录副本） | — |

## 7. 文件索引

- spec：`specs/session-stats-bar.md`（会话级+逐轮胶囊产品规则）、`specs/usage-stats-full-model-charts.md`
- 单测：`packages/ui/test/sessionStatsView.test.ts`、`packages/ui/test/appUsageModelPieChartViewModel.test.ts`
- 组件：`packages/ui/src/v4/SessionStatsCapsules.tsx`、`TurnStatsCapsules.tsx`、`turnStatsContext.ts`、`sessionStatsView.ts`；hooks：`useSessionStats.ts`、`useTurnStats.ts`
- 插槽：`packages/ui/src/prompt-editor/ChatPromptEditor.tsx`（`toolbarCenterNode`）；`packages/ui/src/v4/ConversationRowView.tsx`（逐轮调用点）
- 协议：`packages/shared/src/zcode-protocol-v4/transport.ts`、`packages/shared/src/zcode-protocol/index.ts`
