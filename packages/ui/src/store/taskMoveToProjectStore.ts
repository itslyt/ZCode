import { create } from "zustand";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";

/**
 * 「移动到项目」对话框的请求桥：菜单在各列表深处，对话框在 App 层挂载一次。
 * service 随请求带上（各列表按自己的 workspace 解析 service），避免对话框再走一遍服务查找。
 */
export interface TaskMoveToProjectRequest {
  task: ZCodeTaskMeta;
  zcodeTaskService: Pick<IZCodeTaskService, "moveTask">;
}

interface TaskMoveToProjectStoreState {
  request: TaskMoveToProjectRequest | null;
  requestMove: (request: TaskMoveToProjectRequest) => void;
  settle: () => void;
}

export const useTaskMoveToProjectStore = create<TaskMoveToProjectStoreState>((set) => ({
  request: null,
  requestMove: (request) => set({ request }),
  settle: () => set({ request: null }),
}));

export function useRequestTaskMoveToProject(): (request: TaskMoveToProjectRequest) => void {
  return useTaskMoveToProjectStore((state) => state.requestMove);
}
