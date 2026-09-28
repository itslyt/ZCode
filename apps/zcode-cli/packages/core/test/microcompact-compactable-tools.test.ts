import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS,
  DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS,
  maybeLocalMicrocompactMessages,
} from "../src/compact/microcompact.js";

// 本 fork 的 microcompact 只清「清除后能精确重取」的工具结果。
//
// 依据（对 3 个长会话的真实工具入参实测）：
//   Read / Grep / Glob 的重取指针生成率 100%（file_path / pattern 可从入参完全还原）
//   Bash 为 0%，且其输出 97.5% 未落盘（无 <persisted-output>）→ 清掉就是真丢
//
// 关键修正：提高 minTokenSavings **不能**少销毁证据。
// 清空不可逆、且每次清「除最新 N 条外全部」，所以阈值只影响触发频率，
// 最终被销毁的条数不变（模拟：256→2000 时销毁仍 92%，操作数 332→107）。
// 真正把销毁量从 ~92% 降到 ~15% 的是把不可重取的类别移出名单。
// 见 specs/context-compaction-optimization.md §3.5。

interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  isError?: boolean;
  toolCalls?: Array<{ id: string; input: unknown; name: string }>;
  toolCallId?: string;
  toolName?: string;
}

const contentOf = (m: Msg): string =>
  typeof m.content === "string" ? m.content : JSON.stringify(m.content);

function buildMessages(toolName: string, toolInput: unknown): Msg[] {
  return [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: "call",
      toolCalls: [{ id: "call-a", name: toolName, input: toolInput }],
    },
    { role: "tool", content: "x".repeat(40_000), toolCallId: "call-a", toolName },
    {
      role: "assistant",
      content: "call2",
      toolCalls: [{ id: "call-b", name: "Read", input: { file_path: "/tmp/b.ts" } }],
    },
    { role: "tool", content: "y".repeat(40_000), toolCallId: "call-b", toolName: "Read" },
  ];
}

test("默认可压名单只含能生成重取指针的工具", () => {
  assert.deepEqual([...DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS], ["Read", "Grep", "Glob"]);
});

test("Bash 结果不再被清除（无指针，清掉即不可回读）", () => {
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1 },
    messages: buildMessages("Bash", { command: "sed -n '1,50p' /tmp/a.ts" }),
  });

  const bashMsg = result.messages.find((m) => m.toolCallId === "call-a") as Msg | undefined;
  assert.ok(bashMsg, "Bash 结果应仍在消息列表中");
  assert.equal(contentOf(bashMsg), "x".repeat(40_000), "Bash 结果必须原样保留");
  assert.notEqual(result.decision.reason, "applied", "只有 Bash 可压时不应产生清除");
});

test("Read 结果仍被清除，并留下可精确重取的指针", () => {
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1 },
    messages: buildMessages("Read", { file_path: "/tmp/a.ts", offset: 10, limit: 5 }),
  });

  const readMsg = result.messages.find((m) => m.toolCallId === "call-a") as Msg | undefined;
  assert.ok(readMsg);
  const text = contentOf(readMsg);
  assert.ok(text.startsWith("[Old tool result content cleared]"), "应被清除");
  assert.ok(text.includes('Read(file_path="/tmp/a.ts"'), "清除后必须带重取指针");
});

test("阈值提高只降低触发频率，不改变「清就清干净」的语义", () => {
  // 同一批消息，仅阈值不同：低阈值触发、高阈值不触发。
  // 一旦触发，清除范围都是「除最近 N 条外全部」——这正是它不能少销毁证据的原因。
  const messages = buildMessages("Read", { file_path: "/tmp/a.ts" });
  const low = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1, minTokenSavings: 1 },
    messages,
  });
  const high = maybeLocalMicrocompactMessages({
    config: {
      enabled: true,
      thresholdTokens: 1,
      keepRecentToolResults: 1,
      minTokenSavings: DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS * 1000,
    },
    messages,
  });

  assert.equal(low.decision.reason, "applied");
  assert.equal(high.decision.reason, "below_min_savings");
  // 回滚后消息内容必须完全恢复（不能留下半清除状态）
  const rolledBack = high.messages.find((m) => m.toolCallId === "call-a") as Msg | undefined;
  assert.equal(contentOf(rolledBack!), "x".repeat(40_000), "低于阈值时必须整体回滚");
});
