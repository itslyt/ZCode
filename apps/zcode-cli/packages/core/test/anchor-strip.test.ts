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
