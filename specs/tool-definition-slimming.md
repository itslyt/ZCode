# 工具定义收敛（模型面 schema 与描述）

状态：**已实现**。承接 `specs/system-prompt-overhaul.md` §12 的实测对比。§12 当时的结论是
「保持 ZCode 的胖，不要再手工改描述文案」，本轮**推翻该结论中的两条**并保留其第三条（同步成本）：

1. 推翻「省下的量级不值得」：本节 §1 给出可回收的绝对量，且其中一部分是**纯浪费**（模型永远不会填的字段）。
2. 推翻「AskUserQuestion 的 schema 必须和 Desktop 问答 UI 协议一致，裁短可能弄坏交互」：
   该约束成立，但**只约束运行时校验**，不约束模型面；本轮用 provider-only schema 把两者拆开，校验路径一字未动。
3. 保留「改写上游文案有同步成本」：因此**只删冗余与失实**，不重写语义；每处都给出可回到上游的等价物。

## 1. 实测基线（一次真实请求，17 个工具）

provider 实际序列化的每个 tool 只有 `name` / `description` / `input_schema` 三个键。
下表为 ZCode 侧实测字符数（≈token 按 `chars/3`）。数据取自**线上真实请求体的原始字节**，
用于定位「哪里胖」；§5 的前后对比是另一套口径（同一脚本、含 `name` 键），两者不要相减。

| 工具            | desc | schema | 合计 | ≈tok | 主要问题                           |
| --------------- | ---- | ------ | ---- | ---- | ---------------------------------- |
| AskUserQuestion | 1786 | 3149   | 4935 | 1645 | 3 个输出侧字段进模型面（955 字符） |
| Grep            | 477  | 2759   | 3236 | 1079 | 15 参数，`type`/`offset` 零使用    |
| Agent           | 2188 | 596    | 2784 | 928  | 悬空引用 CreateWorkflow            |
| Bash            | 1048 | 1426   | 2474 | 825  | Git 工作流规范 + 与 identity 冲突  |
| EditAnchored    | 1285 | 859    | 2144 | 715  | 与 Edit 互相解释（重叠 79%）       |
| Edit            | 970  | 1108   | 2078 | 693  | 同上                               |
| Read            | 996  | 609    | 1605 | 535  | —                                  |
| TodoWrite       | 370  | 726    | 1096 | 365  | —                                  |
| Glob            | 140  | 557    | 697  | 232  | —                                  |
| Write           | 240  | 367    | 607  | 202  | —                                  |

四家同一工具的 description 字符数（Codex / dsh 为源码实测，MyFlicker 为二进制实测）：

| 工具   | ZCode          | Codex    | dsh     | MyFlicker |
| ------ | -------------- | -------- | ------- | --------- |
| shell  | 1048           | **82**   | 489     | 2438      |
| read   | **996**        | 无此工具 | **56**  | 1351      |
| edit   | **970 + 1285** | 108      | **59**  | 1200      |
| grep   | **477**        | 无此工具 | 206     | 801       |
| 提问   | **1786**       | 126      | **111** | 847       |
| 子代理 | 2188           | 982      | 337     | —         |

量级提醒：工具定义合计 9.75K / 450K = **2.2%**。本轮**不以省窗口为主要目的**——
主目的是消除「指向不存在工具的指引」与「模型填不了却被要求填的字段」，
这两类会实打实地让模型多绕一圈。省下的量是附带的。

## 2. 关键约束：`ToolEntry.inputSchema` 是双用途的

`inputSchema` 同时供给两条路径，**不能直接裁**：

- **provider 面**：`registry.toContracts()` → `ModelToolContract.inputSchema` → 请求体 `tools[].input_schema`。
- **运行时校验**：`tool/executor/validation.ts` 的 `validateInput` / `validateInitialModelToolInput`
  直接读 `entry.inputSchema`；且 `permission-flow.ts` 在权限改写输入后**会再次** `validateInput`
  （AskUserQuestion 的 `answers` 正是由权限阶段注入的）。

两者含 `additionalProperties: false`（zod `.strict()` 的产物），所以「从 provider 面删字段」
若直接改 `inputSchema`，会让权限注入的 `answers` 在校验阶段被判为非法键。

`resolveModelContract` **也不是**可用的裁减通道：`call-runner.ts` 把投影后的 entry 同时用于
provider 与 executor，Read 的 PDF 分支依赖这一点（投影**增加** `pages`，执行侧也必须接受）。

### 方案：新增 provider-only schema

在 `ToolEntry` 增一个可选字段，只在拼 provider 契约时优先使用：

```ts
/** 仅用于 provider 请求体；缺席则回落到 inputSchema。运行时校验永远读 inputSchema。 */
providerInputSchema?: JsonSchema;
```

`registry.toContracts()`：`inputSchema: entry.providerInputSchema ?? entry.inputSchema`。

这是「模型可见面 ⊂ 运行时接受面」的唯一新概念，且与既有 `providerVisible` / `toolDescriptionForProvider`
同族命名。**只用于收窄，不用于放宽**；放宽仍走 `resolveModelContract`。

## 3. 改动清单

### 3.1 AskUserQuestion：把 3 个输出侧字段移出模型面

`answers` / `annotations` / `metadata` 的描述原文即自证它们不属于模型输入：
`"User answers collected by the permission component"`、`"...annotations from the user"`、
`metadata.source` 甚至写着 `"e.g. \"remember\" for /remember command. Used for analytics tracking"`。
handler 只读 `questions`（`AskUserQuestionAnsweredInputSchema` 要求 `answers` 由权限阶段填好）。

- 新增 provider-only schema：顶层只保留 `questions`。
- 运行时 `AskUserQuestionInputSchema` 与 `AskUserQuestionAnsweredInputSchema` **不动**（校验路径不变）。
- 删除描述里的 **Plan mode note 段**：它引用 `EnterPlanMode` / `ExitPlanMode`，而本 fork 的
  `CODING_ONLY_TOOLS` 不含这两个工具 —— 模型读到的是一段无法执行的指引。

### 3.2 Grep：收敛零使用参数并压缩参数描述

实测 632 次调用：`pattern` 632 / `output_mode` 632 / `path` 609 / `-n` 513 / `head_limit` 256 /
`glob` 124 / `-A` 75 / `-C` 20 / `multiline` 19 / `-o` 19 / `-B` 3 / **`type` 0 / `offset` 0**。

- provider-only schema 删除 `type`、`offset`（0 使用）。运行时 zod 与 handler **不动**。
- 压缩冗长的参数描述（`head_limit` 352 字符、`output_mode` 350 字符等），语义不变，只去重复措辞。
- 描述里去掉 `type` 的提及。

### 3.3 Bash：Git 段收敛到单一所有者

`bash-prompt.ts` 的 `# Git` 段（约 350 字符）三条中：

- `"Use the \`gh\` CLI for GitHub operations"` → 工作流指引，迁到 identity 段。
- `"Commit or push only when the user asks. If on the default branch, branch first."`
  → **与 identity 段既有句冲突**：identity 说 `"Commit when it fits the work"`（可自主提交），
  Bash 说 `"Commit or push only when the user asks"`（须先问）。两句同时在场，模型只能猜。
  保留 identity 作为唯一所有者，把它缺的 `"branch first"` 补进去，删除 Bash 侧重复句。
- `"Interactive flags (-i ...) are not supported"` → 确实是本工具的行为限制，**留在 Bash**。

结果：Git 策略只有一个所有者（identity），工具描述只说工具自己。

### 3.4 Edit / EditAnchored：消除互相解释

两个工具的 description 尾部各有一段 163 字符的「什么时候改用另一个」，重叠度 79%
（`EditAnchored` 是首选，见工具描述本身与 identity 的编辑纪律）。保留**首选工具**（EditAnchored）
里的完整说明，`Edit` 侧压成一句短指针。锚点格式 `N:HASH│` 的说明在 Read 里已有，EditAnchored 保留一次。

### 3.5 悬空引用：CreateWorkflow

`agent.ts` 的工作流那一行由 `includeDynamicWorkflow` 门控，该门**默认开**（`dynamicWorkflowEnabled !== false`）；
但本 fork 的 `CODING_ONLY_TOOLS` 白名单**不含** CreateWorkflow。
两个门彼此独立 → 实测 17 个工具的请求里，Agent 描述仍然写着
`"the CreateWorkflow tool is mandatory"`，而模型手上没有这个工具。

修法：描述门与注册门用**同一个判据**。`createAgentToolEntry` 增加显式入参
（由调用方把「工具面里到底有没有 CreateWorkflow」传进来），不再只看 `dynamicWorkflowEnabled`。

## 4. 验收场景

1. **AskUserQuestion 模型面**：`toContracts()` 产出的 `inputSchema.properties` 恰为 `{questions}`；
   同时 `validateInput({questions, answers, annotations}, entry)` 仍通过（运行时接受面未收窄）。
   —— 这两条必须**同时**成立，是本设计的核心不变式。
2. **AskUserQuestion 描述**：不含 `EnterPlanMode` / `ExitPlanMode` / `/remember` / `metadata`。
3. **Grep 模型面**：`properties` 不含 `type`、`offset`；`validateInput({type:"js", offset:0, pattern:"x"})` 仍通过。
4. **Bash 描述**：不含 `gh` CLI 与 commit/push 策略句；仍含 `-i` 限制。
5. **identity**：含 `gh` CLI 与 `branch first`；commit 策略句在**全量 prompt 里只出现一次**。
6. **Edit 描述**：两段的「改用另一个」说明合计只出现一次。
7. **Agent 描述**：当 CreateWorkflow 不在工具面时不含该行；在工具面时含该行。
8. **面板口径**：`buildToolUsageDetail` 只统计 `name` + `description` + `inputSchema`，
   与 provider 实际序列化的键集合一致。

## 5. 度量

改动前后各取一次 `toContracts()` 的 provider 三键（`name`/`description`/`input_schema`）总量，
在同一套 17 个工具上对比（工具集取自线上真实请求）。

实测（`JSON.stringify` 后字符数，≈token 按 `chars/3`）：

| 工具            | 改前  | 改后  | 差额  | 说明                                    |
| --------------- | ----- | ----- | ----- | --------------------------------------- |
| AskUserQuestion | 4897  | 3513  | −1384 | 3 个输出侧字段出模型面 + 删 Plan note   |
| Grep            | 2515  | 2226  | −289  | `type`/`offset` 出模型面 + 参数描述压缩 |
| Agent           | 2830  | 2593  | −237  | 悬空 CreateWorkflow 行按实际注册面移除  |
| Edit            | 2071  | 1856  | −215  | 回退说明压成一句指针                    |
| EditAnchored    | 2189  | 1984  | −205  | 同上                                    |
| Bash            | 2499  | 2345  | −154  | Git 段以 identity 为唯一所有者          |
| 其余 11 个      | 10807 | 10807 | 0     | 本轮未改动                              |

**合计 27 808 → 25 324 字符，≈9 269 → 8 441 token（−8.9%）**。

（两次测量用同一脚本、同一套 17 个工具、同一口径：`JSON.stringify({name, description, input_schema})`。
先前正文里出现的 29 263 / 9 754 是**线上真实请求的原始字节**——含 provider 附加字段与不同序列化顺序，
与这里不是同一口径，不能与上表相减。）

量级上这只是 450K 窗口的 0.2%。本轮真正的收益在 §4 的 8 条：
消除「指向不存在工具的指引」（Agent/CreateWorkflow、AskUserQuestion/计划模式工具）与
「模型填不了却被要求填的字段」（AskUserQuestion 的 `answers`/`annotations`/`metadata`），
以及修掉 Git 策略的**自相矛盾**（identity 让自主提交、Bash 说要先问）。

## 6. 不做（本轮刻意排除）

- 不重写任何工具的**语义**文案（保留上游措辞，降低同步冲突）。
- 不合并 Edit / EditAnchored 两个工具（涉及运行时与 UI，超出「工具定义收敛」范围）。
- 不动 `CODING_ONLY_TOOLS` 本身（工具面加减是另一件事，见 §3.5 只修描述与注册的一致性）。
- 不改压缩链路（见 `specs/context-compaction-optimization.md`）。
