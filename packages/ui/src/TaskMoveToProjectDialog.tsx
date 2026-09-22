import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { resolveTaskMoveBlockedReason } from "@/lib/taskMoveEligibility.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTaskMoveToProjectStore } from "@/store/taskMoveToProjectStore.js";
import { useWorkspaceDisplayNameStore } from "@/store/workspaceDisplayNameStore.js";

function resolveWorkspaceKey(workspacePath: string, workspaceIdentity?: string | null): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/**
 * 会话移动到其他项目：只列本地可用项目（远程项目既不能作为源也不能作为目标），
 * 选中即执行——移动是 re-key，不改 session id / 历史 / 用量，失败可重试。
 */
export function TaskMoveToProjectDialog() {
  const { intl } = useZCodeIntl();
  const request = useTaskMoveToProjectStore((state) => state.request);
  const settle = useTaskMoveToProjectStore((state) => state.settle);
  const tabs = useTabStore((state) => state.tabs);
  const displayNames = useWorkspaceDisplayNameStore((state) => state.names);
  const [moving, setMoving] = useState(false);
  const sourceWorkspaceState = useZCodeSessionStore((state) =>
    request
      ? state.getWorkspaceState(request.task.workspacePath, request.task.workspaceIdentity)
      : undefined,
  );

  // 运行中与远程来源不允许移动：运行中的会话 cwd 已绑定源目录；
  // 远程 workspace 的会话与本地项目不同源，v1 不支持。
  const blockedReasonId = useMemo(() => {
    if (!request) {
      return null;
    }
    const task = request.task;
    return resolveTaskMoveBlockedReason({
      task,
      runtimeStatus: sourceWorkspaceState?.taskRuntimeByTaskId[task.taskId]?.status,
    });
  }, [request, sourceWorkspaceState]);

  const candidates = useMemo(() => {
    if (!request) {
      return [];
    }
    const currentKey = resolveWorkspaceKey(
      request.task.workspacePath,
      request.task.workspaceIdentity,
    );
    return tabs
      .filter(isWorkspaceTab)
      .filter(
        (tab) =>
          !tab.remoteSessionId?.trim() &&
          !tab.remoteTarget &&
          !tab.workspaceIdentity?.trim() &&
          tab.availability !== "unavailable-local-directory",
      )
      .map((tab) => {
        const key = resolveWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
        return {
          key,
          workspacePath: tab.workspacePath,
          label: displayNames[key]?.trim() || tab.label,
        };
      })
      .filter((candidate) => candidate.key !== currentKey);
  }, [displayNames, request, tabs]);

  const handleMove = async (candidate: { workspacePath: string }) => {
    if (!request || moving || blockedReasonId) {
      return;
    }
    setMoving(true);
    try {
      await request.zcodeTaskService.moveTask({
        taskId: request.task.taskId,
        workspacePath: request.task.workspacePath,
        ...(request.task.workspaceIdentity
          ? { workspaceIdentity: request.task.workspaceIdentity }
          : {}),
        targetWorkspacePath: candidate.workspacePath,
      });
      // 源项目不能再留着这个任务的打开态：pane 绑的是源 workspace，继续用会把旧根目录
      // 和旧 Environment 提示词一直用下去（实测：同一 pane 里再问仍是源目录）。
      // 清掉选中后，从目标项目重新打开会走 resume，按新的 session.directory 生效。
      const sessionStore = useZCodeSessionStore.getState();
      const sourceState = sessionStore.getWorkspaceState(
        request.task.workspacePath,
        request.task.workspaceIdentity,
      );
      if (sourceState?.activeTaskId === request.task.taskId) {
        sessionStore.setActiveTaskId(
          request.task.workspacePath,
          null,
          request.task.workspaceIdentity,
        );
      }
      toast(intl.formatMessage({ id: "taskList.movedToProject" }));
      settle();
    } catch (error) {
      logger.error("[TaskMoveToProjectDialog] 移动 task 失败:", error);
      toast(intl.formatMessage({ id: "taskList.moveToProjectFailed" }));
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) {
          settle();
        }
      }}
    >
      <DialogContent className="max-w-md overflow-hidden rounded-2xl p-0">
        <div className="flex min-w-0 flex-col gap-4 p-6">
          <DialogHeader className="space-y-2">
            <DialogTitle>{intl.formatMessage({ id: "taskList.moveToProjectTitle" })}</DialogTitle>
          </DialogHeader>
          {blockedReasonId ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: blockedReasonId })}
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "taskList.moveToProjectEmpty" })}
            </p>
          ) : (
            <div className="flex max-h-80 min-w-0 flex-col gap-1 overflow-y-auto">
              {candidates.map((candidate) => (
                <Button
                  key={candidate.key}
                  type="button"
                  variant="ghost"
                  className="h-9 min-w-0 justify-start px-3"
                  disabled={moving}
                  onClick={() => {
                    void handleMove(candidate);
                  }}
                >
                  <span className="min-w-0 truncate">{candidate.label}</span>
                </Button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-end">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 px-5"
              onClick={settle}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
