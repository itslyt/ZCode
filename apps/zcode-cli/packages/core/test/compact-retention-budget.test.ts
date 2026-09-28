import assert from "node:assert/strict";
import test from "node:test";
import { CompactTrigger } from "@zcode/contracts";
import {
  DEFAULT_COMPACT_RETAIN_TOKENS,
  selectCompactEntries,
} from "../src/runtime/helpers/compact-selection.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

// 保留粒度：从「固定 1 轮」改为「token 预算内的整轮」。
//
// 依据（实测 3 个长会话，按 assistant 轮分组）：
//   每轮 token 中位 ~1.0–1.6K、p90 ~4.5–5.4K、max ~20.6K。
//   旧行为只保留 1 轮，中位仅留 ~1K token，几乎等于不留；
//   而压缩后可用预算远大于它。
//
// 注意单位：按 user-turn 口径统计会得到「一轮可能上百个工具调用」（p50=19），
// 但压缩的保留单位是 assistant 轮（每轮工具结果数 p50=1）。
// 见 specs/context-compaction-optimization.md §13。

/** 造一条 assistant 轮：1 个 assistant 消息 + 若干 tool 结果，内容量由 chars 控制。 */
function round(id: string, chars: number): RuntimeMessageEntry[] {
  return [
    {
      message: {
        role: "assistant",
        content: "do work",
        toolCalls: [{ id: `${id}-call`, name: "Read", input: { file_path: `/tmp/${id}.ts` } }],
      },
    } as RuntimeMessageEntry,
    {
      message: {
        role: "tool",
        content: "x".repeat(chars),
        toolCallId: `${id}-call`,
        toolName: "Read",
      },
    } as RuntimeMessageEntry,
  ];
}

/** 造 n 轮，每轮约 chars 字符（≈ chars/3 token）。 */
function conversation(n: number, chars: number): RuntimeMessageEntry[] {
  const entries: RuntimeMessageEntry[] = [
    { message: { role: "user", content: "start" } } as RuntimeMessageEntry,
  ];
  for (let i = 0; i < n; i += 1) entries.push(...round(`r${i}`, chars));
  return entries;
}

const preservedRounds = (selection: { groupsPreserved: number }) => selection.groupsPreserved;

test("小轮：预算内尽量多留整轮（旧行为只留 1 轮）", () => {
  // 20 轮 × ~3K 字符 ≈ 1K token/轮 → 20K 预算下应留下远多于 1 轮
  const entries = conversation(20, 3_000);
  const selection = selectCompactEntries({
    entries,
    trigger: CompactTrigger.Auto,
  });

  assert.ok(
    preservedRounds(selection) > 1,
    `预算内应多留整轮，实际只留了 ${preservedRounds(selection)} 轮`,
  );
  // 但必须给摘要留下内容（不能把整段历史都当作保留）
  assert.ok(
    selection.entriesForSummary.length > 0,
    "必须仍有内容可摘要，否则压缩无意义",
  );
});

test("大轮：单轮即超预算时退化为只留 1 轮（不应留 0）", () => {
  // 1 轮就 ~30K token，远超 20K 预算
  const entries = conversation(6, 90_000);
  const selection = selectCompactEntries({
    entries,
    trigger: CompactTrigger.Auto,
  });

  assert.equal(
    preservedRounds(selection),
    1,
    "超预算时必须至少保留最近 1 轮，不能被预算压到 0",
  );
});

test("retainTokens 显式收窄会减少保留轮数，但不少于 1 轮", () => {
  const entries = conversation(20, 3_000);
  const wide = selectCompactEntries({
    entries,
    trigger: CompactTrigger.Auto,
    retainTokens: DEFAULT_COMPACT_RETAIN_TOKENS,
  });
  const narrow = selectCompactEntries({
    entries,
    trigger: CompactTrigger.Auto,
    retainTokens: 1_000,
  });

  assert.ok(
    preservedRounds(narrow) <= preservedRounds(wide),
    "收窄预算不应保留更多轮",
  );
  assert.ok(preservedRounds(narrow) >= 1, "即便预算极小也必须保留 1 轮");
});

test("手动压缩不保留尾部（沿用既有语义）", () => {
  const entries = conversation(20, 3_000);
  const selection = selectCompactEntries({
    entries,
    trigger: CompactTrigger.Manual,
  });

  assert.equal(preservedRounds(selection), 0, "手动压缩应完整摘要");
});

test("minimumGroupsToPreserve 作为下限优先于预算", () => {
  const entries = conversation(20, 3_000);
  // 预算极小，但调用方显式要求至少保留 4 轮
  const selection = selectCompactEntries({
    entries,
    trigger: CompactTrigger.Auto,
    minimumGroupsToPreserve: 4,
    retainTokens: 1,
  });

  assert.equal(
    preservedRounds(selection),
    4,
    "显式下限不可被预算推翻（它编码的是硬要求）",
  );
});
