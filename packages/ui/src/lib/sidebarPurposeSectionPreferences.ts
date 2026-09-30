interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SidebarPurposeSectionPreferences {
  projectsExpanded: boolean;
  conversationsExpanded: boolean;
  bookmarksExpanded: boolean;
  sectionOrder: SidebarPurposeSectionId[];
}

const SIDEBAR_PURPOSE_SECTION_IDS = ["projects", "conversations", "bookmarks"] as const;

type SidebarPurposeSectionId = (typeof SIDEBAR_PURPOSE_SECTION_IDS)[number];

const SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY = "zcode-sidebar-purpose-section-preferences";

const DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES: SidebarPurposeSectionPreferences = {
  projectsExpanded: true,
  conversationsExpanded: true,
  bookmarksExpanded: true,
  sectionOrder: [...SIDEBAR_PURPOSE_SECTION_IDS],
};

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

function getDefaultPreferences(): SidebarPurposeSectionPreferences {
  return {
    ...DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES,
    sectionOrder: [...DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.sectionOrder],
  };
}

/**
 * 归一化分区顺序。
 *
 * 兼容旧数据：新增分区后旧值长度更短，直接判非法会让用户已排好的顺序被整体重置。
 * 这里保留已识别的前缀顺序，再把缺失的分区按默认顺序追加到末尾。
 */
function normalizeSectionOrder(value: unknown): SidebarPurposeSectionId[] {
  if (!Array.isArray(value)) {
    return [...SIDEBAR_PURPOSE_SECTION_IDS];
  }

  const known = new Set<string>(SIDEBAR_PURPOSE_SECTION_IDS);
  const seen = new Set<SidebarPurposeSectionId>();
  const ordered: SidebarPurposeSectionId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !known.has(entry)) continue;
    const sectionId = entry as SidebarPurposeSectionId;
    if (seen.has(sectionId)) continue;
    seen.add(sectionId);
    ordered.push(sectionId);
  }
  for (const sectionId of SIDEBAR_PURPOSE_SECTION_IDS) {
    if (!seen.has(sectionId)) ordered.push(sectionId);
  }
  return ordered;
}

export function reorderSidebarPurposeSections(
  sectionOrder: readonly SidebarPurposeSectionId[],
  activeSectionId: string,
  overSectionId: string,
): SidebarPurposeSectionId[] {
  const currentOrder = normalizeSectionOrder(sectionOrder);
  const activeIndex = currentOrder.indexOf(activeSectionId as SidebarPurposeSectionId);
  const overIndex = currentOrder.indexOf(overSectionId as SidebarPurposeSectionId);
  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
    return currentOrder;
  }

  const nextOrder = [...currentOrder];
  const activeSection = nextOrder[activeIndex];
  if (!activeSection) {
    return currentOrder;
  }
  nextOrder.splice(activeIndex, 1);
  nextOrder.splice(overIndex, 0, activeSection);
  return nextOrder;
}

export function readSidebarPurposeSectionPreferences(
  storage: StorageLike | null = getBrowserStorage(),
): SidebarPurposeSectionPreferences {
  try {
    const rawValue = storage?.getItem(SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY);
    if (!rawValue) {
      return getDefaultPreferences();
    }

    const parsed: unknown = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return getDefaultPreferences();
    }

    const value = parsed as Partial<SidebarPurposeSectionPreferences>;
    return {
      projectsExpanded:
        typeof value.projectsExpanded === "boolean"
          ? value.projectsExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.projectsExpanded,
      conversationsExpanded:
        typeof value.conversationsExpanded === "boolean"
          ? value.conversationsExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.conversationsExpanded,
      bookmarksExpanded:
        typeof value.bookmarksExpanded === "boolean"
          ? value.bookmarksExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.bookmarksExpanded,
      sectionOrder: normalizeSectionOrder(value.sectionOrder),
    };
  } catch {
    return getDefaultPreferences();
  }
}

export function persistSidebarPurposeSectionPreferences(
  preferences: SidebarPurposeSectionPreferences,
  storage: StorageLike | null = getBrowserStorage(),
) {
  try {
    storage?.setItem(
      SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        projectsExpanded: preferences.projectsExpanded,
        conversationsExpanded: preferences.conversationsExpanded,
        bookmarksExpanded: preferences.bookmarksExpanded,
        sectionOrder: normalizeSectionOrder(preferences.sectionOrder),
      }),
    );
  } catch {
    // 受限 WebView 或隐私模式可能禁止写 localStorage；偏好写入失败不能阻断侧栏交互。
  }
}
