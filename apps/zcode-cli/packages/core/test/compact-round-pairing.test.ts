import assert from "node:assert/strict";
import test from "node:test";
import { groupByAssistantStartedRounds } from "../src/compact/rounds.js";
import { selectCompactEntries } from "../src/runtime/helpers/compact-selection.js";
import type { ModelInputMessage, RuntimeMessageEntry } from "../src/agent/message-history.js";
import type { CompactTrigger } from "@zcode/contracts";

// 压缩切点必须落在 assistant 边界上，否则会把一条工具调用和它的结果拆到
// 「已摘要」和「已保留」两侧，provider 会因 tool_use/tool_result 不配对而拒请求。
// 见 specs/context-compaction-optimization.md §7.1。

interface Entry {
  id: string;
  role: "user" | "assistant" | "tool";
}

const roleOf = (e: Entry): string => e.role;

function entry(id: string, role: Entry["role"]): Entry {
  return { id, role };
}

test("工具调用与其结果始终落在同一轮分组内", () => {
  const entries: Entry[] = [
    entry("u1", "user"),
    entry("a1", "assistant"),
    entry("t1", "tool"),
    entry("t2", "tool"),
    entry("a2", "assistant"),
    entry("t3", "tool"),
  ];

  const groups = groupByAssistantStartedRounds(entries, roleOf);

  for (const group of groups) {
    const hasTool = group.some((e) => e.role === "tool");
    if (!hasTool) continue;
    // 含工具结果的分组必须由 assistant 开头，即工具结果不会脱离其调用方。
    assert.equal(group[0]?.role, "assistant", `分组 ${JSON.stringify(group)} 未以 assistant 开头`);
  }
});

test("分组只会在 assistant 处切开，前导 user 归入首组", () => {
  const entries: Entry[] = [
    entry("u1", "user"),
    entry("u2", "user"),
    entry("a1", "assistant"),
    entry("t1", "tool"),
  ];

  const groups = groupByAssistantStartedRounds(entries, roleOf);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups[0]?.map((e) => e.id),
    ["u1", "u2"],
  );
  assert.deepEqual(
    groups[1]?.map((e) => e.id),
    ["a1", "t1"],
  );
});

function msg(
  role: ModelInputMessage["role"],
  content: string,
  extra: Partial<ModelInputMessage> = {},
): RuntimeMessageEntry {
  return { message: { role, content, ...extra } };
}

test("压缩选择不会把工具结果与其调用分到两侧", () => {
  const entries: RuntimeMessageEntry[] = [
    msg("user", "a"),
    msg("assistant", "b", { toolCalls: [{ id: "call-1", name: "read", input: {} }] }),
    msg("tool", "c", { toolCallId: "call-1", toolName: "read" }),
    msg("user", "d"),
    msg("assistant", "e", { toolCalls: [{ id: "call-2", name: "grep", input: {} }] }),
    msg("tool", "f", { toolCallId: "call-2", toolName: "grep" }),
  ];

  const selection = selectCompactEntries({ entries, trigger: "auto" as CompactTrigger });

  // 用 toolCallId 关联调用方与结果，不依赖数组下标。
  const sideOf = new Map<string, "summary" | "preserved">();
  for (const e of selection.entriesForSummary) {
    const m = e.message;
    if (m.toolCallId) sideOf.set(m.toolCallId, "summary");
    for (const tc of m.toolCalls ?? []) sideOf.set(tc.id, "summary");
  }
  for (const e of selection.preservedEntries) {
    const m = e.message;
    if (m.toolCallId) sideOf.set(m.toolCallId, "preserved");
    for (const tc of m.toolCalls ?? []) sideOf.set(tc.id, "preserved");
  }

  for (const callId of ["call-1", "call-2"]) {
    assert.ok(sideOf.has(callId), `${callId} 既不在摘要也不在保留集合中`);
  }
  // 同一 callId 只能落在一侧；若调用与结果分处两侧，上面的 set 会被后写入者覆盖，
  // 因此再直接断言两侧集合里都不存在「只有调用没有结果」的情况。
  const summaryCallIds = new Set<string>();
  const summaryResultIds = new Set<string>();
  for (const e of selection.entriesForSummary) {
    for (const tc of e.message.toolCalls ?? []) summaryCallIds.add(tc.id);
    if (e.message.toolCallId) summaryResultIds.add(e.message.toolCallId);
  }
  assert.deepEqual([...summaryCallIds].sort(), [...summaryResultIds].sort(), "摘要侧出现了不成对的工具调用");
});

