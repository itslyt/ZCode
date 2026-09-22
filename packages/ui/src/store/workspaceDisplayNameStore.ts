import { create } from "zustand";
import {
  persistWorkspaceDisplayName,
  readWorkspaceDisplayNames,
  type WorkspaceDisplayNameState,
} from "@/lib/workspaceDisplayNamePreference.js";

/**
 * workspace 显示名覆盖（只影响展示，不参与路由/缓存/请求关联）。
 * key 统一为 workspaceIdentity?.trim() || workspacePath；空名字表示清除覆盖，回退文件夹名。
 */
interface WorkspaceDisplayNameStoreState {
  names: WorkspaceDisplayNameState;
  setName: (workspaceKey: string, name: string | null) => void;
}

export const useWorkspaceDisplayNameStore = create<WorkspaceDisplayNameStoreState>((set) => ({
  names: readWorkspaceDisplayNames(),
  setName: (workspaceKey, name) => {
    const names = persistWorkspaceDisplayName(workspaceKey, name);
    set({ names });
  },
}));

/** 读取单个 workspace 的显示名；未设置返回 undefined（调用方回退文件夹名）。 */
export function useWorkspaceDisplayName(
  workspaceKey: string | null | undefined,
): string | undefined {
  return useWorkspaceDisplayNameStore((state) =>
    workspaceKey ? state.names[workspaceKey] : undefined,
  );
}
