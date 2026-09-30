/**
 * 网站收藏设置分区
 *
 * 收藏条目是 renderer-local 的展示偏好，读写经 siteBookmarkStore（localStorage 持久化），
 * 不走 settings 服务：跨窗口/跨设备无需同步，避免为展示偏好引入协议字段。
 */
import { useState } from "react";
import { ArrowDown, ArrowUp, Globe, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MAX_SITE_BOOKMARKS,
  SITE_BOOKMARK_NAME_MAX_LENGTH,
  normalizeBookmarkUrl,
} from "@/lib/siteBookmarks.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { useSiteBookmarkStore } from "@/store/siteBookmarkStore.js";

export function SiteBookmarksSection() {
  const { intl } = useZCodeIntl();
  const bookmarks = useSiteBookmarkStore((state) => state.bookmarks);
  const addBookmark = useSiteBookmarkStore((state) => state.addBookmark);
  const removeBookmark = useSiteBookmarkStore((state) => state.removeBookmark);
  const moveBookmark = useSiteBookmarkStore((state) => state.moveBookmark);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const atLimit = bookmarks.length >= MAX_SITE_BOOKMARKS;

  const handleAdd = () => {
    if (!normalizeBookmarkUrl(url)) {
      setError(intl.formatMessage({ id: "bookmarks.error.invalidUrl" }));
      return;
    }
    // 先做本地名/上限判定，让报错贴近用户输入；store 内仍会再校验一次，不依赖调用方。
    if (!name.trim()) {
      setError(intl.formatMessage({ id: "bookmarks.error.nameRequired" }));
      return;
    }
    if (atLimit) {
      setError(intl.formatMessage({ id: "bookmarks.error.limit" }, { max: MAX_SITE_BOOKMARKS }));
      return;
    }

    const outcome = addBookmark({ name, url });
    if (!outcome.ok) {
      setError(
        outcome.error === "limit"
          ? intl.formatMessage({ id: "bookmarks.error.limit" }, { max: MAX_SITE_BOOKMARKS })
          : intl.formatMessage({ id: "bookmarks.error.nameRequired" }),
      );
      return;
    }
    setName("");
    setUrl("");
    setError(null);
    // 重复网址不是错误，但必须让用户知道是「更新」而不是新增了第二条。
    toast(
      intl.formatMessage({ id: outcome.updated ? "bookmarks.added.updated" : "bookmarks.added" }),
    );
  };

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <div className="border-b border-border px-4 py-3">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "bookmarks.addTitle" })}
          </div>
          <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "bookmarks.addDescription" })}
          </div>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={name}
              maxLength={SITE_BOOKMARK_NAME_MAX_LENGTH}
              placeholder={intl.formatMessage({ id: "bookmarks.namePlaceholder" })}
              onChange={(event) => setName(event.target.value)}
              className="sm:w-56"
            />
            <Input
              value={url}
              placeholder={intl.formatMessage({ id: "bookmarks.urlPlaceholder" })}
              spellCheck={false}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleAdd();
              }}
              className="flex-1"
            />
            <Button type="button" size="lg" disabled={atLimit} onClick={handleAdd}>
              {intl.formatMessage({ id: "bookmarks.add" })}
            </Button>
          </div>
          {error ? <p className="text-ui-base text-destructive">{error}</p> : null}
        </div>
      </SettingsGroupCard>

      {bookmarks.length === 0 ? (
        <p className="px-1 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "bookmarks.empty" })}
        </p>
      ) : (
        <SettingsGroupCard>
          {bookmarks.map((bookmark, index) => (
            <div
              key={bookmark.id}
              data-testid="site-bookmark-row"
              // 首行不加分隔线：卡片自身已有边框，重复描边会形成双线。
              className={`flex items-center gap-3 px-4 py-3 ${index === 0 ? "" : "border-t border-border"}`}
            >
              <Globe aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui-base font-medium text-foreground">
                  {bookmark.name}
                </div>
                <div className="truncate text-ui-base text-foreground-subtle">{bookmark.url}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "bookmarks.moveUp" })}
                  disabled={index === 0}
                  onClick={() => moveBookmark(bookmark.id, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "bookmarks.moveDown" })}
                  disabled={index === bookmarks.length - 1}
                  onClick={() => moveBookmark(bookmark.id, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "bookmarks.remove" })}
                  onClick={() => removeBookmark(bookmark.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </SettingsGroupCard>
      )}
    </div>
  );
}
