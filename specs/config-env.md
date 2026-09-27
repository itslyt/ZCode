# 配置文件的 env 字段（直接值 + shell rc 继承）

> 状态：设计已定，待实现。
> 目标读者：接手实现的人，以及后续改这块的维护者。

## 1. 背景与问题

`~/.zcode/cli/config.json` 里没有 `env` 字段（`ZCodeConfigFileSchema`，`apps/zcode-cli/packages/adapters/src/config/schema.ts:284`），而且它是 `.passthrough()` —— 手写 `"env": {...}` 不报错，但 `parsedConfigFileToRuntimePatch`（`schema.ts:398-424`）只拷贝已知键，未知键**静默丢弃**，也不会变成进程环境变量。

现状下想让 agent 的工具子进程拿到某个环境变量，只有三条路，都不满足"改配置就生效"：

| 途径               | 生效范围                                 | 问题                                                                                                                                 |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.zshrc` export  | 只有交互式 shell                         | 非交互 shell 不读；GUI 启动的安装版 app 继承不到（实测 `zsh -i -c 'echo $KS_AGENT_PLATFORM'` → `codeflicker`，agent 的 Bash 里为空） |
| `.env`             | CLI 边界（`packages/cli/src/env.ts:74`） | 打包态协议 server 明确不读（`run.ts:243-256`，`shouldLoadCliDotenvForProtocolServer` 仅 development 为真）                           |
| `launchctl setenv` | GUI app                                  | 改系统级环境、需重启 app、不随项目/工作区分化                                                                                        |

实际后果：agent-browser 的 `obo_token_fetcher.sh:283-293` / `kfetch_cookies.sh:53-68` 按小写后的 `KS_AGENT_PLATFORM` 分支取 OboToken / cookie，空值时三个分支都不命中 → `fail AUTH_FAILED "未能获取 OboToken"`。

**关键事实：`.zshrc` 其实已经被读了，只是没往下传。** 仓库早就有 login shell 快照机制：`captureLoginShellEnvSnapshot`（`packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts:173-218`）用 `zsh -ilc`（interactive + login，zsh 下会 source `.zshrc`）拿 `env -0` 全量快照（4s 超时、POSIX 独立进程组兜底 kill、模块级缓存）。实测该快照有 79 个键，`KS_AGENT_PLATFORM = "codeflicker"`、`FLICKER_USERNAME`、`RELAY_PLATFORM` 都在里面。被挡掉的是**继承环节**：`buildLoginShellEnvPatch`（`runtimeCommandEnv.ts:112-126`）只用固定白名单 `INHERITED_LOGIN_SHELL_ENV_KEY_PATTERNS`（`runtimeCommandEnv.ts:48-106`）过滤，注释写明理由是"避免恢复宽继承把 `NODE_OPTIONS` 等带进 host/agent runtime"（:94）。`KS_*`/`FLICKER_*` 不在名单里，于是被丢弃。

所以本设计有两个 env 来源：**配置里直接写值**（§3.1-§3.6），以及**从已有快照里继承用户声明的键**（§3.7）。

配置文件是**安装版也一定会读**的那一份（`createConfig` 同步读盘，与 dev/prod 无关），所以把这两个字段放进配置是最合适的载体。

## 2. 目标 / 非目标

**目标**

- 用户级 `~/.zcode/cli/config.json` 支持顶层 `env: Record<string, string>`（直接值）与 `envFromShell: string[]`（从 login shell 快照继承），改动后**不需要重新编译、不需要改 shell、不需要 launchctl**。
- 项目级 `<workspace>/.zcode/config.json` 同名字段，但受信任门禁约束（见 §3.4）。
- 两者都注入到 Bash / 工具子进程，语义与"进程本来就有这个变量"等价。
- 复用已有的 shell 快照抓取，不新增抓取机制、不重复配置一遍 `.zshrc` 里已有的变量。
- 默认关闭 `envFromShell`：不声明时行为与今天完全一致（零行为变化、零启动开销）。
- 不破坏现有安全边界：CUA broker、telemetry、代理/证书等敏感键仍不可被配置覆盖。

**非目标（v1 明确不做）**

- 不注入 agent 自身 `process.env`（那会改 provider/网络/权限判定所读的环境，且与 sanitize 规则互相干扰）。
- **不做"全量继承 shell env"**：白名单语义保持。全量继承等于把用户 shell 里所有凭据（token、云厂商 AK）无差别放进 agent 可控的子进程，无法穷举排除。
- 不注入 MCP server（MCP 有自己的 `env` 字段，`schema.ts:82`，保持隔离）与 relay/桌面主进程。
- 不做热重载：生效时机与其它配置字段一致，见 §3.5。
- 不支持值插值/引用（`${HOME}`、`$PATH` 之类），只存字面量。

## 3. 产品规则

### 3.1 生效范围

配置的 `env` / `envFromShell` 只作用于**由 `executionPort` 拉起的子进程**（Bash 工具、以及任何走同一 execution 请求的调用），不作用于 agent 进程本身、MCP server、provider HTTP 客户端。

理由：诉求（skill 脚本、shell 命令）走的就是这条链；不碰 agent 自身进程可以避免"配置能改运行时语义"这一类隐式影响。

### 3.2 优先级

子进程 env 的最终优先级（低 → 高）：

```
进程 process.env（sanitize 后）
  < login shell 快照里 envFromShell 声明的键
    < 配置 env 的直接值
      < 单次调用 overlay（request.env：plugin / hook / 工具自身注入，如 configured-runner-input.ts:74-98）
        < shell provider envOverlay（GIT_EDITOR / SHELL，bash-shell-provider.ts:94-109）
```

要点：

- 配置值**覆盖** `process.env` 里的同名键（否则"改配置没反应"正是要避免的坑），被覆盖的键在启动日志里记一条 `debug`（键名，不记值）。
- 直接值覆盖 shell 继承值：显式声明的胜过环境里的。
- 已被 host patch 继承进进程 env 的白名单键（如 `NVM_DIR`、`JAVA_HOME`）保持进程 env 的值——它与快照同源，不产生差异。

### 3.3 保护键（拒绝清单）

命中以下任一条件的键**不接受**（两个来源都一样），产生一条诊断（§3.6）并跳过：

- `shouldSanitizeZCodeRuntimeEnvKey(key)` 为真（`packages/shared/src/runtimeEnv.ts:286-292`）：即 `SANITIZED_RUNTIME_ENV_KEYS`（CUA broker socket/refresh/authority、`OTEL_*`/`ZCODE_TELEMETRY_*`、代理与 CA 类、`ZCODE_REMOTE_*`、`NODE_ENV`、`ELECTRON_RUN_AS_NODE`、`NODE_NO_WARNINGS`）+ 包管理器 `*_proxy/*_cafile/*_ca` 模式。
- `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`（`runtimeEnv.ts:10`，内部封存载体，不能被配置伪造）。
- 键名不符合 `^[A-Za-z_][A-Za-z0-9_]*$`。

理由不只是洁癖：这些键在 `buildExecutionEnv` 里本来就会被 `sanitizeZCodeRuntimeEnvInPlace` 删掉（`execution-command.ts:48`），或者被 `applyNetworkEgressEnv` 覆盖（`subprocess-env.ts:71-128`）。放行只会得到"配置写了但没用"的静默失效——这正是本功能要消灭的体验。想改代理请用配置里已有的 `network.httpProxy/noProxy/caCertFile`（`schema.ts:26-31`）。

`PATH` **允许**（用户的真实诉求之一就是给工具子进程补 PATH），不列入拒绝清单。

### 3.4 项目级配置需要信任

`<workspace>/.zcode/config.json`（及向上到 `.git` 根的各层，`packages/shared/src/workspace-hook-config.ts:174-179`）里的 `env` 与 `envFromShell` 等价于"仓库可以让你的工具子进程执行任意东西"（`PATH`、`NODE_OPTIONS`、`BASH_ENV`），`envFromShell` 更是**凭据外泄面**（仓库写 `["AWS_*", "GITHUB_*"]` 就能把用户的云凭据注入仓库可控脚本的环境）。因此：

- **未信任**：这两个字段都不从该层进入合并结果，产生 `config_project_env_pending_trust` 诊断；行为对齐 hooks 的现有语义（`project-config.adapter.ts:122-130` 把 hooks 从 patch 中剥离，只留在 side-channel）。
- **已信任**：生效。
- 信任记录复用现有机制（`workspace-hook-trust-v1.json`，`adapters/src/storage/workspace-hook-trust-store.ts:21`；授予走 `zcode hooks trust grant` / 桌面 review controller）。**摘要口径统一**：把项目层声明的 `env` 与 `envFromShell` 并入现有的 hook declaration digest，改内容即视为声明变化 → 重新回到 `pending_trust`。这样"先信任 hooks、之后偷偷加 env"不成立。
- 用户级 `~/.zcode/cli/config.json` 不设门禁——那是用户自己的文件，效果等同于用户在 shell 里 export。

### 3.5 生效时机

配置在 `createConfig`（同步读盘，`create-app.ts:153` / `zcode-protocol-entrypoint.ts:138`）读入，在装配 execution adapter 时编译成 overlay（§4）。因此：

- **改配置后新开一个会话 / 重启 runtime 生效**，不需要重编译、不需要重启 app。
- 不承诺"当前会话内热生效"。要热生效需另开需求（在工具调用边界按 mtime 重读），本 spec 不含。

### 3.6 诊断

新增两个 `ConfigDiagnosticCode`（`schema.ts:313-316`）：

- `config_env_key_rejected`（warning）：某键被 §3.3 拒绝，message 含键名与原因分类（`sanitized_key` / `reserved_key` / `invalid_name`），并标明来源（`env` / `envFromShell`）。
- `config_project_env_pending_trust`（warning）：项目层声明了 env 或 envFromShell 但未信任。

消费方式沿用现有 `logConfigDiagnostics`（`config-factory.ts:400-428`）→ logger.warn，不新增 UI 面。

### 3.7 `envFromShell`：从 login shell 快照继承

**语义**：`envFromShell: string[]`，元素是键名或"前缀 + `*`"。命中的快照键，其值作为一个 env 来源参与 §3.2 的优先级链。

```jsonc
{
  "env": { "KS_AGENT_PLATFORM": "codeflicker" },
  "envFromShell": ["FLICKER_*", "KS_*"],
}
```

**规则**

- 匹配：大小写不敏感（与现有 patterns 一致）。`*` 只允许出现在末尾，表示前缀匹配；禁止中间通配、正则、`?`、字符类——不做通用 glob，避免用户以为能写正则。
- 未命中快照的键不报错，只记 `debug`（键名），因为快照本身依赖 shell init 成功（超时/失败时 `captureLoginShellEnvSnapshot` 返回 `null`）。
- 命中的键同样受 §3.3 拒绝清单与 §3.6 诊断约束（例如 `envFromShell: ["HTTP_PROXY"]` 被拒）。
- **与现有固定白名单是叠加关系，不替换**：`INHERITED_LOGIN_SHELL_ENV_KEY_PATTERNS`（`runtimeCommandEnv.ts:48-106`）继续决定"进入 host/agent 进程 env"的默认集合；`envFromShell` 只扩展"进入工具子进程"的集合。两者分开的理由：前者影响整个 runtime 进程（含 provider、网络、权限判定所读的环境），后者只影响工具子进程——不该为了一个 Bash 变量去放宽 runtime 进程的继承面（那里的注释已明确拒绝宽继承）。

**为什么不在 `buildLoginShellEnvPatch` 里直接扩大白名单**：patch 生产发生在桌面 Main 的异步 prewarm（`packages/desktop/src/main/index.ts:557-577`）与 Host 启动（`packages/services/src/node.ts:1377 initializeRuntimeProcessEnv`），此时**配置还没读**（配置在 agent 侧 `createApp` 才读）。要在那里按配置决定继承集合，就得让 Main/Host 自己再读一遍配置文件 → 第二条配置读取路径、两处状态。因此改为在配置已经读到、且注入点唯一的 create-app 装配处消费快照（`captureLoginShellEnvSnapshotSync`，模块级缓存，同一进程内只抓一次）。

## 4. 状态所有者与接口

**唯一所有者**：配置层解析出 `RuntimeConfig.env` / `RuntimeConfig.envFromShell`，装配点把它编译成一个 overlay 注入 execution adapter。禁止任何工具 handler 各自去读配置文件或自己抓 shell 环境（避免多写入路径）。

| 层              | 位置                                                                                                                   | 改动                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema          | `config/schema.ts:284-306`                                                                                             | `ZCodeConfigFileSchema` 加 `env: stringRecordSchema.optional()` 与 `envFromShell: z.array(z.string()).optional()`（元素格式在解析期校验，非法即 `config_file_invalid`）；`parsedConfigFileToRuntimePatch`（:398-424）映射进 patch |
| 类型            | `contracts/src/config/index.ts` `RuntimeConfig`(:202) / `RuntimeConfigPatch`(:260) / `DefaultRuntimeConfig`(:290)      | 加 `env?: Record<string, string>`（默认 `{}`）与 `envFromShell?: string[]`（默认 `[]`）                                                                                                                                           |
| 合并            | `config-merger.ts:26-45`                                                                                               | `env` 必须**按键深合并**（不能靠 `Object.assign` 整块覆盖，否则 project/cli 层会整体顶掉 user 层）；`envFromShell` 按层**拼接去重**（下层声明不被上层抹掉，冲突时高优先层在前）                                                   |
| 编译            | `create-app.ts:392-403`（`createNodeExecutionAdapter` 调用处）                                                         | 把 `configResult.config.env` 过滤（§3.3）后作为 `configuredEnv` 传入；若 `envFromShell` 非空，则调 `captureLoginShellEnvSnapshotSync()` 取快照、按 §3.7 匹配出键值，作为同一 overlay 的更低一层；两条链路都要接（§6）             |
| 执行适配器      | `adapters/src/exec/`：`NodeExecutionAdapterOptions` + `prepareChildSpawn`（`node-execution-adapter-process.ts:62-67`） | 新 option `configuredEnv?: Record<string,string>`；与 `request.env` 合成一个 overlay：`set = {...configuredEnv, ...request.env.set}`，`unset = request.env.unset`，`base = request.env.base`                                      |
| 子进程 env 组装 | `execution-command.ts:28-69`                                                                                           | **不改**。`overlay.set` 已在 sanitize + 网络注入之后应用（:60-66），配置键天然不被 sanitize 吞掉                                                                                                                                  |
| shell 快照      | `runtimeLoginShellEnvCapture.ts:220-246`（`captureLoginShellEnvSnapshotSync`）                                         | **不改**：复用现有抓取与缓存，不新增 shell 调用逻辑                                                                                                                                                                               |
| 项目信任        | `project-config.adapter.ts:61-130` + digest 计算处                                                                     | 加两个字段的 pending 诊断与剥离，二者并入 declaration digest                                                                                                                                                                      |

**明确不做**：不要用 `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`（`runtimeEnv.ts:227-238`）承载配置 env。该通道的准入判定 `shouldCaptureZCodeToolEnvPassthroughKey`（`runtimeEnv.ts:294-303`）是"只封存本来会被 sanitize 的敏感键"，放宽它等于削弱 CUA/telemetry/remote 的隔离语义。

## 5. 事件顺序

```
~/.zcode/cli/config.json (+ 项目层)
        │  同步读盘，createConfig()                       create-app.ts:153
        ▼
RuntimeConfig.env / .envFromShell
        │  过滤(§3.3)+诊断；envFromShell 非空时读快照      create-app.ts:392-403
        │  （captureLoginShellEnvSnapshotSync：进程内只抓一次 zsh -ilc）
        ▼
configuredEnv（= 快照命中键  ⊕  config.env 直接值）
        │
        ▼
createNodeExecutionAdapter({ configuredEnv, processEnv })
        │
        ▼   Bash 工具调用
ExecutionRequest(env = undefined)                        bash.ts:388-444
        │
        ▼
buildExecutionEnv(overlay, {processEnv})                 execution-command.ts:28
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

Bash 子进程 env 的组装在打包态与 headless CLI 下是**同一套代码**（都经 `createZCodeApp` → `createNodeExecutionAdapter`）。差异只在上游 env 来源与 sanitize 位置：

- headless/protocol：CLI 入口 sanitize（`cli/src/env.ts:28-48`，`run.ts:244-258`）。
- desktop 打包态：Main/host 在 spawn 边界 sanitize（`desktopRuntimeEnv.ts:518-521`，`zcodeAgentProcessManager.ts:1019-1032`），host 侧另经 `initializeRuntimeProcessEnv`（`runtimeCommandEnv.ts:240-267`）注入 `runtimeProcessEnvPatch`。

配置 env 走的是 execution adapter 的 overlay，与上面两处 sanitize 都不冲突；但**两条链路都要在各自的 execution adapter 装配点传 `configuredEnv`**，否则会出现"headless 有、桌面没有"的分裂。

shell 快照另有一处差异：桌面 Main 已经在启动时异步抓过一份快照（`main/index.ts:557-577`），但它算出的 patch 只带白名单键并注入 host 进程；agent 进程不持有这份数据，所以 `envFromShell` 的消费会在 agent 侧再抓一次（有模块级缓存，每个 agent 进程至多一次）。

## 7. 验收场景

1. 用户级 config 写入 `"env": {"KS_AGENT_PLATFORM": "codeflicker", "FLICKER_USERNAME": "liuyutong08"}`，新开会话后 Bash `echo $KS_AGENT_PLATFORM` = `codeflicker`；`obo_token_fetcher.sh` 不再返回 `AUTH_FAILED`。
2. 同名键在 `process.env` 里已存在（例如交互式 shell 里 export 过）时，以配置值为准，并留下一条 `debug` 日志。
3. 保护键：配置 `"env": {"HTTP_PROXY": "...", "ZCODE_CUA_BROKER_SOCKET": "...", "1BAD": "x"}` → 三者都不生效，各产生一条 `config_env_key_rejected`；代理仍由 `network.httpProxy` 决定。
4. 项目层未信任：`<workspace>/.zcode/config.json` 声明 env/envFromShell → 不生效 + `config_project_env_pending_trust`；`zcode hooks trust grant` 后新会话生效；改动声明内容后重新变为 pending。
5. 优先级：某个 hook/plugin 通过 `request.env.set` 注入同名键 → 该次调用以 hook 值为准。
6. 分层合并：user 层写 `env: {A:1,B:2}`，project（已信任）写 `env: {B:3}` → 生效集合为 `A=1,B=3`。
7. 打包态验证：安装版 app（非 dev）改 `~/.zcode/cli/config.json` → 新会话生效，无需重编译、无需 launchctl。
8. 回归：`env` 字段存在时 MCP server 的 env 行为不变（仍只看 `mcp.servers.<name>.env`）。
9. `"envFromShell": ["KS_AGENT_PLATFORM", "FLICKER_*"]` → 新会话 Bash 里 `KS_AGENT_PLATFORM`（精确命中）与 `FLICKER_USERNAME`/`RELAY_PLATFORM`（前缀命中）都可见；`.zshrc` 无需改动。
10. 不声明 `envFromShell` 时行为与改动前完全一致（`KS_AGENT_PLATFORM` 仍不在 Bash 里），且不产生任何额外 shell 抓取。
11. `envFromShell: ["HTTP_PROXY"]` → 拒绝 + `config_env_key_rejected`；`envFromShell: ["A*B"]` / `["a b"]` → 解析期报 `config_file_invalid`。
12. `envFromShell` 声明的键在快照里不存在（例如拼错、或 shell init 失败返回 `null`）→ 不报错、不阻塞，Bash 里没有该变量，日志有 `debug` 记录。
13. 项目层 `envFromShell: ["AWS_*"]` 未信任 → 不生效（凭据不外泄）。

## 8. 测试与验证

- `pnpm --dir apps/zcode-cli/packages/core test`：execution overlay 合成与优先级（快照 < config.env < request.env），以及 §3.3 过滤（拒绝清单命中即丢弃）。
- adapters/config 侧单测：schema 映射（两个字段进 patch）、`config-merger` 的按键深合并与 `envFromShell` 拼接去重、项目层未信任时的剥离与诊断码。
- 匹配器单测（§3.7 规则）：精确、`前缀*`、大小写不敏感、非法模式被拒；用**注入的假快照**测，不真的去跑 shell。
- shell 快照交互测试：mock `captureLoginShellEnvSnapshotSync`，断言未命中键不报错、命中键出现在 overlay 且被 sanitize 拒绝清单挡住。
- headless CLI 真机验证：`ZCODE_ENV=production node .../tsx src/main.ts -p "..." --surface terminal`，让 agent 执行 `echo $KS_AGENT_PLATFORM`，并直查日志确认诊断是否按预期出现。
- 打包态验证按验收场景 7 / 9。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm --dir apps/zcode-cli/packages/{contracts,core,cli} typecheck`（根 typecheck 不覆盖该目录）、`pnpm architecture:check --changed`。

## 9. 落地步骤（建议顺序）

1. schema + 类型 + 合并规则（含单测）。
2. 过滤与诊断（§3.3 / §3.6）。
3. execution adapter 的 `configuredEnv` option + overlay 合成（含单测）。
4. create-app 装配点接线（headless 与 desktop 两条链路）。
5. `envFromShell`：匹配器 + 快照消费 + 与 §3.1-§3.6 的优先级接线（可与 6 并行）。
6. 项目层信任门禁（含 digest 并入与诊断）。
7. 真机验证（headless）→ 打包验收。

1–4 是可独立交付的最小闭环（覆盖"配置里写值"的原始诉求）；5 覆盖"我自己 `.zshrc` 里配好的直接用"；6 是项目级配置生效的前提。

## 10. 已知限制与风险

- 项目层信任的摘要口径变更会让**已有**的 hooks 信任记录失效一次（需要重新 trust），属预期代价，需在改动说明里写清。
- 配置 env 只在会话/runtime 启动时读取：改完配置要新开会话，不是当前会话内即时生效。
- `envFromShell` 开启后，agent 进程首次装配会同步跑一次 login shell（`execFileSync`，超时上限 4s，`runtimeLoginShellEnvCapture.ts:236-240`）。慢 `.zshrc`（nvm/conda/direnv）会拖慢启动：默认关闭该特性即零成本，开启后建议记时并留 `debug` 日志；快照抓取失败不阻塞启动。
- `envFromShell` 是凭据外泄面：`["AWS_*", "GITHUB_*"]` 会把凭据放进仓库可控脚本的环境 → 项目级必须走信任门禁；用户级自担（等同于自己在 shell 里 export）。
- `PATH` 放行意味着配置可以把工具子进程的命令解析指向任意目录；用户级文件自担，项目级靠信任门禁兜。
- 只在工具子进程内可见：若某类调用（MCP server、relay、provider 网关）也需要这些变量，不在本设计范围，需单独设计（MCP 已有自己的 `env` 字段，优先复用而不是叠加）。
