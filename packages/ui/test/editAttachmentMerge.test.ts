import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { resolveEditAttachmentsForSubmit } from "../src/v4/composer/editAttachmentMerge.js";

/**
 * 行内编辑提交的附件列表口径。
 *
 * 这里锁定顺序与「显式空数组」两条语义：顺序决定重发轮次的附件排列，
 * 空数组与 undefined 在 editUserQuery 协议里含义完全不同（清空 vs 沿用原附件）。
 */

function ref(name: string): AttachmentRef {
  return { ref: `/tmp/${name}`, fileName: name, mime: "image/png", bytes: 1 };
}

test("原有在前、新增在后", () => {
  const result = resolveEditAttachmentsForSubmit([ref("a.png")], [ref("b.png")]);
  assert.deepEqual(
    result.map((item) => item.fileName),
    ["a.png", "b.png"],
  );
});

test("只删除、不新增时返回剩下的原附件", () => {
  const result = resolveEditAttachmentsForSubmit([ref("a.png")], []);
  assert.deepEqual(
    result.map((item) => item.fileName),
    ["a.png"],
  );
});

test("删光原附件且不新增时返回空数组，而不是 undefined", () => {
  const result = resolveEditAttachmentsForSubmit([], []);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

test("只新增时原附件不被吞掉", () => {
  const result = resolveEditAttachmentsForSubmit([ref("a.png"), ref("b.png")], [ref("c.png")]);
  assert.deepEqual(
    result.map((item) => item.fileName),
    ["a.png", "b.png", "c.png"],
  );
});

test("保留重复附件（同一文件多次添加是合法输入）", () => {
  const result = resolveEditAttachmentsForSubmit([ref("a.png")], [ref("a.png")]);
  assert.equal(result.length, 2);
});

test("不修改入参数组", () => {
  const original = [ref("a.png")];
  const added = [ref("b.png")];
  resolveEditAttachmentsForSubmit(original, added);
  assert.equal(original.length, 1);
  assert.equal(added.length, 1);
});
