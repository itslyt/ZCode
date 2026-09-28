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

### 3.6 第二轮：删掉「描述不存在的东西」

第一轮之后又过了一遍，发现更值得处理的一类不是「长」，是**失实**。判定标准：
描述里承诺的机制/UI，在消费链末端是否存在。

**AskUserQuestion 的 Preview 段（686 字符）**。原文承诺选项可带 `preview`，渲染成
「并排布局 / monospace 框 / ASCII mockup」。逐层查消费链：

| 环节                                                        | 事实                                     |
| ----------------------------------------------------------- | ---------------------------------------- |
| `ZCodeElicitationOption` 类型（`zcode-task-types-core.ts`） | **无 `preview` 字段**                    |
| `zcodeTaskServiceAdapter` 映射 option                       | 只取 `value`/`label`/`description`，丢弃 |
| `packages/ui/src/ElicitationDialog.tsx`                     | 零处渲染；option 渲染进 `<button>`       |
| TUI `app-question-panel.tsx`                                | 只渲染 `label`/`description`             |

唯一读 `preview` 的是 TUI 的 `app-question-state.ts:343`，它把原文塞进 `annotation`
**回传给模型**——不是渲染。也就是那段承诺的 UI 形态在任何客户端都不存在。

处置：删描述段；**保留 `preview` 字段本身**（TUI 回传链路仍读它），只把字段描述从
「rendered when this option is focused」改成不承诺渲染的说法。字段上的 HTML 校验规则
（片段、禁 script/style）保留——那是**入参约束**，与是否渲染无关。

### 3.7 第二轮：删掉「描述已被移除的机制」

**Read 的「Do NOT re-read a file you just edited to verify」（110 字符）**。
按 `specs/read-unchanged-stub.md`，未变更短路（`file_unchanged` → "Wasted call"）**已被删除**：
`grep` 全仓库确认 `file_unchanged` 已无生产者，Read 一律返回内容。而编辑成功的结果本身带
`"file state is current in your context — no need to Read it back"`（`EDIT_FRESHNESS_SUFFIX`）。
留着这条等于让模型照一个不存在的机制规划行为。

**Edit 的「Strip the Read line prefix (line number + tab)」（部分字符）**。
`findEditMatch` 的 `line_number_prefix_stripped` 策略**已自动剥**前缀，且同时认
`N:HASH│` 与旧的 `N\t`（`anchor-strip.test.ts` 两条用例钉着）。旧文案既过时（现在的格式是
`N:HASH│`，不是 tab）又多余。

同时**保留**「You must Read ... before editing」：它是**事前**指引，能省下一次失败往返；
错误消息只能事后补救。这是本轮区分「冗余」与「有用冗余」的判据。

### 3.8 第二轮：编辑细节收敛到工具描述

identity 段的「Editing files」原为 642 字符，复述了锚点格式、`.ipynb`/binary 回退、
stale-anchor 重试、批次纪律。这些细节**必须留在工具描述**：子代理有自己的 system prompt
（`subagent/general-purpose.ts`、`subagent/explore.ts`），**拿不到 identity 段**，只能从工具
描述学。所以方向是反向的——identity 只留「什么时候用哪个工具」这个判断，细节归工具。

- identity：642 → 156 字符（只留 EditAnchored/Edit 的选择判断）。
- EditAnchored：`Read prefixes every line with an anchor...` 一句删除（锚点格式由 Read 定义），
  但**恢复**保留 `Only lines you have already read can be edited`——它是事前指引。
- Edit：跨工具指針 `Prefer EditAnchored...` **保留**（子代理需要它做导航）。

另外 identity 里「Never mix a deletion or insertion with an edit below it in one batch」也删了：
`edit-batch.ts` 已把所有编辑钉在**原文偏移**上再倒序应用，批内无顺序耦合，那条描述的是一个
**已被实现消除**的隐患。

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

第二轮新增（判据是「描述里承诺的机制/UI 在消费链末端是否存在」）：

9. **AskUserQuestion 描述**：不含 `side-by-side` / `monospace box` / `ASCII mockup` / `Preview feature`。
   同时 `preview` 字段仍在 schema 里（TUI 回传链路依赖），且其 HTTP 片段校验照旧生效。
10. **Read 描述**：不含 `Do NOT re-read`（该短路已删除）；仍含 `N:HASH`（锚点定义属于 Read）。
11. **Edit 描述**：不含 `Strip the Read line prefix`（已自动剥）；**仍含**未读指引
    （事前指引必须留，这是与「冗余」的分界）。
12. **identity**：不含 `N:HASH` / `.ipynb` / `stale-anchor`（编辑细节归工具描述）；
    仍含 `EditAnchored`（选择判断）。
13. **子代理覆盖**：上述工具描述里的跨工具导航与格式定义，在
    `subagent/general-purpose.ts` 那类「没有 identity 段」的 prompt 下仍可见
    ——它们只在工具描述里，这是**故意**的。

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

### 5.1 第二轮（§3.6–3.8）实测

同一脚本、同一 17 个工具、同一口径，相对第一轮之后的基线：

| 项              | 第一轮后 | 第二轮后 | 差额 | 说明                                    |
| --------------- | -------- | -------- | ---- | --------------------------------------- |
| AskUserQuestion | 3468     | 2772     | −696 | 删 686 字符的假 Preview 段 + 改字段描述 |
| Read            | 1632     | 1484     | −148 | 删已移除短路的引用                      |
| Edit            | 1856     | 1792     | −64  | 删已自动剥前缀的指引                    |
| EditAnchored    | 1984     | 1933     | −51  | 删锚点格式重述                          |
| **工具合计**    | 25279    | 24320    | −959 |                                         |
| **identity 段** | 8525     | 8009     | −516 | 编辑细节归工具描述                      |

**两处合计 ≈11 268 → 10 776 token（−1 475 字符 / −492 token）**。

两轮累计：工具定义 27 808 → 24 320 字符（−12.5%），加上 identity 8525 → 8009。
绝对值仍只是窗口的零点几个百分点——**收益不在 token**，在于：
第一轮去掉「指向不存在的工具」与「填不了的字段」，第二轮去掉「不存在的 UI」与
「已删除的机制」。这类失实描述会实打实让模型多绕一圈甚至跑空。

真正可继续挖的方向已不在描述层（见 §7）。

## 6. 不做（本轮刻意排除）

- ~~不重写任何工具的**语义**文案（保留上游措辞，降低同步冲突）。~~
  → 第二轮修正：措辞不改的前提保留，但**失实陈述必须改**（§3.6–3.7）。
  两者判据不同：改措辞是重写，改失实是纠错。
- 不合并 Edit / EditAnchored 两个工具（涉及运行时与 UI，超出「工具定义收敛」范围）。
- 不动 `CODING_ONLY_TOOLS` 本身（工具面加减是另一件事，见 §3.5 只修描述与注册的一致性）。
- 不改压缩链路（见 `specs/context-compaction-optimization.md`）。

## 7. 继续优化的方向（不在描述层）

两轮下来，工具描述能挖的**失实**与**纯重复**已经清完。继续在描述层抠字句的边际收益很低，
而且会撞上「改动越大、上游同步冲突越多」的成本墙。真正还有量级的地方是三处：

1. **工具面本身**（最大）。当前 17 个工具里 `TodoRead`（205 字符，全库只用过 2 次）、
   `TaskStop`（537 字符，1 次）这类「留着以防万一」的工具，可以直接移出
   `CODING_ONLY_TOOLS`。移出一个工具省的是**整条 schema + 描述**，比删几句话高一个量级。
   代价是模型在需要时会说「工具不可用」——这正是 `specs/personal-fork-simplification.md`
   已经在做的事，只是名单还可以再收。
2. **AskUserQuestion 的 `preview` 字段存废**。目前处于「描述不宣传、字段保留、只有 TUI 回传
   会读」的中间态。若确认 TUI 那条链路也没在用，字段连同 HTML 校验可以一起删（约 240 字符 +
   4 条正则 + 一段 refine）。**需要先确认 TUI 的实际使用**，本轮没动。
3. **identity 段与工具描述的分工复核**。本轮只处理了「编辑」一处。其余段落
   （Communication / Delivery 等）与工具描述是否还有其他重叠，值得按同一判据再过一遍：
   「这条规则在代码里有硬机制吗？在子代理的 prompt 里可见吗？」两个都不是，才考虑挪。

优先级：**1 > 3 > 2**。第 1 项是量级最大的，且不涉及文案重写。
