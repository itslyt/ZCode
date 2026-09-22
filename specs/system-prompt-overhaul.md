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
TodoRead/TodoWrite/WebFetch/WebSearch/Skill/Agent/SendMessage/TaskOutput/TaskStop/AskUserQuestion/EnterPlanMode/ExitPlanMode），
作为 `config.toolAllowlist` 缺席时的默认值。因为两个注册入口（首次装配与分支刷新）都读这个 helper，一处改动全覆盖。

- 只影响**内置**工具：MCP 与插件工具走各自注册路径，不受影响。
- 会话显式传入 `toolAllowlist` 仍然优先（可随时要回完整工具面）。
- 工具定义全部保留在代码里，恢复 = 删掉 `?? CODING_ONLY_TOOLS` 这一处默认值。

实测（`registerBuiltInTools` 实跑；Agent/SendMessage 在真实会话里由 subagentPort 门控注册）：

| 指标             | 改前    | 改后                                                                                |
| ---------------- | ------- | ----------------------------------------------------------------------------------- |
| 注册工具数       | 32      | **15**（打包产物实测；比白名单 18 少 Glob/Grep/WebSearch，被 embedded-search 接管） |
| 工具 schema 字符 | 132 456 | **27 499**（打包产物实测，降 79%）                                                  |

注：真实注册的描述比内置 metadata 长得多（如 AskUserQuestion 1 788 → 4 913），所以只有真实请求的字符数能当依据。
打包产物核验：`~/.zcode/cli/rollout/model-io-sess_01babc85-*.jsonl` 的 `request.toolNames` 为上述 15 个，
新人格文案（`Track every background task id` / `defer to the user`）在位，已删的 `Recent commits` 与安全 IMPORTANT 行不在。

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

| 取舍                                                    | 省    | 依据                                         |
| ------------------------------------------------------- | ----- | -------------------------------------------- |
| 计划模式 2 个工具                                       | 7 105 | **已决定保留**（用户：plan 先留着）          |
| 委派面：Task / ReadSessionContext / ListModels 不进名单 | 2 359 | **已实施**：只留子代理必需的一套             |
| 委派面再删 SendMessage / TaskOutput / TaskStop          | 3 234 | 未做：会让后台子代理与后台 Bash 变成半截能力 |

### 与 DSH 对比

DSH `code-max-omni` 是 **18 个工具**（bash / read / write / edit / str_replace_editor / glob / grep /
todo_write / job_list / job_output / job_kill / skill / subagent / ask_user_question / exit_plan_mode /
read_image / undo_last_edit / web_fetch），且**刻意不含** workflow / cron / off-peak / goals / agent-control /
subagent_fork / PTY。ZCode 改前 32 个，改后 18 个，数量与 DSH 持平。

DSH 不落请求体，所以字节数改从**本地源码**量：`/Users/liuyutong08/Work/deepseek-harness`
下各 `tool-*/src` 里的 `description:` 字面量 + `parameters:` 对象字面量。

## 12. 工具定义逐项对比：胖还是瘦

DSH 侧（源码量，同口径：描述 + 参数块）与 ZCode 侧（真实请求）：

| 工具               | DSH       | ZCode                                    | 差             |
| ------------------ | --------- | ---------------------------------------- | -------------- |
| read               | 542       | Read 1 435                               | ZCode 胖 2.6x  |
| write              | 428       | Write 655                                | 1.5x           |
| edit               | 904       | Edit 980                                 | 持平           |
| bash               | 2 475     | Bash 2 499                               | 持平           |
| glob / grep        | 756 / 809 | Glob 142 / Grep 479（内置 metadata）     | 持平           |
| todo               | 782       | TodoWrite 1 133 + TodoRead 221           | 1.7x           |
| jobs 3 个          | 1 274     | TaskOutput 1 562 + TaskStop 553          | 1.7x           |
| skill              | 359       | Skill 1 729                              | **4.8x**       |
| subagent           | 2 563     | Agent 2 834 + SendMessage 1 119          | 1.5x           |
| ask_user           | 1 922     | AskUserQuestion 4 913                    | **2.6x**       |
| plan               | 355       | EnterPlanMode 4 328 + ExitPlanMode 2 777 | **20x**        |
| web_fetch          | 195       | WebFetch 761                             | **3.9x**       |
| read_image         | 254       | —（未注册）                              |                |
| str_replace_editor | 3 489     | —（ZCode 只有 Edit）                     | DSH 自己也不瘦 |

结论：**胖瘦差异集中在 5 个工具**——plan（7 105）、ask_user（4 913）、skill（1 729）、
web_fetch（761）、read（1 435），占 ZCode 现有 18.9k 的 **77%**；而 Bash/Edit/Write/Glob/Grep
这些干活的工具两边几乎一样重。

### 判断：保持 ZCode 的胖，不要向 DSH 的瘦看齐

1. **DSH 的瘦不是写得好，是契约放进了代码**：`plan_mode` 只有 355 字符，因为计划模式的约束由
   `packages/plan/plan-mode/src/invariant.ts` 这类硬机制在运行时守；ZCode 把它写成 4 328 字符的
   散文，模型得读完才知道边界。抄 DSH 的短文案而不搬它的机制，等于把契约删了。
2. **省下的量级不值得**：剩下 18.9k 字符 ≈ 5k tokens，即使砍一半也只省 2.5k tokens，
   而本轮已经砍掉 113k 字符（≈28k tokens）。
3. **成本在同步侧**：改写上游工具描述，每次同步上游都冲突，而且会丢掉上游对这些描述的修复
   （AskUserQuestion 的 schema 必须和 Desktop 的问答 UI 协议一致，裁短可能直接弄坏交互）。

所以：**提示词和工具面已经瘦到位了，不要再手工改描述文案**。

## 13. 要不要把 DSH 的能力搬过来（我的意见）

DSH 真正值得搬的是**硬机制**，不是工具链。逐个对账（ZCode 现状 → DSH 对应物）：

| DSH 机制                                         | ZCode 现状                                                                   | 建议                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------- |
| `tool-result-budget`（结果预算 + 落盘）          | **已有**：`tool/executor/result-serialization.ts` 有字符预算与 artifact 落盘 | 不搬                              |
| 编辑前必须读过（硬错误）                         | **已有**：`tool/handlers/edit.ts` 拒绝未读文件                               | 不搬                              |
| `edit-fail-coach`                                | 部分：已有硬拒绝，但无失败后的提示                                           | 可搬（PostToolUseFailure hook）   |
| `todo-closeout`                                  | **缺**：ZCode 有 TodoWrite，但没有收尾约束                                   | **优先搬**（Stop hook，收益最大） |
| `rollout-budget`（token 账本告警）               | 部分：`turn_usage` / `model_usage` 表有数据，无告警                          | 可搬（数据已存在）                |
| `deliberation-gate` / `cot-drip`（思考强度控制） | 部分：已有 `zcode-patcher` skill 下发 effort                                 | 看需要                            |

ZCode 侧现成可用的挂点：hooks 7 个事件（PreToolUse / PostToolUse / PostToolUseFailure /
PermissionRequest / SessionStart / Stop / UserPromptSubmit）、权限规则集、`tool_usage` 可观测表。

### 我的结论

**现在还不急着把主力切过去**，按这个顺序更稳：

1. 先重打包（`node scripts/build-desktop-agent-cli.mjs`）跑一次真机会话，确认新提示词与 18 个工具在
   App 里真的生效（这是当前唯一未验证环节）；
2. 搬 `todo-closeout` 一个机制（ZCode 缺、成本低、你每天都能感受到）；
3. 拿真实任务并行跑一周：ZCode 干编码，DSH 继续当主力；对比两者在“长任务收尾”和“改完是否验证”上的差别；
4. 再决定全量切。不建议一次性切完——DSH 那 6 个机制是你现在体验的来源，ZCode 只搬了提示词，
   机制还差一层。

## 14. ZCode 能不能拥有 DSH 的机制层（结论：能，而且不用改 fork 代码）

### 关键发现：ZCode 的 hook 是**配置**，不是代码

hook 配置层级是 default → user → project → env → CLI（`config-factory.ts:213-217`），
**user 层就是 `~/.zcode/cli/config.json` 的 `hooks.events`**，不经过 workspace 信任流程
（project 层才需要 trust，见 `project-config.adapter.ts:63`）。所以搬机制**不需要改 core**，
也就没有上游同步成本。

### 契约能力（够不够搬，逐个核过）

| 能力            | ZCode 现状                                                                                                                                               | 位置                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 事件            | 7 个：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop                                         | `packages/shared/src/hooks.ts`         |
| 输入            | stdin JSON：`hook_event_name` / `session_id` / `transcript_path` / `cwd` / `tool_name` / `tool_input`；env 有 `ZCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` | `hooks/configured-runner-input.ts`     |
| 输出            | `additionalContext`（注入上下文）、`decision: block\|approve`、`reason`、`systemMessage`、`continue`、`hookSpecificOutput`                               | `hooks/output.ts`                      |
| **Stop 可续跑** | `output.continue === true` 时把 `additionalContexts` 当 user-role 注入并 `return "continue"`（带 `stopHookContinuationCount` 防死循环）                  | `runtime/methods/turn-stop.ts:204-216` |

第三行是关键：DSH 的 `agent/turn-stopping` 转向能力，ZCode 在 Stop 事件上**同样具备**。

### 逐机制移植账（DSH 源码行数已实测）

| DSH 机制             | 行数 | ZCode 挂点                                                                     | 可移植            | 成本                       |
| -------------------- | ---- | ------------------------------------------------------------------------------ | ----------------- | -------------------------- |
| `todo-closeout`      | 165  | Stop + `continue: true` + additionalContext；待办状态从 `transcript_path` 读   | ✅                | ~150-200 行脚本 + 1 条配置 |
| `edit-fail-coach`    | 139  | PostToolUseFailure + additionalContext                                         | ✅                | 同上                       |
| `rollout-budget`     | 175  | Stop/PostToolUse；用量取自 `turn_usage` 表或 transcript                        | ✅（需定用量源）  | 同上                       |
| `tool-result-budget` | 140  | **已原生**：`tool/executor/result-serialization.ts` 有字符预算 + artifact 落盘 | ❌ 不需搬         | 0                          |
| `deliberation-gate`  | 401  | 拦的是**模型调用/思考流**，不在 7 个事件里                                     | ❌ hooks 覆盖不到 | 需 core 扩展点             |
| `cot-drip`           | 145  | 同上；且已有 `zcode-patcher` 下发 effort                                       | ❌                | 看需要                     |

合计：**3 个可用配置级 hook 搬过来（无 fork 改动），1 个已原生，2 个需要 core 扩展点**。
DSH 自己的实现也就 139-175 行，契约又几乎同构（Claude Code 风格），所以这是“重写一遍”，不是“逆向工程”。

### 这是不是两家最大的区别

**行为上是的，架构上根因是扩展模型。**

- DSH 自己就写着这句话（`todo-closeout.mjs` 顶部）：
  "The persona asks for a closing `todo_write`; **a prompt is not enforcement**."
  这正是你在两家之间的体感差异：DSH 在边界上强制执行，ZCode 目前只在提示词里请求。
- 架构根因：DSH 是 in-process 插件，能拿到 `session/event`、`agent/turn-stopping`、模型调用等全部内部事件；
  ZCode 是外部命令 hook，只有 7 个事件。所以**工具/会话层机制可搬，模型调用层机制搬不了**。
- 第二个区别是产品面（ZCode 有 Desktop/Web/协议/多客户端/会话 DB，DSH 是 harness），
  但对“当主力写代码”这件事，机制层的权重更高。

## 15. 提示词对等性 review（对齐用户自己调的 DSH persona）

对比 `~/.dsh/.agent-presets/code-max-omni/agent.cordis.yml` 的 persona（50 条规则）与 ZCode 现状（46 条）：

| DSH persona 段                | 条数 | ZCode 现状                    | 条数      |
| ----------------------------- | ---- | ----------------------------- | --------- |
| ## Security                   | 1    | —（用户要求删除）             | 0         |
| ## Safety                     | 3    | # Safety                      | 5         |
| ## Untrusted content          | 3    | # Untrusted content           | 3         |
| ## Engineering judgment       | 12   | # Engineering judgment        | 8         |
| ## Verification and reporting | 3    | # Verification and reporting  | 3         |
| ## Working style              | 8    | # Working style               | 7         |
| ## Delivery                   | 6    | # Delivery                    | 5         |
| ## Corrections                | 2    | # Corrections                 | 1（合并） |
| ## Autonomy                   | 4    | # Autonomy                    | 3         |
| ## Communication              | 8    | # Communication               | 8         |
| —                             | —    | # Harness（ZCode 运行时约束） | 3         |

体量：ZCode identity 段 **7 939 字符 / 2 647 tokens** vs DSH persona 8 753 字符，同一量级。

本次 review 补回的 11 条（首版瘦身时删掉的）：改系统状态前先核证据、注释不写给 reviewer 的话、
任务是否过大交用户判断、长产出落盘、后台任务记 id 等通知不轮询、委派只用于短答案的广域探查、
发现问题先说再带假设继续、不确定时先做不依赖答案的部分、用户重申即其决定、给细节但不倾倒、
可读优先于简短、不猜行号、`<system-reminder>` 只当上下文。

唯一有意保留的差距：**Security 段**（拒绝破坏性/恶意请求、双用途工具需授权上下文）——用户明确要求删掉，
ZCode 现在没有这条护栏。要恢复只是三行的事。

## 16. 请求消息结构（实测）与精简

一条真实请求（`~/.zcode/cli/rollout/model-io-*.jsonl`）的消息序列：

| #   | 角色   | 内容                                                            | 长度（字符） |
| --- | ------ | --------------------------------------------------------------- | ------------ |
| 0   | system | `You are ZCode, an interactive coding agent`（`cli_prefix` 段） | 42           |
| 1   | system | 人设正文（identity + Harness + Desktop Context）                | ~8 300       |
| 2   | system | `# Environment` + `# Context management` + `gitStatus` 块       | 1 400~3 000  |
| 3   | user   | `<system-reminder>` 包 `# currentDate`                          | ~305         |
| 4   | user   | 用户输入                                                        | —            |

两条精简（用户要求）：

1. **去掉 gitStatus**：`env-info.ts` 不再输出 `gitStatus: ...` 前缀句和 `Status:` 块（即改动/未跟踪文件清单），
   保留 `Current branch` / `Main branch` / `Git user`。原句自述是“会话开始时的快照、之后不更新”，
   模型随时 `git status` 能拿到更新的结果；且它逐会话不同，让同 workspace 内不同会话的前缀无法共享缓存。
2. **去掉 0 号 system 消息**：`cli_prefix` 段与人设首句是同一个身份（“你是 ZCode”），属于重复；
   它单独成条的唯一作用是给 42 字符加一个 cache breakpoint。删除后请求变成 2 条 system 消息。
   工作流子代理本来就不注入它（`isWorkflowActor` 分支），删除后不受影响。

## 17. 缓存命中率：与 DSH 的实测对比

口径（关键）：两个产品的 `inputTokens` 含义不同，直接比 total 会得出错误结论。

- ZCode（AI SDK v5）：`inputTokens` = **总输入（含命中）**，`inputTokenDetails.cacheReadTokens` 是其中命中的子集。
  证据：`raw_usage_json` 里 `totalTokens = inputTokens + outputTokens`，且 `cacheReadTokens` 单列（如 9 779 = 9 237 + 542）。
- DSH（`dsh-token-usage-counter`）：`totalTokens = input + output + cacheRead`，即 `inputTokens` 只算未命中部分。

实测（ZCode 取 `model_usage` 的 `query_source = main_turn`；DSH 取 `~/.dsh/settings.yaml` 累计）：

| 指标             | ZCode     | DSH       |
| ---------------- | --------- | --------- |
| 请求数           | 1 368     | 7 312     |
| 总输入（含命中） | 138.9M    | 1 131.6M  |
| 命中             | 128.1M    | 1 089.4M  |
| **命中率**       | **92.2%** | **96.3%** |
| 单次未命中       | 7 918     | 5 770     |
| 单次总输入       | 101 567   | 154 750   |

ZCode 侧分布：命中 >90% 的请求 1 142 个（占 92.0% 的输入）；命中 0 的冷启动 143 个（占 10.5% 的请求，
但只占 3.7% 的输入）；其余 83 个介于中间。命中率在所有 provider 上一致（GLM 48.4%、DeepSeek 48.8%、
local 47.7~48.7%——按错误口径算都是 ~48%，按正确口径都是 ~94%），说明差异来自会话结构而非某家后端。

差距拆解与优化方向：

- 冷启动（10.5% 请求 / 3.7% token）：换新任务就会重读一遍静态前缀。前缀越小越便宜——工具面 132k→27.5k 字符
  已经把这块降下来了。
- 同 workspace 跨会话共享前缀：前缀里任何逐会话变化的字节（如 gitStatus）都会让缓存无法跨会话复用；
  §16.1 已移除。
- 单次未命中 7.9k vs DSH 5.8k：这才是真正的差距，未命中 = 本轮新增内容（用户输入 + 工具结果 + 助手输出）。
  要再降只能减少工具结果体积/请求数，而不是继续改提示词。
- 提示词侧已无可榨空间：静态前缀（工具 27.5k + 人设 7.9k + 环境 1.4k）全部落在命中区间内，
  继续压缩只降低冷启动成本，不影响命中率。
