import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeContextUsageBreakdownItem } from "@zcode/shared";
import { buildContextUsageBreakdownSegments } from "../src/chat-input-toolbar/contextUsageBreakdown.js";

function item(
  source: ZCodeContextUsageBreakdownItem["source"],
  chars: number,
  tokens: number,
): ZCodeContextUsageBreakdownItem {
  return { source, chars, tokens };
}

test("分项 K 取估算原值，不按顶部 used 缩放", () => {
  // 同一份 breakdown 在不同轮次里内容不变；旧实现用 round(used × 占比) 缩放，
  // 会让这里的 K 随顶部 used 漂移。现在 K 只由估算值决定。
  const breakdown = [
    item("system_tool_schemas", 26_546, 8_836),
    item("system_prompt", 9_110, 3_037),
    item("messages", 17_481, 6_000),
  ];
  const segments = buildContextUsageBreakdownSegments(breakdown);
  const tool = segments.find((segment) => segment.source === "system_tool_schemas");
  assert.equal(tool?.tokens, 8_836);
  assert.equal(tool?.chars, 26_546);
});

test("同源 breakdown 连续两次派生得到相同 K（不随 used 变化）", () => {
  const breakdown = [item("system_tool_schemas", 1_000, 400), item("messages", 3_000, 600)];
  const first = buildContextUsageBreakdownSegments(breakdown);
  const second = buildContextUsageBreakdownSegments(breakdown);
  assert.deepEqual(
    first.map((segment) => segment.tokens),
    second.map((segment) => segment.tokens),
  );
});

test("占比是各分项估算之和的比值，合计为 1", () => {
  const segments = buildContextUsageBreakdownSegments([
    item("system_tool_schemas", 1_000, 300),
    item("system_prompt", 1_000, 100),
    item("messages", 1_000, 600),
  ]);
  const sum = segments.reduce((total, segment) => total + segment.percent, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const messages = segments.find((segment) => segment.source === "messages");
  assert.equal(messages?.percent, 0.6);
});

test("分项按 K 降序排序，K 相同再按 chars、再按来源固定序", () => {
  const segments = buildContextUsageBreakdownSegments([
    item("messages", 100, 50),
    item("system_prompt", 400, 400),
    item("skills", 900, 400),
  ]);
  assert.deepEqual(
    segments.map((segment) => segment.source),
    ["skills", "system_prompt", "messages"],
  );
});

test("旧快照无 tokens：占比退回字符口径，且不拿 chars 冒充 token", () => {
  const segments = buildContextUsageBreakdownSegments([
    { source: "system_prompt", chars: 3_000 },
    { source: "messages", chars: 1_000 },
  ]);
  const system = segments.find((segment) => segment.source === "system_prompt");
  assert.equal(system?.tokens, 0);
  assert.equal(system?.percent, 0.75);
});

test("chars 非正或非有限的分项被丢弃；全空返回空数组", () => {
  assert.deepEqual(buildContextUsageBreakdownSegments([]), []);
  assert.deepEqual(buildContextUsageBreakdownSegments(undefined), []);
  assert.deepEqual(buildContextUsageBreakdownSegments([item("messages", 0, 10)]), []);
  assert.deepEqual(
    buildContextUsageBreakdownSegments([{ source: "messages", chars: Number.NaN }]),
    [],
  );
});
