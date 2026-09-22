import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import type { ZCodeTaskMeta, ZCodeTaskRuntimeStatus } from "@zcode/shared";

const RUNNING_RUNTIME_STATUSES = new Set<ZCodeTaskRuntimeStatus>([
  "creating",
  "restoring",
  "streaming",
]);

export type TaskMoveBlockedReasonId =
  | "taskList.moveToProjectRemoteBlocked"
  | "taskList.moveToProjectRunningBlocked";

/**
 * 会话移动的准入判断（返回 null 表示可移动）。
 * - 远程来源：会话与本地项目不同源，v1 不支持。
 * - 运行中：运行中的会话 cwd 已绑定源目录，改绑定会让它和新根目录不一致。
 *   持久化的 running 可能滞后，有本地 runtime 状态时以它为准（与列表展示同一套语义）。
 *
 * 不拦「任务当前在 pane 里打开」：resume 不写回 session.directory（只有 create/legacy 修复会写），
 * 打开中的 pane 只是继续用旧 workspace 跑，任务在目标项目重开后即生效。
 */
export function resolveTaskMoveBlockedReason(params: {
  task: Pick<ZCodeTaskMeta, "status" | "workspaceIdentity">;
  runtimeStatus?: ZCodeTaskRuntimeStatus;
}): TaskMoveBlockedReasonId | null {
  const sourceIdentity = params.task.workspaceIdentity?.trim();
  if (sourceIdentity && isRemoteWorkspaceIdentity(sourceIdentity)) {
    return "taskList.moveToProjectRemoteBlocked";
  }
  const running =
    params.runtimeStatus !== undefined
      ? RUNNING_RUNTIME_STATUSES.has(params.runtimeStatus)
      : params.task.status === "running";
  if (running) {
    return "taskList.moveToProjectRunningBlocked";
  }
  return null;
}
