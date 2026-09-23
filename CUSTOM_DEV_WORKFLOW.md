# 自定义开发流程文档（fork 自维护：改码 / 验证 / 打包通用流程）

> 面向接手会话的**通用流程**：在本 fork（`custom` 分支）上做任何自维护功能改动时，怎么改、怎么验、怎么提交、怎么打包，以及通用注意事项。本文走自研路线，不涉及上游同步（见 §6）。
> 仓库规范以 `AGENTS.md` / `DESIGN.md` 为准；具体功能的产品规则、状态所有者与数据口径写在各自 `specs/<feature>.md`，**不在本文重复**。

## 0. 背景

- Fork：`origin` 为个人仓库，`upstream` 为官方仓库；自维护改动一律落在 `custom` 分支。
- 构建产物身份为 **ZCode Preview**（与官方 ZCode 并存安装，共用 `~/.zcode` 数据目录）。
- 本文只写流程；某功能"改哪些文件"以该功能 spec 的组件地图为准。

## 1. 环境准备

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"   # mise 未安装，node 以 nvm v24 为准
pnpm install                                                # 首次；electron 二进制缺失时再跑一次或 node node_modules/electron/install.js
node scripts/check-workspace-freshness.mjs                  # AGENTS.md 要求的开工基线检查
```

## 2. 改码通用流程

1. **先 spec 后代码**（AGENTS.md 强制）：在 `specs/` 写清产品规则、状态所有者、接口、验收场景，再动实现。
2. **协议链 Checklist**（任何跨层数据改动都按此顺序，漏一层即静默失效）：
   `adapters repositories（SQL）→ adapters store 端口实现 → contracts 端口类型 → bootstrap handler → bootstrap server.ts 的 V4_METHODS case → shared/zcode-protocol-v4/transport.ts 的 zod schema 与 V4_METHODS 注册 → shared/zcode-protocol/index.ts 的旧协议 schema（同字段必须同步加）→ services 方法 + 接口 → ui hook/组件`。
3. **观察者/只读 RPC 一律 `existing-only`**：`getReadOnlyClient` 默认 `start-if-needed` 会为已回收会话拉起 runtime（副作用：重置上下文快照等）。只读统计/查询类方法必须显式传 `"existing-only"`；冷 workspace 下因此拿不到数据是既有语义，不是 bug。
4. **UI**：复用既有组件与插槽（见各功能 spec）；i18n 键 zh/en 两份 locale 同步加；样式遵循 `DESIGN.md` token。
5. **轮询持有者唯一**：列表/行级展示数据由上层容器单次轮询、经 Context 下发；禁止行级组件各自轮询。
6. 补/改单测（纯派生逻辑放可测模块），再跑 §3。
7. **一个需求一个提交，写完就提，不必先问。** 不需要等一轮对话结束、也不要攒着多个需求一起提。提交风格 = 英文 conventional subject + 中文 body（写清原因、证据、未验证范围，引用 spec 路径）。
   - 同一需求的多个文件一起提交；需求之间独立就拆成多个提交，按应审查的顺序排。
   - 提交后在回复里报出 commit hash，让人能直接对账。
   - 不要把手头这轮改动留成未提交状态——后续所有步骤（打包、真机验证）都以「改动已提交」为前提。
8. **自动打包并交付 dmg（默认动作，不用问）。** §3 全绿且改动已提交后，直接跑 §5 的打包命令，
   在回复里给出 dmg 的绝对路径和本次改动点，然后**停下等人在外面拖拽安装**。
   - 理由：安装必然要退出 Preview，而 agent 就跑在 Preview 里——自举循环的最后一步 agent 做不到，
     只能交给人。所以 agent 的职责到「包已就绪」为止，不该多问一句「要不要打包」。
   - 例外：本轮明确只调查/只写 spec 没有行为改动，或改动只涉及文档——那时不打包。

## 3. 静态检查（每次改动必跑，报告真实结果）

```bash
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test <test文件...>   # ui 包单测必须带 TSX_TSCONFIG_PATH，否则 @/ 别名解析失败
pnpm typecheck
pnpm lint            # 以当前 warning 基线为准，error 必须为 0
pnpm fmt:check       # 不过：pnpm exec oxfmt <改动文件>
pnpm architecture:check --changed
```

### 3.1 `apps/zcode-cli` 必须逐包单独检查（易漏，曾导致打包失败）

根目录 `pnpm typecheck` **不覆盖 `apps/zcode-cli`**（它只 `tsc -b packages/*`）。而 `pnpm --dir apps/zcode-cli typecheck` 在本机因缺 `turbo` 跑不了。所以改了该目录下的代码，必须逐包跑：

```bash
pnpm --dir apps/zcode-cli/packages/contracts typecheck
pnpm --dir apps/zcode-cli/packages/core typecheck
pnpm --dir apps/zcode-cli/packages/cli typecheck      # 见下方基线说明
```

- **`cli` 包有 67 个既有错误**（未构建的 `@zcode/tui` 导致，报 `Cannot find module '@zcode/tui'` 及一批连锁的 `implicitly any` / `unknown`）。判断是否引入回归用 `git stash -u` 前后对比**错误条数**，不要看具体文件。
- 典型症状：根 `pnpm typecheck` 全绿、单测全绿，但 `pnpm bundle:desktop` 在 `prepare:remote-assets` 阶段挂在 `tsc` 上。所以**打包前先跑这三个逐包检查**。

### 3.2 测试入口（实测命令）

```bash
pnpm --dir apps/zcode-cli/packages/core test        # node --import tsx --test test/*.test.ts
pnpm --dir apps/zcode-cli/packages/services test
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/<file>.test.ts
```

`packages/shared` 无测试。`apps/zcode-cli/packages/core` 的 `test` 脚本是本 fork 新增的；若换包先看该包 `package.json`。

## 4. 真机验证（四层，按需组合）

### 4.0 headless CLI（验证工具行为最快的一层）

不启 UI、不起 server，直接跑 agent 主循环：

```bash
cd apps/zcode-cli/packages/cli
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
ZCODE_ENV=production node /Users/liuyutong08/Work/ZCode/node_modules/.bin/tsx src/main.ts \
  -p "<prompt>" --cwd <目录> --surface terminal
```

- 多轮/跨会话验证用 `--resume <sess_...>`（会话 id 从 DB 查）；`-c/--continue` 续当前目录最近会话。
- **它会写真实会话库**：`ZCODE_DATA_BASE_DIR` 不影响会话库路径（`adapters/src/storage/session-store/paths.ts` 硬编码 `~/.zcode/cli/db/db.sqlite`），所以每次验证都会在你的真实库里留下会话，事后自己清理。
- 模型不完全听指令（例如坚持给 Read 补 `limit`），prompt 里要写死约束；模型的**自述不能当证据**，回 DB/日志取证。
- provider 网关报错时最简 prompt 也会失败，先跑一句 `-p "回复一个字：好"` 区分环境问题与代码问题。

### 4.1 数据库直查（只读，定位数据问题最快）

- `node:sqlite` 以 `readOnly: true` 打开 `~/.zcode/cli/db/db.sqlite`（或验证副本）。
- 通用坑：表/列名以 `pragma_table_info` 为准再写查询（如会话表为 `session`、时间列 `time_updated`）；SQL 字符串字面量用单引号。
- 用途：确认数据是否落库、字段值域、覆盖率；UI 不显示时先查数据再查渲染。

### 4.2 Web 端 + agent-browser（推荐主链路）

```bash
cp -a ~/.zcode ~/.zcode-verify        # 隔离数据副本（含登录态）；绝不与在跑实例共用同一数据目录
ZCODE_ENV=production ZCODE_DATA_BASE_DIR=$HOME/.zcode-verify pnpm dev:web   # 后台：server :3030 + web :5173
agent-browser open http://localhost:5173/
agent-browser snapshot -i             # 拿 ref；click @eNN 交互
agent-browser eval "<js>"             # 读 DOM / 直接 querySelector().click()（ref 会因轮询重渲染失效）
agent-browser screenshot /tmp/x.png   # 留证
```

通用注意事项：

- **改 `apps/zcode-cli` 后必须** `node scripts/build-desktop-agent-cli.mjs` **并重启 dev:web**：web server 起的 agent 是预打 bundle `apps/zcode-cli/packages/cli/dist/zcode.cjs`，dev:web 不重编它（症状：host 日志 ZodError 缺字段）。
- 冷启动无 runtime：侧栏/会话视图可能为空（existing-only 语义）；在 composer 发一条消息拉起 runtime 后再验历史数据。composer 输入用 `agent-browser keyboard type`（`inserttext` 对 Web 编辑器无效）；「发送」按钮禁用态=编辑器空。
- Radix 浮层内容读 `[data-radix-popper-content-wrapper]` 的 innerText；功能元素的 testid 以 `packages/shared/src/test-ids.ts` 为准。
- 桌面端独有 surface（如部分 composer 控件）Web 不渲染，验不了就走 §4.3。

### 4.3 Electron CDP（备用，仅桌面独有 surface 用）

- dev 版主进程**硬编码 CDP 9229**（`packages/desktop/src/main/index.ts`）；用 `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1` 关闭后以 `--remote-debugging-port=<port>` 自选。
- **单实例锁绑 userData「ZCode Dev」**，`--user-data-dir` 无效（main 会 setPath 覆盖）→ 与任何在跑的 dev 实例互斥，后起者静默退出。验证前先确认无其他 dev 在跑；清理进程时 pkill 签名要精确（曾误杀用户 dev 实例）。
- 手动三段式：`pnpm --filter @zcode/desktop exec tsup` → `pnpm exec vite dev`（:5174）→ `ELECTRON_RENDERER_URL=http://localhost:5174 ZCODE_DATA_BASE_DIR=<副本> <repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=<port>`；再 `agent-browser connect <port>`。
- 判别连上哪个实例：eval `location.href` + 侧栏会话对照数据目录；fetch `/src/...` 返回 index.html 是 SPA fallback，**不代表代码旧**。

### 4.4 日志层（工具使用/报错分布的唯一结构化来源）

```bash
~/.zcode/cli/log/zcode-<YYYY-MM-DD>.jsonl     # 按天一份，jsonl
```

- 工具成败事件：`tool.call.completed` / `tool.call.failed`。失败事件带 `context.toolName` 与 `error.context.code`（即 handler 返回的 `errorCode`）。
- 统计报错分布用 `toolName + error.context.code`，**不要解 `error.message` 文本**（本仓禁止依赖错误文本做判断）；原因码是按工具命名空间的，跨工具不冲突。
- 例子：按工具数失败次数、按原因码看某工具的内部构成。
- 日志级别约定：工具 handler 的拒绝走 `error` 级 `tool.call.failed`（可恢复，但已如此）；`debug` 不落盘。

## 5. 打包

```bash
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 pnpm bundle:desktop   # 后台跑，实测约 2–3 分钟
# 产物：packages/desktop/dist/ZCode Preview-<version>-mac-arm64.dmg
```

- **定位：这是默认自动动作（见 §2 第 8 条）**。§3 全绿 + 改动已提交就直接跑，不用等指令。
- 出包门槛：§3 全绿 + 改动已提交；提交风格 = 英文 conventional subject + 中文 body（引用 spec 路径），一个功能一个提交。
- 交付格式：回复里给 dmg **绝对路径** + 本次改动点 + 未验证范围，然后停住等人安装。
- 本地 unsigned 构建；安装 = 退出 ZCode Preview → dmg 拖入 /Applications 覆盖。
- **打包不要求退出 ZCode Preview**（实测：运行中打包成功，app 不受影响）。electron-builder 输出到 `packages/desktop/dist/`（`ZCODE_DESKTOP_DIST_DIR` 可改），而运行中的 app 在 `/Applications/ZCode Preview.app`，两者不相干。所以**自举时可以直接在 Preview 的对话里让它打包**。
- 打包耗时 2–3 分钟，用 `nohup ... > /tmp/zcode-bundle.log 2>&1 &` 后台跑，写日志文件而不是 `| tail`（`| tail` 会吞流式输出，见 §7）。
- 真正需要退出的只有两种情况：**安装**（覆盖 `/Applications/ZCode Preview.app`），以及你从 `dist/` 直接启动过实例（那时重建会撞上正在跑的 bundle）。自举循环的最后一步（退出 → 拖入 → 重开）必须由人在外面做：agent 跑在 Preview 进程里，没法退出自己再把自己换掉。
- 检测主进程用 `pgrep -x "ZCode Preview"`；`pgrep -f ".../Contents/MacOS"` 匹配不到（`ps` 里主进程的命令名就是 `ZCode Preview`）。退出用 `osascript -e 'quit app "ZCode Preview"'`。别碰官方 `ZCode.app`。
- `bundle:desktop` 内部会重建 agent bundle（`prepare:runtime-assets` → `prepare:agent-bundle` → `scripts/build-desktop-agent-cli.mjs`），不需要单独构建。
- 打包日志里的 `Unsupported engine: wanted 24.14.0 (current v24.21.0)` 是既有 WARN，不是失败。
- 校验产物别只看「构建成功」：直接 grep 包内文件确认改动进去了——agent bundle 在 `dist/mac-arm64/ZCode Preview.app/Contents/Resources/glm/zcode.cjs`，renderer 在 `Contents/Resources/app.asar`（`npx asar extract` 后可查）。导出的符号名可能被压缩，优先查字符串字面量或先查 `packages/core/dist` 的编译产物。
- 构建报 electron 缺失：`pnpm install` 或 `node node_modules/electron/install.js`。

## 6. 上游同步（基本不做）

本 fork 走自研路线，官方 ZCode 基本不更新，所以**不把同步上游当常规步骤**，不要主动提或定期做。

真的需要时（官方突然发了值得要的改动）：`git fetch upstream` → 在 `custom` 上 `rebase upstream/main` → 冲突集中在自维护改动文件（以各 spec 组件地图定位）→ 重跑 §3 与 §5。注意自维护改动越多，rebase 越痛——这也是不走这条路的一个理由。

## 7. 通用坑位清单

- edit 工具锚点必须是 read 返回的 3 字符哈希（非行内容/行号）；同文件批量编辑从下往上或拆单发（`E_BATCH_DISPLACED`）；替换文本重复包含锚行内容会产生重复行，发现立即删除修复。
- **改动会跨会话存活的读状态时，Read 必须只传 `file_path`**：带 `limit` 的 Read 算「范围读」，按既有设计不跨 resume 恢复（`isHistoricalFullReadWindow` 要求 `limit === undefined`，见 `agent/read-file-state-hydrator.ts`），于是连 Read 自己那份都恢复不了，看不出你想验的东西修没修。模型习惯给 Read 补 `limit: 2000`，prompt 里要写死。
- **`apps/zcode-cli` 单源文件不得超过 400 行**（该目录 AGENTS.md 硬规定）；超了要拆模块，不能继续堆。写之前先 `wc -l` 看一眼。
- 改提示词/工具选择行为时：系统提示词的工程规范在 `apps/zcode-cli/packages/core/src/context/sections/identity.ts` 的 `PERSONA`（**没有**独立 prompt 文件）；工具描述在各 `tool/handlers/<tool>.ts` 顶部常量。两者都是模型的路由信号，改完用 `buildIdentitySection().content` 断言文本真的渲染出来了。
- 改完提示词/描述**无法用单测证明效果**（那是模型行为）；要写进 spec 的评估口径，用 §4.4 的日志看真实分布。
- `pnpm fmt:check` **会扫未跟踪文件**，仓库里放一个没格式化的草稿也会把门禁卡红；`pnpm exec oxfmt <显式路径>` 有时报 `Expected at least one target file`，直接跑 `pnpm fmt:check` 看全局结果更可靠。
- 写回归测试时注意两个反向陷阱：旧测试可能把 **bug 行为当成了期望**（改写时要真删旧断言，别写成副本）；断言要走消费者真实使用的选择器/入口，而不是自己挑一个好断言的代理值。
- 值域错配是跨表/跨层关联的头号隐性 bug：关联前先以 DB 直查确认两侧 id 值域一致（历史教训：行 turnId 与 turn_usage.turn_id 不同值域，见 `specs/session-stats-bar.md`）。
- 后台任务用 job 管理；`| tail` 会吞流式输出，排查启动问题时改写日志文件再 grep。
- 清理进程前先用 `ps eww`/`lsof` 确认归属，避免误杀用户实例。
- Web 验证环境分裂风险：`ZCODE_DATA_BASE_DIR` 只约束 server 进程（索引/任务库），其拉起的 host 可能仍写**原始**数据目录（会话库/索引另一半），删除等写路径验证后必须直查原始 `~/.zcode/v2/tasks-index.sqlite` 与 `~/.zcode/cli/db/db.sqlite` 取证，发现幽灵条目（索引有行、库无数据）用 tombstone（deleted=1）清理；写路径验证优先桌面 dev 或确认 host 环境继承后再做。
- 桌面 dev 同样会分裂：Host 继承 `ZCODE_DATA_BASE_DIR`（索引写副本），但它拉起的 **Agent 进程不继承**，会话库落回 `~/.zcode/cli/db/db.sqlite`。因此涉及会话行的写路径（删除、移动、改名）在桌面 dev 里验证时会直接改真实数据；验证前先确认会话库落在副本，或验证后立刻把真实库改回原值（`session.project_id/workspace_id/directory`），并直查两处 DB 取证。

## 8. 外部能力清单

| 能力                   | 用途                                           | 入口                                                    |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| agent-browser CLI      | 浏览器自动化（Web 验证）/ Electron CDP（备用） | `open / connect / snapshot / click / eval / screenshot` |
| node:sqlite            | DB 只读直查                                    | `node -e` 或临时 `.mjs`                                 |
| nvm node v24 + pnpm 10 | 检查 / 测试 / 构建                             | 见 §1                                                   |
| 无其他外部服务         | 验证不依赖网络（登录态来自数据目录副本）       | —                                                       |
