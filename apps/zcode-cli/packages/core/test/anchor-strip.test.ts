import assert from "node:assert/strict";
import test from "node:test";
import { findEditMatch } from "../src/tool/edit-matchers.js";
import { formatAnchorPrefix, hashLineContent } from "../src/tool/anchor-hash.js";

const CONTENT = ["function greet(name) {", "  return name;", "}"].join("\n");

test("带锚点前缀粘贴的内容仍能被 Edit 匹配（line_number_prefix_stripped）", () => {
  const pasted = [
    `${formatAnchorPrefix(2, hashLineContent("  return name;"))}  return name;`,
  ].join("\n");

  const match = findEditMatch({ content: CONTENT, search: pasted, replaceAll: false });
  assert.equal(match.status, "matched");
  if (match.status !== "matched") return;
  assert.equal(match.strategy, "line_number_prefix_stripped");
  assert.equal(match.actualString, "  return name;");
});

// §7.9.3：EditAnchored 的错误回传区用 `>>> ` 标出问题行，模型可能整行粘进 old_string。
// 不剥会给 Edit 新增一类无意义的匹配失败（正文其实完全对得上）。
test("带 >>> 标记的锚点前缀粘贴也能被 Edit 匹配", () => {
  const pasted = `>>> ${formatAnchorPrefix(2, hashLineContent("  return name;"))}  return name;`;
  const match = findEditMatch({ content: CONTENT, search: pasted, replaceAll: false });
  assert.equal(match.status, "matched");
  if (match.status !== "matched") return;
  assert.equal(match.strategy, "line_number_prefix_stripped");
  assert.equal(match.actualString, "  return name;");
});

test("旧的 `N\\t` 前缀仍然被识别", () => {
  const match = findEditMatch({ content: CONTENT, search: "2\t  return name;", replaceAll: false });
  assert.equal(match.status, "matched");
  if (match.status !== "matched") return;
  assert.equal(match.strategy, "line_number_prefix_stripped");
});

test("像锚点但哈希非法的前缀不被剥掉（不能误伤正常内容）", () => {
  const match = findEditMatch({ content: "a:b│c", search: "1:!!│c", replaceAll: false });
  assert.equal(match.status, "not_found");
});
