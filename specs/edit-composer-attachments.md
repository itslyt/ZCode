# 行内编辑用户消息时的附件支持（Edit Composer Attachments）

自用 fork 新增：编辑上一条用户消息时，只能改文本、不能加图片/文件。

## 问题

`editUserQuery` 协议本来就带 `attachments` 字段，但行内编辑框没有采集入口：

- 编辑框只传了 `showMentionButton` / `showSlashButton` / `enableWorkspaceFileDrop`
  （`ConversationRowView.tsx` 的 `ChatPromptEditor` 调用点），**没有** `attachmentAction`（+ 菜单）
  也**没有** `onPaste`（粘贴上传）。
- 结果：编辑态只能看到/删除原附件（`UserInputAttachmentList`），无法新增；粘贴图片无反应。

编辑框与正常输入框**是同一个组件** `ChatPromptEditor`（`ConversationRowView.tsx` vs
`ConversationComposer.tsx` 各有一个调用点）。所以这不是"换组件"，而是把 composer 已有的
插槽补上。

## 产品规则

- 编辑态左下角 + 菜单提供「添加图片/文件」，与 composer 同一入口语义（同一 i18n key、
  同一 testId 常量）。
- 编辑态支持粘贴图片/文件，与 composer 同一套剪贴板判定（`shouldPreferSpreadsheetClipboardText`、
  `shouldCreateClipboardTextAttachment` 等既有规则，不另写一套）。
- 原有附件保持可见、可删除；新增与原有附件在同一个编辑框里呈现，顺序为**原有在前、新增在后**。
- 编辑框支持把 OS 文件拖入上传（与 composer 同一套 drop 语义）。
- 提交门禁：任一附件未 ready 时不能提交（与 composer 的 `attachmentsReady` 同语义），
  避免把半上传的附件写进历史。
- 提交时始终传**当前完整列表**（含原有 + 新增 - 已删除）。协议侧语义：`attachments` 省略
  表示"沿用原附件"，显式 `[]` 表示"清空全部"——所以编辑必须始终显式传数组。
- 编辑态不提供 CUA 入口、后台任务入口（那些是"新任务"概念，与编辑历史消息语义不符）。

## 状态所有者

- **附件上传态的唯一所有者仍是 `useComposerAttachmentUploadStore`**，按
  `scopeKey = workspaceKey \0 scopeId` 分桶（`store/composerAttachmentUploadStore.ts`）。
- 编辑态使用**独立的 scopeId**（`edit:<rowId>`），不复用 composer 的 `draftScopeId`：
  否则编辑时加的附件会漏进主输入框，且主输入框清空会连带清掉编辑态附件。
- 上传控制器（`useComposerAttachments`）由编辑框自己实例化一次，持有该 scope 的
  upload/adopt 生命周期；不新增 store、不在行级组件里散落上传逻辑。
- **原有附件不进这个 scope**，继续由行级状态 `editAttachments: AttachmentRef[]` 持有。
  理由：原有附件的缩略图/预览是按 `attachmentIndex` 从该轮的持久 FilePart 分块读的
  （`UserInputAttachmentList` 的 `attachmentIndices` 语义），把它换成 scope 里的
  session-owned 副本会同时丢掉这条读取路径，并让同一份附件在两个状态里各存一遍。
  代价是编辑态附件有两个所有者，因此**只有一个写入点**：`handleSubmitEdit` 里
  `resolveEditAttachmentsForSubmit(editAttachments, await prepareForSend())` 合并一次。
- 编辑框只在编辑期间挂载（独立组件 `UserInputEditBox`），卸载即清空该 scope：
  `useComposerAttachments` 会在 window/document 上挂拖拽监听并订阅 runtime 换代，
  虚拟列表里每个可见 user 行常驻一份会白挂大量监听。

## 接口

- `packages/ui/src/v4/conversationRowContext.ts`：行级上下文新增 `attachmentPut`（上传端口）。
  `attachmentRead` / `attachmentReadRange` 已存在，不重复。
- `packages/ui/src/v4/SessionPane.tsx`：把 `useV4Conversation()` 已有的 `attachmentPut`
  注入 `rowContext`（它本来就在 SessionPane 作用域内，只是没往下传）。
- `packages/ui/src/v4/ConversationRowView.tsx`：编辑态渲染独立组件 `UserInputEditBox`
  （同文件内），由它实例化 `useComposerAttachments`（独立 scope），接 `attachmentAction` +
  `onPaste` + 拖拽上传，提交走 `prepareForSend()`。
- `packages/ui/src/v4/composer/ComposerAttachmentChips.tsx`：从 `ConversationComposer` 抽出的
  附件 chip 渲染（上传进度/失败重试/删除/预览），主输入框与编辑框共用同一条渲染路径；
  主输入框与编辑框只各自接自己的 `onRemove` / `onRetry`。
- `packages/ui/src/v4/composer/useComposerAttachments.ts`：新增 `exposeScopeKeyForE2E`
  （默认 true）。编辑 scope 必须传 false，否则编辑框一挂载就会覆盖 E2E 用例正在用的
  composer scopeKey。
- 协议、CLI、DB 均不改动：`editUserQuery.attachments` 本来就存在。

## 边界与失败语义

- 附件上限沿用 `MAX_CHAT_ATTACHMENTS`（与 composer 同一常量，不另设）。
- 上传失败沿用既有重试/错误提示（`attachmentError`）。
- 编辑取消 / 组件卸载：丢弃该 scope 的附件（含取消未发送的远端暂存与本地 object URL），
  不影响 composer 与其他行的编辑态。原有附件本来就是该轮的历史事实，不需要也不应回滚。
- 编辑提交被 CLI 判 `blocked`（文件回退不安全）：走既有冲突弹窗，附件状态保留，允许改选
  「仅重置对话」重提。

## 验收场景

1. 编辑一条带图片的消息：原有图片可见；点 + 添加新图片后两张都在；提交后新轮次带两张图。
2. 编辑态粘贴剪贴板图片：出现上传 chip，ready 后可提交。
3. 未 ready 时提交按钮禁用（或提交被拒）。
4. 删除全部附件后提交：新轮次无附件（不是"沿用原附件"）。
5. 编辑态加的附件不出现在主输入框；主输入框的附件也不出现在编辑态。
6. 取消编辑：编辑态附件被丢弃，主输入框不受影响。
7. 单测：编辑态附件列表合并顺序与「显式空数组」语义（`editAttachmentMerge.ts`）。
8. 编辑态加的附件不出现在主输入框，取消编辑后该 scope 被清空。
