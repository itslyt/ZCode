/**
 * 网站收藏区块内容
 *
 * 只读消费 siteBookmarkStore；点击条目走既有 onOpenBrowserUrl 打开内置浏览器，
 * 不直接操作 side pane 状态（打开语义由 useAppPanels 统一收口）。
 */
import { Globe } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { requestSidePaneExpanded } from "@/lib/sidePaneExpandIntent.js";
import { useSiteBookmarkStore } from "@/store/siteBookmarkStore.js";

export function SiteBookmarkSectionContent({
  onOpenUrl,
}: {
  /** 缺席表示当前壳层不支持内嵌浏览器；条目改为不可点击，避免产生无效点击。 */
  onOpenUrl?: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const bookmarks = useSiteBookmarkStore((state) => state.bookmarks);

  if (bookmarks.length === 0) {
    return (
      <p className="px-2.5 py-1.5 text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "bookmarks.empty" })}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 px-1.5 pb-1">
      {bookmarks.map((bookmark) => (
        <li key={bookmark.id}>
          <button
            type="button"
            disabled={!onOpenUrl}
            title={bookmark.url}
            data-testid="site-bookmark-item"
            onClick={() => {
              // 收藏是「去这个站点」的主动导航，默认铺满面板以拿到完整可视区域；
              // 其余浏览器入口（地址栏、产物直开）不受影响。
              requestSidePaneExpanded();
              onOpenUrl?.(bookmark.url);
            }}
            className="group/bookmark flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-ui-base text-foreground-subtle outline-none transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default disabled:opacity-60"
          >
            <Globe aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">{bookmark.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
