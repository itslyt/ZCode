import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SITE_BOOKMARKS,
  SITE_BOOKMARK_NAME_MAX_LENGTH,
  moveSiteBookmark,
  normalizeBookmarkUrl,
  normalizeSiteBookmarks,
  readSiteBookmarks,
  removeSiteBookmark,
  updateSiteBookmark,
  upsertSiteBookmark,
  type SiteBookmark,
} from "../src/lib/siteBookmarks.js";

/**
 * 网站收藏的模型语义。
 *
 * 重点是三条容易回归的边界：
 * ① URL 只校验协议、不限制域名（通用化前提，不能悄悄加域名白名单）；
 * ② 同一 URL 只保留一条，重复添加是"更新"而不是"新增"；
 * ③ 存储损坏时回退空列表，而不是让侧边栏/设置页崩掉。
 */

function createStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set("zcode-site-bookmarks:v1", initial);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function bookmark(partial: Partial<SiteBookmark> & { url: string }): SiteBookmark {
  return {
    id: partial.id ?? partial.url,
    name: partial.name ?? "示例",
    url: partial.url,
    createdAt: partial.createdAt ?? 1,
  };
}

test("只接受 http/https 绝对地址，不限域名", () => {
  assert.equal(
    normalizeBookmarkUrl("https://kdev.corp.example.com/a?b=1"),
    "https://kdev.corp.example.com/a?b=1",
  );
  // 任意域名都必须可用：换公司后无需改代码。
  assert.equal(
    normalizeBookmarkUrl("http://internal.other-company.test/"),
    "http://internal.other-company.test/",
  );
  assert.equal(
    normalizeBookmarkUrl("  https://spaced.example.com  "),
    "https://spaced.example.com/",
  );
});

test("拒绝非 http(s) 协议与不可解析输入", () => {
  assert.equal(normalizeBookmarkUrl("ftp://example.com"), null);
  assert.equal(normalizeBookmarkUrl("javascript:alert(1)"), null);
  assert.equal(normalizeBookmarkUrl("file:///etc/passwd"), null);
  assert.equal(normalizeBookmarkUrl("example.com"), null);
  assert.equal(normalizeBookmarkUrl(""), null);
});

test("新增条目携带 id 与创建时间", () => {
  const result = upsertSiteBookmark([], { name: "工作台", url: "https://a.example.com/" });
  assert.equal(result.error, undefined);
  assert.equal(result.updated, false);
  assert.equal(result.bookmarks.length, 1);
  const created = result.bookmarks[0];
  assert.ok(created);
  assert.equal(created.name, "工作台");
  assert.ok(created.id.length > 0);
  assert.ok(created.createdAt > 0);
});

test("同一 URL 重复添加只更新名称，不产生第二条", () => {
  const first = upsertSiteBookmark([], { name: "旧名", url: "https://a.example.com/" });
  const second = upsertSiteBookmark(first.bookmarks, {
    name: "新名",
    url: "https://a.example.com/",
  });
  assert.equal(second.updated, true);
  assert.equal(second.bookmarks.length, 1);
  assert.equal(second.bookmarks[0]?.name, "新名");
  // id 必须稳定：侧边栏 key 与排序都依赖它。
  assert.equal(second.bookmarks[0]?.id, first.bookmarks[0]?.id);
});

test("无效 URL 或空名称不写入", () => {
  const invalidUrl = upsertSiteBookmark([], { name: "x", url: "ftp://a.example.com" });
  assert.equal(invalidUrl.error, "invalid");
  assert.equal(invalidUrl.bookmarks.length, 0);

  const emptyName = upsertSiteBookmark([], { name: "   ", url: "https://a.example.com/" });
  assert.equal(emptyName.error, "invalid");
  assert.equal(emptyName.bookmarks.length, 0);
});

test("名称超长被截断而不是拒绝", () => {
  const longName = "a".repeat(SITE_BOOKMARK_NAME_MAX_LENGTH + 20);
  const result = upsertSiteBookmark([], { name: longName, url: "https://a.example.com/" });
  assert.equal(result.error, undefined);
  assert.equal(result.bookmarks[0]?.name.length, SITE_BOOKMARK_NAME_MAX_LENGTH);
});

test("达到上限后拒绝新增，但仍允许更新既有条目", () => {
  const full: SiteBookmark[] = Array.from({ length: MAX_SITE_BOOKMARKS }, (_, index) =>
    bookmark({ url: `https://site-${index}.example.com/`, name: `站点 ${index}` }),
  );

  const rejected = upsertSiteBookmark(full, { name: "新的", url: "https://one-more.example.com/" });
  assert.equal(rejected.error, "limit");
  assert.equal(rejected.bookmarks.length, MAX_SITE_BOOKMARKS);

  // 上限不能阻止用户修正已收藏条目的名称。
  const updated = upsertSiteBookmark(full, { name: "改名", url: full[0]!.url });
  assert.equal(updated.error, undefined);
  assert.equal(updated.updated, true);
  assert.equal(updated.bookmarks.length, MAX_SITE_BOOKMARKS);
});

test("删除与移动按 id 生效，越界移动保持原样", () => {
  const list = [
    bookmark({ id: "a", url: "https://a.example.com/" }),
    bookmark({ id: "b", url: "https://b.example.com/" }),
    bookmark({ id: "c", url: "https://c.example.com/" }),
  ];

  assert.deepEqual(
    removeSiteBookmark(list, "b").map((item) => item.id),
    ["a", "c"],
  );

  assert.deepEqual(
    moveSiteBookmark(list, "b", -1).map((item) => item.id),
    ["b", "a", "c"],
  );

  const up = moveSiteBookmark(list, "a", -1);
  assert.deepEqual(
    up.map((item) => item.id),
    ["a", "b", "c"],
  );

  const down = moveSiteBookmark(list, "c", 1);
  assert.deepEqual(
    down.map((item) => item.id),
    ["a", "b", "c"],
  );
});

test("存储内容损坏时回退空列表", () => {
  assert.deepEqual(readSiteBookmarks(createStorage("not json")), []);
  assert.deepEqual(readSiteBookmarks(createStorage('{"a":1}')), []);
  assert.deepEqual(readSiteBookmarks(null), []);
});

test("丢弃形状不符的条目而不是整组失败", () => {
  const raw = JSON.stringify([
    { id: "ok", name: "可用", url: "https://a.example.com/", createdAt: 1 },
    { id: "missing-url", name: "缺 URL", createdAt: 2 },
    { nope: true },
  ]);
  const parsed = normalizeSiteBookmarks(JSON.parse(raw));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.id, "ok");
});

test("存储往返后保持顺序", () => {
  const storage = createStorage();
  const list = [
    bookmark({ id: "b", url: "https://b.example.com/" }),
    bookmark({ id: "a", url: "https://a.example.com/" }),
  ];
  storage.setItem("zcode-site-bookmarks:v1", JSON.stringify(list));
  assert.deepEqual(
    readSiteBookmarks(storage).map((item) => item.id),
    ["b", "a"],
  );
});

test("按 id 编辑名称与地址，id 与创建时间保持稳定", () => {
  const list = [bookmark({ id: "a", url: "https://a.example.com/", name: "旧名", createdAt: 42 })];
  const result = updateSiteBookmark(list, "a", { name: "新名", url: "https://a2.example.com/" });

  assert.equal(result.error, undefined);
  const updated = result.bookmarks[0];
  assert.ok(updated);
  assert.equal(updated.name, "新名");
  assert.equal(updated.url, "https://a2.example.com/");
  // id / createdAt 必须稳定：侧边栏 key 与排序都依赖它们。
  assert.equal(updated.id, "a");
  assert.equal(updated.createdAt, 42);
});

test("编辑时改用其他条目已占用的 URL 会报错，不改动任何条目", () => {
  const list = [
    bookmark({ id: "a", url: "https://a.example.com/" }),
    bookmark({ id: "b", url: "https://b.example.com/" }),
  ];
  const result = updateSiteBookmark(list, "a", { name: "A", url: "https://b.example.com/" });

  assert.equal(result.error, "duplicateUrl");
  assert.equal(result.bookmarks[0]?.url, "https://a.example.com/");
  assert.equal(result.bookmarks[1]?.url, "https://b.example.com/");
});

test("编辑不存在的条目与非法输入分别报错", () => {
  const list = [bookmark({ id: "a", url: "https://a.example.com/" })];
  assert.equal(
    updateSiteBookmark(list, "missing", { name: "x", url: "https://c.example.com/" }).error,
    "notFound",
  );
  assert.equal(updateSiteBookmark(list, "a", { name: "x", url: "ftp://nope" }).error, "invalid");
  assert.equal(
    updateSiteBookmark(list, "a", { name: "  ", url: "https://c.example.com/" }).error,
    "invalid",
  );
});

test("编辑保持原 URL 不变时不判为冲突", () => {
  const list = [
    bookmark({ id: "a", url: "https://a.example.com/" }),
    bookmark({ id: "b", url: "https://b.example.com/" }),
  ];
  const result = updateSiteBookmark(list, "a", { name: "只改名", url: "https://a.example.com/" });
  assert.equal(result.error, undefined);
  assert.equal(result.bookmarks[0]?.name, "只改名");
});
