# 上下文压缩优化：复用 KV 缓存、checkpoint 合并规则

> 目标：把 ZCode 的上下文压缩做成「长会话下不衰减、且不烧钱」的那一档。本文只写压缩；提示词与工具面见各自 spec。

## 0. 背景

本 fork 走自研路线（不追上游），判断依据以实测为准。压缩是 harness 里**最贵的一次请求**——它要重读整个上下文，且在长会话里会反复发生。所以这里的每一处浪费都会被放大。

本文的现状与对标数据全部来自读代码，出处见各节；没有推断，未验证的都标了「未验证」。

## 1. 现状（ZCode，已读代码确认）

### 1.1 两级机制

| 层           | 文件                                                                              | 做什么                   |
| ------------ | --------------------------------------------------------------------------------- | ------------------------ |
| microcompact | `core/src/compact/microcompact.ts`                                                | 清空**旧工具结果**的内容 |
| compact      | `core/src/compact/{policy,prompt,manual}.ts`、`runtime/methods/compact-active.ts` | 生成全量摘要替换历史     |

### 1.2 触发口径（绝对 token）

`core/src/compact/policy.ts`：

```
DEFAULT_COMPACT_CONTEXT_WINDOW            = 200_000
DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000
PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000
MAX_OUTPUT_TOKENS_FOR_SUMMARY             = 20_000
AUTOCOMPACT_BUFFER_TOKENS                 = 13_000
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES      = 3
```

```
effectiveContextWindow = contextWindow − min(outputReserve, contextWindow)
autoCompactThreshold   = effectiveContextWindow − bufferTokens
```

**注意**：`outputReserve` 被 `min(32_000, contextWindow)` 夹住，**不随模型声明的最大输出放大**。本机配置（窗口 450 000、最大输出 384 000）下 reserve 仍是 32 000，阈值 = 450 000 − 32 000 − 13 000 = **405 000**。

### 1.3 microcompact 策略（按年龄整条清空）

```
MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE   = "[Old tool result content cleared]"
DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5
DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES   = 60
DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS        = 256
DEFAULT_MICROCOMPACT_THRESHOLD_RATIO          = 0.9
DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS  = 2_000
DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS = Read, Bash, Grep, Glob, WebFetch, WebSearch, Edit, Write, ApplyPatch
```

阈值 `min(autoCompactThreshold × 0.9, autoCompactThreshold − 2_000)`。保留最近 5 条工具结果，更早的**整条清空**（按工具白名单）。另有 60 分钟空闲触发。落盘：原地替换 message content，并发 `MicrocompactBoundary` 会话事件。

### 1.4 摘要请求的构造

- 提示词：`core/src/compact/prompt.ts` —— `NO_TOOLS_PREAMBLE`（禁止调工具）+ `BASE_COMPACT_PROMPT`（**9 段**：Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and fixes / Problem Solving / All user messages / Pending Tasks / Current Work / Optional Next Step）+ 可选自定义指令 + `NO_TOOLS_TRAILER`。要求先输出 `<analysis>` 再输出 `<summary>`，`formatCompactSummary` 会把 `<analysis>` **丢掉**只留 summary。
- 摘要模型：`compact-active.ts:174` `options.model ?? createRuntimeModel(this, { selection: this.getSessionModelSelection() })` —— **默认用会话自己的模型**。是否存在单独的摘要模型配置项**未验证**（在 `contracts/src/config` 里没搜到 compact 相关 model/provider 字段，但类型定义位置未确认）。
- 请求形态：`runtime/methods/compact-summary-model-request.ts` 发送 `messages: request.messages`；`compact-active.ts:255` 会 `this.getTools(compactModel)` 传入工具。**当前这次调用是否构成上一次真实请求的真前缀，未验证**——这是 P0 要先确认的事。
- 超长重试：`manual.ts` `MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3`。

## 2. 对标（DSH 与 Codex，已读代码确认）

### 2.1 DSH

- **触发**：比例制。`dsh-compaction-basic` `DEFAULT_THRESHOLD_RATIO = 0.8`、`DEFAULT_RETAIN_RATIO = 0.16`，`thresholdTokens = floor(contextWindow × thresholdRatio)`，支持按 provider/model 覆盖（`modelPolicies`），并校验 `retainTokens < thresholdTokens`。
- **工具结果**：`dsh-compaction-tool-result-pruner` 按**大小**剪中段 —— `thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024`，中间替换为 `[... tool result middle pruned ...]`。不区分工具、不看年龄。
- **落盘语义**：事件日志重写 + 影子计价 —— 每个替换保留除 `content` 外的完整事件数据、引用被遮蔽节点（供 replay 恢复），并在其前发 `compaction/prune` 计价事件，让纯消费者不用逐节点状态就能扣掉省下的量。
- **摘要请求构造（关键）**：摘要指令**不另起 system prompt**，而是把对话原样重放后**作为最后一条 user 消息追加**。注释写明动机：这样辅助调用是上次路由请求的**真前缀**，provider 的 KV 缓存**复用而非失效**。
- **摘要提示词**：8 个固定 Markdown 段，要求简洁 bullet、空段写 `(none)`、**绝不删段**；产物用 `<compacted-summary>` 包裹 + preamble「automatically generated checkpoint…build on it without restating it」。
- **二次压缩规则**：已存在 `<compacted-summary>` 时**不许照抄**，要保留仍为真的、丢弃过期的、合并成一份。
- 可单独配 `summarizationProvider` / `summarizationModel`。

### 2.2 Codex（`~/Work/codex`，Rust）

- **触发**：绝对且**可配置** —— `core/src/config/mod.rs:628` `model_auto_compact_token_limit`（含 `_scope`），另有 `token_budget.auto_compact_fallback_buffer_tokens`（`feedback_config.rs:46`）。
- **摘要提示词极短**：`prompts/templates/compact/prompt.md` 全文 **9 行 / 4 个 bullet**（当前进展与关键决策 / 重要上下文与用户偏好 / 剩余工作 / 关键数据与引用）。
- **缓存优先的裁剪**：`compact.rs` 在压缩中遇 `ContextWindowExceeded` 时，注释写明「Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact」，即**从头部移除最老项**再重试（`remove_first_item()`，`retries = 0`）。
- `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（与 ZCode 的 `MAX_OUTPUT_TOKENS_FOR_SUMMARY` 同值）。
- 摘要注入前缀 `SUMMARY_PREFIX`：「Another language model started to solve this problem and produced a summary… You also have access to the state of the tools that were used」。
- 跟踪压缩**窗口**：`advance_auto_compact_window()` → `window_number` / `window_ids`。
- 有摘要 fallback 模型（`compact_model_fallback.rs`）、远端压缩 v2（`compact_remote_v2*.rs`）、图片预算与 `retained_image_count`。
- 会给用户弹提示：「Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible…」——即**承认多次压缩会掉质量**。

## 3. 结论：改什么、不改什么

### 3.1 P0 —— 压缩请求复用 KV 缓存（值得做）

**问题**：ZCode 用独立请求 + 独立 system prompt 做摘要，那份额外提示词不在缓存前缀里；而 DSH 与 Codex 都**专门为复用前缀缓存而设计**（DSH 改指令投递位置，Codex 改裁剪方向）。压缩是会话里最贵的一次请求，本机缓存命中率 82.2%（界面实测），所以这里的浪费是实打实的。

**验收**：压缩请求的缓存命中量提升；摘要内容语义不变（现有压缩相关测试全绿）。

### 3.2 P1 —— checkpoint 合并规则（便宜，防长会话衰减）

DSH 有、ZCode 没有的一条明确规则：已存在先前摘要时，**不许照抄进新摘要**，要保留仍为真的、丢弃过期的、合并成一份。缺了它，反复压缩会层层套娃，摘要体积随压缩次数增长。

Codex 那句用户提示从侧面印证这是真问题（多次压缩掉质量）。

**验收**：连续两次压缩后，第二份摘要不是第一份的复制叠加；摘要 token 数不随压缩次数近似线性增长。

### 3.3 明确不做

| 不做                      | 理由                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 触发改成比例制            | ZCode 的「窗口 − 输出预留 − 缓冲」对声明大输出上限的模型更合适；DSH 的纯比例不预留输出空间。这是 ZCode 更强的地方，不是差距 |
| 抄影子计价 / 事件溯源重写 | 为事件日志的 token 账平衡与回放恢复服务，对个人 fork 是过度设计，用户不可见                                                 |
| 为短而砍摘要结构          | Codex 的 9 行提示词短，但短提示词在长任务上的产物质量**未验证**；ZCode 的 9 段结构是有意设计                                |
| 引入独立摘要模型配置      | 无证据表明需要；默认用会话模型是合理的                                                                                      |
| 改工具结果策略（P2）      | 见下                                                                                                                        |

### 3.4 P2 —— 工具结果策略：先取证，别急着改

现状按**年龄**整条清空（保留最近 5 条），DSH 按**大小**剪中段（头 4096 + 尾 1024）。这是**权衡不是升级**：

- 整条清空 → 模型可能被迫重读旧文件（多一轮往返）。
- 剪中段 → 留住报错尾巴，但中段内容永久丢失，且对每条结果都动刀。

**先量再决定**：microcompact 触发后，模型**重读**已被清空文件的频率。若很高，说明整条清空在逼出额外往返，再考虑混合策略。数据源见 §4。

### 3.5 已实施 —— microcompact 默认开启

**现状（上游）**：`runtime/methods/microcompact.ts` 的 `resolveLocalMicrocompactConfig` 用 `enabled: config.microcompact?.enabled === true`，即 **opt-in**。实测日志一直是 `compact.micro.skipped` 且 `reason: "disabled"` —— 这一层从未生效，旧工具结果一路堆到全量压缩阈值才被处理，而那已经是会话最贵的一次请求。

**改动**：`!== false`（默认开，保留显式关闭的开关）。理由：它是便宜层（只清旧工具结果的内容、保留最近若干条），阈值也低于全量压缩，本就应该先它一步生效。

**测试**：`core/test/microcompact-default.test.ts` 钉住「未配置即开启」「显式 false 仍关闭」「默认阈值必须低于全量压缩阈值」。

### 3.6 绝对阈值 vs 比例阈值：ZCode 偏激进，建议取两者较小值

三家触发口径（同一把尺子）：

|                       | 公式                                                 | 450k 窗口下的触发点 | 占窗口    |
| --------------------- | ---------------------------------------------------- | ------------------- | --------- |
| ZCode（preflight-v1） | `W − 21_000 − 13_000`                                | 416_000             | **92.4%** |
| ZCode（legacy）       | `W − 32_000 − 13_000`                                | 405_000             | 90.0%     |
| DSH                   | `0.8 × W`                                            | 360_000             | 80%       |
| Codex                 | 用户配置的绝对值（`model_auto_compact_token_limit`） | 由用户定            | —         |

**问题**：ZCode 的预留量是**固定 token**（21k / 32k），**不随窗口放大**，所以窗口越大触发点越贴近上限。450k 窗口下只剩 7.6% 余量，DSH 的比例制天然保留 20%。

**已在真机复现过后果**：配置窗口 450_000、provider 网关真实上限 393_216，而阈值 416_000 **高于**真实上限 → 压缩永远等不到，请求先被 provider 拒。这不是公式错，是「固定预留 + 大窗口」把触发点推到了天花板之上。

**建议**：阈值取两者较小值 —— `min(W − outputReserve − buffer, ratio × W)`（ratio 取 0.8）。这样同时满足两个约束：**永远给输出留出空间**（ZCode 的强项，DSH 没有）且**永远不贴到上限**（DSH 的强项）。比二选一更稳，也不推翻任何现有常量。

**另一件事**：Codex 把阈值做成可配置项，说明它本就应该可调。本 fork 已有 `bufferTokens` 可配，但 `outputReserve` 被 `min(32_000, W)` 夹住且**不可配**，建议一并放开。

**注意**：上面这条只是结论与建议，**尚未实施**。改前先按 §6 第 1 步确认现状。

### 3.7 补全对标（Claude Code / Takumi）与落地清单

除 §2 的 DSH 与 Codex，又核对了两家（依据：`~/.myflicker/workshop/四大Harness压缩能力专题.md` 的二进制/源码提取结果，与本文自己读代码的结论不冲突）：

**Claude Code（三层）**：microcompact（时间触发、无模型调用）→ auto-compact（9 段摘要，含「全部用户消息」与安全指令 verbatim）→ **precomputeCompaction（预计算，触发前就把摘要算好）**。另配 `PreCompact`/`PostCompact` hooks（PreCompact 有**阻断权**）与完整遥测。

**Takumi（MyFlicker 原生，两层）**：pruning（默认**关**）+ compaction（默认开）。其触发是「小窗口预留固定量、大窗口按比例」，在 330k 处无缝衔接。

### 3.7.1 ZCode 实测缺口（已逐项 grep 确认）

| 能力          | 谁有              | ZCode              | 性质                                                                |
| ------------- | ----------------- | ------------------ | ------------------------------------------------------------------- |
| 工具配对保护  | DSH（内核不变量） | **无**             | 正确性                                                              |
| 转写落盘接线  | Takumi / 宿主层   | **机制有、未接线** | 可回溯                                                              |
| 摘要输入瘦身  | Takumi            | **无**             | 成本                                                                |
| 预计算压缩    | Claude Code       | **无**             | 延迟                                                                |
| blocking 检测 | Takumi            | **无**             | 健壮性                                                              |
| 熔断          | Takumi            | **已有**           | `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`                          |
| PTL 重试      | Takumi            | **部分**           | `MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3`（是否按比例丢轮次未验证） |

### 3.7.2 落地顺序

**① 工具配对保护（正确性，最高优先）** —— DSH 把「切点不得拆散 `tool_use`/`tool_result`」做成内核级不变量（`toolPairingBalancedBefore/After`，注释：`true when no unanswered tool call crosses the cut`）。拆散会让 **API 直接报错**。已 grep 确认：ZCode 压缩代码里 `pairing|paired|unanswered|orphan` **全部搜不到**。这不是优化项，是一类**静默故障**（压缩后请求被 provider 拒，原因不在报错信息里）。

**② 接上 `transcriptPath`（一句话成本）** —— 机制已写好但**未接线**：

- `compact/prompt.ts:146` 已实现「If you need specific details from before compaction… read the full transcript at: <path>」；
- 但调用点 `runtime/methods/compact-active.ts:518` 只传了 `{ suppressFollowup: true }`，**未传 `transcriptPath`**。

接上后，压缩丢掉的东西模型能自己找回来——即「把压缩从信息丢失事件变成可回溯的常规操作」，成本几乎为零。

**③ 摘要输入瘦身（成本）** —— Takumi 在摘要前把工具结果压成一行 `[Tool Results Summary: Tool X executed; …]`、纯工具 assistant 消息变 `[Assistant performed tool operations]`、图片变 `[image]`。ZCode 是**把原始对话直接喂给摘要模型**。它与 §3.1 的缓存复用是同一笔账的两个方向（一个让前缀命中缓存，一个让输入本身变小），**一起做收益最大**。

**④ 预计算压缩（延迟）** —— Claude Code 是四家里唯一做到「触发前就把摘要算好」。本机实测一次压缩**阻塞 69 秒**（`compact.completed` 的 `durationMs: 68821`）。但改动最大、风险最高（要提前触发一次 LLM 调用，并处理「预计算完会话又变了」的失效），**放最后单独评估**。

**⑤ blocking 检测（健壮性）** —— Takumi 在用量 ≥ 输入上限 − 3000 时判定阻塞态，自动压缩关着就直接返回明确错误（`The conversation has exceeded the model's context window. Run /compact…`）。本机实测的体验是**静默死亡**，加这个至少会明确告知去 `/compact`。

### 3.7.3 一条加深了 §3.6 判断的论据

Takumi 的 90% 论证指出：在该路由上比例**同时约束输出预算**——`clampMaxTokensToContext` 把每步输出上限派生为 `min(requested, contextWindow − estimatedContext − 4096)`。比例取 1.0 时这个下界掉到 **1 token**，于是 step 在发出工具调用前被截断，**Agent Loop 会把结果误读为「正常结束的回合」**。

对 ZCode 是双向的：它的 `outputReserve` 正是同一件事的保护（所以绝对公式站得住，不是缺陷）；但反过来说，**固定预留一旦小于实际输出需求，就会重现那个「回合被静默截断」的故障**。所以 §3.6 的 `min(W − outputReserve − buffer, ratio × W)` 更该做：**输出预留保下限，比例保上限**。

### 3.7.4 明确不抄

- **spill 落盘（DSH 第 3 层）**：ZCode 已有 `READ_MAX_OUTPUT_TOKENS` 截断 + 清空旧结果，再加一层 spill artifact + locator 等于给工具结果做第二套存储；且 DSH 自己的注释都在防 `read → spill → read again` 死循环（"`read` is precisely the tool that produces huge logs"），说明这层有真实的坑。
- **按模型差异化阈值**：ZCode 已经走 `modelContextBudgetStrategy` / `preflight-v1`，不缺。
- **OTel 遥测**：jsonl 日志已够用（且该报告自述 MyFlicker 部署下 DSH 的 OTel 是禁用的）。

## 4. 验证方法

| 数据                     | 位置                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| microcompact 决策与效果  | `~/.zcode/cli/log/zcode-<date>.jsonl`，事件 `compact.micro.applied` / `compact.micro.skipped`，带 `preMicrocompactTokenCount`、`postMicrocompactTokenCount`、`tokensSaved`、`trigger`、`reason`、`thresholdTokens` |
| 压缩请求的真实形态与用量 | App 会话写 `~/.zcode/cli/rollout/model-io-sess_*.jsonl`（含完整 `request`：`body.tools`、`messages`、`toolNames`）。**headless 运行不落盘**，要量真实请求必须走 App 会话                                           |
| 缓存命中                 | `model.request.completed` / `model.response.diagnostics`，以及界面显示的缓存命中率                                                                                                                                 |
| 重读频率（P2）           | 会话库 `~/.zcode/cli/db/db.sqlite` 的 `part` 表：microcompact 边界之后的 `Read` 调用，与之前被清空结果的路径比对                                                                                                   |

## 5. 风险

- **改指令投递位置可能改变模型行为**：把摘要指令从独立 system prompt 改成对话末尾的 user 消息（DSH 做法）或中段 system 消息（ZCode 已有 `midConversationSystem` 能力检测），模型可能不再稳定地「只输出摘要」。`NO_TOOLS_PREAMBLE`/`TRAILER` 就是为压制这类跑偏而存在的，改造时必须保留等效约束并实测。
- **缓存复用依赖 provider 真的做前缀缓存**：本机有 82.2% 命中率作为证据，但换 provider 后要重新确认。
- **P0 的前提未验证**：ZCode 当前这次摘要调用是否已经构成真前缀（它确实传了工具与 messages），要先读 `compact-summary-model-request.ts` 与 `compact-active.ts` 的请求组装确认，再决定改法。**不要跳过这一步直接改。**

## 6. 实施顺序

1. 确认 P0 前提（当前摘要请求与主请求的前缀差异到底在哪）。
2. P0 改造 + 现有压缩测试全绿 + 真机量缓存命中。
3. P1 加 checkpoint 合并规则 + 连续两次压缩的摘要体积对比。
4. 用一段时间后按 §3.4 取证，再决定 P2。

每步一个独立提交（见 `CUSTOM_DEV_WORKFLOW.md` §2 第 7 条）。
