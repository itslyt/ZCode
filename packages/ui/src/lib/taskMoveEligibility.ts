import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import type { ZCodeTaskMeta, ZCodeTaskRuntimeStatus } from "@zcode/shared";

const RUNNING_RUNTIME_STATUSES = new Set<ZCodeTaskRuntimeStatus>([
  "creating",
  "restoring",
  "streaming",
]);

export type TaskMoveBlockedReasonId =
  | "taskList.moveToProjectRemoteBlocked"
  | "taskList.moveToProjectRunningBlocked"
  | "taskList.moveToProjectOpenBlocked";

/**
 * 会话移动的准入判断（返回 null 表示可移动）。
 * - 远程来源：会话与本地项目不同源，v1 不支持。
 * - 运行中：任务 cwd 已绑定源目录，改绑定会让运行中的会话与新根目录不一致。
 * - 正在打开：pane 带着源 workspace 重新 resume 时会把目录写回源项目，等于撤销移动。
 */
export function resolveTaskMoveBlockedReason(params: {
  task: Pick<ZCodeTaskMeta, "status" | "workspaceIdentity">;
  runtimeStatus?: ZCodeTaskRuntimeStatus;
  activeTaskId?: string | null;
  taskId: string;
}): TaskMoveBlockedReasonId | null {
  const sourceIdentity = params.task.workspaceIdentity?.trim();
  if (sourceIdentity && isRemoteWorkspaceIdentity(sourceIdentity)) {
    return "taskList.moveToProjectRemoteBlocked";
  }
  if (
    params.task.status === "running" ||
    (params.runtimeStatus !== undefined && RUNNING_RUNTIME_STATUSES.has(params.runtimeStatus))
  ) {
    return "taskList.moveToProjectRunningBlocked";
  }
  if (params.activeTaskId === params.taskId) {
    return "taskList.moveToProjectOpenBlocked";
  }
  return null;
}
