import type { AnchorFailureReason } from "./anchor-resolve.js";
import type { ToolHandlerFailure } from "./types.js";

/**
 * `EditAnchored` 的失败分类。
 *
 * 单独成模块有两个理由：一是失败原因是这个工具对外的稳定契约（日志、统计、后续调优都要按它
 * 分组），不该埋在 handler 的业务流程里；二是 handler 已经接近本包 400 行的硬限制，失败分类
 * 与「怎么编辑」本来就是两件事。
 */

/**
 * 失败原因码。数值只在 EditAnchored 命名空间内唯一（同 `task-output` 用 1/2、
 * `resolve-workflow-question` 用 21-24 的惯例），跨工具不冲突，靠日志里的 `toolName` 区分。
 *
 * 为什么不用一个通用码：`tool.call.failed` 日志与 `ToolExecutionResult.error.code` 都只带码，
 * 原因若只活在消息文本里，之后想统计报错分布就只能解字符串（本仓明确禁止依赖错误文本做
 * 判断）。有了码就能直接按 `toolName + error.context.code` 分组。
 */
export const EDIT_ANCHORED_ERROR_CODE = {
  MALFORMED_ANCHOR: 1,
  UNSERVED_ANCHOR: 2,
  STALE_ANCHOR: 3,
  AMBIGUOUS_ANCHOR: 4,
  REVERSED_RANGE: 5,
  OVERLAPPING_EDITS: 6,
  NOTEBOOK_FILE: 7,
} as const;

/**
 * 声明成 `Record<AnchorFailureReason, number>` 而不是普通对象：新增一个 reason 时这里编译不过，
 * 逼着补码，不会默默落到默认值上。
 */
export const ANCHOR_FAILURE_ERROR_CODE: Record<AnchorFailureReason, number> = {
  malformed_anchor: EDIT_ANCHORED_ERROR_CODE.MALFORMED_ANCHOR,
  unserved: EDIT_ANCHORED_ERROR_CODE.UNSERVED_ANCHOR,
  stale: EDIT_ANCHORED_ERROR_CODE.STALE_ANCHOR,
  ambiguous: EDIT_ANCHORED_ERROR_CODE.AMBIGUOUS_ANCHOR,
  reversed_range: EDIT_ANCHORED_ERROR_CODE.REVERSED_RANGE,
};

export function createEditAnchoredFailure(
  errorCode: number,
  message: string,
): ToolHandlerFailure {
  return { result: false, errorCode, message };
}
