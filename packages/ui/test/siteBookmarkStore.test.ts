import assert from "node:assert/strict";
import test from "node:test";
import { useSiteBookmarkStore } from "../src/store/siteBookmarkStore.js";

/**
 * store 层的写入语义。
 *
 * 这里锁定三件事：
 * ① 写入路径唯一（都经 addBookmark / removeBookmark / moveBookmark）；
 * ② 重复网址返回 updated=true，让 UI 能区分"新增"与"更新"；
 * ③ 失败（非法输入 / 超上限）不改变已有列表。
 */

function reset(bookmarks: ReturnType<typeof useSiteBookmarkStore.getState>["bookmarks"] = []) {
  useSiteBookmarkStore.setState({ bookmarks });
}

test("新增返回 ok 且 updated=false", () => {
  reset();
  const outcome = useSiteBookmarkStore
    .getState()
    .addBookmark({ name: "工作台", url: "https://kdev.example.com/" });
  assert.deepEqual(outcome, { ok: true, updated: false });
  assert.equal(useSiteBookmarkStore.getState().bookmarks.length, 1);
});

test("重复网址返回 updated=true 且不新增第二条", () => {
  reset();
  const store = useSiteBookmarkStore.getState();
  store.addBookmark({ name: "旧", url: "https://dup.example.com/" });
  const outcome = useSiteBookmarkStore
    .getState()
    .addBookmark({ name: "新", url: "https://dup.example.com/" });

  assert.deepEqual(outcome, { ok: true, updated: true });
  const { bookmarks } = useSiteBookmarkStore.getState();
  assert.equal(bookmarks.length, 1);
  assert.equal(bookmarks[0]?.name, "新");
});

test("非法输入返回错误且不改动列表", () => {
  reset();
  const outcome = useSiteBookmarkStore
    .getState()
    .addBookmark({ name: "x", url: "ftp://nope.example.com" });

  assert.equal(outcome.ok, false);
  assert.equal(useSiteBookmarkStore.getState().bookmarks.length, 0);
});

test("删除与移动经 store 写入", () => {
  reset([
    { id: "a", name: "A", url: "https://a.example.com/", createdAt: 1 },
    { id: "b", name: "B", url: "https://b.example.com/", createdAt: 2 },
  ]);

  useSiteBookmarkStore.getState().moveBookmark("b", -1);
  assert.deepEqual(
    useSiteBookmarkStore.getState().bookmarks.map((item) => item.id),
    ["b", "a"],
  );

  useSiteBookmarkStore.getState().removeBookmark("a");
  assert.deepEqual(
    useSiteBookmarkStore.getState().bookmarks.map((item) => item.id),
    ["b"],
  );
});
