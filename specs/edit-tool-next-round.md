# 编辑工具下一轮：改什么、怎么评测（交接文档）

> 接手方式：先读本文，再读 `specs/edit-tool-usage-report.md`（本轮实测数据与结论）、`specs/edit-tool-roadmap.md`（编辑工具的总设计与阶段记录）。通用开发流程（改码/检查/提交/打包/真机验证）见 `CUSTOM_DEV_WORKFLOW.md`，本文不重复。
>
> 本文的每一条结论都附了数据出处或代码位置，**不要凭印象改**。凡标「未验证」的都还没证实。

## 1. 已经做完的，不要再做

| 事项                                           | 提交                 | 状态                                 |
| ---------------------------------------------- | -------------------- | ------------------------------------ |
| `EditAnchored` 上线、锚点机制、读后写门禁      | `c40152c` 等         | 已完成                               |
| 主备切到 EditAnchored（提示词 + 两段工具描述） | `3564dc1`            | 已完成，实测生效（占比 23%→72%→96%） |
| 每条失败路径一个稳定原因码                     | `3564dc1`            | 已完成，实测日志里已出现 code=2/4    |
| 恢复 Glob/Grep（关掉 embedded search branch）  | `8824bc8`            | 已完成，**效果未验证**（见 §6）      |
| 去掉计划模式工具与 WebSearch                   | `cdaffe1`            | 已完成                               |
| 使用情况分析（全局 + 单会话）                  | `e648cd8`、`40ed216` | 已完成                               |

**不要再提的建议**：把「连续失败两次降级到 Edit」从提示词升级为运行时约束。我在 `specs/edit-tool-usage-report.md` §结论里提过，**现已撤回**：连续失败 ≥2 次的片段全局只有 12 个、在干净的会话（`sess_9311a7f8`，27 次编辑）里是 **0** 个。为一个罕见情形引入跨调用的文件级状态是过度设计。

## 2. 评测工具（先跑这个再动手）

我写了一个可复用的分析脚本，已实测：

```bash
node scripts/analyze-edit-tools.mjs                    # 全局
node scripts/analyze-edit-tools.mjs sess_9311a7f8-...  # 单个会话
```

它输出 5 段：调用比（按天）、失败率、失败原因（按码 + 按消息交叉校验 + 按天）、连续失败与降级遵守率、malformed 样本里裸哈希的占比。

### 数据源与字段（改脚本前必读）

- `~/.zcode/cli/db/db.sqlite` 的 `part` 表，每个工具调用一个部件：
  - `json_extract(data,'$.type') = 'tool'`
  - `json_extract(data,'$.tool')` 工具名
  - `json_extract(data,'$.state.status')` → `completed` / `error`
  - `json_extract(data,'$.state.input')` 调用参数（含 `file_path`）
  - 列：`session_id`、`time_created`（毫秒整数，**不是字符串**）
- `~/.zcode/cli/log/zcode-<日期>.jsonl`，`event == 'tool.call.failed'`：
  - 顶层 `sessionId`、`context.toolName`
  - `error.context.code` = handler 返回的 `errorCode`（按工具命名空间）
  - `error.context.toolHandlerFailure.message` = 人读的原因

### 三条口径纪律

1. **统计原因用 `error.context.code`**，消息文本只用于交叉校验（本仓禁止依赖错误文本做流程判断）。
2. **跨版本必须按天分段**：原因码是 `3564dc1` 之后才有的，之前所有 `EditAnchored` 失败都是 `code=1`，原因不可分。拿旧数据算「malformed 占 67%」就是错的——我犯过这个错。
3. **日志有保留期**：`sess_9311a7f8` 的失败事件在我分析时是 6 条，稍后重跑只剩 2 条（旧日志被清理）。**要做单会话分析就趁早**。

### 本轮基线（用于对比改动效果）

```
EditAnchored   105 成功 / 38 失败 = 26.6%
Edit           251 成功 / 22 失败 =  8.1%
原因分布：unserved 36% / stale 28% / malformed 14% / ambiguous 8% / overlap 8%
调用比：09-22 的 23% → 09-23 的 72% → 09-27 的 86%（单会话 96%）
降级遵守率（仅看有下一次编辑的连失片段）：57%
```

**该盯的指标不是失败率，而是「失败是否引发连续失败」**：`sess_9311a7f8` 的 15.8% 失败全部在下一步自愈，连失 0 次，净成本 3 次多余调用 / 191 = 1.6%。调用级失败率 ≠ 任务受阻率。

## 3. P0：裸哈希自愈（建议先做这一条）

### 问题

模型给出的锚点经常**只有哈希、没有行号**：`"H669"`、`"44B6"`、`"KKXE"`，以及 `sess_9311a7f8` 里一次**整批 13 个锚点全部缺行号**。

而在这两处证据里，**哈希本身都是对的**：

- 13 个锚点的批次，12 秒后补上行号（`31:H669`、`43:252V`…）用**同一批哈希**一次成功；
- 拒绝消息说 `malformed`，但哈希是准的。

**行号是冗余信息**：哈希唯一时，行号可以由哈希推出。现在却因为缺行号整批拒绝。

### 现状代码

- `apps/zcode-cli/packages/core/src/tool/anchor-hash.ts:86` `parseAnchor(raw)`：找不到 `:` 就返回 `null`（所以裸哈希根本不进入解析流程）。
- `apps/zcode-cli/packages/core/src/tool/anchor-resolve.ts:139` 与 `:150`：`parseAnchor` 返回 `null` → `reason: "malformed_anchor"`，**整批拒绝**。
- 同一函数在 `:133` 已经算好 `lineHashes = computeLineHashes(lines)`——即整文件的「行 → 哈希」表**就在手边**。

### 目标行为

锚点允许两种形态：

1. `N:HASH`（现状，行为不变）
2. **裸哈希 `HASH`**：在 `lineHashes` 里查。
   - 唯一命中 → 解析成那一行，正常继续（等价于用户写了 `N:HASH`）。
   - 多行命中 → `ambiguous`（不是 malformed）。
   - 零命中 → `unserved`（不是 malformed；格式合法，只是文件里没有这个哈希）。

真正畸形的输入（`"abc"`、`"not-an-anchor"`、空串）仍返回 `malformed_anchor`。

### 验收场景（要写成测试）

1. 裸哈希在文件内唯一 → 编辑成功，且**效果与 `N:HASH` 完全一致**。
2. 裸哈希多行命中 → `ambiguous`，消息里给出行候选（与现有 ambiguous 行为一致）。
3. 裸哈希零命中 → `unserved`，消息提示补读该区域。
4. `"abc"` / `"not-an-anchor"` / `""` → 仍 `malformed_anchor`。
5. `N:HASH` 的所有既有路径**行为不变**（现有 26 个 `anchor-resolve` 测试必须全绿，不许改期望值来迁就）。
6. 批量场景：13 个裸哈希一次提交 → 全部解析（对应真实观察到的那个批次）。

### 注意

- **不要**放宽成「裸哈希随便匹配」：多命中必须仍然拒绝，否则会把「改错行」变成静默错误。
- 解析出的行是否算「已 served」要按现有服务的语义走（`servedAnchors` / `formatAnchorRegion` / `buildUpdatedAnchors` 三处是既有机制，别新加一层）。
- `apps/zcode-cli` 单文件 ≤ 400 行；`anchor-resolve.ts` 现在 **431 行**（已超限），**加逻辑前先拆模块**，不要继续堆。

## 4. P1：工具定义的英文散文（收益更确定，工作量更大）

### 数据

从真实请求体量出（`~/.zcode/cli/rollout/model-io-sess_*.jsonl`，注意只有 App 会话才落盘）：

```
16 个工具 / 30 928 字符 / 7 742 tokens（按 core/context/utils.ts 的 estimateTokens，与界面同源）
  描述 4 552 (59%) + schema 2 833 (37%)，其中 schema 里还有 1 450 是参数 .describe() 散文
  → 散文合计 6 002 = 78%，真正的结构只占 ~18%
```

最重的两笔（`cdaffe1` 之后剩下的）：

| 工具              | tokens | 其中描述 | schema                     |
| ----------------- | ------ | -------- | -------------------------- |
| `AskUserQuestion` | 1 229  | 447      | 756（其中 482 是参数散文） |
| `Agent`           | 711    | 547      | 142                        |

对照 DSH（同一个模型跑的另一套 harness）：DSH 是一句话描述（`"Read a UTF-8 text file and return line-numbered content."`），全部工具包描述合计约 3 242 tokens；本 fork 仅 16 个活跃工具就 4 552。**差距在散文，不在工具数或 schema 结构。**

### 为什么值得做

工具定义是**每一次请求的固定成本**，而编辑工具的失败只是偶发的几次往返。`cdaffe1` 已经砍掉 28.5%（同口径 4 784 → 3 426 tokens），下一个 1.5~2K 就在 `AskUserQuestion` + `Agent`。

### 怎么做

压缩这两段描述与参数 `.describe()`，**保留所有会改变模型行为的约束**（例如 `AskUserQuestion` 的「最多 4 个问题」「可多选」）。不要为了省 token 删掉边界条件。

### 验收

1. 工具名集合不变、schema 的必填/可选字段不变（只动文案）。
2. 用同一把尺子量：`estimateTokens` 对 `{name, description, parameters}`，改动前后对比。
3. 真机确认工具仍能被正常调用（`AskUserQuestion`、`Agent` 各跑一次）。

## 5. P2：`unserved` 提示词一句话（小）

`unserved` 是最大的桶（36%），但**定性已完成**：`sess_9311a7f8` 里模型对没读过的第 240 行给出 `240:41Q0`，而**正确哈希是 `FJNV`**——行号对、哈希是编的；补读 `offset=240 limit=10` 后一次改对。所以：

- **不是** Read 截断，**不是**服务端没 serve，**是模型侧行为**；
- 工具正确挡住了，一次往返自愈。

可做的是在 `EditAnchored` 描述或 `PERSONA` 里加一句「锚点必须来自你实际读过的区域」——**只省往返，不救错误**，值一句话，不值机制。

## 6. 待解释的观察（先看清楚再决定）

1. **`stale` 10 条全部集中在 09-23，之后归零。** 至今没有解释。是自愈（整文件唯一哈希回退）起作用，还是那两天改的文件类型不同（09-24 后多在改 Java 业务代码，改动更集中）？没弄清前不要动 `stale` 相关逻辑。
2. **Glob/Grep 恢复后 Bash 占比该下降。** `sess_9311a7f8` 里 Bash 125 次 vs Grep 1 次——搜索**确实**在走 Bash，这是我恢复 Glob/Grep 的直接理由。但**效果还没验证**：装了含 `8824bc8` 的版本后，重新统计一个会话的 Bash / Grep / Glob 次数，Bash 占比下降才说明那个改动有价值。
3. **`sess_9311a7f8` 里有一次空参数调用**（`state.input = {}`，报 `Tool input failed inputSchema validation`）。这是 inputSchema 校验失败，不是锚点问题，未深究。

## 7. 做改动时的通用注意

- 一个需求一个提交，写完就提，不必先问（`CUSTOM_DEV_WORKFLOW.md` §2 第 7 步）。
- `apps/zcode-cli` 要**逐包** typecheck，根目录 `pnpm typecheck` 不覆盖它（`CUSTOM_DEV_WORKFLOW.md` §3.1）。
- 核心测试：`pnpm --dir apps/zcode-cli/packages/core test`（当前 **90 例全绿**；数字随开发变动，以实跑为准）。
- 打包：`ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 pnpm bundle:desktop`，**不需要退出 Preview**（运行中打包已验证可行，产物在 `packages/desktop/dist/ZCode Preview-<版本>-mac-arm64.dmg`）。装完之后要在**新开的**会话里验证——正在运行的那个窗口仍是旧版。
- 提示词与工具描述的效果**无法用单测证明**，只能靠 §2 的脚本看真实分布。改动前先记下基线，改完用同一脚本对比。
