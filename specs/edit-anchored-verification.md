# EditAnchored 真机验证报告

对 `c40152c`（新增 EditAnchored）+ `b8d4d12`（锚点前缀剥离修复）两个提交的验收。方法是在真实
harness 里直接调用 `EditAnchored` 工具（不是只跑单测），再对可疑点回到函数层用
`node --import tsx` 做确定性复现。

结论：**核心机制正确，初验有 5 个缺陷**，其中 2 个会直接破坏 §2.1/§2.2 承诺的设计语义。

**2026-09-23 更新**：初验 5 个缺陷已由 `f9730f8` 修复；复验时发现该修复引入了一个新的门禁绕过（§6），
`f66798b` 修复。第二轮复验又查出 3 项（§7）：`a068243` 修了 §7.2，§7.3 确认不可达并保留，
§7.1 判定待决策。第三轮（`e751ad2`）清掉两条遗留（§7.5）。第四轮（`f624f05`）修了 §7.1，
并在复验方指出后纠正了「其它工具的 error 部件天然被跳过」这个错误论断（§7.6）。

**验收结论：通过。** 全部缺陷已闭环，无遗留。

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| §1–§5 | 初验 5 项 | 已修复，复验通过 |
| §6 | 修复引入的读门禁绕过 | 已修复，复验通过 |
| §7.2 | 空内容渲染假行 / 空行哈希 | 已修复，复验通过 |
| §7.3 | 不可达分支 | 确认不可达，保留 + 注释 |
| §7.1 | 拒绝路径的 served 不跨 resume | 已修复（`f624f05`），端到端复验通过 |
| §7.5 | 重复用例 + 临时脚本 | 已清 |
| §7.6 | 「天然被跳过」论断错误 | 已纠正（措辞 + 测试钉住） |

修复轮次：`f9730f8`（§1–§5）→ `f66798b`（§6）→ `a068243`（§7.2/§7.3）→ `e751ad2`（§7.5）
→ `f624f05`（§7.1/§7.6）。每轮都在目标 HEAD 上重新复验，不是沿用上一轮结论。

**遗留（非缺陷，低优先）**：`anchor-resolve.ts` 的 `new Array(edits.length)` 触发
`unicorn(no-new-array)`，`f9730f8` 引入、到 `f624f05` 仍在；被根 `ignorePatterns` 遮住。
另：`servedAnchors` 只增不减、无上限（见 §9 未验证项）。

本文只描述现象、复现与根因，不给实现方案——hashline 的修法由你判断。

---

## 0.5 修复验证（四轮，HEAD `f624f05`）

复验方式与初验一致：真机调用 `EditAnchored` + handler 层假 port 复现，不是只跑单测。
每一项都在目标 HEAD 上重新跑过（不是沿用上一轮的结论）。

| 缺陷 | 状态 | 复验证据（HEAD 实测） |
| --- | --- | --- |
| §1 served 灌全文 | **已修复** | 读 1–5 行 → 改第 3 行 → 改第 100 行 → 拒绝 `references anchor 100:2CAP, which was never shown to you` |
| §2 reject-and-serve 死循环 | **已修复** | stale 拒绝后照抄错误信息里的 `2:4XNY` 重发 → **成功**，文件落回 `const change = 2;` |
| §3a `end` 被丢弃 | **已修复** | 1 行换 5 行 → 回传含 `const r5 = 5;` |
| §3b 索引空间错位 | **已修复** | `changedRanges` 回报 `[{0,2},{6,6}]`（新内容空间），回传含 `A5x` |
| §3c 区块被 `continue` 丢弃 | **已修复** | 两条编辑 → 回传含第 7 行 `const e = 500;` |
| §4 resume 不恢复 | **已修复** | hydrator `restoredCount: 2`（原为 1），`b.ts` 恢复，`sourceTool: EditAnchored` |
| §5 UI 身份 | **已修复** | identity `family: "file-write"`，`isFileDiffToolCall: true`，summaries 1 条带 patch |
| §6 读门禁绕过 | **已修复** | 见下 |

### §6 复验（`f66798b`）

复现脚本与 §6 正文一致（partial view + 外部改动触发 stale），HEAD 实测：

```
前置: isPartialView = true | content 行数 = 30
A) partial view 下 Edit 第 100 行（应被拒）      -> REJECTED
B) 外部改动第 3 行 → EditAnchored stale 拒绝   -> REJECTED
   拒绝后 isPartialView = true | content 行数 = 30 | servedAnchors = 31
C) 再用 Edit 第 100 行                          -> REJECTED   （修复前 APPLIED）
D) 再用 Write 覆盖全文                          -> THREW: write_file_not_read
```

成功路径两个方向都对（这是修复里我最担心会矫枉过正的地方）：

```
场景 A：partial view（30/120 行）下成功的锚点编辑
  A1) 编辑第 3 行（已 served）           -> APPLIED
  编辑后 gate: isPartialView = true      ← 未被放宽
  A2) 再用 Edit 第 100 行                -> REJECTED
场景 B：整文件读过后编辑（防过度保守）
  B1) 编辑第 3 行                        -> APPLIED
  编辑后 gate: isPartialView = false     ← 未被降级
  B2) 再用 Edit 第 100 行                -> APPLIED
```

「拒绝路径不刷新 `readAt`」这条我也确认了：门禁按同路径 `readAt` 最新的条目选基准
（`read-file-state.ts:49` `findLatestReadFileStateByPath(..., () => true)`），拒绝路径改用
`mergeServedAnchorsAfterRejection` 后只改 `servedAnchors` 字段，不新建条目、不动 `readAt`。

`unserved` 拒绝仍然不会授予整文件已读——这条防线在两轮修复后都保持有效。

### 检查结果（HEAD `ca01c3f`）

- core 测试 `node --import tsx --test test/*.test.ts` → **47/47 通过**（`anchor-resolve` 25 +
  `edit-batch` 12 + `edit-anchored-read-gate` 4 + `anchor-strip` 3 + `read-file-state-hydrator` 3）。
  新增的 `edit-anchored-read-gate.test.ts` 确实断言了 `isPartialView`（此前 43 个用例一个都没断言过），
  且用门禁实际选择器 `findLatestReadFileState` 取值——盯的正是 §6 那个盲区。
- UI 测试 `toolIdentityEditAnchored.test.ts` 4 例。
- `pnpm typecheck` 通过；`pnpm lint` 0 error / 74 warning（全为既有）。
- 上一轮我报的 lint 告警仍在：`anchor-resolve.ts:240` 的 `new Array(edits.length)` 触发
  `unicorn(no-new-array)`。`f66798b` 没有动它。包内 `npx oxlint src --no-ignore` 可见，
  根 `pnpm lint` 因 `ignorePatterns` 含 `apps/zcode-cli` 看不到。

一处与提交说明的出入（上一轮已提，仍成立）：commit message 说"测试从 31 例补到 47 例"，core 实际
43 例 + UI 4 例 = 47。数字对得上，只是分布与字面读法不同。`specs/edit-tool-roadmap.md` 里
「回归防线：core（43 例）」是准确的。

---

## 0. 环境与基线（初验轮，`b8d4d12`）

下表是**初验**的基线，保留以便对照。后续各轮的测试数变化在 §0.5 与各节末尾。

| 项 | 值 |
| --- | --- |
| 验证提交 | `b8d4d12`（当时的 HEAD） |
| 工作区 | 干净，仅 `.zcodeignore` 未跟踪（与本次无关，未改动） |
| 测试临时文件 | 全部落在 `.tmp/hashline-check/`，验证后已删除 |
| 单测 | `node --import tsx --test test/*.test.ts` → **31/31 通过** |
| 类型检查 | `pnpm typecheck` → **通过** |
| Lint | `pnpm lint` → 0 error / 74 warning（全为既有） |

关于 lint 的一个补充：根 `.oxlintrc.json` 的 `ignorePatterns` 含 `apps/zcode-cli`，所以根
`pnpm lint` **不覆盖**本次改动的代码。包内 `npx oxlint src --no-ignore` 有 30 个 `max-lines`
error，其中 `src/tool/edit-matchers.ts`(415) 与 `src/tool/handlers/read.ts`(474) 在改动前
（`7202ddc`）就已超限——我把旧版本 checkout 到临时目录复验过，初验未引入新的 lint 错误。

后续轮次新增的 lint 项：`f9730f8` 引入 `anchor-resolve.ts` 的 `new Array(edits.length)`
触发 `unicorn(no-new-array)`（1 个 warning），到 `e751ad2` 仍在。同样被根 `ignorePatterns` 遮住。

---

## 1. 【严重】served 集合被整文件灌入，"只允许改看过的行"约束在首次编辑后失效

### 现象

只读过文件开头若干行，改其中一行之后，**文件任意位置都能改**，`unserved` 拒绝不再触发。

### 复现（函数层，确定性）

```bash
cd apps/zcode-cli/packages/core
```

```ts
// 复刻 handler 的写入：servedAnchors 传的是整个新文件的逐行哈希
const newContent = /* 任意长文件 */;
computeLineHashes(newContent.split("\n"));   // ← 全文，不是改动区域
```

真机观察（同一 harness 内连续调用）：

1. 造 120 行文件 `.tmp/hashline-check/partial.ts`（`const item001 = 1;` … `const item120 = 120;`）。
2. `Read` **只读第 1–5 行**。
3. `EditAnchored` 改第 3 行（锚点 `3:JYEW`）→ 成功。
4. `EditAnchored` 改第 100 行（锚点 `100:2CAP`，该行从未展示过）→ **成功**。

对照实验（60 行文件 `serveguard.ts`）：读第 1–5 行 → 改第 3 行 → 改第 50 行 → **成功**。

对照 `Read` 的正确写法，它传的是 `input.output.content`（只含实际展示的行）：

```ts
// src/tool/handlers/read.ts:383
servedAnchors: mergeServedAnchors(
  state.get(key)?.servedAnchors,
  computeLineHashes(input.output.content.split(/\r?\n/)),
),
```

### 根因

```ts
// src/tool/handlers/edit-anchored.ts:172-178
const entry = updateReadFileStateAfterAnchoredEdit({
  readFileState: context.readFileState,
  filePath,
  content: newContent,
  revision: writeResult.revision,
  servedAnchors: computeLineHashes(newContent.split("\n")),   // ← 第 177 行
});
```

注释写的是「编辑结果里回传了新锚点，模型看过了，所以并进 served」，意图是只并
`updatedAnchors` 实际渲染的那几行；但传进去的是 `newContent` 的**全部**行哈希。文件里任何一行
只要在这一次编辑后存在，就永久进入 served 集合。

注意这与 `Edit` 的处理方式不同——`Edit` 是刻意不并的：

```ts
// src/tool/handlers/edit.ts:732
servedAnchors: mergeServedAnchors(previous?.servedAnchors, []),   // 只保留旧的
```

### 影响

`unserved` 是锚点编辑的硬约束（`anchor-served.ts` 开头写明「只允许改模型看过的行」）。第一次
编辑之后该约束对那个文件形同虚设：模型可以对一个只读了 5 行的 3000 行文件做任意位置替换，而
内容哈希见证只能保证"那一行还是老样子"，无法保证"那一行模型见过"。这直接削弱了 hashline 相对
replace 的安全论据。

### 单测为何没拦住

`test/anchor-resolve.test.ts` 里的 `servedOf(content)` 就是拿全文当 served：

```ts
function servedOf(content: string): Set<string> {
  return new Set(computeLineHashes(splitLines(content)));   // 结构上不可能发现本缺陷
}
```

该辅助函数把"served = 全文"当成了前提，所以整组测试对这个缺陷是盲的。

---

## 2. 【严重】reject-and-serve 回传的锚点没进 served，模型照抄必然二次失败

### 现象

`stale` 拒绝时会回传「Current anchors (lines X-Y)」，但模型拿这些锚点重发，会被判
`unserved`。**reject-and-serve 省掉的往返又回来了**，且比不做 reject-and-serve 更糟——模型先
被明确告知了新锚点，再被拒绝说"没给你看过"。

### 复现（真机，连续两次调用）

1. 造 `.tmp/hashline-check/stale.ts`：

```ts
const keep = 1;
const change = 2;
const tail = 3;
```

2. `Read` 全文 → 拿到 `2:DEJQ`。
3. 在 harness 外把文件改成 `const change = 999;`（模拟外部改动）。
4. `EditAnchored` 用 `2:DEJQ` 改回 → 预期失败，实际失败并回传：

```
Edit 1 of 1 anchor 2:DEJQ no longer exists in the file — the content it pointed at changed.
No edits were applied.
Current anchors (lines 1-4):
1:92YW│const keep = 1;
2:4XNY│const change = 999;      ← 服务端主动给出的新锚点
3:PJ61│const tail = 3;
4:RVM2│
```

5. 立刻用错误信息里给出的 `2:4XNY` 重发 → **再次失败**：

```
Edit 1 of 1 references anchor 2:4XNY, which was never shown to you for this file.
Read the region first, then copy the anchor from that Read result.
No edits were applied.
```

### 根因

失败路径在 `src/tool/handlers/edit-anchored.ts:136-149` 提前返回，**从不走到**第 172 行的
`updateReadFileStateAfterAnchoredEdit`，因此既不更新 served，也不调用
`recordReadFileStateMetadata`：

```ts
// src/tool/handlers/edit-anchored.ts:136-140
if (resolved.status === "failed") {
  return editAnchoredFailure(
    createAnchorFailureMessage({ content, failure: resolved, total: requests.length }),
  );
}
```

而 `createAnchorFailureMessage` 在 `stale` 分支里渲染的区域锚点，只是文本：

```ts
// src/tool/anchor-resolve.ts:333-338
case "stale":
  return [
    `${position} anchor ${failure.anchor} no longer exists in the file — the content it pointed at changed.`,
    "No edits were applied.",
    formatAnchorRegion(content, hintLine),   // ← 渲染了锚点，但没人把哈希并进 served
  ].join("\n");
```

`formatAnchorRegion`（`anchor-resolve.ts:241`）与 `buildUpdatedAnchors`（`anchor-resolve.ts:264`）
都只返回字符串，没有把哈希回传出来给 served 集合用。

### 影响

`specs/edit-tool-roadmap.md` §2.1 第 4 步与 §2.2「拒绝要给好错误信息」把 reject-and-serve 当作
核心设计卖点（"模型不必重新定位"/"省掉一次重读"）。当前实现下这条路径是死循环：模型要么改用
`Read` 重读（那 reject-and-serve 就没意义了），要么反复撞 `unserved`。同样是"只写不读"的路径，
`Read` 会更新 served 而拒绝路径不会。

---

## 3. 【中】`updatedAnchors` 区间错误，且多编辑时会整块丢失

三个独立的子问题叠在一起。

### 3a. `end` 被丢弃，回传区域比实际改动短

```ts
// src/tool/handlers/edit-anchored.ts:167-170
const updatedAnchors = buildUpdatedAnchors(
  newContent,
  resolved.edits.map((edit) => ({ start: edit.start, end: edit.start })),   // ← end = start
);
```

`end` 一律等于 `start`，被替换的真实区间长度丢失。

真机复现（`.tmp/hashline-check/grow.ts`，`const a = 1; / const b = 2; / const c = 3;`）：

- 用 `2:NMZP` 把第 2 行一行换成 5 行（`const r1 = 1;` … `const r5 = 5;`）。
- 回传区域只有 4 行，**`const r5 = 5;` 缺失**：

```
Current anchors for the changed region:
1:59W6│const a = 1;
2:X1XH│const r1 = 1;
3:D1N6│const r2 = 2;
4:X79B│const r3 = 3;
5:D73A│const r4 = 4;      ← 只到 r4，r5 没回传
```

与工具描述「The result returns fresh anchors for the changed region」不符。

### 3b. 区间用的是原始内容索引，却作用在新内容上

`resolved.edits[].start/end` 是**原始内容**的行索引（`resolveAnchorEdits` 基于 `content` 解析），
但 `buildUpdatedAnchors` 的第一个参数是 `newContent`。当靠前的编辑改变了行数时，后续编辑的索引
在新内容里已经指向别处。

确定性复现：

```ts
// 原始: A1..A5；edit1 把 A1 换成 3 行（净 +2），edit2 改原 A5
const newContent = ["A1a","A1b","A1c","A2","A3","A4","A5x"].join("\n");

// 原始索引 [4] 在新内容里是第 5 行 A3 —— 不是被编辑的 A5x
buildUpdatedAnchors(newContent, [{ start: 0, end: 0 }, { start: 4, end: 4 }]);
// 实际编辑的行是 index 6 (A5x)，却报告了 index 4 附近
```

### 3c. `covered.has(from)` 会把后一个区块整块 `continue` 掉

```ts
// src/tool/anchor-resolve.ts:275-279
for (const range of changedRanges) {
  const from = Math.max(1, range.start + 1 - contextLines);
  const to = Math.min(lines.length, range.end + 1 + contextLines);
  if (covered.has(from)) continue;              // ← 只看起始行是否被覆盖
  for (let line = from; line <= to; line += 1) covered.add(line);
```

判据只比较 `from`（区块起点），不比较区块是否被完全包含。当后一个区块的起点落在前一个区块的
上下文窗口内、但窗口尾部超出前一个窗口时，后一个区块被整个丢弃。

真机复现（`.tmp/hashline-check/batch.ts`，5 行文件 `const a = 1;` … `const e = 5;`）：

- 一条调用里两条编辑：`1:59W6` 一行换三行；`5:5K16` 改成 `const e = 500;`。
- 两条都真实生效（文件里 `const e = 500;` 在），但回传**只有一个区块**，第二条编辑所在行完全
  没出现：

```
Current anchors for the changed region:
1:59W6│const a = 1;
2:CC8J│const a2 = 2;
3:W9PC│const a3 = 3;
4:NMZP│const b = 2;      ← 到此为止，第二条编辑 (const e = 500;) 未回传
```

注意 3c 独立于 3a/3b：即使把 `end` 和索引空间都修对，只要两个编辑的窗口有重叠，后者仍会被丢。

```ts
// 索引空间正确、end 正确，仍丢第二个区块：
buildUpdatedAnchors(newContent, [{ start: 0, end: 2 }, { start: 6, end: 6 }]);
// 只输出 lines 1-6，line 7 (A5x) 缺失
```

### 影响

模型在多步编辑里依赖回传锚点继续操作（这是它省掉重读的依据）。回传不完整 → 模型手里缺少刚编辑
过的行的新锚点 → 下一次编辑要么用旧锚点撞 `stale`，要么被迫 `Read`。批量编辑（本 fork 的 P0
卖点）受影响最重。

### 单测为何没拦住

`test/anchor-resolve.test.ts:256` 只覆盖了单条、单行、无位移的场景：

```ts
test("编辑结果回传受影响区域的新锚点", () => {
  const updated = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
  const anchors = buildUpdatedAnchors(updated, [{ start: 1, end: 1 }]);   // 单条 1 行
  ...
});
```

多编辑、行数增长、窗口重叠三种场景都没进测试。

---

## 4. 【中】resume 后 EditAnchored 的读状态不恢复

### 现象

会话 resume 后，`EditAnchored` 留下的 `readFileState`（含 served 集合）不恢复，模型手里所有
锚点变成 `unserved`。

### 复现（hydrator 层，确定性）

```ts
// 构造两条 tool part：一条 Edit、一条 EditAnchored，metadata 都合法
const result = await hydrateReadFileStateFromSession({ messages, readFileState, ... });
```

实测输出：

```
restoredCount: 1
paths in state: [ '/tmp/a.ts\u00001\u0000' ]        ← 只有 Edit 的条目
b.ts (EditAnchored) restored? false                  ← EditAnchored 的丢了
```

### 根因

```ts
// src/agent/read-file-state-hydrator.ts:71-74
if (part.tool === "Edit") {
  const restored = restoreMetadataToolState(input.readFileState, part, "Edit");
  if (restored) result.restoredCount++;
}
```

只匹配 `part.tool === "Edit"`，而工具部件名是 `EditAnchored`（`tool-part-persistence.ts:62` 用
`projected.toolName` 落库），分支永不命中。

有一处容易混淆：`edit-anchored.ts:247` 写 metadata 时填的 `toolName` 是 `"Edit"`：

```ts
// src/tool/handlers/edit-anchored.ts:239-250
function recordReadFileStateMetadata(context, entry): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: "Edit",                                  // ← metadata 侧是 "Edit"
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}
```

所以 `parseReadFileStateMetadata` 那关能过，只差 hydrator 这一层的部件名匹配。`read-file-state-metadata.ts:6`
的 `PersistedReadFileStateTool` 联合类型也只有 `"Read" | "Write" | "Edit"`。

### 影响

resume / rewind 之后，模型对之前锚点编辑过的文件失去"已读"状态，之前建立的 served 集合归零。
表现为 resume 后第一次锚点编辑大概率撞 `unserved`。`resume.ts:310-312` 会把
`readFileStateRestoredCount` 报给上层，但这个数字不会指出被漏掉的是 EditAnchored。

---

## 5. 【中】UI 不认识 `EditAnchored`，锚点编辑不显示 diff

### 现象

`EditAnchored` 的调用卡退化成原始 JSON 兜底卡，没有 diff 预览、没有文件摘要、treemap 活动
统计不计入。

### 复现（UI 层，确定性）

```ts
// packages/ui
resolveToolCallIdentity({ toolName: "EditAnchored", kind: "EditAnchored", title: "EditAnchored", input: {} });
// => {"toolName":null,"family":"unknown","source":"unknown"}

isFileDiffToolCall(src);                    // => false
readRawToolCallFileSummaries(raw, src);     // => []      （output.display 里明明有 file_diff）
```

对照 `Edit`：`{"toolName":"Edit","family":"file-write","source":"toolName"}`。

### 根因链

1. `EditAnchored` 不在 `packages/shared/src/tool-identity.ts:1` 的 `ZCODE_KNOWN_TOOL_NAMES`
   里 → `normalizeZCodeToolName` 返回 null → `getZCodeToolFamilyForName` 返回 null →
   identity 落到 `unknown`。
2. `resolveRenderer.ts:170` 的 `default` 分支 → `FallbackToolCallBlock`。
3. `fileSummaries.ts:107` 的 `hasWritableToolSemantic` 检查
   `resolveToolCallIdentity(source).family === "file-write"` → false → 直接返回 `[]`，
   **即使 `output.display` 里已经有 `file_diff`**（`call-runner.ts:485` 确实产出了它）。

`toolCallRowAdapter.ts:97` 用 `kind: row.toolName`，所以 v4 路径下 `kind === "EditAnchored"`，
也救不回来。`toolIdentity.ts:172` 的 legacy 正则
`/(?:^|_)(?:edit|patch|replace|...)(?:_|$)/i` 对 `editanchored` 不匹配（无分隔符）、对
`edit_anchored` 才匹配——但 v4 走的是已知工具名分支，不是 legacy 分支。

### 附带：流式预览也命名不了

```ts
// packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:4449
function inferStreamingToolInputToolName(input: unknown): string | undefined {
  ...
  if (readStreamingToolInputStringField(record, ["old_string", "oldString", "old_text", "oldText"])) return "Edit";
  if (readStreamingToolInputStringField(record, ["content", "new_string", ...]) !== undefined) return "Write";
  return undefined;
}
```

只认 `old_string` / `content`，不认 `edits` / `remove_from` / `replacement_text`，所以锚点编辑在
流式阶段拿不到工具名。

### 影响

不影响编辑正确性，但每次锚点编辑都显示一张原始 JSON 卡，用户看不到 diff；底部摘要与 treemap
统计漏计。对一个要"当主力日常驱动"的工具，这是可见的体验退化。

---

## 6. 【严重·修复引入】`stale`/`ambiguous` 拒绝会把读状态刷成"整文件已读"，绕过 Edit/Write 的门禁

这一条**不在初验报告里**，是 `f9730f8` 的修法带出来的。修 §2（拒绝路径要落 served）时，
把整份 `readFileState` 条目重写了一遍，顺带把 `isPartialView` 从 `true` 翻成 `false`、
`content` 从"模型实际看到的那部分"换成"整文件"。于是 `Edit`/`Write` 的"先读后写"门禁被绕过。

### 复现（handler 层，确定性）

需要构造 `isPartialView: true` 的读状态（真实场景是 Read 被 token cap 截断，`read.ts` 的
`truncatedByTokenCap`）。用假 port + 直接构造 `readFileState` 跑两个 handler：

```ts
// 120 行文件，Read 只看到前 30 行且被标记 partial view
readFileState.set(`${PATH}\u00001\u0000`, {
  path: PATH, content: /* 前 30 行 */, offset: undefined, limit: undefined,
  isPartialView: true, sourceTool: "Read", /* mtime/size 故意置旧以触发 stale */
});

// A) partial view 下 Edit 改第 100 行 → 正确拒绝
// B) 外部改动第 3 行 → EditAnchored stale 拒绝
// C) 再用 Edit 改第 100 行
```

实测输出：

```
A) partial view 下 Edit 第 100 行（应被拒）
   -> REJECTED: File has not been read yet. Read it first before writing to it.
B) partial view 下 EditAnchored stale 拒绝
   -> REJECTED
   拒绝后 isPartialView = false | content 行数 = 121 /120 | servedAnchors = 31
C) 再用 Edit 改第 100 行
   -> APPLIED  ← 模型从未读过第 100 行
```

`Write` 同样中招（`write.ts:284` 用同一个 `isPartialView` 判定）：

```
A) partial view 下 Write 全文（应被拒） -> THREW: write_file_not_read
B) EditAnchored stale 拒绝              -> REJECTED
   拒绝后 isPartialView = false | content 行数 = 121
C) 再用 Write 覆盖全文                  -> APPLIED
```

成功路径有同样现象（改一个已 served 的行，第 100 行随后就能被 `Edit` 改）：

```
B) 成功的锚点编辑：改第 3 行 -> APPLIED
   成功后: isPartialView = false | content 行数 = 121 /120 | servedAnchors = 31
C) 再用 Edit 改第 100 行 -> APPLIED
```

### 根因

```ts
// src/tool/handlers/edit-anchored.ts:229-258（writeAnchoredReadState，成功与拒绝共用）
const entry: ReadFileStateEntry = {
  path: input.filePath,
  content: input.content,        // ← 整文件，不是模型看到的那部分
  offset: undefined,
  limit: undefined,
  isPartialView: false,          // ← 第 247 行：无条件置 false，覆盖掉 Read 的 partial 标记
  ...
  servedAnchors: mergeServedAnchors(previous?.servedAnchors, input.servedHashes),
};
```

关键点：**served 集合与读状态条目是两件事，修 §2 时把它们混在一起写了。**

- served 集合（`servedAnchors`）确实应该按渲染区域并进去——这是 §2 的修复，方向正确。
- 但 `isPartialView` / `content` / `offset` / `limit` 是 `Edit`/`Write` 的**门禁依据**
  （`edit.ts:494` 的 `!lastRead || lastRead.isPartialView`、`write.ts:284` 同款）。
  拒绝路径本不该碰它们：模型只是被拒绝了一次，并没有因此读到更多内容。

`isPartialView: false` 这个写法在**成功**路径上是可以自洽的（编辑后文件内容与模型所见的
`content` 一致，且 `Edit` 的成功路径也是这么写的——`edit.ts:724`）。问题在拒绝路径复用了同一个
函数，而拒绝时 `content` 传的是**未修改的整文件**、`isPartialView` 却被翻成 `false`。

对照 `Edit` 的实现，它只在自己**成功**时写（`edit.ts:659`），拒绝路径不写：

```ts
// edit.ts:710 updateReadFileStateAfterEdit —— 只被 writeEditResult（成功路径）调用
```

### 影响

比 §1 更直接。§1 是"锚点门变松"，这一条是"**绕过 `Edit`/`Write` 的读门禁**"：

- 模型对一个只读了 30 行的 3000 行文件，只要先做一次**会被拒绝**的锚点编辑（stale 很常见——
  外部 formatter、用户手动保存都会触发），就能拿到"整文件已读"状态，然后用 `Edit` 或 `Write`
  覆盖任意位置。
- 被拒绝的操作本该是**零副作用**的。现在它有副作用，且副作用是放宽其他工具的约束。
- 触发成本极低：一次 stale 拒绝即可，不需要编辑成功。

### 为什么没被测试拦住

新增的 43 个 core 用例没有一个断言 `isPartialView`（`grep isPartialView test/*.test.ts` 只命中
hydrator 测试里一个 fixture 字面量）。§1/§2 的修复测试盯的是 `servedAnchors` 的内容，而这条
缺陷落在同一个函数写出的**另一个字段**上——测试覆盖了"改对了的那个字段"，没覆盖"顺手改错的
那个字段"。

### 与 §1 修复的关系

§1 修的是"served 灌全文"，§2 修的是"拒绝不写 served"，方向都对。§6 是这两处共用的写入函数
把**不该动的门禁字段**一起重写了。三者都在 `writeAnchoredReadState` 这一个函数里，建议一起看。

---

## 7. 新发现（复验 §1–§6 时顺带查出）

三项。**第三轮（`a068243` + `e751ad2`）已逐项处理**，处理结果见每节末尾的「处理状态」。

### 7.1 拒绝路径并进的 served 锚点跨 resume 丢失

**这是 §2 修复的一个残留**，不是新引入的——`f9730f8` 让拒绝路径也写 served，但那条写入只在内存
里生效，落盘路径没有带上。

复现（端到端，两段会话）：

```ts
// 会话1：外部改动第 2 行 → EditAnchored 用旧锚点 → stale 拒绝
//        （拒绝信息回传了新锚点 v2，并把它并进内存 served）
// 会话1 落盘：复刻 call-runner 的失败收口
const err = createToolHandlerFailureError(toolCall, failure);
const failedResult = createErrorResult(toolCall, err, 1);
// 会话2：resume
```

实测：

```
会话1: 拒绝 = true | 内存 served 数 = 5
       v2 锚点已并进内存 served: true
会话1 落盘的失败部件带 readFileStateMetadata: false
会话2: 恢复条目数 = 0 | v2 锚点是否恢复: false
=> 结论：拒绝路径并进 served 的锚点 跨 resume 丢失
```

根因链：

1. 拒绝路径经 `mergeServedAnchorsAfterRejection` 调 `recordReadFileStateMetadata`
   （`edit-anchored.ts:288`），把 metadata 交给 `context.recordReadFileStateMetadata`。
2. 但 handler 随后返回 `ToolHandlerFailure`，`call-runner.ts:454` 把它转成异常抛出，走 catch 分支。
3. catch 分支用 `createErrorResult`（`errors.ts:6`）构造失败结果——该函数**不携带**
   `readFileStateMetadata` 字段（对比成功路径 `call-runner.ts:521` 的
   `...(readFileStateMetadata ? { readFileStateMetadata } : {})`）。
4. `runtime/methods/tool-part-metadata.ts:39` 因此写不出 `readFileState`；`turn-tools.ts:337`
   的失败分支 metadata 也只有 `mcpToolPartMetadata` + `modelContent`。
5. resume 时 hydrator 从 tool part metadata 恢复，读不到 → 0 条。

补充：hydrator 本身也只看 `status: "completed"` 的部件（`read-file-state-hydrator.ts` 的
`isCompletedToolPart`），失败部件即便带了 metadata 也不会被读。所以这条要修得动两处，或者干脆让
拒绝路径的 served 不落盘。

**影响**：比 §4 轻（§4 是成功的锚点编辑丢状态，这条是拒绝的），但语义上是同一个问题的镜像：
`f9730f8` 特意让拒绝路径写 served 以闭合 reject-and-serve 循环，这个闭合只在**单次会话内**成立。
resume 后模型手里那些「从 stale 错误信息里抄来的锚点」又会变 unserved，需要重新 Read。

**范围要说准**（第三轮修正）：丢的是**仅拒绝路径**并进的那一份 served。成功路径写的读状态照常
落盘（成功结果带 `readFileStateMetadata` → completed 部件 → hydrator 恢复），所以 resume 后
「成功编辑并进的 served」是好的，§4 的修复没有被这条抵消。

**需要决策**：是让失败结果也带上 read-state metadata（改 `createErrorResult` + hydrator 接受
error 部件），还是接受"拒绝路径的 served 不跨会话"并在文档里写明。前者动的是通用错误层，
影响面比 hashline 大，我不建议在这轮顺手改。

**处理状态（`f624f05`）：已修复，端到端复验通过。**

中间经过一轮「待决策」（`86bcfd7`/`e751ad2`）：处理方先查清影响面、写下 4 处改动点与验证方式，
判定不在当时那轮做（理由：不是复杂度而是验证成本——在共享的错误/持久化层上落只做过单测的改动，
正是 §6 的成因）。这个判断我认同。

随后 `f624f05` 单独立项完成，四处改动：

| 处 | 改动 |
| --- | --- |
| `createErrorResult` | `options` 增可选 `readFileStateMetadata`（不动位置参数） |
| `call-runner.ts:575` | catch 分支传入已在作用域内的 `readFileStateMetadata` |
| `tool-part-metadata.ts` | 抽出 `readFileStateMetadataField`，completed 与 error 分支共用 |
| `read-file-state-hydrator.ts` | 判据换成 `isReadStateBearingToolPart`，接受 completed 与 error |

端到端复验（复刻两段会话）：

```
会话 1：外部改动 → stale 拒绝
  拒绝: true | 内存 served 含 v2: true
会话 1 落盘（复刻 call-runner 失败收口）
  失败结果带 readFileStateMetadata: true
  tool part metadata 字段: [ 'readFileState' ] | servedAnchors 含 v2: true
会话 2：resume
  恢复条目数: 1 | v2 锚点恢复: true
```

**一处补充（§7.6）**：它原先在 commit/spec 里写的「其它工具的 error 部件天然被跳过」不成立，
经我实测指出后已纠正。详见 §7.6。

**它记下的一个验证陷阱（值得记）**：范围读（传了 `limit`）的读状态按设计不跨 resume 恢复
（`isHistoricalFullReadWindow` 要求 `limit === undefined`）。模型习惯给 Read 补 `limit: 2000`，
于是 4 行小文件也被当成范围读，resume 后连 Read 自己那份都不恢复，看不出这条修没修。
验证这个场景必须让 Read 只传 `file_path`。

### 7.2 空文件/清空后的锚点会把"空行哈希"当成已读

`applyAnchorEdits` 在内容被清空时，`changedRanges` 会给出 `{start: 0, end: 0}`，`buildUpdatedAnchors`
对空内容渲染出一个假行：

```ts
// 原始 "A1\nA2\nA3"，删掉全部 3 行
applyAnchorEdits(...).content        // ""
applyAnchorEdits(...).changedRanges  // [{ start: 0, end: 0 }]
buildUpdatedAnchors("", [{start:0,end:0}])
// => { text: "1:RVM2│", servedHashes: ["RVM2"] }
```

`RVM2` 就是 `hashLineContent("")`。因为 `splitLines("")` 返回 `[""]`（一个空行），
`lines.length === 0` 的早退分支不成立，于是渲染出一个不存在的第 1 行。

**影响**：把空行哈希并进 served。之后该文件里任何空行（比如任意函数之间的空行）都变成"已读"，
模型可以引用它们的锚点。范围限于空行——不是 §1 那种整文件解锁，但同一类问题的缩小版。

**处理状态（`a068243`）：已修，复验通过。** 改用 `isEmptyContent(content)` 判据，
`formatAnchorRegion` 同款问题一并修掉（它此前对空文件显示 `Current anchors (lines 1-1)` 而不是
`(file is empty)`）。复验输出：

```
content: "" | changedRanges: [{"start":0,"end":0}]
buildUpdatedAnchors: {"text":"","servedHashes":[]}
formatAnchorRegion(""): {"text":"(file is empty)","servedHashes":[]}
=> 空行哈希是否被并进 served: false
```

端到端（删光全文 → 检查 served → 再用 `Edit`/`Write`）也验过。处理方还顺手修掉了一条把旧行为当
期望的测试（原来断言 `servedHashes` 长度为 1、文本是 lines 1-1，等于把 bug 固化成了期望）。

**补充观察（复验方）**：空行哈希本来就会经正常 `Read` 进入 served——`read.ts:383` 用
`content.split(/\r?\n/)` 算 served，文件有尾随换行时（`"A1\nA2\nA3\n"`）会多出一个空元素，
实测 `servedAnchors` 4 个、含 `hashLineContent("")`。所以 §7.2 的实际增量是"**没有 Read 也会**"
把空行哈希并进 served，而不是"凭空创造了这个哈希"。修掉仍然正确，但它不是我原先判断的"凭空
解锁空行"——空行在多数真实文件里早就因为尾随换行被 Read 服务过了。

### 7.3 `mergeServedAnchorsAfterRejection` 的"无读状态"分支不可达

```ts
// edit-anchored.ts:285-308
const existing = findLatestReadFileState(readFileState, input.filePath);
if (existing) { /* ... */ return; }
// 没有任何读状态时，served 需要有地方放。建一条保守条目……
```

该分支要求同时满足：`servedHashes.length > 0`（才进入这个函数）且 `findLatestReadFileState`
返回 undefined。但 `servedHashes > 0` 只可能来自 `stale`/`ambiguous`，而这两个 reason 的前提是
锚点哈希**在 served 集合里**（`anchor-resolve.ts:78` 的 `servedHashes.has(anchor.hash)` 不通过就是
`unserved`，不渲染任何内容）。served 集合来自同路径的读状态条目，所以此时必然存在读状态条目。

实测验证：

```
空 served 下 reason = unserved | 渲染哈希数 = 0
=> fallback 分支可达性: 不可达（死代码）
```

新增的 4 个 read-gate 用例也没有覆盖它（`grep "servedAnchors: \[\]"` 命中 0）。

**影响**：无功能影响，只是 16 行不会被执行的代码。写它的理由（"served 需要有地方放"）在
`servedHashes > 0` 这个入口条件下不成立。

**处理状态（`a068243`）：确认不可达，保留并写明。** 处理方复核了我的论证，选择保留而不是删除，
理由是在注释里写清它为什么不可达（`edit-anchored.ts:294-301`），删掉会让未来其它调用方在该状态下
静默丢掉 served（表现为模型重发撞 unserved）。**我同意这个取舍**——保留一个带"为什么不可达"注释的
契约分支，比删掉后让契约在代码里失去落点要好。

---

## 7.5 第三轮遗留（`e751ad2` 后）

复验方在 `e751ad2` 上发现的两条，处理方已修，我逐条复验通过：

| 项 | 状态 | 复验证据 |
| --- | --- | --- |
| `test/tmp/v7.ts` 未跟踪脚本 | **已清** | `ls test/tmp` → No such file；已移入 `~/.Trash/zcode-anchor-repro-20260923/` |
| `anchor-resolve.test.ts` 重复用例 | **已删** | `grep -c 'test("空内容上渲染区域返回空结果'` → 0（保留带 `§7.2` 前缀那条）；该文件 27 → 26，全套 49 → 48，`§7.2` 行为仍被覆盖 |

重复用例的根因（处理方自述，我核对属实）：改写旧的「空文件上渲染区域不报错」时写成了与新用例
相同的正文，本该直接删掉旧的那条。commit message 说「顺带修掉一个把旧行为当期望的测试」没错，
但没回头检查改写结果是不是变成了重复。

另：复验方（我）在跑 §7.2 端到端时留下了一个 `.tmp-eh.txt`（内容 `A1/A2/A3`，尾随换行夹具），
处理方按"不删不是自己建的东西"的规矩没动它，我自行移入了 `~/.Trash/`。这条是我这边的疏漏。

---

## 7.6 第四轮：一个被当成机制的约定（`f624f05`）

`f624f05` 的 commit 与 spec 初版都写了这样一句论证：

> 放宽 hydrator 是安全的：…而只有 `EditAnchored` 在失败路径写读状态（`read.ts` / `edit.ts` /
> `write.ts` 的写入都在成功路径），其它工具的 error 部件**天然被跳过**。

**前半段对，后半段不成立。** hydrator 的判据是「`parseReadFileStateMetadata` 能解析出结构化
metadata + tool 名在白名单里」，**不看工具名是不是 `EditAnchored`**。实测四组对照：

```
error 件 metadata 为空          : restored=0 size=0
error 件带 Write 读状态        : restored=1 size=1   ← 会恢复
error 件带 EditAnchored 读状态 : restored=1 size=1   ← 目标行为
error 件 tool 名不认识         : restored=0 size=0
```

第 2 条说明：`Write`/`Edit` 的 error 部件只要带了合法 metadata 就会被恢复。

**可达性很窄但不是零。** `readFileStateMetadata` 在 `call-runner` 里是同一个 try 作用域的变量
（声明 `:363`、赋值 `:420`、catch 里读 `:571`），而 handler 成功之后还有 `validateOutput` /
`serializeOutput` / `runPostToolUseHooks` / `emitToolCallResult` 都在这个 try 里。所以
`Write` 写入成功、随后事件发送抛错时，它的读状态会被带进 error 部件并在 resume 时恢复。
实测各环节的抛错可能：`runPostToolUseHooks` 里 `throw` 计数为 0；`serializeOutput` 只有 CUA
保护路径会抛（Write/Edit/Read 不设该保护）；`validateOutput` 正常路径不抛。所以实际可达的
只有事件发送失败这一条，概率低。

**它选的是「改措辞」而不是「按 tool 名收窄」，我同意——而且它的第二条理由比我的建议更准。**

1. 按 tool 名特判会让通用层反向依赖具体工具（`executor/errors.ts:27` 的注释讲的就是这条原则，
   虽然原文说的是展示文案，但「通用层不按工具名分派」这个方向同样适用）。
2. **语义上这是对的**：`Write` / `Edit` 只在**写入成功之后**才记读状态，所以模型的视图是准的；
   调用后来因 serialize / emit 抛错而被报成失败，并不让视图变错。

第 2 条是我提建议时没想到的——我原来只从「防未授权恢复」的角度看，没考虑「写成功即已读」
本身语义成立。它的反驳站得住。

**落地**（复验通过）：

- 新增测试「带合法读状态的 Write 失败件也会恢复（恢复不按工具名特判）」，把这条行为从
  「碰巧成立」变成「有意为之」。测试 54 → 55。
- 旧测试改名成「失败部件没带读状态时不会凭空造出已读」——它测的确实是「没带」而不是「带的是
  别的工具」，改名后名实相符（这一点正是我指出它原测试绕开的区分）。
- spec 的「为什么放宽 hydrator 是安全的」改成「hydrator 放宽的实际语义（初版论证已纠正）」，
  开头先写明初版错在哪，附四组实测与可达链路。

**复验方补的三处小修（本轮由我直接改）**：

| 项 | 修改 |
| --- | --- |
| `errors.ts:18` 与 `read-file-state-hydrator.ts:32` 的「照拄」 | 改为「照抄」（本轮新注释引入的错别字） |
| spec 引用 `executor/errors.ts:18` 支撑「反对按 tool 名特判」 | 改为 `:27`（那条原则注释的实际位置），并说明它是类比 |
| hydrator 的 `FailedToolPart` JSDoc 仍写着「其它工具不在失败路径写读状态，所以走不到恢复」 | 改成与 spec 一致的「恢复判据是带没带合法读状态，不是工具名」 |

第三条是同一处错误论断的另一份拷贝——处理方改了 commit message 和 spec，但代码注释里的那份
漏了。三处现在一致。

---


## 8. 已验证正常的部分（改的时候别碰坏）

以下都是真机调用确认过的：

| 场景 | 结果 |
| --- | --- |
| 快路径单行替换 | 正确 |
| 自愈合：上方插入 3 行后旧行号失效，哈希唯一命中 | 正确，落点行号准确 |
| 删除区间（`replacement_text: ""`） | 正确 |
| 单行 → 多行替换的内容写入 | 正确（只是回传锚点不全，见 §3a） |
| 批量编辑原子性 | 正确，两条都生效 |
| 重叠区间拒绝 | 正确（`Edit 1 and edit 2 target overlapping line ranges.`） |
| 歧义拒绝（3 行相同内容，`99:E8FE`） | 正确，`matches 3 lines` |
| `unserved` 拒绝（首次编辑前） | 正确 |
| `malformed_anchor` / `reversed_range` 拒绝 | 正确，提示可修正 |
| `.ipynb` 拒绝 | 正确（`NOTEBOOK_FILE_MESSAGE`） |
| `Edit` 粘贴带锚点前缀的内容 | 正确（`b8d4d12` 的修复有效，`line_number_prefix_stripped` 命中） |

哈希质量也复核过。用唯一内容 + LCG 生成器测碰撞：

| 行数 | 实测碰撞（30 次均值） | 均匀分布期望 |
| --- | --- | --- |
| 1 000 | 0.30 | 0.48 |
| 5 000 | 11.53 | 11.92 |
| 20 000 | 190.03 | 190.73 |

FNV-1a 32 位分布正常，实测与理论一致。`specs/edit-tool-roadmap.md` §2 里"用行号定位、用哈希
见证、4 字符而非 3 字符"的决策成立（3 字符 1000 行碰撞率约 88% 的估算可以复现）。

---

## 9. 未验证的部分（说明清楚，别当成通过）

- **未做 UI 端到端**：没有起 `pnpm dev:desktop` / `dev:web` 点开真实会话看卡片。§5 的结论来自
  对 `resolveToolCallIdentity` / `isFileDiffToolCall` / `readRawToolCallFileSummaries` 的直接
  调用，不是截图确认。
- **未做真实模型往返**：全部验证是我在 harness 里直接构造工具调用，没有让模型自己决定何时用
  `EditAnchored`。§2 的"模型会照抄错误信息里的锚点"是基于设计意图的推断，不是实测模型行为。
- **未验证 served 集合的持久化体积**：`servedAnchors` 只增不减、无上限（`anchor-served.ts:17`
  的 `mergeServedAnchors` 不截断，`read-file-state-metadata.ts:76` 也无 bound）。大文件 + 多次
  编辑后这个数组会持续增长并随每条 tool-result metadata 落盘，我没测它对消息体积和 replay 的
  实际影响。这条只是观察，未定性为缺陷。`specs/edit-tool-roadmap.md` 也把它列为"未处理（观察）"，
  并给出了"修正后上界是单次 Read 的行数"的理由——那个推理我认同，但同样没有实测。
- **未验证并发**：`concurrentSafe: false`，没测同一文件并发编辑。`batch-runner.ts:130` 与
  `streaming-tool-coordinator.ts:356` 会据此串行化，但同一文件被两次 `EditAnchored` 交错
  （比如一个成功一个 stale）时读状态条目的最终值我没验过。**这条是"没看过"，不是"已知没问题"**
  ——与 §7.1 一样属于当前唯一未覆盖的语义面。
- **未验证 range read 的边界**：只读了 `offset=100 limit=50` 时，`isPartialView` 是 `false`
  （range view 不等于 partial view，`read.ts:374` 的注释说明了这个区分）。这意味着 range read 后
  `Edit` 的"先读后写"门禁按"整文件已读"处理。实测确认 `EditAnchored` 与 `Edit` 在这个场景下行为
  **完全一致**（都放行范围外的编辑），所以不是 hashline 引入的差异——但这条语义本身值得确认是否有意为之。

---

## 10. 缺陷优先级建议

**全部缺陷已闭环，无待处理项。** 只剩两条非缺陷的观察：

1. **lint 告警**（低优先）—— `anchor-resolve.ts` 的 `new Array(edits.length)` 触发
   `unicorn(no-new-array)`，`f9730f8` 引入、到 `f624f05` 仍在。被根 `ignorePatterns` 遮住，
   但包内 lint 可见。一行改动。
2. **`servedAnchors` 无上限**（观察，未定性为缺陷）—— 只增不减、不截断。修正后增长只来自真正
   展示过的行，单次 Read 的上界就是文件行数，与既有 `content` 快照同量级。加硬上限会引入新失败
   模式（旧锚点被误判 unserved），目前证据不足以支持。见 §9。

已处理项的原始优先级（留档）：

| 编号 | 内容 | 处理 |
| --- | --- | --- |
| §1 | served 灌全文 | `f9730f8` 修复 |
| §2 | reject-and-serve 锚点不进 served | `f9730f8` 修复 |
| §3 | updatedAnchors 区间错误 | `f9730f8` 修复 |
| §4 | resume 不恢复 | `f9730f8` 修复 |
| §5 | UI 不认工具名 | `f9730f8` 修复 |
| §6 | 修复引入的读门禁绕过 | `f66798b` 修复 |
| §7.2 | 空内容渲染假行 | `a068243` 修复 |
| §7.3 | 不可达分支 | `a068243` 确认保留 |
| §7.5 | 重复用例 + 临时脚本 | `e751ad2` 清理 |
| §7.1 | 拒绝路径的 served 不跨 resume | `f624f05` 修复 |
| §7.6 | 「天然被跳过」论断错误 | `f624f05` 纠正 + 测试钉住 |

> 下面这段是初验时的建议，已被 `f9730f8` 采纳（成功与拒绝共用 `writeAnchoredReadState`）。
> 但正是这次共用把 §6 的门禁字段一起重写了——`f66798b` 又把两者拆开。留档以便对照这个来回。

§1 与 §2 是同一个根因的两面（`servedAnchors` 的写入语义），建议一起处理：明确"哪些哈希算
被展示过"的唯一规则，然后让成功路径（只并 `updatedAnchors` 渲染的行）和拒绝路径（并
`formatAnchorRegion` 渲染的行）走同一条写入逻辑。

---

## 附：复现用的一次性脚本

以下脚本在 `apps/zcode-cli/packages/core` 下用 `node --import tsx <file>` 运行，验证完已删除。

<details>
<summary>§3c：多编辑区块丢失（内容真的缺失）</summary>

```ts
import { buildUpdatedAnchors } from "./src/tool/anchor-resolve.ts";

// 复刻真机 batch.ts：原始 5 行 a..e
// edit1 把 index0 一行换成 3 行（净 +2）；edit2 改 index4（原 const e = 5;）
const newContent = [
  "const a = 1;","const a2 = 2;","const a3 = 3;",
  "const b = 2;","const c = 3;","const d = 4;","const e = 500;",
].join("\n");

const out = buildUpdatedAnchors(newContent, [{ start: 0, end: 0 }, { start: 4, end: 4 }]);
console.log(out);
console.log("区块数:", out.split("\n...\n").length);            // 1（应为 2）
console.log("含 const e = 500;?", out.includes("const e = 500;")); // false ← 内容真的丢了
```

输出：

```
1:59W6│const a = 1;
2:CC8J│const a2 = 2;
3:W9PC│const a3 = 3;
4:NMZP│const b = 2;
区块数: 1
含 const e = 500;? false
```

第二条编辑的窗口起点 `from = 4+1-3 = 2` 落在第一个区块已覆盖的 `{1,2,3,4}` 里，于是被
`covered.has(from)` 整个 `continue` 掉；而它真正对应的新内容第 7 行不在第一个区块的窗口
（1–4）内，所以那几行锚点彻底没回传。

更弱的一种表现（内容碰巧被前一个窗口覆盖，只是没有单独成块）：

```ts
const content = ["L1","L2","L3","L4","L5","L6","L7","L8","L9","L10"].join("\n");
// edit1 窗口 = lines 1-5，把 edit2（index 4 → line 5）一起吞了 → 只回 1 个区块
buildUpdatedAnchors(content, [{ start: 1, end: 1 }, { start: 4, end: 4 }]);
```

</details>

<details>
<summary>§4：hydrator 漏 EditAnchored</summary>

```ts
import { hydrateReadFileStateFromSession } from "./src/agent/read-file-state-hydrator.ts";
function part(tool: string, path: string, content: string) {
  return {
    id: `p-${tool}`, type: "tool" as const, tool,
    state: {
      status: "completed" as const,
      input: { file_path: path },
      output: { filePath: path },
      metadata: { readFileState: {
        schemaVersion: 1, tool: "Edit", path, content, isPartialView: false,
        readAtMs: 1000, revisionId: "rev1", mtimeMs: 1000,
        sizeBytes: content.length, servedAnchors: ["AAAA"],
      } },
    },
  };
}
const messages = [{ info: { id: "m1", role: "assistant" as const }, parts: [
  part("Edit", "/tmp/a.ts", "const a = 1;"),
  part("EditAnchored", "/tmp/b.ts", "const b = 1;"),
] }] as never;
const readFileState = new Map();
const r = await hydrateReadFileStateFromSession({
  messages, readFileState: readFileState as never,
  workingDirectory: "/tmp", workspaceRoot: "/tmp",
});
console.log("restoredCount:", r.restoredCount);                       // 初验 1（应为 2）；修复后 2
console.log([...readFileState.values()].some((e: any) => e.path === "/tmp/b.ts"));  // 初验 false；修复后 true
```

</details>

<details>
<summary>§5：UI identity 与 file summary</summary>

```ts
// 在 packages/ui 下运行
import { resolveToolCallIdentity, isFileDiffToolCall } from "./src/lib/toolIdentity.ts";
import { readRawToolCallFileSummaries } from "./src/ToolCallBlocks/fileSummaries.ts";

const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-const a = 1;", "+const a = 2;"] }];
const display = { kind: "file_diff", filePath: "/tmp/x.ts", additions: 1, deletions: 1, structuredPatch: patch };
const output = { filePath: "/tmp/x.ts", editCount: 1, originalFile: "const a = 1;",
  structuredPatch: patch, userModified: false, updatedAnchors: "1:ABCD│const a = 2;" };

// 注意：v4 adapter（toolCallRowAdapter.ts:110）把 display 放在 raw 顶层。
// 初验时我误把 display 放在 raw.output/raw.result 下，那是错的形态，会永远得到 0。
const raw = { toolName: "EditAnchored", display, status: "completed" };
const src = { toolName: "EditAnchored", kind: "EditAnchored", title: "EditAnchored",
  input: { file_path: "/tmp/x.ts" }, output, raw };

console.log(resolveToolCallIdentity(src).family);              // 初验 "unknown"；修复后 "file-write"
console.log(isFileDiffToolCall(src));                          // 初验 false；修复后 true
console.log(readRawToolCallFileSummaries(raw, src).length);    // 初验 0；修复后 1（带 patch）
```

</details>

<details>
<summary>§6：拒绝路径刷掉 isPartialView，绕过 Edit/Write 门禁（修复引入）</summary>

需要假 port（`stat`/`readTextFile`/`writeTextFile` 三个方法）。关键是把 `readFileState` 构造成
`isPartialView: true` 且 mtime/size 置旧：

```ts
// 在 apps/zcode-cli/packages/core 下运行
import { editAnchoredToolEntry } from "./src/tool/handlers/edit-anchored.ts";
import { editToolEntry } from "./src/tool/handlers/edit.ts";
import { writeToolEntry } from "./src/tool/handlers/write.ts";
import { splitLines, computeLineHashes, hashLineContent, formatAnchor } from "./src/tool/anchor-hash.ts";
import { readFile, writeFile, stat } from "node:fs/promises";

const PATH = "/tmp/reg.ts";
const original = Array.from({length: 120}, (_, i) => `const item${String(i+1).padStart(3,"0")} = ${i+1};`).join("\n") + "\n";
await writeFile(PATH, original, "utf8");

const port: any = {
  async stat({ path }: any) { const s = await stat(path);
    return { path, kind: "file", sizeBytes: s.size, mtimeMs: s.mtimeMs,
      revision: { id: `r-${s.mtimeMs}-${s.size}`, mtimeMs: s.mtimeMs, sizeBytes: s.size } }; },
  async readTextFile({ path }: any) { const content = await readFile(path, "utf8"); const s = await stat(path);
    return { path, content, encoding: "utf8", lineEndings: "lf", bytesRead: Buffer.byteLength(content),
      sizeBytes: s.size, truncated: false,
      revision: { id: `r-${s.mtimeMs}-${s.size}`, mtimeMs: s.mtimeMs, sizeBytes: s.size } }; },
  async writeTextFile({ path, content }: any) { await writeFile(path, content, "utf8"); const s = await stat(path);
    return { path, bytesWritten: Buffer.byteLength(content),
      revision: { id: `r-${s.mtimeMs}-${s.size}`, mtimeMs: s.mtimeMs, sizeBytes: s.size } }; },
};

const KEY = `${PATH}\u00001\u0000`;
// token-capped Read：只看到前 30 行，isPartialView = true；mtime/size 置旧以触发 stale
const state = new Map<string, any>([[KEY, {
  path: PATH, content: splitLines(original).slice(0, 30).join("\n"), offset: undefined, limit: undefined,
  isPartialView: true, readAt: new Date(Date.now() - 1000), sourceTool: "Read",
  revisionId: "stale", mtimeMs: 1, sizeBytes: 1,
  servedAnchors: computeLineHashes(splitLines(original).slice(0, 30)),
}]]);
const ctx: any = { toolCallId: "t", traceId: "tr", abortSignal: new AbortController().signal,
  fileSystemPort: port, readFileState: state, workingDirectory: "/tmp", workspaceRoot: "/tmp", sessionId: "s" };
const run = async (l: string, fn: () => Promise<any>) => {
  try { const r = await fn(); console.log(l, "->", (r as any)?.result === false ? "REJECTED" : "APPLIED"); }
  catch (e: any) { console.log(l, "-> THREW:", e?.context?.code ?? String(e?.message).split("\n")[0]); }
};

// A) partial view 下 Edit 第 100 行 → 正确拒绝
await run("A) partial view 下 Edit 第 100 行", () =>
  editToolEntry.handler!({ file_path: PATH, old_string: "const item100 = 100;", new_string: "const item100 = X;" }, ctx));

// B) 外部改动第 3 行 → EditAnchored stale 拒绝
await writeFile(PATH, original.replace("const item003 = 3;", "const item003 = 333;"), "utf8");
await run("B) EditAnchored stale 拒绝", () =>
  editAnchoredToolEntry.handler!({ file_path: PATH, edits: [{ remove_from: formatAnchor(3, hashLineContent("const item003 = 3;")), remove_to: formatAnchor(3, hashLineContent("const item003 = 3;")), replacement_text: "x" }] }, ctx));
const e = state.get(KEY);
console.log("   拒绝后 isPartialView =", e.isPartialView, "| content 行数 =", splitLines(e.content).length, "/120");

// C) 再用 Edit 第 100 行 → 当前会 APPLIED（缺陷）
await run("C) 再用 Edit 第 100 行", () =>
  editToolEntry.handler!({ file_path: PATH, old_string: "const item100 = 100;", new_string: "const item100 = X;" }, ctx));
```

把 B 换成成功的锚点编辑（改第 3 行，锚点门允许），C 同样会 `APPLIED`。把 C 换成 `writeToolEntry`
则对应 `Write` 的同一绕过。

**注意**：这段脚本描述的是 §6 修复**之前**的行为。HEAD `ca01c3f` 上 C 应当返回 `REJECTED`、
D 应当 `THREW: write_file_not_read`。保留脚本是为了能反向验证修复。

</details>

<details>
<summary>§7.1：拒绝路径的 served 跨 resume 丢失</summary>

```ts
// 在 apps/zcode-cli/packages/core 下运行
import { editAnchoredToolEntry } from "./src/tool/handlers/edit-anchored.ts";
import { hydrateReadFileStateFromSession } from "./src/agent/read-file-state-hydrator.ts";
import { createErrorResult, createToolHandlerFailureError } from "./src/tool/executor/errors.ts";
import { splitLines, hashLineContent, formatAnchor } from "./src/tool/anchor-hash.ts";
import { createReadFileStateKey } from "./src/tool/read-file-state.ts";
import { readFile, writeFile, stat } from "node:fs/promises";

const PATH = "/tmp/persist.ts";
const original = "const keep = 1;\nconst change = 2;\nconst tail = 3;\n";
await writeFile(PATH, original, "utf8");
const port: any = {
  async readTextFile({ path }: any) { const content = await readFile(path, "utf8"); const s = await stat(path);
    return { path, content, encoding: "utf8", lineEndings: "lf", bytesRead: Buffer.byteLength(content),
      sizeBytes: s.size, truncated: false,
      revision: { id: `r-${s.size}`, mtimeMs: s.mtimeMs, sizeBytes: s.size } }; },
  async writeTextFile({ path, content }: any) { await writeFile(path, content, "utf8"); const s = await stat(path);
    return { path, bytesWritten: Buffer.byteLength(content),
      revision: { id: `r-${s.size}`, mtimeMs: s.mtimeMs, sizeBytes: s.size } }; },
};
const KEY = createReadFileStateKey(PATH, 1, undefined);
const state = new Map<string, any>([[KEY, {
  path: PATH, content: original, offset: undefined, limit: undefined, isPartialView: false,
  readAt: new Date(Date.now() - 60_000), sourceTool: "Read", revisionId: "r-old", mtimeMs: 1, sizeBytes: 1,
  servedAnchors: splitLines(original).map(hashLineContent),
}]]);

// 会话1：外部改动 → stale 拒绝（拒绝信息回传 v2 锚点并并进内存 served）
await writeFile(PATH, original.replace("const change = 2;", "const change = 999;"), "utf8");
const captured: any[] = [];
const ctx: any = { toolCallId: "c1", traceId: "tr", abortSignal: new AbortController().signal,
  fileSystemPort: port, readFileState: state, workingDirectory: "/tmp", workspaceRoot: "/tmp", sessionId: "s",
  recordReadFileStateMetadata: (m: any) => captured.push(m) };
const r: any = await editAnchoredToolEntry.handler!({ file_path: PATH, edits: [{ remove_from: formatAnchor(2, hashLineContent("const change = 2;")), remove_to: formatAnchor(2, hashLineContent("const change = 2;")), replacement_text: "x" }] }, ctx);
const v2Hash = hashLineContent("const change = 999;");
console.log("会话1: 内存 served 含 v2 锚点:", state.get(KEY).servedAnchors.includes(v2Hash));

// 会话1 落盘：复刻 call-runner 的失败收口
const toolCall: any = { id: "c1", name: "EditAnchored", input: {} };
const failedResult: any = createErrorResult(toolCall, createToolHandlerFailureError(toolCall, r), 1);
console.log("会话1 落盘的失败部件带 readFileStateMetadata:", "readFileStateMetadata" in failedResult);

// 会话2：resume
const parts = [{ id: "p1", type: "tool" as const, tool: "EditAnchored",
  state: { status: "error" as const, input: { file_path: PATH }, error: "stale",
    metadata: failedResult.readFileStateMetadata ? { readFileState: failedResult.readFileStateMetadata } : {} } }];
const st2 = new Map();
const h = await hydrateReadFileStateFromSession({ messages: [{ info: { id: "m1", role: "assistant" as const }, parts }] as never, readFileState: st2 as never, workingDirectory: "/tmp", workspaceRoot: "/tmp" });
const restored = [...st2.values()].flatMap((e: any) => e.servedAnchors ?? []);
console.log("会话2: 恢复条目数 =", h.restoredCount, "| v2 锚点恢复:", restored.includes(v2Hash));
```

实测：会话1 内存里 `true`、落盘 `false`、会话2 恢复条目 0 且 v2 锚点丢失。

</details>

<details>
<summary>§7.2：空内容渲染出假行、把空行哈希并进 served</summary>

```ts
import { resolveAnchorEdits, applyAnchorEdits, buildUpdatedAnchors } from "./src/tool/anchor-resolve.ts";
import { splitLines, computeLineHashes, hashLineContent, formatAnchor } from "./src/tool/anchor-hash.ts";

const c = "A1\nA2\nA3";
const served = new Set(computeLineHashes(splitLines(c)));
const at = (ln: number) => formatAnchor(ln, hashLineContent(splitLines(c)[ln - 1]!));

const r = resolveAnchorEdits(c, served, [{ removeFrom: at(1), removeTo: at(3), replacementText: "" }]);
if (r.status === "resolved") {
  const a = applyAnchorEdits(c, r.edits);
  const u = buildUpdatedAnchors(a.content, a.changedRanges);
  console.log("内容:", JSON.stringify(a.content));              // ""
  console.log("changedRanges:", JSON.stringify(a.changedRanges)); // [{"start":0,"end":0}]
  console.log("回传文本:", JSON.stringify(u.text));             // "1:RVM2│"
  console.log("servedHashes:", JSON.stringify(u.servedHashes)); // ["RVM2"]
  console.log("空串哈希 =", hashLineContent(""));               // RVM2
}
```

`splitLines("")` 返回 `[""]`，所以 `lines.length === 0` 的早退不成立，渲染出一个不存在的第 1 行。
`RVM2` 即 `hashLineContent("")`，之后该文件任意空行都会被当成"已读"。

</details>

<details>
<summary>§7.3：`mergeServedAnchorsAfterRejection` 的无读状态分支不可达</summary>

```ts
import { resolveAnchorEdits, createAnchorFailureMessage } from "./src/tool/anchor-resolve.ts";

const content = "const a = 1;\nconst b = 2;\n";
// 空 served：模拟"没有任何读状态"
const r = resolveAnchorEdits(content, new Set(), [{ removeFrom: "1:AAAA", removeTo: "1:AAAA", replacementText: "x" }]);
if (r.status === "failed") {
  const f = createAnchorFailureMessage({ content, failure: r, total: 1 });
  console.log("reason =", r.reason, "| 渲染哈希数 =", f.servedHashes.length);
  // reason = unserved | 渲染哈希数 = 0
}
```

入口条件是 `servedHashes.length > 0`，而它只可能来自 `stale`/`ambiguous`——这两个 reason 的前提是
锚点哈希**在 served 集合里**（`anchor-resolve.ts:78`），served 又来自同路径读状态条目。所以进入该
函数时读状态必然存在，`!existing` 分支永不执行。

</details>

<details>
<summary>§7.2 补充：空行哈希本来就会经正常 Read 进入 served</summary>

```ts
import { hashLineContent } from "./src/tool/anchor-hash.ts";

// 复刻 read.ts:383 的 served 计算：input.output.content.split(/\r?\n/)
const empty = hashLineContent("");
for (const [label, c] of [
  ["有尾随换行", "A1\nA2\nA3\n"],
  ["无尾随换行", "A1\nA2\nA3"],
] as const) {
  const hashes = c.split(/\r?\n/).map(hashLineContent);
  console.log(`Read(${label}): 行数=${c.split(/\r?\n/).length} 含空行哈希=${hashes.includes(empty)}`);
}
// Read(有尾随换行): 行数=4 含空行哈希=true
// Read(无尾随换行): 行数=3 含空行哈希=false
```

再用真 `readToolEntry` + 假 port 读一个 `"A1\nA2\nA3\n"` 文件，实测 `servedAnchors` 4 个且含
`hashLineContent("")`。所以 §7.2 的实际增量是「**没有 Read 也会**并进空行哈希」，不是凭空创造它。

</details>

<details>
<summary>§7.5：重复用例与临时脚本的复验命令</summary>

```bash
cd apps/zcode-cli/packages/core

# 重复用例已删（0 = 已删；保留的是带 §7.2 前缀那条）
grep -c 'test("空内容上渲染区域返回空结果' test/anchor-resolve.test.ts   # 0
grep -c 'test("§7.2 空内容上渲染区域返回空结果' test/anchor-resolve.test.ts  # 1

# 临时脚本目录已清
ls test/tmp                                                             # No such file or directory

# 用例数：anchor-resolve 27 → 26，全套 49 → 48
for f in test/*.test.ts; do echo "$(grep -c '^test(' $f) $f"; done
node --import tsx --test test/*.test.ts | tail -8
```

</details>

<details>
<summary>§7.6：hydrator 不按工具名特判（四组对照）</summary>

```ts
// 在 apps/zcode-cli/packages/core 下运行
import { hydrateReadFileStateFromSession } from "./src/agent/read-file-state-hydrator.ts";

const mkMeta = (path: string, tool: string, content: string) => ({
  readFileState: { schemaVersion: 1, tool, path, content, isPartialView: false,
    readAtMs: 1000, revisionId: "r1", mtimeMs: 1000, sizeBytes: content.length,
    servedAnchors: ["AAAA", "BBBB"] },
});
const errPart = (tool: string, path: string, meta: any) => ({
  id: "p1", type: "tool" as const, tool,
  state: { status: "error" as const, input: { file_path: path }, error: "boom", metadata: meta },
});
const msg = (parts: any[]) => [{ info: { id: "m1", role: "assistant" as const }, parts }] as never;

const run = async (label: string, parts: any[]) => {
  const st = new Map();
  const r = await hydrateReadFileStateFromSession({
    messages: msg(parts), readFileState: st as never,
    workingDirectory: "/tmp", workspaceRoot: "/tmp",
  });
  console.log(`${label}: restored=${r.restoredCount} size=${st.size}`);
};

await run("error 件 metadata 为空          ", [errPart("Write", "/tmp/a.ts", {})]);
await run("error 件带 Write 读状态        ", [errPart("Write", "/tmp/a.ts", mkMeta("/tmp/a.ts", "Write", "x"))]);
await run("error 件带 EditAnchored 读状态 ", [errPart("EditAnchored", "/tmp/b.ts", mkMeta("/tmp/b.ts", "EditAnchored", "x"))]);
await run("error 件 tool 名不认识         ", [errPart("EditAnchored", "/tmp/b.ts", mkMeta("/tmp/b.ts", "SomethingElse", "x"))]);
```

输出（第 2 行即「天然被跳过」不成立的证据）：

```
error 件 metadata 为空          : restored=0 size=0
error 件带 Write 读状态        : restored=1 size=1
error 件带 EditAnchored 读状态 : restored=1 size=1
error 件 tool 名不认识         : restored=0 size=0
```

</details>

<details>
<summary>§7.1：跨会话 reject-and-serve 端到端（两段会话）</summary>

```ts
// 在 apps/zcode-cli/packages/core 下运行；需要 stat / readTextFile / writeTextFile 三个方法的假 port
import { editAnchoredToolEntry } from "./src/tool/handlers/edit-anchored.ts";
import { hydrateReadFileStateFromSession } from "./src/agent/read-file-state-hydrator.ts";
import { createErrorResult, createToolHandlerFailureError } from "./src/tool/executor/errors.ts";
import { readFileStateMetadataField } from "./src/runtime/methods/tool-part-metadata.ts";
import { splitLines, hashLineContent, formatAnchor } from "./src/tool/anchor-hash.ts";
import { createReadFileStateKey } from "./src/tool/read-file-state.ts";
import { readFile, writeFile, stat } from "node:fs/promises";

// …构造 port 与 readFileState（同 §6 脚本），然后：
// 会话 1：外部改动 → EditAnchored 用旧锚点 → stale 拒绝
// 会话 1 落盘：createErrorResult(..., { readFileStateMetadata })
// 会话 2：hydrateReadFileStateFromSession
```

输出：

```
会话1 拒绝: true | 内存 served 含 v2: true
会话2 恢复条目数: 1 | v2 锚点恢复: true
```

**陷阱**：验证前必须让 Read 只传 `file_path`。范围读（传了 `limit`）按设计不跨 resume 恢复
（`isHistoricalFullReadWindow` 要求 `limit === undefined`），而模型习惯补 `limit: 2000`，
于是小文件也被当成范围读，resume 后连 Read 自己那份都不恢复，看不出这条修没修。

</details>

## 7.7 第五轮：锚点的两个「展示与登记不一致」出口（`731ac8f` 后）

`731ac8f` 把「锚点只能从 Read 得到」写进了描述。但描述层修不了**工具自身**在两条路径上
「把锚点展示给模型、却不登记进 served」的不一致——那是 §1/§2 同一类缺陷的另外两个出口。

### 7.7.1 附件提醒：伪装成 Read、带锚点、不登记 served

**现象**：用户发 `@file` 附件时，`conversation.ts` → `prompt-attachment.ts` 会构造一条
**伪装成 Read 调用**的系统提醒：

```
Called the Read tool with the following input: {"file_path":"/tmp/x.ts"}
Result of calling the Read tool:
1:3BND│# Title
2:RVM2│
```

内容来自 `formatReadTextOutput`（`read-text.ts:80` → `addReadLineNumbers`），**是完整锚点**。
但这条路径不写 `readFileState`（`attachments.ts`/`prompt-attachment.ts` 里 `servedAnchors`
出现 0 次），所以模型抄这些锚点去编辑必然 `unserved`。

**实测（真实运行，非读代码）**：同一份 5 行内容，附件提醒与 Read 输出**逐字相同的 5 个锚点**。

**为什么严重**：它比 Bash 那条更隐蔽——模型看到的是「一次成功的 Read」，没有任何线索
提示这些锚点不可用；而 Bash 至少没有锚点、模型不会误以为可用。

**DB 取证**：本机出现过带锚点的附件提醒（`sess_f7d418fa`），是测试期间往 `/tmp`
写文件时被当附件读进去的。真实用户 `@file` 会走同一条路。

**修法**：附件提醒**不再渲染锚点**。它本来就不是一次 Read，不该长成 Read 的样子。
用同一份内容渲染但去掉 `N:HASH│` 前缀（保留行号，便于模型理解结构）——
既不改变它「用户提供上下文」的定性，也不给出它给不了的可编辑承诺。

### 7.7.2 compact 清空 readFileState，但保留了带锚点的条目

**现象**：`compact-active.ts:649` 的 `readFileState.clear()` 把 served 集合归零；
而压缩按 `compact-selection.ts` 会**原样保留最近若干轮**，于是模型上下文里
**还留着带锚点的 Read 结果**，served 集合却已经空了。模型照抄眼前看得见的锚点 → `unserved`。

这与 `anchor-served.ts` 自己写下的不变量直接冲突：

> **只增不减**。文件内容变了也不清空——模型自己编辑一次后，它手里其余行的锚点仍然是被
> 展示过的，清掉会让这些锚点被误判为 unserved，逼模型重新读整个文件。

压缩正是同一件事：模型手里仍有锚点（条目被保留了），却被清空判为没看过。

**实测归因（全部 65 次 unserved，时序比对）**：

| 归因 | 次数 |
| --- | --- |
| 提交哈希 ≠ Read 展示的哈希（转写错误） | 18 |
| 完全没 Read 过 | 15 |
| 读过但锚点行不在读取范围内 | 10 |
| **读后被压缩清空** | **5** |
| 同名不同路径（读的是兄弟文件） | 1 |

对那 5 例做了决定性比对：**逐字比对提交哈希与 Read 展示哈希，5 例全部是转写错误**，
不是被压缩误伤。即本条**目前没有可证实的真实受害者**，是理论坑位而非正在流血的口子。

**结论：本条按「方向正确但无实证」对待——修，但改动要小，且必须不引入新语义。**

#### 修法（方案 A：压缩后用保留条目重建 served）

把裸 `clear()` 换成：清空读状态（保留原有语义），随后**用压缩后仍留在上下文里的
Read / EditAnchored 结果重建 served 子集**。

复用 §4/§7.1 已有的恢复路径思想，但**必须保持两种语义的分界**：

| 字段 | 语义 | 压缩后 |
| --- | --- | --- |
| `servedAnchors` | 「这行给模型看过」——随会话上下文走 | **按保留条目重建** |
| `content`/`mtimeMs`/`sizeBytes`/`revisionId` | 「文件未变」门禁依据——随磁盘事实走 | **不重建**（保持清空） |

**为什么门禁字段不能一起重建**：`getEditableReadStateFailure` 用它们判 stale
（`edit.ts:499-512`）。压缩不等于重新读盘，拿被保留条目的旧 mtime 当门禁基准，
会把「压缩后文件已被外部改过」判成「未变」——那是 §6 那类「凭一次未发生的读拿到写权限」的
同一个错误。**served 只增不减，门禁必须重新建立。**

**实现约束（已核实）**：
- 重建走**已保留条目**（`preservedEntries`），它们是 `RuntimeMessageEntry`，
  工具结果在 `message.role === "tool"` 且带 `toolName`；锚点正文在 `content` 文本里，
  用 `parseAnchorToken`/`ANCHOR_SEPARATOR` 解析（`anchor-hash.ts`）。
- 只认 `Read` 与 `EditAnchored` 的结果——与 hydrator 一致（`read-file-state-hydrator.ts` 已把
  `EditAnchored` 纳入，注释说明「只匹配 `Edit` 会让锚点编辑过的文件在 resume 后丢 served」）。
- 条目文本可能已被 microcompact 清空（`MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX`）：
  那种条目**没有**锚点，解析自然得空，不需特判。
- 重建出的条目用 `mergeServedAnchorsAfterRejection`（`edit-anchored.ts:280`）**同一个形状**：
  门禁字段按「没读全」处理（`isPartialView: true`、`content: ""`），只放 served。
  不新建写入路径，复用既有那个「served 需要有地方放」的保守条目。

### 7.7.3 验收

1. **附件提醒**：`buildPromptAttachmentReminderBodies({kind:"file", …})` 的输出
   不含 `N:HASH│` 前缀；同时 Read 自己的输出仍含（别把两处一起改掉）。
2. **压缩重建**：给定「保留条目里含带锚点的 Read 结果」，压缩后
   `readFileState` 的 served 集合含这些锚点，且门禁字段未被重建（条目 `isPartialView: true`、
   无 `content`）。
3. **门禁不受影响**：压缩后对同一文件发 `Edit`（未重新 Read），仍报 `File has not been read yet`
   ——压缩不得成为「凭保留条目拿到写权限」的捷径。

## 7.8 第六轮：`>>>` 问题行标记 + 解析器容错（三方实现对比后）

### 7.8.1 起因：对比 oh-my-openagent 与 oh-my-pi

三套独立实现的对比（各自 star 数都不低，说明这些取舍经过真实使用验证）：

| | ZCode | oh-my-openagent | **oh-my-pi** |
| --- | --- | --- | --- |
| 哈希粒度 | **行级** | 行级 | **文件级**（整文件一个 tag） |
| 引用形式 | `73:DG75` | `42#VK` | `[path#A1B2]` + 裸行号 |
| 哈希位宽 | 4 字符 base32 = 1,048,576 | 2 字符 = **256** | 4 位十六进制 = 65,536 |
| 算法 | FNV-1a 32 | XXH32 | XXH32 (`& 0xffff`) |
| 失配标记 | 仅范围 | `>>>` 标问题行 | **`*` 标问题行** |
| remaps | 无 | **有**（旧→新映射） | 无 |
| 自愈（唯一命中即移动） | **有** | 无 | 无（靠多版本历史） |
| 实现规模 | ~600 行 TS | ~6700 行 TS | 6712 行 Rust |

**收敛点**：三者都实现「读过才允许改」+「不猜」+「失配回传上下文」。
**分歧点**：`>>>` 标记 2/3 有（我们缺）；remaps 1/3 有（可选择不做）。

### 7.8.2 决定一：加 `>>>` 标记（2/3 实现收敛）

`formatAnchorRegion` 新增 `markedLine` 参数，在问题行前渲染 `>>> `，
并在标题里声明 `>>> marks line N`。**只影响可读性，不改变 served**——
带标记的行照旧进 `servedHashes`。

**为什么不只给范围**：原本回传 `Current anchors (lines 70-76)`，模型要在 7 行里
自己找哪一行才是它指的那行。实测那 7 行里通常有 2-3 个空行/符号行，定位成本真实存在。

### 7.8.3 决定二：解析器容忍标记与正文后缀（成对上线，不能只做一半）

**标记必须与容错同时上线**，否则是负优化：模型会连 `>>> ` 和行内正文一起抄回来
（`>>> 73:ZF8K│## 4. 真机验证`），而解析器只认裸锚点，于是**新增一类 malformed**。

`stripAnchorDecorations` 剥两样东西，都不碰锚点本体：
- 行首装饰：`>>> ` / `* ` / `+ ` / `- `（错误信息与 diff 的记号）
- 分隔符之后的正文：`22:AB3F│const x = 1;` → `22:AB3F`

**边界**：容错只针对**排版**，不放行垃圾。源码正文仍判 malformed——
`return normalizeThemePreference(x);` 必须继续被拒（有测试钉住）。

### 7.8.4 决定三：不加 remaps

`oh-my-openagent` 的 remaps（旧锚点 → 新锚点映射）**不做**，理由：

1. **我们有自愈**：哈希在文件内唯一命中时 `resolveEndpoint` 已自动移动
   （`shifted: true`），不需要告诉模型新锚点。
2. **它的 remaps 只在失配位置附近生成**，远处引用不更新，映射本身不完整。
3. **`oh-my-pi` 也没有**——2/3 实现不需要它。它只说「用当前 tag」，
   和我们现在「照抄回传的锚点」是同一策略。

### 7.8.5 决定四：**不改 3 位哈希**（关键：削弱「只改看过的行」）

这一条推翻了「3 位只是少 1 字符、碰撞略增」的直觉。真正的问题**不是歧义率**，
而是 **served 集合被击穿**：

```
实测（88 万行真实代码，逐行）：
  「该行哈希对应 ≥2 种不同内容」的行占比
    4 位: 0.060%
    3 位: 1.906%
    倍数: 32x
```

看起来 1.9% 很小，但它的后果是**安全保证失效**，构造性验证：

```
找一对「3 位碰撞、4 位不碰撞」的真实代码行：
  a = "const x12195 = 12195;"  3位=KS4  4位=KS4J
  b = "const y12195 = 85365;"  3位=KS4  4位=KS4B

served 集合 = {KS4}（模型只读过第 1 行）
用 900:KS4 编辑第 900 行（内容 b，模型从未读过）：
  3 位 → resolved（行号命中）★ 改了一个没看过的行
  4 位 → unserved（被拦下）
```

即：**3 位会把「只允许改模型看过的行」这条硬约束，从 0.06% 的可击穿面扩大到 1.9%**
（32 倍）。这不是「多几次 ambiguous 拒绝」——ambiguous 是响亮失败，这个是**静默放行**。

**token 收益也远小于直觉**（实测 2637 次 Read / 245,990 行）：

```
Read 输出总计        11,582,220 字符 ≈ 3,860,740 token
锚点整列(123:AB3F│)   2,176,608  占 18.79%
其中哈希列(AB3F│)     1,229,950  占 10.62%
第 4 位单独             245,990  占  2.12%   ← 改 3 位省的是这个
```

**结论**：省 2.12% 里的 1/4（≈82K token / 全库），换「读过的行」保证削弱 32 倍。
**不做**。若将来确实要压 token，该谈的是那 **10.62% 的哈希列**（oh-my-pi 的做法是
整列不显示，哈希只在文件头），而不是第 4 位。

### 7.8.6 验收

1. `formatAnchorRegion(content, 2, 1, 2)` 恰好一行带 `>>> `，且文本声明 `>>> marks line 2`。
2. 带标记的行出现在 `servedHashes` 里。
3. `markedLine` 落在窗口外时不标，也不声明。
4. `parseAnchorToken` 接受 `>>> 73:ZF8K`、`73:ZF8K│正文`、两者叠加、`ZF8K│正文`。
5. **`parseAnchorToken("return normalizeThemePreference(x);")` 仍是 malformed**（不容错垃圾）。
6. 端到端：照抄错误信息里带 `>>>` 的锚点重发，必须 `resolved`。
7. 压缩重建 served 的 `ANCHOR_LINE_PATTERN` 容忍 `>>> `——否则带标记的行会被漏掉。

## 7.9 第七轮：三条事前硬约束 + 两种失配的恢复动作 + 未看见行显式化

### 7.9.1 数据（本轮三个改动的依据）

**（a）失败原因的分布**（全库 757 次 `EditAnchored`）：

| 原因 | 次数 | 性质 |
| --- | --- | --- |
| `unserved`（该哈希从未展示过） | 66 | 最大头 |
| `ambiguous`（哈希多命中） | 55 | 次之 |
| malformed | 11 | — |
| `stale`（展示过但内容已变） | 9 | — |

**（b）恢复能力**：失败后同文件下一次编辑 **66.2% 一次就成功**，
连续失败链 109/16/3/1 条（1/2/3/4 次）。说明现有回传区基本够用。

**（c）13 次「下一步仍失败」里，3 次的回传区是 0 行**——那是 `hintLine < 1`
的裸哈希路径（`anchor-resolve.ts` 明确「无从指路，退回纯文本，不猜区域」）。
模型完全无路可走，只能自己猜 → 这正是自拼哈希的温床。

**（d）范围读占压倒多数且静默截断**：

```
Read 调用形态：整文件读 386，范围读(offset/limit) 2258   ← 85% 是范围读
范围读未读满时（传了 limit 但输出行数 < limit）：
  有告知「还有没看见的行」: 0
  静默截断: 256
带锚点的 Read 输出 2644 次里，声明过 partial view 的只有 6 次
```

即：**模型拿到 19 行，看不出文件还有几百行**。它随后按记忆写一个行号，
行号来自「上一个版本」或「想象中的文件」，就产生 `unserved`。

### 7.9.2 决定一：三条事前硬约束进描述（借鉴 oh-my-pi）

`oh-my-pi` 的 `prompts/hashline.md` 有三条我们缺的硬约束：

```
- Elisions UNSEEN: `…`, `..`, collapsed `N-M:` rows. NEVER hunk in/across one; `read` first.
- Numbers and `#TAG`: latest `read`/`search`; numbers are original, never shifted by hunks.
- Touch displayed lines only; undisplayed hunks REJECTED.
```

我们 `EditAnchored` 描述里只有一句「Only lines you have already read」，
**没有**覆盖这三件事。补进描述（判据与 §3.8 一致：事前指引能省下失败往返）。

**同时修一个失实**：`buildUpdatedAnchors` 用裸 `\n...\n` 连接不连续窗口，
那是个**没有标注的省略号**——模型可能把 `...` 当成文件里的真实行。
改为带行号范围的显式标记（见 7.9.4）。

### 7.9.3 决定二：两种失配的恢复动作分开（pi 的 seen_lines 思路）

`unserved` 与 `stale` 已是两个独立原因，但**恢复指引写得一样模糊**。
两者的正确动作不同：

| 原因 | 含义 | 正确动作 |
| --- | --- | --- |
| `stale` | 该哈希**展示过**，但内容已变（别人改了文件） | 用回传区的**新**锚点重发 |
| `unserved` | 该哈希**从未展示过**（编造 / 抄了他处的） | **必须 Read**，不能猜 |

描述与错误信息都要点明这个区别。另外 `unserved` 且 `hintLine < 1` 时
（回传区 0 行，见 7.9.1c），**改进指路方式**：不改「不猜区域」这条原则，
而是**让模型知道它的行号对不上**——这样它知道该重读而非继续猜。

### 7.9.4 决定三：未看见的行显式化

两处：

1. **`buildUpdatedAnchors` 的窗口间隔**：`\n...\n` → 带行号范围的显式省略标记，
   明示「这里省略了 N 行，不能在这上面编辑」。
2. **`Read` 的范围读**：截断时明确声明「还有多少行没显示」。
   现状是 2644 次里只有 6 次有声明——模型不知道自己没看全。

### 7.9.5 验收

1. `EditAnchored` 描述含三条硬约束（未看见的省略、行号是原始行号、只改展示过的行）。
2. `stale` 与 `unserved` 的错误信息给出**不同**的恢复指引。
3. `unserved` 且无行号可指时，错误信息告知「你的行号对不上」，而不是只说「重读」。
4. `buildUpdatedAnchors` 的窗口间隔是显式标记，不是裸 `...`。
5. `Read` 范围读截断时声明未显示的行数。

6. Edit 匹配侧的锚点前缀剥离容忍 `>>> `（模型可能把带标记的整行粘进 `old_string`）；
   只容忍 `>>>`——`*`/`+`/`-` 是 Markdown 列表语义，剥了会误伤正文。
7. `stale`/`unserved` 的文案必须不同：前者说「展示了但内容变了，拿新锚点重发即可」，
   后者说「从未展示过，必须 Read，继续猜会同样失败」。
