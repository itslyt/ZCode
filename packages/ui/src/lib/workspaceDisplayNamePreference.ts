interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const WORKSPACE_DISPLAY_NAME_STORAGE_KEY = "zcode-workspace-display-names";
const MAX_DISPLAY_NAME_LENGTH = 60;

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export type WorkspaceDisplayNameState = Record<string, string>;

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function normalizeWorkspaceDisplayNameState(value: unknown): WorkspaceDisplayNameState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries: [string, string][] = [];
  for (const [key, rawName] of Object.entries(value)) {
    if (key.trim().length === 0) {
      continue;
    }
    const name = normalizeDisplayName(rawName);
    if (name) {
      entries.push([key, name]);
    }
  }

  return Object.fromEntries(entries);
}

export function readWorkspaceDisplayNames(
  storage: StorageLike | null = getBrowserStorage(),
): WorkspaceDisplayNameState {
  const rawValue = storage?.getItem(WORKSPACE_DISPLAY_NAME_STORAGE_KEY);
  if (!rawValue) {
    return {};
  }

  try {
    return normalizeWorkspaceDisplayNameState(JSON.parse(rawValue));
  } catch {
    return {};
  }
}

function persistWorkspaceDisplayNameState(
  state: WorkspaceDisplayNameState,
  storage: StorageLike | null = getBrowserStorage(),
) {
  storage?.setItem(
    WORKSPACE_DISPLAY_NAME_STORAGE_KEY,
    JSON.stringify(normalizeWorkspaceDisplayNameState(state)),
  );
}

/** 写入单个 workspace 的显示名；name 为空表示清除覆盖，回退文件夹名。 */
export function persistWorkspaceDisplayName(
  workspaceKey: string,
  name: string | null,
  storage: StorageLike | null = getBrowserStorage(),
): WorkspaceDisplayNameState {
  const currentState = readWorkspaceDisplayNames(storage);
  const normalized = normalizeDisplayName(name);
  const nextState = { ...currentState };

  if (normalized) {
    nextState[workspaceKey] = normalized;
  } else {
    delete nextState[workspaceKey];
  }

  persistWorkspaceDisplayNameState(nextState, storage);
  return nextState;
}
