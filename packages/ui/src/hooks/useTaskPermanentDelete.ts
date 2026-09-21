import { useCallback } from "react";
import type { IZCodeTaskService } from "@zcode/services";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import { toast } from "@/components/ui/toast.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

export interface TaskPermanentDeleteTarget {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 会话彻底删除入口：二次确认后调用 task service 删除（tombstone + 物理删除 CLI 数据），
 * 成功后移除列表缓存并换代 membership。失败 toast，列表保持原状。
 * 目标与 service 在调用时传入，兼容多 workspace 列表（时间线/置顶区按条目解析 service）。
 */
export function useTaskPermanentDelete() {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();

  return useCallback(
    async (
      task: TaskPermanentDeleteTarget,
      zcodeTaskService: Pick<IZCodeTaskService, "deleteTask">,
    ) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "confirmDialog.taskDeleteTitle" }),
        description: intl.formatMessage(
          { id: "confirmDialog.taskDeleteDescription" },
          { taskTitle: task.title },
        ),
        confirmLabel: intl.formatMessage({ id: "taskList.delete" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) {
        return;
      }
      const { workspacePath, workspaceIdentity } = task;
      try {
        await zcodeTaskService.deleteTask({
          taskId: task.taskId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
        bumpTaskListMembershipVersion();
        removeTaskFromTaskCaches({ workspacePath, workspaceIdentity, taskId: task.taskId });
      } catch (error) {
        logger.error("[useTaskPermanentDelete] 删除 task 失败:", error);
        toast(intl.formatMessage({ id: "taskList.deleteFailed" }));
      }
    },
    [confirmDialog, intl],
  );
}
