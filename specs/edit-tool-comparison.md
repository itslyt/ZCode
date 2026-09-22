# 编辑工具横向评估：五家实现对比与取舍

评估对象（均为本地检出源码）：

| 代号            | 路径                                       | 形态                                                                |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| **DSH 官方**    | `/Users/liuyutong08/Work/deepseek-harness` | 内置工具 + fs 层守卫                                                |
| **better-edit** | `/Users/liuyutong08/Work/dsh-better-edit`  | 插件，哈希锚点，替换内置 read/edit                                  |
| **Codex**       | `/Users/liuyutong08/Work/codex`            | Rust，freeform patch 工具（grammar 约束）                           |
| **oh-my-pi**    | `/Users/liuyutong08/Work/oh-my-pi`         | Rust，`pi-edit` 五模式（replace/patch/apply_patch/hashline/sloppy） |
| **ZCode 现状**  | `apps/zcode-cli/packages/core/src/tool/`   | JSON 工具 + 8 级模糊匹配级联                                        |

本文只做评估，不含实现改动。结论见 §7。

---

## 1. 对比矩阵

| 维度           | DSH 官方       | better-edit              | Codex                            | oh-my-pi                              | ZCode 现状                      |
| -------------- | -------------- | ------------------------ | -------------------------------- | ------------------------------------- | ------------------------------- |
| 定位方式       | 字面量精确匹配 | **3 字符锚点哈希**       | patch 上下文行                   | 行号+文件标签 / FIND 文本 / 字面量    | 字面量 + **8 级降级**           |
| 负载形态       | JSON           | JSON（元组数组）         | **纯文本 patch**                 | 纯文本 / JSON                         | JSON                            |
| 每次调用编辑数 | 1              | **≤32（原子）**          | 多文件多 hunk                    | 多 hunk                               | **1**                           |
| 原子性         | —              | ✅ 全有或全无            | ❌ 报告已提交增量                | ✅                                    | —                               |
| 匹配容错       | 无（精确）     | ASCII 空白不敏感         | 4 级（精确→rstrip→trim→Unicode） | 10 种策略 + 相似度阈值                | 8 级（含 Levenshtein 0.8 块锚） |
| 歧义处理       | 拒绝           | `E_AMBIGUOUS_ANCHOR`     | 取首个匹配                       | 候选预览 + 主导判定                   | **拒绝（唯一性校验）**          |
| 未读即写       | ✅ fs 层守卫   | ✅ served 状态           | ❌                               | ✅ 未展示 hunk 拒绝                   | ✅ 工具层校验                   |
| 陈旧检测       | ✅ 版本守卫    | ✅ reject-and-serve      | ❌                               | ✅ 标签不匹配                         | ✅ 校验 + 报错                  |
| 失败可恢复性   | 报错           | **回传新锚点，无需重读** | 报错 + 已提交增量                | **回传就近片段 + 可复制修正 payload** | 报错，需重读                    |
| 撤销           | ❌             | ✅ 持久化                | ❌                               | ❌                                    | ❌                              |
| 约束解码       | —              | —                        | ✅ Lark grammar                  | ✅ sloppy/hashline 有 grammar         | ❌                              |

### 1.1 四大流派定位：ZCode 与 DSH 官方都属 replace 族

按**定位方式**（模型要回显多少旧内容）划分，主流是四族：

| 流派            | 定位方式                                     | 模型回显的旧内容           | 采用者                                                                                   |
| --------------- | -------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| **replace**     | 字面量 `old_string`                          | **全部被替换文本**         | **ZCode `Edit`**、**DSH 官方**（`str_replace_editor` + `edit`）、oh-my-pi `replace` 模式 |
| **apply_patch** | `*** Begin Patch` + `@@` 上下文 + `+`/`-` 行 | 上下文行（变更行用 +/-）   | Codex、oh-my-pi `patch`/`apply_patch` 模式                                               |
| **hashline**    | 行号 + 文件标签 / 内容哈希锚点               | **只回显锚点**             | dsh-better-edit（3 字符哈希）、oh-my-pi `hashline`（行号 + 4 位标签）                    |
| **sloppy**      | `*** SM:FIND` 引用原文 + `…` 省略            | 引用的原文（可省略未变段） | oh-my-pi `sloppy` 模式                                                                   |

回显量决定 token 成本。§3 里 590/480 那两列是 **oh-my-pi 的 `hashline` 模式**（`[path#tag]` + `PUT N.=M:`），不是 `sloppy`——sloppy 没有公开实测数据，本文补测见 §3.1。

四族的实测排序（同一语料、同一 tokenizer，详见 §3）：

```
replace            964–969
sloppy（本次补测）   929（逐次）/ 874（批量）
better-edit hashline 701
oh-my-pi hashline   590（逐次）/ 480（批量）
```

**sloppy 并没有想象中省**：它仍要逐字复述 `*** SM:FIND` 引用的原文，省下的只是 JSON 的引号与 `\n` 转义。见 §3.1。

**ZCode 与 DSH 官方都在 replace 族**，但两点必须限定：

1. **容错策略差一个档次**。ZCode 是「replace + 8 级模糊降级 + 逐级唯一性判定」；DSH 官方是**纯精确** `content.indexOf(search)`，零容错。同族不等于同级。
2. **ZCode 有 apply_patch 的契约但没有实现**。`apps/zcode-cli/packages/contracts/src/tools/apply-patch.ts`（80 行）定义了完整的 `patch_text` 入参与 `files[{type: add\|update\|delete\|move}]` 出参，但全仓库**没有 handler**：`tool/handlers/index.ts:80` 的 `applyPatchToolEntry` 是注释状态，且该注释来自上游开源提交 `872ad96 feat: open source`（非本 fork 改动）。即 apply_patch 家族在 ZCode 是**预留接口**，不是缺失。

> 注：`runtime/methods/file-rewind.ts` 里的 `applyPatch` 来自 npm `diff` 包，用于会话回滚，与工具无关。

---

## 2. 逐家剖析

### 2.1 DSH 官方：把守卫下沉到文件系统层

两个工具并存：

- `packages/fs/tool-str-replace-editor/src/index.ts`（531 行）：Anthropic 经典 `str_replace_editor`，`view`/`create`/`str_replace`/`insert` 四命令。匹配是**纯精确** `content.indexOf(search)`，注释里明确要求 "should match EXACTLY one or more consecutive lines … Be mindful of whitespaces"。每次写操作 `ctx.emit('fs/observed', target, …)` 记录已观察状态。
- `packages/fs/tool-fs/src/edit.ts`（168 行）：新的 `edit`，参数 `file_path`/`old_string`/`new_string`/`replace_all`。关键在注释：

  > It obtains an optional guard from the single intent slot, calls `ctx.fs.editText` without a separate stat, then records the observed version; no policy means an unconditional atomic edit.

  写之前先走 `ctx.waterfall('fs/edit-intent', target, exec, …)`，由 `packages/fs/fs-observation-policy/src/index.ts` 决定放行还是抛 `FS_NOT_OBSERVED`：

  ```ts
  throw new FsError(`edit requires reading "${target.displayPath}" first`, "FS_NOT_OBSERVED");
  ```

**可借鉴的精华**：读后写守卫不是散在每个工具里的 if，而是**文件系统层的一个 policy 插件**——所有写入路径自动受约束，新增工具不需要重写一遍守卫。这比 ZCode 在 Edit 内部自己校验更不容易漏。

**弱点**：匹配零容错，模型缩进差一个空格就失败；失败后不回传上下文，只能重读。

### 2.2 better-edit：锚点哈希 + served 校验

我日常使用的工具。实现要点（`src/hashline/`）：

- **哈希不是行内容的摘要**，而是从 62³ = 238,328 的槽位空间**分配**出来的身份：`idxToHash(idx)` 用 `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789` 做 base62 编码（`hash-assign.ts`）。`hashToCanon` 记住"这个哈希代表这段文本"，槽位耗尽时报 `E_ANCHOR_SPACE_EXHAUSTED` 并做 GC promotion（`read-and-serve.ts`）。另有 `contentChecksum()`（xxh64）用于整文件比对。
- **served 状态**：`read` 把展示过的行按 `(session, path)` 落进 SQLite（`read-and-serve.ts` 的 `FileView`：normalize → hash → render → truncate → served selection）。`edit` 对解析出的每一行调 `verifyServedRange`，任何一行没被展示过 → `E_RANGE_UNSERVED`，写盘前拒绝。
- **reject-and-serve**：拒绝时把当前范围以新锚点重新发回，模型不用重读。
- **错误分类**：`[MODEL]` 前缀表示"你要改这个 payload"，`[USER]` 表示"这是给人看的提示"，机器可判别。20+ 错误码（`E_STALE_ANCHOR`、`E_BATCH_ABORT`、`E_SERVED_ECHO`、`E_WRITE_HASH_ECHO`…）。
- **batch 语义**：`{ path, edits: [[from, to, text], …] }`，同文件 ≤32 条原子执行，一条失败整批拒绝（`E_BATCH_ABORT`）。
- **撤销**：`undo_last_edit`，重启后仍有效（SQLite 快照 + 内容一致才允许）。

**可借鉴的精华**：① served 校验——把"模型只该改自己看过的行"从约定变成硬约束；② 失败即回传新状态，消除重读往返；③ 原子批量；④ 错误码带受众前缀。

**弱点**（我实测，见 §5）：锚点本身很好，但**批内顺序契约**和**payload 形状**是持续出错的地方。

### 2.3 Codex：用语法约束让模型无法写错格式

- 工具是 **freeform**，不是 JSON：`ToolSpec::Freeform`，`format: { type: "grammar", syntax: "lark" }`，grammar 内联自 `codex-rs/core/assets/tools/apply_patch.lark`。描述只有一句：

  > The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.

- 语法：`*** Begin Patch` / `*** Add File:` / `*** Delete File:` / `*** Update File:` / `*** Move to:` / `*** End Patch`，hunk 内是 `@@` 上下文锚 + ` `/`+`/`-` 前缀行，末尾可带 `*** End of File`。
- 定位算法 `apply-patch/src/seek_sequence.rs`（193 行），**4 级递进**：精确 → `trim_end` → `trim` → Unicode 标点归一（花引号/破折号/NBSP 折成 ASCII）。`eof` 时先从文件尾试。
- **原子性：不保证**。`lib.rs` 顺序 `for hunk in hunks` 逐个写，失败时返回 `ApplyPatchFailure` 携带 `AppliedPatchDelta`——即"失败前已确定提交的增量"，让调用方知道哪些文件已经被改了。

**可借鉴的精华**：① grammar 约束解码（前提是 provider 支持）；② Unicode 标点归一这一级容错（ZCode 也有 `quote_normalized`，方向一致）；③ 部分提交要**如实报告**而不是假装原子。

**弱点**：非原子；patch 语法本身有学习成本；grammar 强依赖 OpenAI 系 provider。

### 2.4 oh-my-pi：五种模式，最有价值的是"可复制修正"

`crates/pi-edit/` 把五种编辑形态做成可切换模式，每种配一份提示词（`prompts/*.md`）和可选 grammar：

| 模式          | 定位方式                                             | 特点                                                                                    |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `replace`     | 字面量                                               | 基线                                                                                    |
| `patch`       | 上下文行                                             | Codex 风格                                                                              |
| `apply_patch` | `*** Begin Patch`                                    | 带 lark grammar                                                                         |
| `hashline`    | **行号 + 4 位文件标签 `[path#A1B2]`**                | `PUT N.=M:`，块操作 `PUT N*:`、寄存器 `@name`、`CUT`/`REM`/`MV`；**每次编辑后重新编号** |
| `sloppy`      | **`\*** SM:FIND`引用原文 +`**\* SM:PUT`/`SM:AFTER`** | `…` 省略未变行；"sloppy" 指匹配容错                                                     |

`sloppy` 的提示词把设计哲学写得很直白：

> - Copy FIND lines byte-for-byte from the last file read, including indentation. Markdown, diffs, and agent summaries are not reliable sources.
> - PUT and AFTER indentation is written verbatim. The engine NEVER infers, converts, or repairs indentation.
> - AVOID retyping unchanged lines; use AFTER or `…` captures.
> - Edits address the original file; earlier edits never shift later anchors.
> - **Fuzzy matching NEVER repairs authored whitespace, operators, or delimiters.**
> - Failure applies nothing and returns a copy-ready corrected payload; resend it verbatim.

匹配引擎 `fuzzy.rs`（1573 行）比 ZCode 精细得多：10 种序列策略（Exact / TrimTrailing / Trim / CommentPrefix / Unicode / Prefix / Substring / Fuzzy / FuzzyDominant / Character）、多个阈值（`DEFAULT_FUZZY_THRESHOLD 0.95`、`SEQUENCE 0.92`、`FALLBACK 0.8`、`DOMINANT 0.97` + `DELTA 0.08`）、**缩进深度感知的归一化**（`relative_indent_depths` 把绝对缩进折成相对层级再比）、候选溢出保护（`MAX_RECORDED_MATCHES 5`）、带上下文的候选预览（`OCCURRENCE_PREVIEW_CONTEXT 5` 行 / `OCCURRENCE_PREVIEW_MAX_LEN 80`）。

失败时的输出（`modes/sloppy/apply.rs`）是本次评估里最值得抄的一段：

```
Current file content near the closest match (no re-read needed):
<numbered_preview>
Copy-ready corrected operation:
<修正后的完整 payload>
```

并且区分了三种情形：能给出可复制修正就给出；只有模糊命中（`closest.2 < 0.35`）就明说"别抄上面的模糊结果，重读"；多操作 payload 里则提醒"单独重试会丢掉兄弟操作"。

**可借鉴的精华**：① **失败即回传"就近编号片段 + 可直接复制的修正 payload"**——把一次失败从"重读 + 重新构造"压缩成"重发"；② 缩进深度感知归一化；③ 候选预览（行号 + 上下文）帮助模型自己判断歧义；④ 把"重试会丢兄弟操作"这种坑明确告知模型。

**弱点**：`hashline` 模式每次编辑后要重新编号、重新取标签，把账记在模型脑子里（better-edit 的 README 对此有逐条批评）；`sloppy` 的 `…` 捕获语义和块操作能力抬高了模型技能门槛；模式可切换本身也让提示词变复杂。

### 2.5 ZCode 现状：容错够强，恢复能力最弱

- `edit-matchers.ts`（411 行）：8 级降级 `exact → quote_normalized → line_number_prefix_stripped → escape_normalized → unicode_escape_normalized → line_trimmed → indentation_flexible → block_anchor`，`block_anchor` 用行级 Levenshtein 且要求中段平均相似度 ≥ 0.8。**每一级都做唯一性判定**：`toMatchResult` 对候选值去重，>1 个不同值即 `ambiguous`。容错广度上不输 oh-my-pi。
- 守卫（工具层）：`EDIT_NOT_READ_MESSAGE`（未读即写）、`EDIT_STALE_MESSAGE`（读后被改）、`NON_UNIQUE_OLD_STRING_MESSAGE`（不唯一）。
- 工具面：`file_path`/`old_string`/`new_string`/`replace_all`；schema 552 字符 + 描述 422 字符 ≈ 974 字符。
- `read-text.ts:94` 行前缀是 `` `${index + startLine}\t${line}` ``，即 `cat -n` 风格，**不补零**。

**三个明确短板**：

1. **没有批量编辑**（全仓库无 `MultiEdit`）。结构性改动 = N 次往返。
2. **失败后没有任何恢复材料**：只回一句错误，模型必须重读文件再重新构造。
3. **编辑成功后模型拿不到新位置**。`formatEditModelContent` 只回一句 "The file X has been updated successfully (file state is current in your context — no need to Read it back)"——`structuredPatch` 在输出对象里但没进模型可见内容，所以模型被明确告知"不用重读"，却也没有拿到新的行号。**这正是锚点方案要解决的问题**，也是 ZCode 目前最像"缺了一块"的地方。

另有一处细节风险：`toMatchResult` 按**值**去重，如果文件里有两段完全相同的代码块，宽策略会判定为唯一匹配。这是 `E_AMBIGUOUS_ANCHOR` 类硬校验能覆盖、而纯文本匹配覆盖不了的场景。

---

## 3. token 成本：我自己跑了一遍基准

`dsh-better-edit` 的基准是确定性的（固定语料 + 固定 tokenizer），我本地复现：

```
corpus: benchmark/corpus/shopping-cart.ts (103 行), edits: 12 (8 单行, 4 多行)
tokenizer: js-tiktoken cl100k_base

TOTAL ×12   hashline 701 | str_replace 969 | oh-my-pi seq 590 | oh-my-pi batch 480
vs str_replace: hashline −28%, oh-my-pi seq −39%, oh-my-pi batch −50%
单行 ×8:  311 vs 314  →  −1%
多行 ×4:  390 vs 655  →  −40%
```

**README 与实测不一致**：README 写 "hashline 702 / str_replace 1015 / 省 313（31%）"，我跑出来 str_replace 是 **969**（省 28%）。hashline 与 oh-my-pi 两列数字吻合（701/702、590、480），差的是 str_replace 基线——README 那张表是旧版本跑的快照。另外该仓库工作树是脏的（11 个文件被改，版本 `0.8.2-local.1`），所以这组数字反映的是本地这棵树的构建，不是发布版。

**换算到 ZCode**：基准里的 str_replace 载荷是 `{ path, old_string, new_string }`，与 ZCode 的 `{ file_path, old_string, new_string, replace_all }` 同构，所以 **−28%（单行≈持平，多行 −40%）可以直接迁移**。但要看清量级：12 次编辑省 **268 个输出 token**。单行微调基本打平——README 自己也承认这一点。

**read 侧其实不赚**：ZCode 行前缀是 `${n}\t`（1000 行内 2–5 字符），锚点是固定的 `ABC│`（4 字符）。小文件锚点更贵，大文件才略省。两边基本打平，锚点的收益**几乎全部来自"不回显旧文本"**。

### 3.1 sloppy 补测：只比 replace 省 3.6% / 9.3%

sloppy 没有公开基准，我用**同一个语料、同一份 12 条编辑脚本、同一个 tokenizer**（js-tiktoken cl100k_base）补测，payload 按其发布语法构造（`*** SM:EDIT` + `*** SM:FIND` + `*** SM:PUT`，批量模式用裸 `*** SM:EDIT` 续同一文件、路径只写一次）：

| 场景                        | 行数 | replace | sloppy 逐次 | sloppy 批量 |
| --------------------------- | ---- | ------- | ----------- | ----------- |
| single · constant           | 1    | 37      | **40**      | —           |
| single · comment            | 1    | 39      | **43**      | —           |
| single · signature          | 1    | 42      | **45**      | —           |
| multi · 3-line if-block     | 3    | 79      | 75          | —           |
| multi · 6-line helper body  | 6    | 118     | 110         | —           |
| multi · 10-line loop block  | 10   | 138     | 127         | —           |
| multi · 15-line method body | 15   | 315     | **278**     | —           |
| **合计 ×12**                |      | **964** | **929**     | **874**     |
| 相对 replace                |      | —       | **−3.6%**   | **−9.3%**   |

**结论：sloppy 在单行编辑上比 replace 更贵**（`*** SM:FIND`/`*** SM:PUT` 两个头比 JSON 的 `"old_string"/"new_string"` 两个键更费 token），只在多行范围上小幅领先，且领先幅度随行数增长（15 行 −12%）。它省下的是 JSON 的引号与 `\n` 转义，**没有省掉复述原文本身**。

与 hashline 对比：better-edit hashline 701（−27%）、oh-my-pi hashline 590/480（−39%/−50%）。**sloppy 的 token 收益比 hashline 差一个数量级。**

> 口径说明：本表 replace 用**原始文件**内容计算（与 sloppy 的"edits address the original file"语义对齐），得 964；`benchmark/run.mjs` 的 replace 臂在**演进中的文件**上取范围（工具循环语义），得 969。两者都合理，差异不影响结论。

---

## 4. 锚点方案的真实收益来源

把 better-edit 的卖点拆开，会发现"省 token"和"防错行"是两件独立的事：

| 收益                         | 真正来自什么         | 是否必须换寻址方式                                |
| ---------------------------- | -------------------- | ------------------------------------------------- |
| 不回显旧文本（省输出 token） | 锚点                 | ✅ 必须                                           |
| 错行编辑不落盘               | **served 校验**      | ❌ 不需要——用 ZCode 已有的 read-file-state 就能做 |
| 失败不用重读                 | **reject-and-serve** | ❌ 不需要——回传就近片段即可                       |
| 上方编辑后锚点仍有效         | 内容寻址             | ✅ 必须（行号会失效）                             |
| 连续编辑少往返               | 批量 + 新锚点回传    | 部分                                              |

**结论：四项收益里只有两项真正依赖锚点**，而另两项（对正确性的贡献更大）可以在不换寻址方式的前提下拿到。这是我给出 §7 建议的主要依据。

---

## 5. 我使用 better-edit 的实测体感

**赢的地方（真实感受）**：

- **不用复述旧代码**。改大块代码时不必逐字重打缩进，这是最直接的体感改善——尤其在被要求"删掉/替换一整段"时，我只需要两个哈希。
- **锚点不会被上方编辑作废**。同一个文件连续改多处时，我不需要重读。用行号方案时我必须自己维护偏移量，那是我最容易算错的地方。
- **`read` 的输出直接可编辑**。`HASH│content` 我抄 3 个字符就能定位，比"复制一段文本、再确保它唯一"心智负担低。
- **失败带受众标记**。`[MODEL]` 前缀让我能确定"这是要我改 payload"，而不是把给人看的提示当成指令照做。

**痛的地方（也是我在本会话里真实踩到的）**：

1. **payload 形状是元组数组**，不是对象。我最近一次就写成了 `[[from, to, text], to, text, extra]` 这种四元组，直接 `E_BAD_PAYLOAD`。工具签名违反 JSON 工具的常规直觉。
2. **批内顺序契约反直觉**。同一次调用里的多条编辑会互相影响锚点位置，我踩过 `E_BATCH_DISPLACED`（前面的编辑把后面的锚点挤走）。用户也为此专门提醒过我"拆成单独 edit 逐个提交"。文档里有"edits 独立才可批量"的规则，但**规则本身是隐藏耦合**——两个编辑是否独立，需要模型自己推理。
3. **`E_SERVED_ECHO` / `E_WRITE_HASH_ECHO` 属于"我抄多了"**。把 `HASH│content` 整行当成内容复制进 replacement_text 会被拒。工具会尝试自动纠正，但这说明**展示格式和输入格式共用同一个 `│` 分隔符**，容易混。
4. **锚点是会话态**。换会话/换工作区后锚点不复用（存储按 `(session, path)` 隔离），SQLite 库可丢但锚点历史也一起丢。这不是缺陷，但意味着"锚点"不是文件系统的属性，而是会话的属性——移植它就得连带移植这套状态。

**一句话总结体感**：**锚点是净收益，批处理契约是净负担。** 如果要移植，我建议移植前者、重新设计后者。

---

## 6. 各家精华清单（按可移植性排序）

| 优先级 | 设计点                                                       | 来源                              | 移植成本                         |
| ------ | ------------------------------------------------------------ | --------------------------------- | -------------------------------- |
| P0     | 原子批量编辑 + 失败整批拒绝                                  | better-edit `E_BATCH_ABORT`       | 低                               |
| P0     | 失败回传「就近编号片段 + 可直接复制的修正 payload」          | oh-my-pi `copy-ready correction`  | 低                               |
| P0     | 未读/未展示区域硬拒绝（不只靠"读没读过整个文件"）            | better-edit `E_RANGE_UNSERVED`    | 中（ZCode 已有 read-file-state） |
| P1     | 歧义时给候选行号 + 上下文预览                                | oh-my-pi `occurrence_previews`    | 低                               |
| P1     | 缩进深度感知归一化（替代绝对缩进比较）                       | oh-my-pi `relative_indent_depths` | 低                               |
| P1     | 守卫下沉到文件系统层 policy                                  | DSH `fs-observation-policy`       | 中                               |
| P2     | `undo_last_edit`                                             | better-edit                       | 中（需要快照存储）               |
| P2     | Unicode 标点归一（已有 `quote_normalized`，可补破折号/NBSP） | Codex `seek_sequence`             | 极低                             |
| P3     | 锚点寻址                                                     | better-edit                       | **高**（见 §7）                  |
| P3     | grammar 约束解码                                             | Codex / oh-my-pi                  | 高（依赖 provider）              |

---

## 7. 结论与建议

### 7.1 要不要换 ZCode 的编辑工具？

**不建议换寻址方式（不做锚点编辑），建议移植机制。**

理由：

1. **收益侧**：锚点带来的确定收益是"不回显旧文本"，实测 −28%（单行持平、多行 −40%）。ZCode 的 Edit 已经是同类里较省的形态（描述+schema 仅 974 字符）。
2. **成本侧**：真要做锚点，必须**同时改 `Read`**（否则模型没有锚点可用），还要引入会话态锚点存储、served 状态、约 20 个错误码、提示词重写、diff/UI 渲染适配。这是把一个工具的改动升级成"Read+Edit+存储+提示词"四件事，且与 ZCode 现有的 8 级模糊级联是两种哲学，并存会让模型难以判断该用哪个。
3. **正确性侧**：锚点最有价值的两个保护（错行不落盘、失败不重读）**不需要锚点**就能实现——ZCode 已有 read-file-state 跟踪和唯一性校验，缺的只是"未展示区域硬拒绝"和"失败回传材料"。
4. **ZCode 已有优势不该丢**：8 级模糊级联 + 逐级唯一性判定，容错广度与 oh-my-pi 同级，比 DSH 官方和 Codex 都强。换成锚点等于用一套更贵的机制换掉一个已经不弱的能力。

### 7.2 具体建议（按优先级）

**P0 — 直接做，收益明确、成本低**

1. **`Edit` 支持原子批量**：新增可选 `edits: [{old_string, new_string, replace_all?}]`，与现有单条参数二选一；同文件多条**原子执行**（任一条失败则整文件不落盘，错误里指明第几条）。同时**去掉批内顺序耦合**——批内每条都基于**原始内容**定位（像 oh-my-pi 的 "Edits address the original file; earlier edits never shift later anchors"），而不是基于前一条的结果。这一条能把我踩的 `E_BATCH_DISPLACED` 类问题从设计上消掉。
2. **失败诊断带上恢复材料**：错误信息里附「最近的候选区域（带行号）+ 完整可重发的参数」。这是 oh-my-pi 最值得抄的一段，能把"失败 → 重读 → 重新构造"压缩成"失败 → 改一个字段重发"。

**P1 — 值得做**

3. **未展示区域硬拒绝**：ZCode 已有 `read-file-state`，把"该文件读过"收紧为"该区域被展示过"（记录展示过的行区间，编辑命中区间外则拒绝并回传该区间当前内容）。这补上 ZCode 目前最实质的正确性缺口。
4. **歧义时给候选预览**：现在只说"不唯一"，改为附最多 5 处候选的行号 + 上下文，让模型自己挑。

**P2 — 可选**

5. **`undo_last_edit`**：需要按 `(session, path)` 存编辑前快照，并校验"文件仍等于编辑后内容"才允许撤销。
6. **守卫下沉到 fs 层**：参考 DSH 的 `fs-observation-policy`，把读后写守卫从 Edit 内部挪到文件系统适配层，避免以后新增写入类工具时漏掉守卫。

**P3 — 明确不采纳**

- **锚点寻址**：成本收益不成立（§7.1）。如果将来仍想验证，正确做法是**作为独立工具、config 开关、与现有 Edit 并存做 A/B**，而不是替换——但在 P0/P1 做完之前没有做的必要。
- **Codex 的 freeform grammar**：需要 constrained decoding，ZCode 走标准 JSON tool schema，跨 provider 不可靠。
- **`hashline` 的块操作/寄存器/`MV`**：抬高模型技能门槛，收益主要是"少打字"而非正确性。
- **Codex 的非原子部分提交**：与 ZCode 的权限/审批模型冲突——半成品落盘后审批语义会变复杂。

### 7.3 一句话

**ZCode 的编辑工具不缺容错，缺的是"一次改多处"和"失败后能自己爬起来"。先补这两块，锚点留作以后的可选项。**

---

## 8. 评估方法

- 阅读源码：DSH `tool-str-replace-editor/src/index.ts`、`tool-fs/src/edit.ts`、`fs-observation-policy/src/index.ts`；better-edit `src/hashline/*`、`src/read-and-serve.ts`、README.zh.md；Codex `apply-patch/src/{lib,seek_sequence,parser}.rs`、`core/assets/tools/apply_patch.lark`、`core/src/tools/handlers/apply_patch_spec.rs`；oh-my-pi `crates/pi-edit/{src/fuzzy.rs,src/modes/sloppy/*,prompts/*,grammars/sloppy.lark}`；ZCode `handlers/edit.ts`、`edit-matchers.ts`、`contracts/src/tools/edit.ts`、`handlers/read-text.ts`。
- 基准：本地执行 `npm run benchmark`（`/Users/liuyutong08/Work/dsh-better-edit`），结果见 §3。注意该仓库工作树为脏（`0.8.2-local.1`），数字反映本地构建。
- 未做：跨模型端到端编辑成功率实测（需要多模型多次运行，成本高）；锚点方案的 ZCode 原型（未实现）。
