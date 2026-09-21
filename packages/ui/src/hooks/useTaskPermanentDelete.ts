import { useCallback } from "react";
import type { IZCodeTaskService } from "@zcode/services";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import { toast } from "@/components/ui/toast.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

/**
 * 会话彻底删除入口：二次确认后调用 task service 删除（tombstone + 物理删除 CLI 数据），
 * 成功后移除列表缓存并换代 membership。失败 toast，列表保持原状。
 */
export function useTaskPermanentDelete(options: {
  zcodeTaskService: Pick<IZCodeTaskService, "deleteTask">;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const { zcodeTaskService, workspacePath, workspaceIdentity } = options;

  return useCallback(
    async (task: { taskId: string; title: string }) => {
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
    [confirmDialog, intl, workspaceIdentity, workspacePath, zcodeTaskService],
  );
}
