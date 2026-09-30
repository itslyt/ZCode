/**
 * 网站收藏 store
 *
 * 单点持有收藏条目与全部写入动作；持久化委托给 lib/siteBookmarks.ts 的纯函数。
 * 侧边栏与设置页共用这一个 store：侧边栏只读，设置页写，不存在第二条写入路径。
 */
import { create } from "zustand";
import {
  moveSiteBookmark,
  persistSiteBookmarks,
  readSiteBookmarks,
  removeSiteBookmark,
  upsertSiteBookmark,
  type SiteBookmark,
  type UpsertSiteBookmarkError,
} from "@/lib/siteBookmarks.js";

/** 新增结果：区分"新增成功 / 命中同 URL 并更新 / 失败"，供调用方给出准确反馈。 */
export type AddSiteBookmarkOutcome =
  | { ok: true; updated: boolean }
  | { ok: false; error: UpsertSiteBookmarkError };

export interface SiteBookmarkStore {
  bookmarks: SiteBookmark[];
  addBookmark: (input: { name: string; url: string }) => AddSiteBookmarkOutcome;
  removeBookmark: (id: string) => void;
  moveBookmark: (id: string, delta: -1 | 1) => void;
}

function commit(
  bookmarks: SiteBookmark[],
  set: (partial: Partial<SiteBookmarkStore>) => void,
): void {
  set({ bookmarks });
  persistSiteBookmarks(bookmarks);
}

export const useSiteBookmarkStore = create<SiteBookmarkStore>((set, get) => ({
  bookmarks: readSiteBookmarks(),

  addBookmark: ({ name, url }) => {
    const result = upsertSiteBookmark(get().bookmarks, { name, url });
    if (result.error) {
      // 失败时不写入：调用方据 error 展示提示，用户输入保留在表单里。
      return { ok: false, error: result.error };
    }
    commit(result.bookmarks, set);
    return { ok: true, updated: result.updated };
  },

  removeBookmark: (id) => {
    commit(removeSiteBookmark(get().bookmarks, id), set);
  },

  moveBookmark: (id, delta) => {
    commit(moveSiteBookmark(get().bookmarks, id, delta), set);
  },
}));
