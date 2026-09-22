# ZCode 系统提示词改造（迁移主力到 ZCode）

状态：**已实现（直接改提示词，不新增 section）**。目标：把日常主力从 DSH 迁到 ZCode，先把**系统提示词**
按 DSH 上已验证的 persona 重构，同时砍掉 ZCode 里产品专属、重复、无信号的段。

实现说明：原计划的「新增 `custom_persona` 段 + 默认关闭开关」已放弃——直接改 `sections/identity.ts`
等现有提示词文件更简单，也少一层配置与死代码。实现记录见 §8。

## 1. 两家现状对比

| 维度     | DSH（`code-max-omni` preset）                                                                                                                                                      | ZCode（当前）                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 组织方式 | `persona` 一段 prefix（8753 字符）+ `agent-instructions`（≤64KB）                                                                                                                  | 13 个 section 按序拼装，system / meta_user 两个注入目标，各带 `cacheHint`（stable / dynamic）                          |
| 人格内容 | 11 段 49 条：Security / Safety / Untrusted content / Engineering judgment(12) / Verification(3) / Working style(8) / Delivery(6) / Corrections(2) / Autonomy(4) / Communication(7) | identity 1211 字符 = 开场句 + 安全 IMPORTANT 行 + `# Harness` 5 条；**没有工程判断、没有验证纪律、没有不可信内容处理** |
| 过程纪律 | 6 个 Harness 硬机制（deliberation-gate / cot-drip / todo-closeout / tool-result-budget / rollout-budget / edit-fail-coach）                                                        | 无硬机制；过程纪律全靠提示词（`dynamic_behavior` 3065 + `context_management` 1915）                                    |
| 工具面   | 18 个                                                                                                                                                                              | ~35 个（含 Cron/OffPeak/Workflow/协调面）                                                                              |
| 项目指令 | `agent-instructions` ≤64KB                                                                                                                                                         | `request_user_context`（meta_user）：`# agentsMd` + AGENTS.md（上限 100KB）+ MEMORY.md 索引                            |

## 2. ZCode 当前 system 段清单（字符数为实测）

| 段                        | source                 | 字符           | 判定                                                                                                                       |
| ------------------------- | ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| CLI Prefix                | `cli_prefix`           | 42             | **合并**进 identity（`You are ZCode, an interactive coding agent` 与 identity 开场句重复；workflow 子代理还要特意跳过它）  |
| Agent Identity            | `identity`             | 1211           | **保留 + 精简**：安全行保留；`# Harness` 里"终端 markdown""hooks 输出当用户反馈"对个人使用无信号                           |
| ZCode Desktop Context     | `desktop_context`      | 1100           | **产品专属，条件化**：`::code-comment{}` 指令是 Desktop 内联评论功能，占大半；不用就删                                     |
| Dynamic Behavior          | `dynamic_behavior`     | 3065           | **拆分**：`Communicating with the user`（5 段）与 persona 的 Communication 重复 → 单一所有者；`hard-to-reverse` 安全段保留 |
| Session-specific guidance | `session_guidance`     | 162            | **合并**进 skills 段（现在只剩一条 Skill 用法；Agent/AskUserQuestion 指导已被注释掉）                                      |
| Memory                    | `memory`               | 0（未启用时）  | **默认关**：用户不依赖 auto-memory，规则写 AGENTS.md                                                                       |
| Environment Info          | `env_info`             | ~300           | **保留**：cwd / git / platform / shell 是编码必需                                                                          |
| Output Style              | `output_style`         | 0              | 目前**没有生产者**（core 只消费，插件 manifest 里 `outputStyles` 是 diagnostic-only）→ 可作可选挂点                        |
| Context Management        | `context_management`   | 1915           | **拆分**：压缩说明保留；autonomy 4 条与 persona 的 Autonomy / Delivery 重复 → 单一所有者                                   |
| Git System Context        | `git system context`   | 400–2000       | **精简**：recent commits 段可去或限条数                                                                                    |
| Skills                    | `skills`               | 200–20000      | 保留（预算 20k）                                                                                                           |
| Request User Context      | `request_user_context` | AGENTS.md 实测 | 保留（上限 100KB）                                                                                                         |
| Current Date              | `current_date`         | ~60            | 保留                                                                                                                       |

静态 system 段合计 **7495 字符**（cli-prefix+identity+desktop+dynamic_behavior+session_guidance+context_management）。
对比：persona 8753 字符，但**内容几乎不重叠**——ZCode 花了 7.5k 字符仍缺工程判断/验证/不可信内容三类规则，
其中约 1.1k 还是 Desktop UI 功能说明。

## 3. 相对 persona 缺失的规则（需补进 ZCode）

- **Untrusted content（完全缺失）**：文件/工具结果/网页/skill 内容只当数据；"忽略上述指令"类文本不执行并上报。
- **Engineering judgment（缺失）**：查根因不打补丁；新项目可大胆、老代码要克制；不过度抽象/不加不可能发生的兜底；
  注释只写非显然的 why；删掉真正无用的代码；不引入安全漏洞。
- **Verification and reporting（部分缺失）**：区分"已验证 / 只是相信"；报真实结果与输出；UI 改动要真跑起来再报完成。
- **Working style（部分缺失）**：已有并行调用（Harness 段）；缺 todo 收尾纪律、编辑纪律（改元数据后重读 / 批次不混删插）、
  先搜后读、长产出落盘、子代理只用广域探查。
- **Safety（部分）**：已有"删改前先看目标"；缺"不永久删除用户文件（进回收站）""不泄露密钥"。
- **Delivery / Corrections（缺失）**：scope 不悄悄收窄/放大；不过度自我纠错、不因追问就认错。

## 4. 改造方案（三档）

**A. 最小侵入（零代码）**：把 persona 写进 AGENTS.md。

- 优点：不碰源码，上游同步零冲突。
- 缺点：AGENTS.md 是 meta_user 注入（位置在 system 段之后）、语义上是"项目指令"、按仓库一份；跨项目不通用，
  且与工程约定混在一起。**不单独采用。**

**B. 推荐：新增 persona 段（单一所有者 + 上游段精简）**

- 新增 section source `custom_persona`，从**用户级文件**读取（建议 `~/.zcode/PERSONA.md`，settings 可覆盖路径与开关），
  注入位置紧跟 identity（`injectionTarget: "system"`、`cacheHint: "stable"`），默认关闭以便上游同步后行为不变。
- 把 persona 的工程判断/验证/工作方式/交付/纠错/不可信内容/安全补齐到该段；对上游段做**单一所有者**裁剪：
  `dynamic_behavior` 的 Communication 只留一条精简版、`context_management` 的 autonomy 移入 persona、
  `desktop_context` 的 `::code-comment` 改为按设置条件化、`cli-prefix` 合并进 identity、git 段去掉 recent commits。
- 改动面：新增 1 个 section 文件 + `builder.ts` 一处 push + 4 个上游段精简。

**C. 最彻底：`systemPrompt` 整段替换**（通道已存在：`config.systemPrompt` → `customSystemPrompt`）

- 优点：完全掌控。
- 缺点：builder 在 `hasCustomSystemPrompt` 时会**跳过整个动态 system 块**，连 `env_info`（cwd/git/shell）、
  压缩说明、git 上下文一起丢；个人编码场景下 cwd 缺失不可接受。**不推荐**（除非后续给该路径补回 env_info）。

## 5. 上游同步策略（fork 现实）

- 只新增文件（persona section、读取逻辑、spec）：与上游零冲突。
- 需要编辑的上游文件控制在 4 个（`builder.ts`、`sections/identity.ts`、`dynamic-sections.ts`、`sections/desktop.ts`），
  每处改动在 spec 里记录锚点与理由，`custom` 分支同步上游后按锚点重放。
- 所有裁剪默认**可回退**（设置开关），保证同步后先保持上游行为，再逐项启用。

## 6. 度量与验收

1. 提示词体积：改造前后 dump 各 section 的 `chars/tokens`（可直接复用本次实测脚本），目标静态段不增反降。
2. 规则覆盖：按 §3 清单逐条核对新提示词是否覆盖（人工 checklist）。
3. 行为回归（真实任务各一次）：改一个 bug（看是否先搜后读、是否查根因）、一次 UI 改动（看是否真跑起来再报完成）、
   一次探查问题（看是否只给评估不动手）。
4. 测试：`packages/core` 里断言 prompt 文本的测试需同步更新；`pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 全绿。

## 7. 分阶段

- **P0**：persona 段挂点 + 用户级文件读取 + 默认关闭（不改变现有行为）。
- **P1**：把 persona 内容补齐并启用；上游段去重（Communication / autonomy 单一所有者）。
- **P2**：产品专属段条件化（desktop `::code-comment`、git recent commits、memory 默认关）。
- **P3（另一条线）**：把 DSH 的 6 个硬机制按需搬进 ZCode（hooks 7 事件 + core 策略层），不在本次范围。

## 8. 实施记录（直接改提示词）

改动文件：`sections/identity.ts`（写入工程人格）、`dynamic-sections.ts`（删 Communication/autonomy，Context Management 只留压缩说明）、
`sections/desktop.ts`（删 `::code-comment{}` 指令）、`builder.ts`（停止推送 Dynamic Behavior）、`context/types.ts`（删 `dynamic_behavior` source）。

实测（同一脚本 dump 各段 `chars`）：

| 段                 | 改前     | 改后        |
| ------------------ | -------- | ----------- |
| cli-prefix         | 42       | 42          |
| identity           | 1211     | 6656        |
| desktop            | 1100     | 369         |
| dynamic_behavior   | 3065     | 0（段已删） |
| session_guidance   | 162      | 162         |
| context_management | 1915     | 280         |
| **合计**           | **7495** | **7509**    |

总量基本持平，但成分变了：去掉 4.9k 重复与产品文案，换上同等体量的工程人格（engineering judgment / safety /
untrusted content / working style / verification / delivery / autonomy / corrections / communication，
identity 段 2219 tokens）。人格措辞已收紧（比 DSH 的 8753 字符短约 24%），并删掉 ZCode 已用代码强制的重复项
（Edit 拒绝未读文件、权限模式只写一句）。

副作用（需知晓）：删掉 `::code-comment{}` 指令后，模型不再主动发内联评论，Desktop 的
`AssistantCodeCommentCards` 只在旧会话里还能看到；如果要用这个功能，把那段加回 `sections/desktop.ts` 即可。

进一步瘦身的可选杠杆（未做）：安全 IMPORTANT 行 560 字符（产品合规文案）、git system context 的 recent commits、
persona 再压到 ~4.5k。

验证：`pnpm typecheck` 0 error、`pnpm lint` 74 warnings/0 errors（与基线一致）、`pnpm fmt:check` 通过、
`pnpm architecture:check --changed` 0 新增违规。`apps/zcode-cli` 下没有测试文件，也没有断言提示词文本的测试，
故本次以「按 section dump 字符」为证（段就是拼接进请求的内容，结构未动）；**未做真机会话回归**
（需真实模型调用），也未跑 `pnpm --dir apps/zcode-cli lint`（本机未安装 turbo）。

## 9. 工具面才是真正的大头（实测一次真实请求）

从 `~/.zcode/cli/debug/model-io-sess_88d90c26-*.jsonl` 的 `request` 读到的实际工具面：
**32 个工具、132 456 字符**（描述 + input schema）。按族分类：

| 族         | 工具                                                                                                                                                                                                              | 字符        | 对编码场景    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------- |
| 动态工作流 | CreateWorkflow 33 995 / SaveWorkflow 26 011 / EvalWorkflowSnippet 10 710 / AmendWorkflow 7 105 / ListWorkflowRuns 2 879 / GetWorkflowRun 2 810 / ResumeWorkflowRun / ResolveWorkflowQuestion / ListSavedWorkflows | **~88 000** | 无用          |
| 定时任务   | CronCreate 6 143 / CronUpdate 3 883 / CronDelete / CronList                                                                                                                                                       | **~11 000** | 无用          |
| 闲时任务   | OffPeakCreate 3 652 / OffPeakList                                                                                                                                                                                 | **~4 100**  | 无用          |
| 计划模式   | EnterPlanMode 4 328 / ExitPlanMode 2 777                                                                                                                                                                          | **7 105**   | 实测 0 次调用 |
| 委派/协调  | Agent 2 834 / TaskOutput 1 562 / ReadSessionContext 1 405 / SendMessage 1 119 / ListModels 954 / TaskStop 553                                                                                                     | **8 427**   | 实测 3 次调用 |
| 编码核心   | AskUserQuestion 4 913 / Bash 2 499 / Skill 1 729 / Read 1 435 / TodoWrite 1 133 / Edit 980 / WebFetch 761 / Write 655 / TodoRead 221                                                                              | **14 326**  | 实测 1 232 次 |

工作流 + 定时 + 闲时合计 **~103 000 字符（占工具面 78%）**，是系统提示词全部静态段（7 509）的 13.7 倍。

### 关闭路径（逐个确认过）

| 族         | 门                                                                                                                                                                       | 能不能不改代码关掉                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 动态工作流 | Host 下发 `dynamicWorkflow.mode`（`dynamic-workflow-policy.ts`）；来源是 coding-plan 订阅特征位（`useDynamicWorkflowAvailabilityLoader(codingPlanSubscriptionService)`） | **不能**：CLI 刻意“只缓存结论，从不读 feature key 或本地覆盖环境变量” → 需在 host 侧强制 false |
| 定时任务   | `includeAutomation = Boolean(deps.automationPort)`；protocol 会话在 `server-operations.ts:3462` **无条件**创建 automationPort                                            | **不能**：改一处调用点（不传 / 按配置门控）                                                    |
| 闲时任务   | `offPeakPort` 由 host 的 `offPeakToolEnabled` 注入                                                                                                                       | 看 host 是否已关；实测它出现在请求里 → 当前是开的                                              |
| 任意子集   | 会话级 `toolAllowlist`（`server-operations.ts:3434` 已支持从协议参数读）                                                                                                 | **可以**：给会话传编码白名单，一处配置锁全部族；代价是要有客户端注入点                         |

### 结论

想“只留编码”，优先级应是：**工具面（~103k）>> persona 再压（~1k）> git recent commits（~0.4-2k）> 安全 IMPORTANT 行（0.56k）**。
工具面这一项一处改动就能拿掉 78%，远大于提示词侧任何单项。

## 10. 实施记录（只注册编码工具 + 去掉非编码提示词）

按用户决定执行两件事：提示词去掉安全 IMPORTANT 行与 git 提交记录、合并重复的人格条目；
工具侧**不删定义**，改用编码白名单让工作流/定时/闲时三族不注册。

### 提示词

| 项                | 改动                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 安全 IMPORTANT 行 | 删 `SECURITY_NOTICE` 与 `buildSecurityNotice()`（560 字符），`workflow-actor.ts` 的引用一并去掉                                                 |
| git 提交记录      | `env-info.ts` 删 `Recent commits` 行与 `formatRecentCommits()`（保留 branch/status）。探针仍产出 `recentCommits`，只是提示词不再渲染            |
| persona 去重      | 合并「Default to short answers」+「Match the response to the question」；「Finish the whole task」+「Stop short of actions beyond the request」 |

identity 段 6656 → **6132**（2044 tokens）；env_info 含 3 条提交时由 ~700 降到 **197**。

### 工具面（白名单）

`core/src/runtime/helpers/tool-allowlist.ts` 新增 `CODING_ONLY_TOOLS`（18 个：Read/Write/Edit/Bash/Glob/Grep/
TodoRead/TodoWrite/WebFetch/WebSearch/Skill/Agent/Task/TaskOutput/TaskStop/AskUserQuestion/EnterPlanMode/ExitPlanMode），
作为 `config.toolAllowlist` 缺席时的默认值。因为两个注册入口（首次装配与分支刷新）都读这个 helper，一处改动全覆盖。

- 只影响**内置**工具：MCP 与插件工具走各自注册路径，不受影响。
- 会话显式传入 `toolAllowlist` 仍然优先（可随时要回完整工具面）。
- 工具定义全部保留在代码里，恢复 = 删掉 `?? CODING_ONLY_TOOLS` 这一处默认值。

实测（`registerBuiltInTools` 实跑，含 Agent/Task 的实际会话值）：

| 指标             | 改前    | 改后                                                                            |
| ---------------- | ------- | ------------------------------------------------------------------------------- |
| 注册工具数       | 32      | 18                                                                              |
| 工具 schema 字符 | 132 456 | ~18 900（注册表实跑 16 个工具为 14 438，加上被 `includeAgent` 门的 Agent/Task） |

被移除的族：动态工作流 9 个（~88k）、定时任务 4 个（~11k）、闲时任务 2 个（~4.1k），
以及 ListModels / SendMessage / ReadSessionContext / js。

验证：`pnpm typecheck` 0 error、`pnpm lint` 0 error（基线 74 warnings）、`pnpm fmt:check` 通过、
`pnpm architecture:check --changed` 0 新增违规。真机会话回归仍未做（需重打包 + 真实模型调用）。

## 11. 使用频率证据与下一步取舍

数据源：真实 session DB `~/.zcode/cli/db/db.sqlite` 的 `tool_usage` 表，71 个 session、1257 次工具调用。

| 工具      | 调用次数 | 工具                                                                                                       | 调用次数 |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| Bash      | 797      | WebFetch                                                                                                   | 6        |
| Edit      | 185      | WebSearch                                                                                                  | 2        |
| Read      | 169      | TaskOutput                                                                                                 | 2        |
| TodoWrite | 54       | TodoRead / TaskStop / ListSavedWorkflows / CronList / AskUserQuestion                                      | 各 1     |
| Write     | 27       | EnterPlanMode / ExitPlanMode / Agent / SendMessage / ReadSessionContext / ListModels / Cron 其余 / OffPeak | 0        |
| Skill     | 10       |                                                                                                            |          |

两点修正（之前的表有两处不准，以本节为准）：

1. 真实 desktop 会话里 **Task / Grep / Glob / WebSearch 根本没注册**：前三个被 embedded-search 开关接管，
   `Task` 由配置门控。所以“编码核心 12 个”实际是 **9 个**，Bash/Edit/Read 承担了 98% 的调用（1232/1257）。
2. 真实请求里的 schema 比内置 metadata 大得多（AskUserQuestion 1788→4913、CronCreate 430→6143），
   因为注册时描述会被策略/协议层加长。**只有真实请求的字符数可以当依据**。

### 下一步可选（未做，等用户决定）

| 取舍                     | 省     | 依据                                                |
| ------------------------ | ------ | --------------------------------------------------- |
| 不注册计划模式 2 个工具  | 7 105  | 71 个 session 里 0 次调用                           |
| 不注册委派/协调 6 个工具 | 8 427  | 共 3 次调用；若要保留子代理则只留 Agent             |
| 两者都做                 | 15 532 | 工具面 18 900 → **~3 400**，相对原始 132 456 降 97% |

### 与 DSH 对比

DSH `code-max-omni` 是 **18 个工具**（bash / read / write / edit / str_replace_editor / glob / grep /
todo_write / job_list / job_output / job_kill / skill / subagent / ask_user_question / exit_plan_mode /
read_image / undo_last_edit / web_fetch），且**刻意不含** workflow / cron / off-peak / goals / agent-control /
subagent_fork / PTY。ZCode 改前 32 个，改后 18 个，数量与 DSH 持平。

DSH 的 schema 字节数无法测量：DSH 不落请求体，session 文件是 zstd 且不含 tools 数组（本机也没有 zstd 命令）。
所以这一项只能做数量与结构的对比，字节对比是估算。
