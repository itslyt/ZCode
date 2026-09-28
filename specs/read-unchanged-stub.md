# Read 未变更短路：删除不可满足的引用（C）

> 目标：消灭「Read 拒绝给内容、被指的结果又取不到」这一类结构性死路。
> 本文只写 Read 的未变更短路；压缩策略见 `context-compaction-optimization.md`，两者只有一条指针关系。

## 0. 问题

`core/src/tool/handlers/read.ts` 在缓存命中且文件未变时，不返回内容，而返回：

```
Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.
```

这条引用**在构造上可能无法满足**：被指的「earlier tool_result」可能已经不在本次请求的上下文里。
届时模型既拿不到内容（Read 拒绝返回），又指不到任何东西（目标不存在），只能绕道 Bash。

### 0.1 为什么是结构性缺陷，不是频率问题

短路判定发生在 **exec 期**（`read.ts:193-200`）：`isCachedReadFresh(cached, stat)` 用真实 `stat`
比对，命中即产出 `{ type: "file_unchanged", filePath }`。而「被指结果是否还在本次请求的窗口里」
取决于**未来那次请求**的窗口形态 —— exec 期不可能预知。所以不存在一个能判对的时机，
与命中率无关。这是选删掉、而不是选加条件的根本理由。

### 0.2 引用无法补救（已确认）

| 事实                                                                  | 出处                            |
| --------------------------------------------------------------------- | ------------------------------- |
| exec 期产出带类型结果 `{ type: "file_unchanged", filePath }`          | `read.ts:194`                   |
| exec 期被格式化成 stub 文本（`formatReadModelContent`）               | `result-serialization.ts:361`   |
| 库中已是拍平文本：含 `file_unchanged` 236 条、含 stub 文本 214 条     | `part.data` 实测                |
| 请求侧 tool 消息只有 `[role, content, toolCallId, toolName, isError]` | rollout `request.messages` 实测 |

结论：请求构建期拿到的是**已拍平的字符串**，读不到 metadata、也读不到 `file_unchanged` 类型。
因此「把 stub 条件改成『被指结果在本请求可见』」对历史消息无效 —— 类型信息在 exec 期就丢了。
若要让请求期能判断，必须改持久化格式或新增请求期查询路径；两者都比删掉这段行为更重。

### 0.3 实测（本机 rollout，按 `call_id` 去重）

| 会话            | stub 事件 | 可判决 | 目标正常 | 目标不在窗口（不可满足） | 指向已清结果 |
| --------------- | --------- | ------ | -------- | ------------------------ | ------------ |
| `sess_22501403` | 63        | 13     | 8        | 5                        | 0            |
| `sess_db308a67` | 21        | —      | —        | —                        | —            |

不可满足的成因是**请求窗口截断**（`messagesKind: tail/delta`，`messageOffset` 652/913），
不是 microcompact 清除 —— 悬空（指向 `[Old tool result content cleared]`）实测 0 次。

> 计数纪律：上两轮曾有 816 / 642 两个数字流出，均为**未去重**的原始出现次数，已作废。
> 同一 rollout 每个请求带全量历史，一次事件会在后续每个请求里重复出现；报数必须先按 `call_id` 去重。
> 同文件同口径的正确值：含 `windowHostControllerService.ts` 的 Bash 调用 原始 816 / 去重 36，
> 其中 `sed -n` 读范围 原始 84 / 去重 5。

## 1. 新发现：Bash 回填让短路陷阱自我维持

`bash-read-file-state.ts:157-160` 在 Bash 只读命令（`cat -n` / `sed -n` / `grep` 等）执行后，
把读到的内容以**与 Read 相同的 key 形式**写入 `readFileState`：

```ts
readFileState.set(
  createReadFileStateKey(resolvedPath, selected.offset ?? 1, selected.limit),
  entry,
);
```

只在该路径尚无 state 时回填（`bash-read-file-state.ts:118`）。于是：

1. autocompact 清空 `readFileState`（`compact-active.ts:625`）
2. 模型用 Bash `sed -n '676,760p'` 读某文件 → 回填一条「676 起 85 行」的 state
3. 模型随后对同一范围发起 `Read(file, 676, 85)` → 缓存命中 → **再次返回 stub**
4. stub 说的「your last Read」并不存在（那次读是 Bash 做的）→ 不可满足 → 又回 Bash

即：模型为绕开短路而走的 Bash 绕道，恰好把短路重新装填好。
这解释了实测里 `sed -n` 反复出现（本次会话 5 次去重）而 Read 始终拿不到内容。

**删掉 stub 后此循环自动消失**：不再存在「拒绝返回、让你去看别处」的分支，
缓存命中路径不再产生任何指向上下文的引用。

## 2. 修法：删除未变更短路（方案 i）

1. **C（本 spec）**：删除 `read.ts:193-200` 的短路分支，与未命中缓存走同一条路（正常范围读）。
   让它与「缓存未命中」走同一条路：正常读取并返回内容。

- 删掉的是「重读抑制器」这一整个分支，符合 `AGENTS.md`「不不断增加兜底分支」
- token 代价接近中性：命中时省下的内容字节，在误伤时由 Bash 绕道又花一遍，还丢掉行锚点
  （`sed -n` 读到的字节没有 `N:HASH│` 锚点，`EditAnchored` 用不了，必然多一轮）
- 依据是结构性的三条，不是账：① exec 期无法预知窗口（§0.1）② 不复存在「被逼绕道」
  ③ 删分支
- 判据不用字节量，而用**因缺锚点多花的往返次数** —— 那才是真实代价函数

### 2.1 实现约束（已核实，避免误作“零成本”）

- `readTextFileForModel`（`read-text.ts:43`）每次都调 `fileSystemPort.readTextFileRange`，
  **没有内容缓存层**。所以删分支后是一次正常的范围读，不是“从 `readFileState` 直接取 content”。
- `ReadFileStateEntry`（`types.ts:206-225`）只存 `path/content/offset/limit/isPartialView/
revisionId/mtimeMs/sizeBytes/servedAnchors`，**没有** `totalLines`/`startLine`/`numLines`，
  不足以重建 `ReadTextOutput`。因此**不要**试图用缓存内容拼输出 —— 那会缺字段（如
  `Showing a partial view of lines X-Y of Z` 的 Z）。
- `isCachedReadFresh`（`read.ts:338`）在删分支后若无其他调用点，一并移除；
  它的写前校验用途由 `edit`/`write` 自己的 freshness 校验承担（同名策略，非同一函数）。

## 3. 不做（写下来防止后人顺手加回）

- **不做**：在 microcompact 清除结果时失效 `readFileState`。
  缓存说「文件未变」是**对的**（`read.ts:193` 用真实 `stat` 比对过），错的是 stub 引用了取不到的结果。
  删掉 stub 后此问题不存在，无需失效逻辑。而加上失效会让下一次读丢掉一个**仍然有效**的缓存、
  重新打磁盘 —— 正是方案 i 已经用更便宜的方式（直接返回缓存内容）达到的效果，属于同一结果叠第二个机制。
- **不做**：把 `file_unchanged` 作为类型持久化、把 stub 决策挪到请求构建期（方案 ii）。
  牵着持久化格式与 resume，且与 `read-file-state-metadata.ts` 的既有形态冲突。
  仅当方案 i 被实测证伪时才重新考虑。
- **不做**：保留 stub 但在文本里塞引用 + 请求期按 `toolCallId` 回查 part 存储。
  请求侧拿不到 metadata（§0.2），回查等于新增请求期 I/O 路径；且它本质是方案 ii 换了层皮。

## 4. 边界

- 只有 Read 有这类短路：全仓 `Wasted call` / `refer to ... earlier tool_result` 仅出现在 `read.ts`。
- Bash 读内容的绕道**是这条短路逼出来的**，不是「模型不听话」；
  而 Bash `grep` 搜索仍属不听话（`Grep` 工具正常、无短路）。两者必须分开评价。

## 5. 验收场景

1. 缓存命中且文件未变时，`Read` 返回**内容**，响应中不含 `Wasted call` 文本。
2. 同一 `(file, offset, limit)` 连续读两次，第二次仍返回可用的内容与锚点，可直接用于 `EditAnchored`。
3. Bash 只读命令回填 `readFileState` 后，随后的同范围 `Read` 返回内容而非 stub。
4. microcompact 清除某次 Read 结果后，对该文件的再次 `Read` 返回内容（不出现不可满足引用）。
5. 请求窗口截断掉更早的 Read 结果时，后续同范围 `Read` 仍返回内容。
6. 既有 `read-file-state` / microcompact / 配对不变量测试保持全绿（配对不变量：
   清结果内容时保留 tool call 入参）。

## 6. 后续步骤的实测结论（全部否证，不做）

本节直接记录对后续四步的量化结果。**结论是四步都不做** —— 原方案是在缺数据时拍定的，量完之后方向都不成立。

### 6.1 重复读检测（不做）

```
sess_22501403 去重后：Read 共 159 次，唯一 (file,offset,limit) 141 组
  同范围重复: 18 次 = 11%
  windowHostControllerService.ts: 读 81 次，唯一范围 72 组，同范围重复 6 次
```

真实形态是「逐段扫描同一文件」（offset 1→200→472→676→700→505），**不是「同一段读三遍」**。
同范围检测只覆盖 11%，且 C 已删后连触发点都不存在。不做。

### 6.2 `A`（Bash 移出可压缩列表）—— 不做，且方向相反

各类工具结果被清空的比例（去重后）：

| 工具         | 总数 | 已清 | 比例 |
| ------------ | ---- | ---- | ---- |
| Bash         | 342  | 334  | 97%  |
| Read         | 80   | 0    | 0%   |
| Grep         | 14   | 0    | 0%   |
| EditAnchored | 11   | 0    | 0%   |

microcompact 当下主要在清 **Bash 输出**（一次性、体积大、不可确定性重取 —— 正是最该清的），
而 Read/Grep 一次都没被清。把 Bash 移出列表会让这 334 次清空全部失效、原始输出永久堆积。
原假设「清 Bash 逼模型重跑」与实测相反。**不做**，并撤销 §7 里「C 修好前不要动 A」这条
预防性约束 —— 它防的方向根本不存在。

### 6.3 eviction 摘要（不做，前提未出现）

本会话 240 个请求的 `messagesKind` 只有 `tail` / `delta`，**全程没有一次全量 compact**；
34 次「offset 回退」均为窗口滑动（如 724→665），非压缩。要解决的问题未出现。

### 6.4 台账（导航记忆）—— 不做；且我先前给的 87% 作废

> **数据更正**：我曾报「87% 的读是范围已被覆盖」，属**口径错误**。
> 那个数拿「会话历史里的全部读」做基准，而早期结果早已滑出请求窗口、模型当时看不到。

按「同一快照内可见的读」重算：

```
含 Read 的快照 240 个，快照内 Read 累计 1844
同快照内「范围已被同快照内更早的读覆盖」: 273 = 14%
该文件总共被读 81 次，但任一时刻窗口内最多只看到 14 次（中位 6）
```

即：**大量重读源于窗口挤出，不是缺台账**。模型看不到已被挤出的内容，重读是必要的；
加台账不能阻止这类重读（台账本身也会被挤出），反而多一份状态。真正的冗余只有 14%。

### 6.5 净结果

本轮只做 C 一件事。其余四步全部由实测否证，理由留在本节，避免以后有人按旧方案重做。

## 7. 与压缩 spec 的关系

`context-compaction-optimization.md` §9 只留指针，不写因果：
本次实测悬空 0 次，压缩交互**没有**证据；C 的成因是请求窗口截断。

§6 已撤销原先「C 修好前不要动 `A`」的约束（见 §6.2 实测）。
