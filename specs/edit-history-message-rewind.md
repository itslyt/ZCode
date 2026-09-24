# 编辑历史消息：放开 latest-only 门控 + 文件级联回滚 + 发送前确认

> 目标：让用户能像编辑最后一条那样编辑任意历史 realUser 消息。语义是**原地编辑 = 截断该轮及之后的全部对话**，文件改动按 cascade 一并重置；发送前必须经过一次确认，确认框默认动作是「仅修改对话」。
> 非目标：retry 仍保持 latest-only；不改文件摘要面板的「撤销本轮文件」语义；不新增快照/artifact 回收（见 §6）。

## 0. 产品决策（用户已定）

1. **文件语义 = cascade**。编辑第 3 轮 → 第 3 轮及其之后所有轮次的文件改动一并重置。理由：对话被截断到第 3 轮，若文件只回滚第 3 轮，第 4~N 轮改的文件仍在盘上，与截断后的对话矛盾（且后续轮的 checkpoint 会基于已回滚的内容再次回滚，产生冲突）。
2. **撤销 = 提交前的取消**。编辑框是纯 UI 本地状态，只有确认框里的按钮才 dispatch 命令；点取消/关闭不产生任何回滚。一旦确认即真回退，**不提供**发送后的撤销（`clearRevert` 至今无调用者，本 spec 不新增）。
3. **UI = 原地编辑**。不采用 dsh 的「内容回填到 composer」形态，保持现有行内编辑框；只是把编辑入口挂到历史消息上。
4. **删掉编辑框里的「与文件一起重置」按钮**。它点击即发送、没有二次确认，是本次事故的直接原因。
5. **改为发送时确认**：点发送后展开确认面板；**默认回车 = 仅修改对话**；左侧按钮 = 对话和代码一起回退；目标轮没有可安全回滚的文件改动时，左侧按钮不展示。

## 1. 现状机制（已读代码确认）

### 1.1 编辑 = 换文本的 retryTurn

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/fork-edit-retry.ts:4`

```
editUserQuery = 换文本的 retryTurn：rewind 截断该 turn → 原生 prompt turn 重发新文本
```

截断走 `submitConversationRewind` → `runtime.rewindConversationToMessage`（同文件 `:104`），策略必须是 `RewindStrategy.ActiveChain`（`:109`），即把锚点之后的整条活跃链切掉。

### 1.2 文件重置当前是 per-turn，且与对话截断原子提交

`workspaceMode === "rewind"` 时（`fork-edit-retry.ts:150-205`）：

1. `previewWorkspaceFileRewind({ targetMessageIds: getMessageIdsForTurnRow(rowId), targetTurnId })`（`:160`）—— **fail closed**：`!canApply || ignoredFiles.length > 0 || safeFiles.length === 0` 即整体拒绝，返回 `disposition: "blocked"`（`:162-183`）。
2. `applyWorkspaceFileRewind({ ...fileOptions, commitAfterApply })`（`:184`）—— 逐文件 journal 补偿（`core/src/runtime/methods/file-rewind.ts`），**branch cut 只在所有文件写成功后的 `commitAfterApply` 里提交**。全有或全无。

`getMessageIdsForTurnRow` 按 `candidate.turnId !== row.turnId → continue` 过滤（`product-projection.ts`），所以**文件范围只有目标轮，不是 cascade**。这是本次要改的点。

core 里已有 cascade 的完整实现：`rewindWorkspaceCascadeToMessage`（`rewind-message.ts:152-196`）用 `activeSuffixMessageIdsForRewind`（`helpers/rewind.ts:137`）从 `readActiveMessagesForWorkspaceRewind` 的活跃消息集里取后缀。本 spec 复用这一套，**不新增第二条 messageId 计算路径**。

### 1.3 三层 latest-only 门控

| 层            | 位置                                                                                                                 | 行为                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 投影 action   | `product-projection.ts` `materializeCommandRowActions`：从后往前扫第一条 realUser；只给该行 `canEdit`，其余 `delete` | 决定 UI 是否显示编辑按钮 |
| entityId 直查 | `product-projection.ts` `resolveEditTargetByEntityId`：`entityId !== currentEditableEntityId → null`                 | 防直查绕过               |
| 命令兜底      | `fork-edit-retry.ts` 抛 `V4EditTargetNotLatestError`（`guard.latestQueryEditOnly`）                                  | 防御闸                   |

**两个死门（勿被名字带偏）**：`isLatestEditableUserRow` 与 `isLatestRetryAssistantRow` 在全仓库**没有任何调用点**。真正生效的是 `resolveRowActionTarget` 读 `row.actions`。

### 1.4 UI 已经是数据驱动的

`ConversationTurnGroup.tsx:678`：

```tsx
onEdit={item.row.actions?.canEdit === true ? onEdit : undefined}
```

UI 不自行判定 latest。`editWorkspaceRewindAvailability` 按轮计算（`ConversationTurnGroup.tsx:1222`），历史轮同样具备 `canRewindFiles`。

**因此放开编辑门不需要改 UI 逻辑**，只需 Host 下发 `canEdit`。

### 1.5 数据层面已经齐备

`registerCanonicalUserRowTarget` 对每条 realUser 行登记完整 edit target，历史行的 `transcriptMessageId` 可用。`rewindConversationToMessage` 对任意 user messageId 都能工作。**不需要补采集。**

## 2. 设计

### 2.1 状态所有者

- **可编辑集合**：`product-projection.ts` 的 projection 是唯一所有者。`currentEditableEntityId: string | null` 改为 `editableEntityIds: Set<string>`，在 `materializeCommandRowActions` 内与 row actions 同一次归约中整体替换（保证 action 与 resolver authority 不分叉，沿用原单值字段的约束）。
- **文件目标集**：core runtime 是唯一所有者。bootstrap 只传「从哪个 messageId 开始 cascade」，不自己算 messageId 集合。
- **编辑框草稿 + 确认面板开关**：UI 本地状态，不落服务端。提交前取消不产生任何副作用。

### 2.2 投影层：单值改集合

`materializeCommandRowActions`：

- 扫描逻辑从「取第一条 realUser」改为「收集全部 realUser rowId」；`compactActive` 时集合为空（沿用原有 guard）。
- 每行的 messageId/editTarget 双重校验分别执行，只把校验通过的行放进集合。
- 只读集合成员判定替代 `row.rowId === latestEditableRowId`。
- `this.currentEditableEntityId = ...` 改为 `this.editableEntityIds = <新集合>`。

`resolveEditTargetByEntityId`：

```ts
// 改前：单值比较
if (entityId !== this.currentEditableEntityId) return null;
// 改后：集合成员判定
if (!this.editableEntityIds.has(entityId)) return null;
```

克隆/候选恢复路径同步。`isLatestEditableUserRow` 保留原实现不动（无调用者），注释更新为「仅表示『是否可编辑』，不再蕴含 latest」。

### 2.3 core：文件级联回滚

`previewWorkspaceFileRewind` / `applyWorkspaceFileRewind` 的 options 增加 `cascade?: boolean`：

```ts
options: {
  abortSignal?: AbortSignal;
  cascade?: boolean;        // 新增：从 targetMessageId 起级联到活跃分支末尾
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  targetMessageIds?: MessageId[];
  targetTurnId?: TurnId;
  traceContext?: TraceContext;
}
```

`buildWorkspaceFileRewindPlan` 内在解析 checkpoints 前展开：

```ts
// cascade 与显式 targetMessageIds 互斥；cascade 时由 runtime 按活跃分支展开，
// 避免调用方自己拼 messageId 集合而与 activeSessionMessages 口径分叉。
const targetMessageIds =
  options.cascade && options.targetMessageId
    ? await resolveCascadeMessageIds.call(this, options.targetMessageId)
    : options.targetMessageIds;
```

`resolveCascadeMessageIds` 复用既有 `readActiveMessagesForWorkspaceRewind`（从 `rewind-message.ts` 导出）与 `activeSuffixMessageIdsForRewind`，与 `rewindWorkspaceCascadeToMessage` 保持完全一致的语义。

**降级规则**：cascade 展开结果为空（目标 messageId 不在活跃分支里，例如已被裁掉）时，退回 `[targetMessageId]` 单值语义，与 `rewindWorkspaceCascadeToMessage` 的 `suffixMessageIds.length > 0 ? suffixMessageIds : [targetMessageId]` 一致。

### 2.4 handler：去掉兜底拒绝，改用 cascade

`fork-edit-retry.ts`：

- 删除 `V4EditTargetNotLatestError` 及其抛出点 —— `resolveRowActionTarget` 返回 `guard.actionUnavailable` 已足够表达「不可编辑」。
- `fileOptions` 改为 `{ cascade: true, targetMessageId: editTarget.transcriptMessageId, targetTurnId, traceContext }`，不再调 `getMessageIdsForTurnRow`。
- 「文件已提交则跳过对话截断」逻辑不变。

`retryTurn` **保持 latest-only 不动**，`V4RetryTargetNotLatestError` 保留。

### 2.5 UI：确认面板

`ConversationRowView.tsx` 行内编辑态：

- 删除编辑框里的「与文件一起重置」按钮（`onResetConversationAndFiles` 那条路径的入口）。
- 发送按钮/回车先打开确认面板（本地 state `pendingConfirm: boolean`），不直接 dispatch。
- 确认面板渲染在编辑框正下方（与编辑框同容器），文案：

```
确认发送？
所有代码变更都将被回退到该对话发生之前，且后续的对话记录将会被清除，是否继续？
```

- 按钮布局：
  - 左：**对话和代码一起回退** → `workspaceMode: "rewind"`。当 `editWorkspaceRewindAvailability` 表示本轮无可安全回滚的文件改动时，**不渲染该按钮**。
  - 右：**仅修改对话**（主按钮，带 `⏎` 提示）→ `workspaceMode: "preserve"`。**Enter 触发它**。
- 关闭（X）或 Esc：关闭面板，保留编辑内容，不发命令。
- 面板打开期间编辑内容不可改（避免确认对象与草稿不一致）；关闭后恢复可编辑。

### 2.6 事件顺序

```
用户点历史消息的编辑按钮
  → UI 进入行内编辑（纯本地状态）
  → [取消] 丢弃本地状态，无副作用
  → [发送] 打开确认面板（不 dispatch）
       → [X / Esc] 关闭面板，保留草稿
       → [仅修改对话 ⏎]   dispatch editUserQuery { workspaceMode: "preserve" }
       → [对话和代码一起回退] dispatch editUserQuery { workspaceMode: "rewind" }
            ├─ resolveRowActionTarget（读 row.actions.canEdit）
            ├─ mapAttachmentRefsToTurnAttachments   ← 附件映射必须在截断前，避免半程失败
            ├─ preemptActiveTurnAndWait             ← 掐掉正在跑的轮次
            ├─ previewWorkspaceFileRewind(cascade)  ← fail closed，失败即 blocked
            └─ applyWorkspaceFileRewind(commitAfterApply)
                 ├─ 逐文件写盘（journal 可补偿）
                 └─ commitAfterApply: rewindConversationToMessage → branch cut
                      └─ RewindTriggered → 投影自收口
            └─ startCanonicalIntent（重发 newText）
```

## 3. 验收场景

| #   | 场景                                          | 期望                                                            |
| --- | --------------------------------------------- | --------------------------------------------------------------- |
| 1   | 有 3 轮对话，编辑第 1 轮                      | 第 1/2/3 轮都显示编辑按钮                                       |
| 2   | 编辑第 1 轮 → 发送 → 点「仅修改对话」         | 对话只剩第 1 轮的新文本及其回复；第 2/3 轮消失；文件不动        |
| 3   | 编辑第 1 轮 → 发送 → 点「对话和代码一起回退」 | 同上，且第 1/2/3 轮的文件改动全部回滚                           |
| 4   | 编辑第 1 轮 → 发送 → 关闭确认面板             | 无任何变化；对话与文件都不动；草稿保留                          |
| 5   | 编辑第 1 轮 → 发送 → 按 Enter                 | 等价于「仅修改对话」，文件不动                                  |
| 6   | 目标轮无可安全回滚文件（如只有 shell 写入）   | 确认面板只有「仅修改对话」，左侧按钮不渲染                      |
| 7   | 编辑第 1 轮（rewind），第 2 轮有 shell 写入   | preview fail closed → `disposition: "blocked"`；UI 提示只改对话 |
| 8   | compact 进行中                                | 所有行的编辑按钮都不显示                                        |
| 9   | 对历史 assistant 点 retry                     | 仍被 `guard.latestAssistantRetryOnly` 拒绝（非目标）            |
| 10  | 文件摘要面板「撤销本轮文件」                  | 仍只回滚该轮（per-turn 语义不变）                               |
| 11  | 编辑第 1 轮后立刻编辑新的第 1 轮              | 第二次编辑可用（集合在每次 materialization 重算）               |

## 4. 影响面

| 文件                                                                   | 改动                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| `bootstrap/src/zcode-protocol-v4/product-projection.ts`                | 单值 → 集合；扫描收集全部 realUser                 |
| `bootstrap/src/zcode-protocol-v4/commands/handlers/fork-edit-retry.ts` | 删 latest-only 兜底；fileOptions 改 cascade        |
| `core/src/runtime/methods/file-rewind.ts`                              | 新增 `cascade` 选项 + 目标集展开                   |
| `core/src/runtime/methods/rewind-message.ts`                           | 导出 `readActiveMessagesForWorkspaceRewind` 供复用 |
| `core/src/runtime/internal-turn-methods.ts`                            | 两个方法的签名加 `cascade?`                        |
| `ui/src/v4/ConversationRowView.tsx`                                    | 删「与文件一起重置」按钮；新增确认面板             |
| `ui/src/i18n/locales/*.ts`                                             | 新增确认面板文案 key                               |

不改：`ConversationTurnGroup.tsx`（已是数据驱动）、`ConversationFileSummaryPanel.tsx`（per-turn 撤销语义不变）、`rewind-message.ts` 的 cascade 实现（复用）。

## 5. 已识别的遗留风险（本次不修，记录待决）

| 风险                              | 说明                                                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 动态 workflow 泄漏                | `cancelRemovedBranchBackgroundTasks` 按 `task.turnId` 匹配，而 run 进度事件**刻意不带 turnId**。被删轮次启动的 workflow 会继续跑并往截断后的会话写进度行。放开历史编辑后此路径可达。                                                      |
| `coveredByStableCompact` 是死字段 | `product-projection.ts` 写入、**全仓库零读取**。命名意图像「跨压缩边界不允许编辑」，实际从未生效。`evaluateRewindTarget` 对 compact 覆盖目标的策略是 `ActiveChain` + `covered_by_compact_active_branch_rebuild`，设计上允许，故暂不接线。 |
| 无发送后撤销                      | `clearRevert` 在 `session-store.port.ts` 有定义、零调用者。旧消息仍在 append-only store，但产品无入口切回。本次沿用「确认即终态」。                                                                                                       |
| 轮内 steer 可作锚点               | `isRewindableUserPrompt` 只判 `role === "user" && !summary`，steer 消息也能当锚点 → 截断点落在轮中间。本次编辑入口只挂 `origin === "realUser"`，不暴露 steer。                                                                            |

## 6. 快照/artifact 回收（独立议题，本 spec 不实现）

本次改动**不新增任何快照存储**：编辑历史复用的是既有的 per-turn workspace checkpoint（`CheckpointCreated` → `~/.zcode/cli/artifacts/<sessionId>/`），cascade 只是把「选哪些 checkpoint」从单轮扩成后缀，不产生新文件。

但**存量问题确实存在且与本次改动无关**：`retention: "session"` 写入后 `NodeToolArtifactStore` 从不读取，全仓库无 GC/sweep/retention job，目录只增不减（实测 89 MB / 39 个 session）。放开历史编辑会让 checkpoint 的**读取范围**变大（要读更多历史 checkpoint 才能算 cascade 计划），从而放大「历史 checkpoint 缺失导致 preview fail closed」的概率，所以建议紧随其后补一档最小回收：

- 按不活跃天数删除整个 `<sessionId>` 目录（目录级 prune，与 ZCode「每 session 一目录」的布局天然契合）。
- 需要先确认 `retention: "project" | "temporary"` 两个枚举值的预期语义，否则无法定义保留边界。
- 不建议照搬 dsh 的 link-aware 去重淘汰：ZCode checkpoint 是 JSON 内嵌 `beforeContent`、无 content-hash 去重链，复杂度不在一个量级。
