import assert from "node:assert/strict";
import test from "node:test";
import {
  readSidebarPurposeSectionPreferences,
  reorderSidebarPurposeSections,
} from "../src/lib/sidebarPurposeSectionPreferences.js";

/**
 * 侧边栏分区顺序的归一化与迁移。
 *
 * 关键回归点：新增分区（bookmarks）后，旧 localStorage 里只有两个分区。
 * 归一化必须保留用户已排好的顺序并把新分区追加到末尾，
 * 而不是因为"长度不符"把整组顺序重置成默认值。
 */

function createStorage(value: string) {
  return {
    getItem: () => value,
    setItem: () => {},
  };
}

test("旧数据（缺 bookmarks）保留原顺序并把新分区追加到末尾", () => {
  const legacy = JSON.stringify({
    projectsExpanded: true,
    conversationsExpanded: false,
    sectionOrder: ["conversations", "projects"],
  });
  const preferences = readSidebarPurposeSectionPreferences(createStorage(legacy));

  assert.deepEqual(preferences.sectionOrder, ["conversations", "projects", "bookmarks"]);
  // 展开态按字段独立读取，不因新增分区被改写。
  assert.equal(preferences.conversationsExpanded, false);
  assert.equal(preferences.projectsExpanded, true);
  assert.equal(preferences.bookmarksExpanded, true);
});

test("未知分区 id 被忽略，缺失分区补齐", () => {
  const raw = JSON.stringify({ sectionOrder: ["projects", "unknown-section"] });
  const preferences = readSidebarPurposeSectionPreferences(createStorage(raw));
  assert.deepEqual(preferences.sectionOrder, ["projects", "conversations", "bookmarks"]);
});

test("重复分区 id 只保留首次出现", () => {
  const raw = JSON.stringify({ sectionOrder: ["bookmarks", "bookmarks", "projects"] });
  const preferences = readSidebarPurposeSectionPreferences(createStorage(raw));
  assert.deepEqual(preferences.sectionOrder, ["bookmarks", "projects", "conversations"]);
});

test("损坏数据回退默认顺序", () => {
  const preferences = readSidebarPurposeSectionPreferences(createStorage("not-json"));
  assert.deepEqual(preferences.sectionOrder, ["projects", "conversations", "bookmarks"]);
});

test("拖拽换序在三个分区之间生效", () => {
  const reordered = reorderSidebarPurposeSections(
    ["projects", "conversations", "bookmarks"],
    "bookmarks",
    "projects",
  );
  assert.deepEqual(reordered, ["bookmarks", "projects", "conversations"]);
});
