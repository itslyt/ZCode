# 编辑工具路线：replace 优化 + hashline 并存

承接 `specs/edit-tool-comparison.md` 的五家评估。本文回答三个决策问题：

1. replace 先优化什么；
2. 新增的并存编辑工具选 **hashline** 还是 **sloppy**；
3. 谁当主力、谁当降级。

**决策摘要**

| 问题     | 结论                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| 主力编辑 | **hashline**（逐行哈希锚点变体），作为**新增工具**与 `Edit` 并存，不替换 `Edit`       |
| 降级编辑 | **`Edit`（replace）保留不动**，8 级模糊级联继续兜底                                   |
| sloppy   | **不作为首选**：token 收益比 hashline 差一个数量级，且未消除核心失败类（见 §1）       |
| 前置改动 | replace 的 P0 优化（原子批量 + 失败恢复材料）**先行**，它是两个方案共同的前置         |
| 落地节奏 | 阶段 0（replace P0）→ 阶段 1（hashline 新工具）→ 阶段 2（实测后再决定是否提升为主力） |

---

## 1. 为什么主力选 hashline 而不是 sloppy

上次评估我倾向于"sloppy 成本更低"，依据是那组 590/480 的数字。**那个归因是错的**：590/480 是 oh-my-pi 的 `hashline` 模式（`[path#tag]` + `PUT N.=M:`），不是 `sloppy`。sloppy 没有公开基准，我补测了。

### 1.1 补测方法与结果

同一语料（`dsh-better-edit/benchmark/corpus/shopping-cart.ts`，103 行）、同一份 12 条编辑脚本、同一 tokenizer（js-tiktoken `cl100k_base`），sloppy payload 按其发布语法构造：

| 场景                        | 行数 | replace | sloppy 逐次      | sloppy 批量      |
| --------------------------- | ---- | ------- | ---------------- | ---------------- |
| single · constant           | 1    | 37      | **40**           | —                |
| single · comment            | 1    | 39      | **43**           | —                |
| single · signature          | 1    | 42      | **45**           | —                |
| multi · 3-line if-block     | 3    | 79      | 75               | —                |
| multi · 6-line helper body  | 6    | 118     | 110              | —                |
| multi · 10-line loop block  | 10   | 138     | 127              | —                |
| multi · 15-line method body | 15   | 315     | **278**          | —                |
| **合计 ×12**                |      | **964** | **929（−3.6%）** | **874（−9.3%）** |

对照 hashline：better-edit 701（−27%）、oh-my-pi 590 / 480（−39% / −50%）。

### 1.2 三个决定性事实

1. **sloppy 在单行编辑上比 replace 更贵**。`*** SM:FIND` + `*** SM:PUT` 两个头，比 JSON 的 `"old_string"` + `"new_string"` 两个键更费 token。它省下的只是 JSON 的引号与 `\n` 转义，**没有省掉复述原文本身**。
2. **sloppy 与 replace 是同一失败模式**。两者都要求模型逐字复述旧内容——正是 harness-problem 文献指认的头号失败源。sloppy 只是复述量略小，没有换掉失败类。把它设为主力、replace 设为降级，两者在可靠性上没有质变，主/备分层失去意义。
3. **hashline 是唯一"零复述"的方案**，token 收益也高一个数量级。

### 1.3 成本对比并不站在 sloppy 一边

直觉上 sloppy 更便宜（不用改 Read、不用状态），但按 ZCode 的实际架构拆开看：

| 成本项     | sloppy                                                                | hashline                                                   |
| ---------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| Read 工具  | 不用改                                                                | **要改**（行前缀 `N\t` → `HASH│`）                         |
| 持久化状态 | 不需要                                                                | 需要 served 区间，**但可搭 `read-file-state` 便车**（§3）  |
| 匹配器     | 复用现有 8 级级联 + 新增 `…` gap 分段匹配                             | 不需要模糊匹配（锚点精确），需要锚点解析与校验             |
| 权限模型   | 多文件 payload → **要新造**（ZCode 无多路径工具先例）；限单文件可规避 | 单文件 → **直接复用** `Edit` 的 `patternSources: ["path"]` |
| diff UI    | 多文件 diff 卡片 → 要新造；限单文件可规避                             | 单文件 → **零改动**                                        |
| 解析器     | 新语法（oh-my-pi 的 parser 2037 行 Rust，TS 精简版约 600–800 行）     | 无（锚点是既有 JSON 字段）                                 |
| 估算规模   | 限单文件约 1400 行 TS                                                 | 约 1200–1500 行 TS                                         |

**限单文件后，sloppy 与 hashline 的实现量级相当**（都在 1.5k 行 TS 上下），sloppy 只省下"改 Read"这一项。用这点成本差换 −27%/−50% → −3.6%/−9.3% 的收益落差，不划算。

> 结论：**选 hashline。**

---

## 2. hashline 的两个变体与选型

|              | 变体 A：逐行哈希锚点     | 变体 B：行号 + 文件标签                  |
| ------------ | ------------------------ | ---------------------------------------- |
| 代表         | dsh-better-edit          | oh-my-pi `hashline` 模式                 |
| Read 输出    | `ve7│function hello() {` | `[path#A1B2]` 头 + `1:def greet():`      |
| 定位         | 两个 3 字符哈希          | `PUT N.=M:` 行号区间                     |
| 上方编辑影响 | **无**（内容寻址）       | 行号全部位移，**每次编辑后必须重新编号** |
| 状态         | served 区间 + 锚点映射   | 仅文件内容标签（无状态）                 |
| 模型负担     | 抄锚点                   | 维护行号 + 每次重取标签                  |
| 实测 token   | 701                      | 590 / 480                                |

**选变体 A。** 理由：用户的目标是"主力日常驱动"，多步编辑的可靠性是核心；变体 B 的"每次编辑后重新编号"把账记在模型脑子里，正是最容易出错的地方（oh-my-pi 自己的提示词把 "RE-GROUND AFTER EVERY EDIT" 列为头号规则）。变体 B 唯一优势是省状态，而 ZCode 的状态落点已经存在（§3）。

**锚点用「行号 + 哈希」联合寻址，不用纯哈希。** 这一点我最初的设计是错的，此处已修正。

内容派生的短哈希在单文件内必然碰撞：3 字符 = 62³ = 238 328 个值，按生日问题估算，1000 行文件的碰撞概率约 **88%**，10 000 行几乎必然碰撞。参考实现（`chen.zz.ac` 的复测文章）明确指出——短哈希只在「行号 + 哈希」联合校验下才可靠：同一行号上撞哈希可以忽略，但拿哈希当全文件唯一 ID，遇到重复行（多个 `}`）立刻出事。

因此锚点形如 `行号:哈希`：

```
Read 输出：  22:f1│  return "world";
Edit 锚点：  remove_from: "22:f1",  remove_to: "24:0e"
```

- **行号负责定位**：`22` 明确指向第 22 行，重复内容与哈希碰撞都不破坏唯一性。
- **哈希负责见证**：`f1` 校验第 22 行内容确实还是模型看过的那一行；不符即拒绝。
- **纯函数、无状态**：`hash = base62_2(xxh32(lineContent))`，随时可从文件内容重算，不需要锚点分配表，也不需要持久化锚点。

### 2.1 自愈合重定位（本 fork 的优化）

文章把「编辑后行号全部位移、旧标签作废、模型必须重新读取」列为第一条实战坑（其作者的第一版实现因此空转）。我们不在提示词里叮嘱模型重新定位，而是让解析器自己修：

1. 先按行号精确校验 `N:hash`；
2. 不符时，在该行附近窗口（默认 ±200 行）内搜索哈希唯一的匹配；
3. 唯一命中 → **按新位置应用**，并在结果里回传新锚点与实际位移；
4. 无命中或多次命中 → 拒绝，并回传该行附近区域的当前锚点。

这样模型手里过期的行号会自愈，而不是变成一次失败往返。对比：better-edit 靠持久化锚点表避免位移，oh-my-pi 靠让模型每次重新取标签；本方案两者都不需要。

### 2.2 文章其余三条教训的落地

| 教训                                 | 本方案的做法                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 编辑成功后必须回传受影响区域的新锚点 | 编辑结果带 `updatedAnchors`（改动区域 ±3 行）与行数位移，模型无需重读                                             |
| 短哈希会撞，别当全局 ID              | 见上文：行号 + 哈希联合校验                                                                                       |
| 拒绝要给好错误信息                   | 拒绝时回传「第 N 行现在是 `<内容>`（锚点 `<hash>`）；你要改的区域已变化」+ 该区域当前锚点，而不是 `edit rejected` |

需要持久化的**只有 served 区间**（模型实际被展示过哪些行）。

---

## 3. ZCode 落点与成本拆解

### 3.1 已就位的基础设施（这是 hashline 在本仓库成本可控的主因）

- **`read-file-state` 已存 `content` + `offset` + `limit` + `isPartialView` + `revisionId` + `mtimeMs` + `sizeBytes`**（`tool/types.ts:203` `ReadFileStateEntry`），且已经服务于 `Edit` 的"未读即写"和"陈旧"校验（`EDIT_NOT_READ_MESSAGE` / `EDIT_STALE_MESSAGE`）。
- **它随 transcript 持久化**：`call-runner.ts:521` 把 `readFileStateMetadata` 挂到 tool result，`tool-part-metadata.ts:39` 以 `readFileState` 落进消息元数据。→ 锚点与 served 状态**天然获得跨重启存活**，不需要新建 SQLite 层（better-edit 为此专门建了一个库）。
- **Read 行格式的消费者极少**：全仓库只有 `edit-matchers.ts` 的 `line_number_prefix_stripped` 策略及其测试。UI 侧没有任何代码解析 `N\t` 前缀（`grep` 验证）。

### 3.2 改动清单

| 模块                       | 改动                                                                                                      | 估算    |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| `handlers/read-text.ts`    | 行渲染 `${n}\t${line}` → `${hash}│${line}`                                                                | ~80 行  |
| 新增 `tool/anchor-hash.ts` | 确定性 3 字符哈希 + 文件内重复行消解                                                                      | ~90 行  |
| `tool/read-file-state*`    | 新增 `servedRanges: {start,end}[]`，`Read` 写入、`Edit`/锚点工具读取                                      | ~80 行  |
| `contracts/src/tools/*`    | 新工具契约（`path` / `edits: [{remove_from, remove_to, replacement_text}]`，`path` 可为 null 由锚点推断） | ~140 行 |
| 新增锚点解析与校验         | 锚点 → 行区间、served 校验、reject-and-serve 回显新锚点                                                   | ~400 行 |
| handler + 注册 + 权限      | `builtInTools` 注册、`CODING_ONLY_TOOLS` 加名、复用 `patternSources: ["path"]`                            | ~180 行 |
| 提示词 + i18n + 测试       | 工具描述、`tool:edit` 类片段、zh/en、单测                                                                 | ~300 行 |

合计约 **1200–1500 行 TS**。

### 3.3 必须一起改的既有行为

- `line_number_prefix_stripped` 策略**保留**：Grep / Bash 输出仍带行号，模型可能粘贴这类文本，这一级降级仍有价值（只是从"Read 来源"变成"其他来源"）。
- Read 工具描述里的 "Results are returned using cat -n format" 必须改；同时要明确"锚点就是行地址"。
- `edit-matchers.ts` 的 `stripReadLineNumberPrefixes` 需同时能剥离 `HASH│` 前缀（模型抄多了的情况），并给出可自动纠正的提示（对应 better-edit 的 `E_BARE_HASH_PREFIX`）。

---

## 4. 分阶段实施

### 阶段 0：replace 的 P0 优化（已完成）

1. **`Edit` 支持原子批量**：新增可选 `edits: [{old_string, new_string, replace_all?}]`；同文件多条**原子执行**（任一条失败整文件不落盘，错误指明第几条）；**批内每条都基于原始内容定位**（先全部定位、再按偏移倒序写回），消除批内顺序耦合；区间重叠显式拒绝（`BATCH_EDIT_OVERLAP`）。
2. **失败诊断带恢复材料**：附「最近候选区域的带行号片段」（学 oh-my-pi 的 `numbered_preview`）；找不到相似区域时明确要求重读，而不是给一个错误的片段。

**`edits` 与 `old_string`/`new_string` 的优先级（真机验证后修正）**

最初实现的是「两者同时给出就拒绝」的互斥校验。真机验证证明那是错的：模型会顺手把可选字段也填上，实测四次尝试里**三次**因此被拒（分别填了真实内容、`"unused"`、空串），白耗三个往返。

模型填满可选字段是**结构性行为**，用校验去拦它属于「用提示词劝阻失败模式」。现改为：

- `edits` 直接赢，同时给出的 `old_string`/`new_string` 被忽略；
- 结果里明说 `The old_string/new_string arguments were ignored because edits was provided.`，不静默；
- `edits` 缺失时才要求 `old_string`/`new_string` 必须成对出现。

验收（已真机跑通）：批量编辑中途失败时文件零改动；单条失败后模型无需 `Read` 即可重发；批量在模型同时填写两套参数时**一次成功**。

### 阶段 1：hashline 作为新增工具并存（已完成）

新增 `EditAnchored`，与 `Edit` 同时注册。落地时对原计划做了三处修正：

**锚点格式：`N:HASH`，4 字符 Crockford base32**

- 字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`（去 I/L/O/U），归一化时把 `I/L→1`、`O→0`，大小写不敏感——模型抄错大小写不该变成一次失败。
- 4 字符 = 1 048 576 个值。**不用纯哈希寻址**：3 字符 base62 只有 238 328 个值，1000 行文件按生日问题算碰撞概率约 88%，碰撞后锚点无法确定指向哪一行。带行号后行号负责定位、哈希负责见证。
- Read 输出改为 `N:HASH│content`。

**served 状态：按哈希而非按行号**

原计划的 `servedRanges: {start,end}[]` 换成了 `ReadFileStateEntry.servedAnchors: string[]`（已展示过的行哈希，去重）。理由：文件被编辑后行号会移动，但哈希代表的仍是同一段内容，所以「这个哈希有没有出现过」才是稳定的判定。两条不变量：

- **只增不减**：文件内容变了也不清空，否则模型自己编辑一次后，手里其余行的锚点会被误判为 unserved。
- **按文件跨条目聚合**：同一文件多次 range read 落在不同 key 上，判定时必须取并集。

随 tool-result metadata 持久化（`servedAnchors` 字段），resume 后仍可用。

**解析优先级：宁可拒绝也不猜**

1. 锚点语法合法；2. 哈希在 served 集合里；3. 行号处哈希对得上 → 直接用；4. 对不上 → 全文按哈希找，**唯一命中才移动**（自愈合）；5. 找不到 / 多处命中 → 拒绝并回传该区域当前锚点（reject-and-serve）。

第 4 步是相对参考实现的改进：better-edit 靠持久化锚点表避免位移，oh-my-pi 让模型每次重新取标签（它自己的提示词把 `RE-GROUND AFTER EVERY EDIT` 列在头号规则）。这里让解析器自己修。第 5 步的多处命中一律拒绝，保证不会改错行。

编辑成功后结果里回传受影响区域的新锚点，省掉一次重读。因为锚点用内容哈希见证，这里**不需要** `Edit` 那套 mtime/revision stale guard。

**真机验证发现并修掉的 bug**：Read 的 `offset: 0` 路径把 `startLine` 直接置 0，而渲染是 `index + startLine`，于是首行渲染成 `0:HASH│`——既与工具描述「line numbers starting at 1」矛盾，又让 `offset=0` / `offset=1` 两次读取的行号不一致，模型拿着 0 号锚点会被判非法，白耗一个往返。修在渲染层：`startLine <= 0` 时按第 1 行起算。

验收（已真机跑通）：一次调用原子完成三处修改，锚点 1 起始；未展示区域被拒并回传新锚点；同一文件连续多步编辑无需重读。

单元测试：`pnpm --dir apps/zcode-cli/packages/core test`（28 例，覆盖哈希/解析/自愈合/歧义拒绝/重叠/删除插入）。

### 阶段 1.1：served 语义修正（已完成）

真机验收（报告见 `specs/edit-anchored-verification.md`）查出五个缺陷，根因集中在**「哪些行算被展示过」没有唯一规则**。修正后的规则：

> `served` 只增加**这一次实际渲染给模型的行**。渲染只有两个出口——成功路径的 `buildUpdatedAnchors` 与拒绝路径的 `formatAnchorRegion`——两者都回报自己渲染了哪些哈希，调用方并进 served。

这条规则同时修掉了两个方向相反的错误：

| 缺陷                                                                                       | 修正                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 成功路径把**整个新文件**的哈希灌进 served，首次编辑后「只允许改看过的行」形同虚设          | 只并回传区域实际渲染的行                                |
| 拒绝路径直接 return，**不写** served，错误信息里刚给出的锚点不算看过，模型照抄必然二次失败 | 拒绝路径也写，且与成功路径共用 `writeAnchoredReadState` |

拒绝路径只在**确实渲染了区域**时才写（`stale` / `ambiguous`）；`unserved` / `malformed` / `reversed_range` 不渲染任何内容，连 served 也不用并。`ambiguous` 也从「叫模型再读一次」改成回传区域锚点——否则同样把 reject-and-serve 省下的往返还回去。

**served 集合与门禁字段是两件事**（报告 §6，修复引入的缺陷）：第一版修法把两者混在一个函数里写，顺带把 `isPartialView` 从 `true` 翻成 `false`、`content` 换成整文件，于是模型只要触发一次**会被拒绝**的锚点编辑就拿到「整文件已读」，随后能用 `Edit`/`Write` 覆盖它从未读过的位置。现在拆开：

- 拒绝路径只并 `servedAnchors`，不碰 `content` / `isPartialView` / `readAt` / `revision`。拒绝是零副作用的，模型并没有因此读到更多内容；刷新 `readAt` 也等于替模型把门禁基准推到一次它并未读取的动作上。
- 成功路径保留旧的 `isPartialView`（取门禁实际会选中的那条，即同路径 `readAt` 最新的条目），不再无条件置 `false`。锚点编辑可以在只读了部分内容的文件上成功——锚点是内容见证的，不需要整文件视图。

`partial view` 是可达的：整文件 Read 一个超限文件会返回截断结果并置 `truncatedByTokenCap`（实测 3001 行文件返回 515 行，读状态即 `isPartialView: true`）。

**回传锚点的区间**三个叠加缺陷一并修掉：`end` 被丢弃、区间用原始内容索引却作用在新内容上、窗口重叠时后一个区块被整个丢弃。现在 `applyAnchorEdits` 直接回报每条编辑在**新内容**里的落点（并平移倒序处理带来的位移），`buildUpdatedAnchors` 按区间合并重叠/相接的窗口。

**跨会话与 UI**：hydrator 原先只匹配 `part.tool === "Edit"`，锚点编辑写的读状态在 resume 后整个丢掉；`ZCODE_KNOWN_TOOL_NAMES` 也没有 `EditAnchored`，工具卡退化成原始 JSON。两处均已登记。

回归防线：`pnpm --dir apps/zcode-cli/packages/core test`（43 例）与 `packages/ui/test/toolIdentityEditAnchored.test.ts`（4 例）。新增用例盯的正是报告指出的单测盲区——旧辅助函数把「served = 全文」当成了前提，所以对第一类缺陷结构上是盲的。

**未处理（观察，未定性为缺陷）**：`servedAnchors` 只增不减、无上限。修正后它的增长只来自真正展示过的行（不再是一次编辑灌全文），单次 Read 的上界就是文件行数，与既有 `content` 快照同量级。加硬上限会引入新失败模式（模型手里的旧锚点被误判 unserved），目前证据不足以支持，先留观察。

### 阶段 1.2：§7 复验发现

本节区分「已知且已修」与「已知但未修」——后者不是「已验证没问题」，而是缺陷仍开着。

**已修：内容清空后渲染出假行**（报告 §7.2）。`splitLines("")` 返回 `[""]` 而不是空数组，所以 `lines.length === 0` 这个判据在空内容上不成立。删光全文后 `buildUpdatedAnchors("")` 会凭空渲染出 `1:RVM2│`，而 `RVM2` 就是 `hashLineContent("")`——并进 served 之后，该文件里任意空行都变成「已读」，模型可以引用它们的锚点。这是 §1 那类问题（放宽方向）的缩小版，已改用 `isEmptyContent` 判据，`formatAnchorRegion` 同款问题一并修掉。

**已修：拒绝路径并进的 served 不跨会话**（报告 §7.1）。

`f9730f8` 让拒绝路径也写 served 以闭合 reject-and-serve 循环，但这个闭合只在单次会话内成立：handler 返回 `ToolHandlerFailure` → `call-runner` 转成异常抛出 → catch 分支的 `createErrorResult`（`executor/errors.ts:6`）不携带 `readFileStateMetadata`，所以 `tool-part-metadata.ts:39` 写不出 `readFileState`；且 hydrator 的 `isCompletedToolPart`（`read-file-state-hydrator.ts:190`）只接受 `status: "completed"` 的部件。

**范围**：丢的是**仅拒绝路径**并进的那一份 served。成功路径写的读状态照常落盘（成功结果带 `readFileStateMetadata` → completed 部件 → hydrator 恢复），§4 的修复没有被这条抵消。

#### 产品规则

**读状态是「模型对文件的视图」，它由产生它的那次工具调用决定，与那次调用成功还是失败无关。** 持久化通道不得按 success 过滤——否则「拒绝是零副作用的」这条规则会在跨会话时被静默破坏。

对应的反向规则同样保留：**拒绝只并 served，不改门禁字段**（§6）。两条合起来是：拒绝路径会写读状态，但写进去的只是 served 集合。

#### 状态所有者与写入顺序

```
handler (EditAnchored)
  └─ context.recordReadFileStateMetadata(metadata)   ← 上报，成功/拒绝两条路都调
       │
call-runner                                          ← 唯一把上报值接到结果上的地方
  ├─ 成功：ToolExecutionResult.readFileStateMetadata  （已有）
  └─ 失败：createErrorResult(..., { readFileStateMetadata })  ← 本次补上
       │
runtime/methods/tool-part-metadata.ts                ← 写进 tool part
  ├─ completed 部件：completedToolPartMetadata(result)（已有）
  └─ error 部件：同样带 readFileState（本次补上）
       │
agent/read-file-state-hydrator.ts                    ← resume 时恢复
  └─ 接受 completed 与 error 两种部件
```

#### 接口

`createErrorResult(toolCall, error, durationMs?, options?)` 的 `options` 增一个可选 `readFileStateMetadata?: PersistedReadFileStateMetadata`。不新增位置参数，新增字段是可选的，对现有调用点都是加性的。

传 `options` 的调用点实际只有 2 处（初版写的「4 个」是错的）：`permission-flow.ts:329` 的 `{ preserveReasonFormatting: true }` 与本处 `call-runner.ts:575`。`createPermissionErrorResult`（`errors.ts:105`）是个带自己 `options` 的转发 wrapper，不算在内。

#### hydrator 放宽的实际语义（初版论证已纠正）

**先纠正一个错误的说法**：初版这里写的是「其它工具的 error 部件天然被跳过」，不成立。hydrator 的判据是「`parseReadFileStateMetadata` 能解析出结构化 metadata + tool 名在白名单里」，**不看工具名是不是 `EditAnchored`**。实测：

```
error 件 metadata 为空:            restored=0 size=0
error 件带 Write 读状态:           restored=1 size=1   ← 会恢复
error 件带 EditAnchored 读状态:    restored=1 size=1   ← 目标行为
error 件 tool 名不认识:            restored=0 size=0
```

可达性很窄但不是零：`readFileStateMetadata` 在 `call-runner` 里是同一个 try 作用域的变量（声明 `:363`、赋值 `:420`、catch 里读 `:571`），而 handler 成功之后还有 `validateOutput` / `serializeOutput` / `runPostToolUseHooks` / `emitToolCallResult` 都在这个 try 里。所以 `Write` 写入成功、随后事件发送抛错时，它的读状态会被带进 error 部件并在 resume 时恢复。（`runPostToolUseHooks` 里 `throw` 计数为 0，`serializeOutput` 只有 CUA 保护路径会抛，所以实际可达的只有事件发送失败。）

**决定：保留这个统一行为，不按 tool 名收窄。** 两个理由：

1. 按 tool 名特判会让通用层反向依赖具体工具。`executor/errors.ts:27` 的注释（「通用错误层按 tool name 拼接 provider 文案会反向依赖具体工具」）讲的就是这条原则——虽然它说的是展示文案，但「通用层不按工具名分派」这个方向同样适用于恢复判据。
2. 语义上这是对的：`Write` / `Edit` 只在**写入成功之后**才记读状态，所以模型的视图是准的；调用后来因为 serialize / emit 抛错而被报成失败，并不让视图变错。这与本节的规则（读状态与 success 无关）一致。

所以这条的保证要这样说：**凡带合法 read-state metadata 的部件都恢复，无论成功或失败；写不写由 handler 决定。** 它依赖的不变式在 handler 一侧——只有确实读过或写过文件的 handler 才写读状态，而不是靠通用层拦。这条行为已用测试钉住（`带合法读状态的 Write 失败件也会恢复`），不靠碰巧成立。

#### 明确不做

不从失败部件的 `modelContent` 文本里解析回传的锚点。那会把恢复绑死在展示格式上，而 `Read` 的 resume 路径当初就是为了避开这一点才改成结构化持久化的。

#### 验收场景

1. **跨会话闭合**（主场景）：会话 1 Read 后触发 stale 拒绝 → 失败部件带 `readFileState`（含回传的当前锚点）；会话 2 resume → 该文件读状态恢复、served 含那些锚点；用会话 1 错误信息里抄来的锚点重发**直接成功**，不需要重新 Read。
2. **其它工具的失败件不产生读状态**：Write 失败后 Edit 仍被门禁拒（不能因为失败件放宽了恢复语义而获得「已读」）。
3. **成功路径不回归**：§4 的恢复照常。
4. **门禁不回归**：拒绝路径写入的条目仍是 partial view 原值（§6）。

#### 验证方式

单测盖 1/2/3 的机制层（错误结果携带 metadata、hydrator 接受 error 部件且拒绝不认识的 tool）；主场景 1 跑了真实两段会话。

#### 验证结果

```
会话 1：Read（全文件）→ 外部 sed 改第 2 行 → EditAnchored 用旧锚点 2:BZMC → 拒绝
        拒绝信息回传当前锚点 2:PHZF；失败部件的 metadata.readFileState.servedAnchors
        含 PHZF（数据库实测）
会话 2：--resume 后直接用 2:PHZF 重发，全程未调 Read → APPLIED
        数据库实测：该会话 EditAnchored 共 2 次，completed 那次 remove_from=2:PHZF
```

**一个会让人误判的坑（既有设计，不是本轮的缺陷）**：范围读（传了 `limit`）的读状态按设计不跨 resume 恢复（`isHistoricalFullReadWindow` 要求 `limit === undefined`）。模型有习惯性地给 Read 补上 `limit: 2000`，这样即使是 4 行的小文件也会被当成范围读，于是 resume 后连 Read 自己那份都不恢复，看不出 §7.1 修没修。验证这个场景必须让 Read 只传 `file_path`。

上一轮判定「本轮不做」的理由（在一个共享的错误/持久化层上落只做过单测的改动，正是 §6 的成因）仍然成立，所以这一轮把它单独拿出来做，并先补上面那条端到端验证。

### 阶段 2：实测后再决定主力地位

原计划是「用真实会话对比 `EditAnchored` 与 `Edit` 的首次成功率、失败后恢复轮次、输出 token、错行落盘次数，只有数据支持时才把锚点工具写进提示词作为首选」。

**用户已决定先切主备，不等数据**：目标就是以 `EditAnchored` 为主、`Edit` 为辅，然后用一段时间的真实使用数据再回来优化。所以本节从「待决策」变成「已实施」，而原来要测的那些指标改成**切换后的评估口径**。

#### 主备规则

| 场景                                        | 用哪个             | 依据                           |
| ------------------------------------------- | ------------------ | ------------------------------ |
| 已读过该文件（拿到过 `N:HASH│` 锚点）       | **`EditAnchored`** | 零复述、锚点免疫位移、批量原子 |
| 连续多步编辑同一文件                        | **`EditAnchored`** | 无需重读                       |
| 只 grep 到位置、目标行从未展示              | `Edit` 或先 `Read` | 锚点工具会硬拒                 |
| 新建文件 / 整文件重写                       | `Write`            | 无锚点可用                     |
| `.ipynb` / 二进制 / 非 UTF-8                | `Edit` 或 `Bash`   | 锚点依赖文本行                 |
| **`EditAnchored` 在同一文件上连续失败两次** | **降级到 `Edit`**  | 8 级模糊级联容错更宽，兜底     |

降级那条是关键：主备分层要有明确的降级触发条件，否则模型会在一个工具上反复试错。本轮先把它写进提示词（模型能自己数失败次数），不做运行时检测——先看真实使用里到底会不会反复撞，再决定要不要上机制。

#### 落地位置

- `context/sections/identity.ts` 的 `PERSONA`：把原来的 “Edit discipline” 那一条改成工具选择规则（原来只讲了先读后写与批量纪律，没有工具选择指导）。
- `handlers/edit-anchored.ts` 的 `EDIT_ANCHORED_PROVIDER_DESCRIPTION`：自称已读文件时的默认选择，不再把自己写成备选。
- `handlers/edit.ts` 的 `EDIT_PROVIDER_DESCRIPTION`：补一句「已读过的文件优先用 `EditAnchored`」。

不改注册表、不改 handler 逻辑、不移除 `Edit`（「明确不做」里有这条）。

#### 切换后的评估口径（下次看数据时用这个）

数据源已经就绪，不需要新增埋点：

- **使用分布**：`~/.zcode/cli/db/db.sqlite` 的 `part` 表，每个工具部件带 `tool` 与 `state.status`。
- **报错分布**：`~/.zcode/cli/log/zcode-<date>.jsonl` 的 `tool.call.failed` 事件，带 `context.toolName` 与 `error.context.code`。

切主备前这两个源就已经能用（实测当日：EditAnchored 20 次失败、Read 6、Edit 3、Write 2），**但原因分布分不出来**：EditAnchored 的 7 条失败路径全都填 `errorCode: 1`，原因只在消息文本里。所以本轮同时给每条路径一个稳定码（见下），这样用 `toolName + error.context.code` 就能直接分组，不必解析文本（也符合本仓「不依赖错误文本做流程判断」的规则）。

要看的四个指标：

1. `EditAnchored` 与 `Edit` 的调用比——验证「为主」是否真的发生。
2. `EditAnchored` 各原因码的占比——`unserved` 高说明模型没读就改（提示词没说清或读被截断）；`stale` 高说明外部改动频繁；`ambiguous` 高说明哈希碰撞在真实语料上超预期。
3. 同一文件上连续失败的次数——验证「两次降级」是否需要升级成运行时机制。
4. 每次编辑的往返轮次——主备切错时最直接的代价。

#### 失败原因码

数值只在 EditAnchored 命名空间内唯一（同 `task-output` 用 1/2、`resolve-workflow-question` 用 21-24 的惯例），跨工具不冲突，靠日志里的 `toolName` 区分。

| 原因                | 码  | 含义                               |
| ------------------- | --- | ---------------------------------- |
| `MALFORMED_ANCHOR`  | 1   | 锚点格式不合法（不是 `行号:哈希`） |
| `UNSERVED_ANCHOR`   | 2   | 锚点从未展示给模型                 |
| `STALE_ANCHOR`      | 3   | 锚点所指内容已变                   |
| `AMBIGUOUS_ANCHOR`  | 4   | 哈希在多处命中，拒绝猜             |
| `REVERSED_RANGE`    | 5   | `remove_to` 在 `remove_from` 之前  |
| `OVERLAPPING_EDITS` | 6   | 同一次调用里两条编辑区间重叠       |
| `NOTEBOOK_FILE`     | 7   | `.ipynb` 必须走 `Edit` 改 JSON     |

`AnchorFailureReason` → 码用 `Record<AnchorFailureReason, number>` 声明，新增 reason 时编译期就报错，逼着补码，不会默默落到默认值。

---

## 5. 主备分工规则（写进提示词）

| 场景                                   | 用哪个                 | 依据                           |
| -------------------------------------- | ---------------------- | ------------------------------ |
| 已读过文件、单文件多处修改             | **锚点工具**           | 零复述、锚点免疫位移、批量原子 |
| 连续多步编辑同一文件                   | **锚点工具**           | 无需重读                       |
| 新建文件 / 整文件重写                  | `Write`                | 无锚点可用                     |
| 目标行从未被展示（例如只 grep 到位置） | **`Edit`** 或先 `Read` | 锚点工具会硬拒绝               |
| 非 UTF-8 / 超大文件 / 二进制           | `Edit` 或 `Bash`       | 锚点依赖文本行                 |
| 锚点工具连续失败两次                   | **降级到 `Edit`**      | 8 级模糊级联容错更宽，兜底     |

这条"失败两次即降级"是关键：主/备分层要有**自动的降级触发条件**，否则模型会在一个工具上反复试错。

---

## 6. 风险与明确不做的事

**风险**

- **Read 契约变化会影响所有会话的既有上下文**：旧 transcript 里是 `N\t`，新会话是 `HASH│`。模型可能混用两种前缀 → 靠 `edit-matchers` 的前缀剥离 + 提示词说明消化，且锚点工具只认裸哈希（拒绝带前缀的输入并自动纠正）。
- **锚点稳定性依赖哈希确定性**：一旦哈希函数改动，旧会话的锚点全部失效。哈希函数必须冻结并写进 spec。
- **重复行消解规则要可解释**：`occurrenceIndex` 变化（文件被外部改动）会让哈希变化 → 这正是期望行为（陈旧即拒绝），但要在错误信息里说清。

**不做**

- 不替换 `Edit`：锚点工具是**新增**，`Edit` 的 8 级模糊级联是容错上限最高的资产，不能丢。
- 不引入 sloppy 的 `…` gap / `AFTER` / `PUT N*` 块操作：抬高模型技能门槛，收益是"少打字"而非正确性。
- 不做 Codex 的 freeform grammar：需要 constrained decoding，跨 provider 不可靠。
- 不新建锚点持久化层：搭 `read-file-state` 便车，避免第二个状态所有者（AGENTS.md：避免重复状态和多条写入路径）。

---

## 7. 待验证假设

1. **锚点 3 字符是否够用**：62³ = 238,328，单文件内碰撞概率随行数上升。需要实测大文件（>5k 行）下的碰撞率，必要时在文件内做确定性消解（而非换更长的哈希）。
2. **Read 输出格式变化的 token 影响**：`N\t`（2–5 字符）→ `ABC│`（4 字符）。理论上大文件略省、小文件略贵，需要真实会话数据确认是净收益还是打平。
3. **模型能否稳定使用两个编辑工具**：需要实测"该用哪个"的判断准确率；如果混用严重，阶段 2 就不提升主力地位，只保留一个。
4. **阶段 0 的批量编辑是否真的减少往返**：需要真实会话的编辑调用次数对比。

---

## 8. 评估依据

- token 数据：`dsh-better-edit` 的 `npm run benchmark`（本地复现，见 `specs/edit-tool-comparison.md` §3）+ 本文 §1.1 的 sloppy 补测（脚本按发布语法构造 payload，tokenizer 与基准一致）。
- 架构落点：`tool/types.ts`（`ReadFileStateEntry`）、`tool/executor/call-runner.ts`、`runtime/methods/tool-part-metadata.ts`、`handlers/read-text.ts`、`tool/edit-matchers.ts`、`contracts/src/tools/edit.ts`。
- 参考实现：`dsh-better-edit`（`src/hashline/*`、`src/read-and-serve.ts`）、`oh-my-pi`（`crates/pi-edit/prompts/{sloppy,hashline}.md`、`src/modes/sloppy/*`）。
