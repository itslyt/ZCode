/**
 * 网站收藏（Site Bookmarks）
 *
 * 纯模型 + localStorage 持久化：条目只存「地址 + 展示名」，不持有任何页面运行时状态
 * （URL / 标题 / favicon / residency 由既有 BrowserSidePaneTab 负责）。
 *
 * 定位：这是 renderer-local 的展示偏好，跨窗口无需同步，故不走 settings 服务。
 * 参照 sidebarPurposeSectionPreferences 的存储容错做法：解析失败一律回退空列表，
 * 不抛错、不阻断使用。
 */

export const SITE_BOOKMARKS_STORAGE_KEY = "zcode-site-bookmarks:v1";

/** 条目上限：避免侧边栏与设置项无限增长。 */
export const MAX_SITE_BOOKMARKS = 50;

/** 展示名长度上限。 */
export const SITE_BOOKMARK_NAME_MAX_LENGTH = 40;

export interface SiteBookmark {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

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

/**
 * 校验可收藏的 URL。
 *
 * 只校验协议与可解析性，**不限制域名**——这是本功能通用化的关键：
 * 换公司/换项目后只需改条目，代码不含任何公司专有域名。
 */
export function normalizeBookmarkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeBookmarkName(raw: string): string {
  return raw.trim().slice(0, SITE_BOOKMARK_NAME_MAX_LENGTH);
}

function isSiteBookmark(value: unknown): value is SiteBookmark {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SiteBookmark>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.name === "string" &&
    typeof record.url === "string" &&
    typeof record.createdAt === "number"
  );
}

/** 从任意已解析值归一化为条目列表；形状不符的条目被丢弃，而不是让整组失败。 */
export function normalizeSiteBookmarks(value: unknown): SiteBookmark[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSiteBookmark).slice(0, MAX_SITE_BOOKMARKS);
}

function createBookmarkId(): string {
  try {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // crypto 在部分受限容器不可用，落到时间戳兜底。
  }
  return `bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type UpsertSiteBookmarkError = "invalid" | "limit";

export interface UpsertSiteBookmarkResult {
  bookmarks: SiteBookmark[];
  /** true 表示命中同一 URL 的既有条目并更新了它，而非新增。 */
  updated: boolean;
  error?: UpsertSiteBookmarkError;
}

/**
 * 新增或更新条目。
 *
 * 同一 URL 只保留一条：命中既有条目时更新展示名，不产生重复项。
 * 调用方需先展示 error，再决定是否保留用户输入。
 */
export function upsertSiteBookmark(
  bookmarks: readonly SiteBookmark[],
  input: { name: string; url: string },
): UpsertSiteBookmarkResult {
  const url = normalizeBookmarkUrl(input.url);
  const name = normalizeBookmarkName(input.name);
  if (!url || !name) {
    return { bookmarks: [...bookmarks], updated: false, error: "invalid" };
  }

  const existingIndex = bookmarks.findIndex((bookmark) => bookmark.url === url);
  if (existingIndex >= 0) {
    const existing = bookmarks[existingIndex];
    if (!existing) {
      return { bookmarks: [...bookmarks], updated: false, error: "invalid" };
    }
    const next = [...bookmarks];
    next[existingIndex] = { ...existing, name };
    return { bookmarks: next, updated: true };
  }

  if (bookmarks.length >= MAX_SITE_BOOKMARKS) {
    return { bookmarks: [...bookmarks], updated: false, error: "limit" };
  }

  return {
    bookmarks: [...bookmarks, { id: createBookmarkId(), name, url, createdAt: Date.now() }],
    updated: false,
  };
}

export function removeSiteBookmark(bookmarks: readonly SiteBookmark[], id: string): SiteBookmark[] {
  return bookmarks.filter((bookmark) => bookmark.id !== id);
}

/** 按位移移动条目；越界时原样返回，调用方无需先做边界判断。 */
export function moveSiteBookmark(
  bookmarks: readonly SiteBookmark[],
  id: string,
  delta: -1 | 1,
): SiteBookmark[] {
  const index = bookmarks.findIndex((bookmark) => bookmark.id === id);
  if (index === -1) return [...bookmarks];
  const targetIndex = index + delta;
  if (targetIndex < 0 || targetIndex >= bookmarks.length) return [...bookmarks];
  const next = [...bookmarks];
  const moved = next[index];
  const displaced = next[targetIndex];
  if (!moved || !displaced) return [...bookmarks];
  next[index] = displaced;
  next[targetIndex] = moved;
  return next;
}

export function readSiteBookmarks(
  storage: StorageLike | null = getBrowserStorage(),
): SiteBookmark[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(SITE_BOOKMARKS_STORAGE_KEY);
    if (!raw) return [];
    return normalizeSiteBookmarks(JSON.parse(raw));
  } catch {
    // 存储被禁用或数据损坏时回退空列表，避免阻断侧边栏与设置页渲染。
    return [];
  }
}

export function persistSiteBookmarks(
  bookmarks: readonly SiteBookmark[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SITE_BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
  } catch {
    // 隐私模式或受限 WebView 可能禁止写 localStorage；写入失败只影响持久化，不阻断交互。
  }
}
