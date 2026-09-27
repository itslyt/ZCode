# 配置文件的 env 字段（工具子进程环境变量）

> 状态：v1 已实现（用户级 `env`，见 §9）。项目级生效与 `envFromShell` 是二期，见 §3.4 / §3.7。

## 1. 背景与问题

`~/.zcode/cli/config.json` 里原本没有 `env` 字段（`ZCodeConfigFileSchema`，`apps/zcode-cli/packages/adapters/src/config/schema.ts:286`），而且它是 `.passthrough()` —— 手写 `"env": {...}` 不报错，但 `parsedConfigFileToRuntimePatch` 只拷贝已知键，未知键**静默丢弃**，也不会变成进程环境变量。

现状下想让 agent 的工具子进程拿到某个环境变量，原来只有三条路，都不满足"改配置就生效"：

| 途径               | 生效范围                                 | 问题                                                                                                                                 |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.zshrc` export  | 只有交互式 shell                         | 非交互 shell 不读；GUI 启动的安装版 app 继承不到（实测 `zsh -i -c 'echo $KS_AGENT_PLATFORM'` → `codeflicker`，agent 的 Bash 里为空） |
| `.env`             | CLI 边界（`packages/cli/src/env.ts:74`） | 打包态协议 server 明确不读（`run.ts:243-256`，`shouldLoadCliDotenvForProtocolServer` 仅 development 为真）                           |
| `launchctl setenv` | GUI app                                  | 改系统级环境、需重启 app、不随项目/工作区分化                                                                                        |

实际后果：agent-browser 的 `obo_token_fetcher.sh:283-293` / `kfetch_cookies.sh:53-68` 按小写后的 `KS_AGENT_PLATFORM` 分支取 OboToken / cookie，空值时三个分支都不命中 → `fail AUTH_FAILED "未能获取 OboToken"`。

配置文件是**安装版也一定会读**的那一份（`createConfig` 同步读盘，与 dev/prod 无关），所以把 env 放进配置是最合适的载体。

**顺带查清的一点**：`.zshrc` 其实已经被读了。仓库早在 `packages/services` 侧有 login shell 快照机制（`runtimeLoginShellEnvCapture.ts:173`，`zsh -ilc` + `env -0`，4s 超时、进程组兜底 kill、模块级缓存），实测该快照的 79 个键里含 `KS_AGENT_PLATFORM` / `FLICKER_USERNAME` / `RELAY_PLATFORM`；被丢弃的是**继承环节**——`buildLoginShellEnvPatch`（`runtimeCommandEnv.ts:112`）只放行固定白名单 `INHERITED_LOGIN_SHELL_ENV_KEY_PATTERNS`，注释明确拒绝宽继承。想"直接用 `.zshrc` 里配好的"需要 §3.7 的 `envFromShell`，但那要先解决跨包依赖问题，所以放进二期。

## 2. 目标 / 非目标

**目标（v1 已实现）**

- 用户级 `~/.zcode/cli/config.json` 支持顶层 `env: Record<string, string>`，改动后**不需要重新编译、不需要改 shell、不需要 launchctl**。
- 注入到 Bash / 工具子进程，语义与"进程本来就有这个变量"等价。
- 不破坏现有安全边界：CUA broker、telemetry、代理/证书等敏感键不接受。

**非目标（v1 明确不做）**

- **项目级不生效**：`<workspace>/.zcode/config.json` 的 `env` 被剥离（§3.4），信任门禁是二期。
- **`envFromShell` 是二期**（§3.7）：本期不消费 login shell 快照。
- 不注入 agent 自身 `process.env`（那会改 provider/网络/权限判定所读的环境，且与 sanitize 规则互相干扰）。
- 不做"全量继承 shell env"：白名单语义保持。全量继承等于把用户 shell 里所有凭据（token、云厂商 AK）无差别放进 agent 可控的子进程，无法穷举排除。
- 不注入 MCP server（MCP 有自己的 `env` 字段，`schema.ts:82`，保持隔离）与 relay/桌面主进程。
- 不做热重载：生效时机与其它配置字段一致，见 §3.5。
- 不支持值插值/引用（`${HOME}`、`$PATH` 之类），只存字面量。

## 3. 产品规则

### 3.1 生效范围

配置的 `env` 只作用于**由 `executionPort` 拉起的子进程**（Bash 工具、以及任何走同一 execution 请求的调用），不作用于 agent 进程本身、MCP server、provider HTTP 客户端。

理由：诉求（skill 脚本、shell 命令）走的就是这条链；不碰 agent 自身进程可以避免"配置能改运行时语义"这一类隐式影响。

范围边界要写清：`workflow-facade.ts:304` 与 `script-workflow-child-runtime.ts:194` 也各自 `createNodeExecutionAdapter`，那是 workflow 子运行时，本设计没有给它们传 `configuredEnv`。要在那里也可见需单独接。

### 3.2 优先级

子进程 env 的最终优先级（低 → 高）：

```
进程 process.env（sanitize 后）
  < 配置 env（config.env 的直接值）
    < 单次调用 overlay（request.env：plugin / hook / 工具自身注入，如 configured-runner-input.ts:74-98）
      < shell provider envOverlay（GIT_EDITOR / SHELL，bash-shell-provider.ts:94-109）
```

要点：

- 配置值**覆盖** `process.env` 里的同名键（否则"改配置没反应"正是要避免的坑）。
- 已被 host patch 继承进进程 env 的白名单键（如 `NVM_DIR`、`JAVA_HOME`）不受影响——配置没声明它们就还是进程 env 的值。

### 3.3 保护键（拒绝清单）

实现是 `resolveConfiguredToolEnv`（`packages/shared/src/runtimeEnv.ts`）。命中以下任一条件的键不接受并产生诊断（§3.6）：

- `shouldSanitizeZCodeRuntimeEnvKey(key)` 为真（`runtimeEnv.ts:286`）：即 `SANITIZED_RUNTIME_ENV_KEYS`（CUA broker socket/refresh/authority、`OTEL_*`/`ZCODE_TELEMETRY_*`、代理与 CA 类、`ZCODE_REMOTE_*`、`NODE_ENV`、`ELECTRON_RUN_AS_NODE`、`NODE_NO_WARNINGS`）+ 包管理器 `*_proxy/*_cafile/*_ca` 模式 → 记为 `sanitized_key`。
- `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`（`runtimeEnv.ts:10`，内部封存载体，不能被配置伪造）→ 记为 `reserved_key`。
- 键名不符合 `^[A-Za-z_][A-Za-z0-9_]*$` → 记为 `invalid_name`。

理由不只是洁癖：这些键在 `buildExecutionEnv` 里本来就会被 `sanitizeZCodeRuntimeEnvInPlace` 删掉，或者被 `applyNetworkEgressEnv` 覆盖（`subprocess-env.ts:71-128`）。放行只会得到"配置写了但没用"的静默失效——这正是本功能要消灭的体验。想改代理请用配置里已有的 `network.httpProxy/noProxy/caCertFile`（`schema.ts:26-31`）。

`PATH` **允许**（用户的真实诉求之一就是给工具子进程补 PATH），不列入拒绝清单。

### 3.4 项目级配置：本期不生效

`<workspace>/.zcode/config.json`（及向上到 `.git` 根的各层，`workspace-hook-config.ts:335`）里的 `env` 等价于"仓库可以让你的工具子进程执行任意东西"（`PATH`、`NODE_OPTIONS`、`BASH_ENV`），二期的 `envFromShell` 更是凭据外泄面。因此：

- **本期已实现**：项目层的 `env` 在 `normalizeProjectConfig`（`project-config.adapter.ts`，与 hooks 的剥离同一处）里从 patch 中剥离，并产生 `config_project_env_blocked` 诊断。
- 这是 **fail-closed**，不是忽略：若只是不实现门禁而让项目层照常合并，就等于 clone 一个仓库即可获得任意 env 注入能力——比 hooks 更危险。实测：项目层写 `KS_AGENT_PLATFORM: "hijacked-by-project"` 时，工具子进程里仍是用户级的值。
- 用户级 `~/.zcode/cli/config.json` 不设门禁——那是用户自己的文件，效果等同于用户在 shell 里 export。

**二期方案（真实需求出现时再做）**：未授权时字段不进合并结果（`config_project_env_blocked` 语义由"不支持"改为"待信任"，声明只留在不可变 side-channel）；授权后生效。信任记录复用 hooks 的机制（`workspace-hook-trust-v1.json`，`workspace-hook-trust-store.ts:20`；判定 `evaluateWorkspaceHookEntry`，`workspace-hook-trust-evaluation.ts:15`；授予走 `zcode hooks trust grant` 或设置页内联信任入口），并把项目层声明的 `env` / `envFromShell` 并入现有 declaration digest，使"先授权 hooks、之后偷偷加 env"不成立。

### 3.5 生效时机

配置在 `createConfig`（同步读盘，`create-app.ts:153` / `zcode-protocol-entrypoint.ts:138`）读入，在装配 execution adapter 时编译成 overlay（§4）。因此：

- **改配置后新开一个会话 / 重启 runtime 生效**，不需要重编译、不需要重启 app。
- 不承诺"当前会话内热生效"。要热生效需另开需求（在工具调用边界按 mtime 重读），本 spec 不含。

### 3.6 诊断

- `config_project_env_blocked`（warning）：项目层声明了 `env` 但不生效。走既有配置诊断管线（`schema.ts` 的 `ConfigDiagnosticCode` → `config-factory.ts` 的 `logConfigDiagnostics` → logger.warn，事件名 `config.project_env.blocked`）。
- 保护键被拒：**没有**做成 `ConfigDiagnosticCode`，而是在装配处 `logger.warn`，事件名 `config.env.key_rejected`，context 带 `key` 与 `reason`（`sanitized_key` / `reserved_key` / `invalid_name`）。原因：剔除发生在消费点（create-app 装配 execution adapter），那里才知道最终生效集合；配置诊断管线是"按文件、装载期"的，硬塞进去还得把来源信息一路透传下来。

两条都只落日志（现有 config diagnostics 无 UI 面）。

### 3.7 二期：`envFromShell`（从 login shell 快照继承）

**要解决的问题**：用户已经在 `.zshrc` 里配好了变量，希望不用在配置里重写一遍。

**已具备的前置条件**：login shell 快照机制已存在（`packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts`，`captureLoginShellEnvSnapshotSync` 带模块级缓存），实测能拿到 `.zshrc` 里的 `KS_AGENT_PLATFORM` 等键值。

**为什么本期没做**：快照实现位于 `packages/services`，而 agent 的装配点是 `apps/zcode-cli/packages/bootstrap`。两者是**不同的包**，bootstrap 目前不依赖 `@zcode/services`（`package.json` 无该依赖、src 无引用）。要消费快照就得新增一条跨包依赖（并过架构策略），或者为 CLI 侧另写一份抓取——都不属于"简单实现 v1"的范围。另外也不能直接在 `buildLoginShellEnvPatch` 扩大白名单：patch 生产发生在桌面 Main 的异步 prewarm（`packages/desktop/src/main/index.ts:557`）与 Host 启动（`packages/services/src/node.ts:1377`），那时**配置还没读**，在那里按配置决定继承集合会造成第二条配置读取路径。

**二期的做法**（设计已定，待实现）：

- 配置加 `envFromShell: string[]`，元素为键名或"前缀 + `*`"（大小写不敏感，`*` 只允许在末尾，不做通用 glob）。
- 命中快照的键，作为 §3.2 优先级链里**低于** `config.env` 直接值的来源；未命中不报错（快照可能因 shell init 失败返回 `null`），只记 `debug`。
- 与现有固定白名单是**叠加**关系：白名单继续决定"进入 host/agent 进程 env"的集合，`envFromShell` 只扩展"进入工具子进程"的集合——不该为了一个 Bash 变量去放宽 runtime 进程的继承面。
- 同样受 §3.3 拒绝清单与 §3.4 项目层剥离约束。
- 默认不声明即零行为变化、零启动开销；开启后 agent 进程首次装配会同步跑一次 login shell（`execFileSync`，上限 4s），慢 `.zshrc` 会拖慢启动，需要记时并留日志。

## 4. 状态所有者与接口

**唯一所有者**：配置层解析出 `RuntimeConfig.env`，装配点（`create-app.ts` 的 `createNodeExecutionAdapter` 调用处）编译成 overlay 注入 execution adapter。禁止任何工具 handler 各自去读配置文件。

| 层              | 位置                                                                                                                           | 实现                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| schema          | `config/schema.ts`                                                                                                             | `ZCodeConfigFileSchema` 加 `env: stringRecordSchema.optional()`；`parsedConfigFileToRuntimePatch` 映射进 patch                                                                                   |
| 类型            | `contracts/src/config/index.ts`                                                                                                | `RuntimeConfig.env: Record<string, string>`、`RuntimeConfigPatch.env?`、`DefaultRuntimeConfig.env = {}`                                                                                          |
| ConfigPort      | `adapters/src/config/index.ts`                                                                                                 | `env` 不在 `ConfigKey` 里，`ConfigPortImpl.getAll()` 从构造时保存的副本返回它。**坑位**：`createConfig().config` 是 `configPort.getAll()` 而不是合并出的 patch，漏改这里会出现"解析对了但拿不到" |
| 合并            | `config-merger.ts`                                                                                                             | `env` 从 `previousEnv` 起做按键合并（`Object.assign` 是引用替换，省事会让上层整体顶掉 user 层）                                                                                                  |
| 装配            | `create-app.ts`（`createNodeExecutionAdapter` 调用处）                                                                         | `resolveConfiguredToolEnv(configResult.config.env)` → 被拒的键逐个 `logger.warn` → `configuredEnv` 传给 adapter                                                                                  |
| 执行适配器      | `adapters/src/exec/`：`NodeExecutionAdapterOptions.configuredEnv` + `node-execution-adapter-process.ts` 的 `prepareChildSpawn` | `mergeExecutionEnvOverlay(configuredEnv, request.env)`（`execution-command.ts`）合成 overlay：`set = {...configuredEnv, ...request.env.set}`                                                     |
| 子进程 env 组装 | `execution-command.ts` 的 `buildExecutionEnv`                                                                                  | **未改**。`overlay.set` 已在该函数末尾（sanitize 与网络注入之后）应用，配置键天然不被 sanitize 吞掉                                                                                              |
| 项目层          | `project-config.adapter.ts`                                                                                                    | `normalizeProjectConfig` 剥离 `env`；`loadProjectConfigFile` 在有声明时推 `config_project_env_blocked` 诊断                                                                                      |

**明确不做**：不要用 `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`（`runtimeEnv.ts:227`）承载配置 env。该通道的准入判定 `shouldCaptureZCodeToolEnvPassthroughKey` 是"只封存本来会被 sanitize 的敏感键"，放宽它等于削弱 CUA/telemetry/remote 的隔离语义。

## 5. 事件顺序

```
~/.zcode/cli/config.json（项目层同名声明在装载时被剥离）
        │  同步读盘，createConfig()                       create-app.ts:153
        ▼
RuntimeConfig.env  ──resolveConfiguredToolEnv──►  configuredEnv（含被拒键的 warn 诊断）
        │                                               create-app.ts
        ▼
createNodeExecutionAdapter({ configuredEnv, processEnv })
        │
        ▼   Bash 工具调用
ExecutionRequest(env = undefined)                        bash.ts
        │
        ▼
buildExecutionEnv(mergeExecutionEnvOverlay(...), {processEnv})   execution-command.ts
   1) 复制 processEnv → sanitize 名单剔除
   2) text env
   3) network egress（代理/CA/封存恢复）
   4) overlay.unset → overlay.set   ◄── configuredEnv 与 request.env 合并后在此生效
   5) shellProvider.envOverlay
        │
        ▼
spawn 子进程（skill 脚本 / shell 命令）
```

## 6. 与现有两条链路的差异

Bash 子进程 env 的组装在打包态与 headless CLI 下是**同一套代码**（都经 `createZCodeApp` → `createNodeExecutionAdapter`），配置 env 走的就是这套的同一个装配点。差异只在上游 env 来源与 sanitize 位置：

- headless/protocol：CLI 入口 sanitize（`cli/src/env.ts:28`，`run.ts:244`）。
- desktop 打包态：Main/host 在 spawn 边界 sanitize（`desktopRuntimeEnv.ts:518`，`zcodeAgentProcessManager.ts:1019`）。

两者都不影响配置 env 的注入（它发生在 execution adapter 内部、sanitize 之后）。注意：**安装版要生效需要一次打包**（agent bundle 里才有这段代码），之后改配置就不需要再打包了。

## 7. 验收场景

标注 ✅ 的是 v1 已实测：

1. ✅ 用户级 config 写 `"env": {"KS_AGENT_PLATFORM": "codeflicker", ...}`，headless CLI 里 Bash 执行 `printf 'PROBE=%s|%s|%s\n' "$KS_AGENT_PLATFORM" "$FLICKER_USERNAME" "$PROBE_FROM_CONFIG"`，tool 输出 `PROBE=codeflicker|liuyutong08|config-value-ok`（证据取自会话库 `part.data`，不是模型自述）。
2. 同名键在 `process.env` 里已存在时以配置值为准。
3. ✅ 保护键：配置里放 `HTTP_PROXY` → 不生效，日志出现 `config.env.key_rejected`，context 为 `{"key":"HTTP_PROXY","reason":"sanitized_key"}`。
4. ✅ 项目层声明被阻断：项目 `.zcode/config.json` 写 `env`（含 `KS_AGENT_PLATFORM: "hijacked-by-project"`）→ 不生效（Bash 里仍是用户级的值），日志出现 `config.project_env.blocked`。
5. 单次调用 overlay 优先：hook/plugin 通过 `request.env.set` 注入同名键时以 hook 值为准（合成规则见 §8 单测）。
6. 分层合并：user 层 `env: {A:1,B:2}`、project 层 `env: {B:3}` → 生效集合 `A=1,B=2`（项目层被剥离）。
7. 打包态验证：安装版 app 改 `~/.zcode/cli/config.json` → 新会话生效，无需重编译。
8. 回归：`env` 字段存在时 MCP server 的 env 行为不变（仍只看 `mcp.servers.<name>.env`）。

## 8. 测试与验证

- 单测（已跑，6 例全过）：`apps/zcode-cli/packages/core/test/configured-tool-env.test.ts` —— 普通键接受、大小写与空值保留、`undefined`/空输入、sanitize 名单键被拒（含小写 `http_proxy` 与 `npm_config_proxy`）、封存载体键被拒、非法键名被拒、被拒键不影响同批合法键。运行：`pnpm --dir apps/zcode-cli/packages/core test`。
- 门禁（已跑）：`pnpm typecheck`（exit 0）、逐包 `pnpm --dir apps/zcode-cli/packages/{contracts,adapters,core,bootstrap,cli} typecheck`（各 0 error）、`pnpm lint`（0 error，74 个既有 warning）、`pnpm architecture:check --changed`（violations 0）、`pnpm knip` 未报新增符号未使用。
- 真机（已跑）：headless CLI 覆盖场景 1 / 3 / 4（命令形态见 `CUSTOM_DEV_WORKFLOW.md` §4.0）。注意它会写真实会话库，验证后要清理（本次留下两个探针会话）。
- 尚未验证：打包态（场景 7）、桌面 dev、Windows。

## 9. 落地状态

**v1 已完成**：schema → 类型 → ConfigPort 暴露 → 合并 → 过滤与诊断 → 项目层剥离 → execution adapter overlay → create-app 接线 → 单测 → headless 真机验证。

**二期（真实需求出现再做）**：

1. `envFromShell`（§3.7），前置是解决 `packages/services` 快照与 `apps/zcode-cli` bootstrap 之间的跨包依赖。
2. 项目级 `env` / `envFromShell` 生效 + 信任门禁（§3.4），届时把 `config_project_env_blocked` 的依据从"不支持"改为"待信任"。
3. 可选的体验补强：保护键被拒时在 CLI 输出里可见（现在只落日志）。

## 10. 已知限制与风险

- 配置 env 只在会话/runtime 启动时读取：改完配置要新开会话，不是当前会话内即时生效。
- 项目级声明本期被剥离，而诊断只落日志（现有 config diagnostics 无 UI 面），用户可能在命令行看不到解释。
- `PATH` 放行意味着用户级配置可以把工具子进程的命令解析指向任意目录（用户自担，等同于自己在 shell 里 export）；项目级因不允许生效，不构成仓库侧风险。
- **只覆盖 `create-app.ts` 这一个装配点**：workflow 子运行时（`workflow-facade.ts`、`script-workflow-child-runtime.ts`）另建 execution adapter，那里看不到配置 env。
- 只在工具子进程内可见：若某类调用（MCP server、relay、provider 网关）也需要这些变量，不在本设计范围（MCP 已有自己的 `env` 字段）。
- `apps/zcode-cli` 下被改动的 `config/schema.ts`、`config/index.ts`、`bootstrap/create-app.ts` 在 HEAD 时就已超过该目录的 400 行硬规定，本次各增了几行；后续若要继续动这几处，应先拆分模块。
