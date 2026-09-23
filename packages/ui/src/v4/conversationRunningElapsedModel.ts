import type { ConversationTurnWorkSegment } from "@/v4/conversationTurnWorkSegments.js";

/**
 * 执行中底部时长条的取数口径。
 *
 * 只认最后一个视觉工作段：guide 切段后前段已冻结（`activeMs` 固定），
 * 整轮累计值会在中途跳变，用户看到的「工作了多久」应当是当前这一段。
 */
export function resolveRunningWorkElapsedMs(unit: {
  isRunning: boolean;
  workSegments?: readonly ConversationTurnWorkSegment[];
}): number | undefined {
  if (!unit.isRunning) return undefined;
  const segment = unit.workSegments?.at(-1);
  if (segment?.workStatus?.state !== "running") return undefined;
  return segment.workStatus.durationMs;
}
