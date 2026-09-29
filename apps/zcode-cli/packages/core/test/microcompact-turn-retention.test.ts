import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS_IN_TURN,
  MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX,
  maybeLocalMicrocompactMessages,
} from "../src/compact/microcompact.js";

// 保留条数的单位是 **model step**（带 toolCalls 的 assistant 消息），不是用户轮。
// 实测一个用户轮的中位步数是 10——keep=5 时 **78~81% 的轮在轮内就发生清除**，
// 这是「同一文件反复读」的根本来源。见 specs/context-compaction-optimization.md §16.1。
//
// 规则：轮内保留量放大到 15，跳轮回到 5。
// 为什么不用「轮内完全不清」：microcompact 是 autocompact 前的缓冲区，轮内不清会把
// 本该回收的量直接撞 416K 阈值，把一次便宜的本地清除换成一次完整 LLM 摘要调用（且不可逆）。

interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{ id: string; input: unknown; name: string }>;
  toolCallId?: string;
  toolName?: string;
}

const contentOf = (m: Msg): string => (typeof m.content === "string" ? m.content : "");

function readRound(callId: string, filePath: string): Msg[] {
  return [
    {
      role: "assistant",
      content: "t",
      toolCalls: [{ id: callId, name: "Read", input: { file_path: filePath } }],
    },
    { role: "tool", content: "x".repeat(4000), toolCallId: callId, toolName: "Read" },
  ];
}

/** 造 n 个 model step，每个含 1 条可压结果；末尾带一条真实用户消息表示“在本轮内”。 */
function steps(n: number, withinTurn: boolean): Msg[] {
  const messages: Msg[] = [{ role: "user", content: "earlier question" }];
  for (let i = 0; i < n; i += 1) messages.push(...readRound(`call-${i}`, `/tmp/f${i}.ts`));
  if (withinTurn) messages.push({ role: "user", content: "current question" });
  return messages;
}

const base = { enabled: true, thresholdTokens: 1, minTokenSavings: 1 } as const;

test("轮内：保留量取 15，超过它的步数才被清", () => {
  // 12 步 < 15 → 轮内一条都不清
  const few = maybeLocalMicrocompactMessages({
    config: { ...base, modelStepIndex: 1 },
    messages: steps(12, true),
  });
  assert.equal(few.decision.reason, "nothing_to_clear", "12 步在轮内应全部保留");
  assert.equal(few.payload, undefined);

  // 18 步（实测 max）→ 只清最早 3 条
  const many = maybeLocalMicrocompactMessages({
    config: { ...base, modelStepIndex: 1 },
    messages: steps(18, true),
  });
  assert.equal(many.decision.reason, "applied");
  assert.equal(many.decision.observation?.keepRecentLimit, DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS_IN_TURN);
  assert.equal(many.decision.observation?.withinUserTurn, true);
  assert.equal(many.payload?.clearedMessageCount, 18 - DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS_IN_TURN);
  const cleared = many.messages.filter(
    (m) => m.role === "tool" && contentOf(m).startsWith(MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX),
  );
  assert.equal(cleared.length, 3);
});

test("跳轮：回到保留 5 条（旧行为）", () => {
  // modelStepIndex = 0 → 轮首（上一轮已结束）
  const result = maybeLocalMicrocompactMessages({
    config: { ...base, modelStepIndex: 0 },
    messages: steps(12, false),
  });
  assert.equal(result.decision.reason, "applied");
  assert.equal(result.decision.observation?.keepRecentLimit, DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS);
  assert.equal(result.decision.observation?.withinUserTurn, false);
  assert.equal(result.payload?.clearedMessageCount, 12 - DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS);
});

test("缺省 modelStepIndex 时按跳轮处理（子代理 / model-only 不改变行为）", () => {
  const result = maybeLocalMicrocompactMessages({
    config: base,
    messages: steps(12, false),
  });
  assert.equal(result.decision.observation?.keepRecentLimit, DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS);
  assert.equal(result.decision.observation?.withinUserTurn, false);
});

test("轮内保留量可显式覆盖（keepRecentToolResultsInTurn）", () => {
  const result = maybeLocalMicrocompactMessages({
    config: { ...base, modelStepIndex: 1, keepRecentToolResultsInTurn: 8 },
    messages: steps(8, true),
  });
  assert.equal(result.decision.observation?.keepRecentLimit, 8);
  assert.equal(result.decision.reason, "nothing_to_clear", "8 步正好等于 8 条保留，无需清");

  const over = maybeLocalMicrocompactMessages({
    config: { ...base, modelStepIndex: 1, keepRecentToolResultsInTurn: 8 },
    messages: steps(10, true),
  });
  assert.equal(over.payload?.clearedMessageCount, 2);
});

test("轮内放大不改变「组内多条一起清」的配对语义", () => {
  // 分组单位是「一条带 toolCalls 的 assistant 消息」：同一条 assistant 下的多个结果同组。
  // 把含 2 条结果的组放在最旧位置，用 keep=2 把它挤进清除范围，验证同组两条一起清。
  const messages: Msg[] = [
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: "t",
      toolCalls: [
        { id: "g1-a", name: "Read", input: { file_path: "/tmp/a.ts" } },
        { id: "g1-b", name: "Read", input: { file_path: "/tmp/b.ts" } },
      ],
    },
    { role: "tool", content: "x".repeat(4000), toolCallId: "g1-a", toolName: "Read" },
    { role: "tool", content: "x".repeat(4000), toolCallId: "g1-b", toolName: "Read" },
    ...readRound("g2", "/tmp/c.ts"),
    ...readRound("g3", "/tmp/d.ts"),
    { role: "user", content: "q2" },
  ];
  const result = maybeLocalMicrocompactMessages({
    config: { ...base, modelStepIndex: 1, keepRecentToolResultsInTurn: 2 },
    messages,
  });
  assert.equal(result.decision.reason, "applied");
  assert.deepEqual(result.payload?.clearedToolCallIds, ["g1-a", "g1-b"], "同组的 g1-a/g1-b 必须一起清");
  assert.deepEqual(result.payload?.keptToolCallIds, ["g2", "g3"]);
});
