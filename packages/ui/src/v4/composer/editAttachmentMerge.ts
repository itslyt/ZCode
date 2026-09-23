import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";

/**
 * 行内编辑提交时的附件列表口径。
 *
 * 编辑态的附件来自两个所有者：
 * - `originalRefs`：该轮原有的附件，已由 session 接管（`referenceOwnership: "session"`），
 *   用户可逐个删除，所以这里传进来的就是「删完之后剩下的」；
 * - `addedRefs`：本次编辑新加并已 ready 的附件。
 *
 * 提交顺序固定为原有在前、新增在后，与编辑框里的可见顺序一致；不做去重，
 * 与主输入框一致（同一文件可被有意添加多次）。
 *
 * 注意：返回空数组时**必须**显式传给 `editUserQuery`。协议里 `attachments` 缺省表示
 * 「沿用 canonical 原附件」，只有显式 `[]` 才能表达「用户删光了」。
 */
export function resolveEditAttachmentsForSubmit(
  originalRefs: readonly AttachmentRef[],
  addedRefs: readonly AttachmentRef[],
): AttachmentRef[] {
  return [...originalRefs, ...addedRefs];
}
