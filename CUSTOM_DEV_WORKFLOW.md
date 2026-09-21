# 自定义开发流程文档（fork 自维护：改码 / 验证 / 打包通用流程）

> 面向接手会话的**通用流程**：在本 fork（`custom` 分支）上做任何自维护功能改动时，怎么改、怎么验、怎么打包、怎么与官方同步，以及通用注意事项。
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

## 3. 静态检查（每次改动必跑，报告真实结果）

```bash
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test <test文件...>   # ui 包单测必须带 TSX_TSCONFIG_PATH，否则 @/ 别名解析失败
pnpm typecheck
pnpm lint            # 以当前 warning 基线为准，error 必须为 0
pnpm fmt:check       # 不过：pnpm exec oxfmt <改动文件>
pnpm architecture:check --changed
```

## 4. 真机验证（三层，按需组合）

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

## 5. 打包

```bash
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 pnpm bundle:desktop   # 后台跑约 15 分钟
# 产物：packages/desktop/dist/ZCode Preview-<version>-mac-arm64.dmg
```

- 出包门槛：§3 全绿 + 改动已提交；提交风格 = 英文 conventional subject + 中文 body（引用 spec 路径），一个功能一个提交。
- 本地 unsigned 构建；安装 = 退出 ZCode Preview → dmg 拖入 /Applications 覆盖。
- 构建报 electron 缺失：`pnpm install` 或 `node node_modules/electron/install.js`。

## 6. 与官方同步

`git fetch upstream` → 在 `custom` 上 `rebase upstream/main` → 冲突集中在自维护改动文件（以各 spec 组件地图定位）→ 重跑 §3 与 §5。

## 7. 通用坑位清单

- edit 工具锚点必须是 read 返回的 3 字符哈希（非行内容/行号）；同文件批量编辑从下往上或拆单发（`E_BATCH_DISPLACED`）；替换文本重复包含锚行内容会产生重复行，发现立即删除修复。
- 值域错配是跨表/跨层关联的头号隐性 bug：关联前先以 DB 直查确认两侧 id 值域一致（历史教训：行 turnId 与 turn_usage.turn_id 不同值域，见 `specs/session-stats-bar.md`）。
- 后台任务用 job 管理；`| tail` 会吞流式输出，排查启动问题时改写日志文件再 grep。
- 清理进程前先用 `ps eww`/`lsof` 确认归属，避免误杀用户实例。

## 8. 外部能力清单

| 能力                   | 用途                                           | 入口                                                    |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| agent-browser CLI      | 浏览器自动化（Web 验证）/ Electron CDP（备用） | `open / connect / snapshot / click / eval / screenshot` |
| node:sqlite            | DB 只读直查                                    | `node -e` 或临时 `.mjs`                                 |
| nvm node v24 + pnpm 10 | 检查 / 测试 / 构建                             | 见 §1                                                   |
| 无其他外部服务         | 验证不依赖网络（登录态来自数据目录副本）       | —                                                       |
