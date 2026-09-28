import assert from "node:assert/strict";
import test from "node:test";
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX,
  maybeLocalMicrocompactMessages,
} from "../src/compact/microcompact.js";

// 背景：microcompact 清除旧工具结果后，模型只剩一句裸占位符，无法据此精确重取，
// 只能盲目重读（实测本会话 32/32 次重读都发生在结果被清除之后）。
// 现在清除时保留结构化重取指针，见 specs/context-compaction-optimization.md §8。

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

test("Read 结果被清除时保留 file/offset/limit 重取指针", () => {
  const messages: Msg[] = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: "call",
      toolCalls: [
        {
          id: "call-read",
          name: "Read",
          input: { file_path: "/tmp/a.ts", offset: 100, limit: 50 },
        },
      ],
    },
    { role: "tool", content: "x".repeat(4000), toolCallId: "call-read", toolName: "Read" },
    // 最近一条保留，保证前面那条进入清除集合
    {
      role: "assistant",
      content: "call2",
      toolCalls: [{ id: "call-bash", name: "Bash", input: { command: "ls" } }],
    },
    { role: "tool", content: "y".repeat(4000), toolCallId: "call-bash", toolName: "Bash" },
  ];

  const result = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1 },
    messages,
  });

  assert.equal(result.decision.reason, "applied");
  const cleared = result.messages.find(
    (m) => m.toolCallId === "call-read",
  ) as Msg | undefined;
  assert.ok(cleared, "被清除的 Read 结果应仍在消息列表中");
  const text = contentOf(cleared);
  assert.ok(text.startsWith(MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX), "应以清除标记开头");
  assert.ok(text.includes('Read(file_path="/tmp/a.ts"'), "指针应含文件路径");
  assert.ok(text.includes("offset=100"), "指针应含 offset");
  assert.ok(text.includes("limit=50"), "指针应含 limit");
});

test("Bash 结果被清除时不给指针（无结构化参数可还原）", () => {
  const messages: Msg[] = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: "call",
      toolCalls: [{ id: "call-bash", name: "Bash", input: { command: "cat a.ts" } }],
    },
    { role: "tool", content: "x".repeat(4000), toolCallId: "call-bash", toolName: "Bash" },
    {
      role: "assistant",
      content: "call2",
      toolCalls: [{ id: "call-bash2", name: "Bash", input: { command: "ls" } }],
    },
    { role: "tool", content: "y".repeat(4000), toolCallId: "call-bash2", toolName: "Bash" },
  ];

  const result = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1 },
    messages,
  });

  assert.equal(result.decision.reason, "applied");
  const cleared = result.messages.find((m) => m.toolCallId === "call-bash") as Msg | undefined;
  assert.ok(cleared);
  const text = contentOf(cleared);
  assert.equal(text, MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX, "Bash 清除后应只有裸标记");
});

test("带指针的清除内容不会被二次清除（幂等）", () => {
  const alreadyCleared = `${MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX}\nRe-fetch with: Read(file_path="/tmp/a.ts")`;
  const messages: Msg[] = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: "call",
      toolCalls: [
        { id: "call-read", name: "Read", input: { file_path: "/tmp/a.ts" } },
      ],
    },
    { role: "tool", content: alreadyCleared, toolCallId: "call-read", toolName: "Read" },
    {
      role: "assistant",
      content: "call2",
      toolCalls: [{ id: "call-bash", name: "Bash", input: { command: "ls" } }],
    },
    { role: "tool", content: "y".repeat(4000), toolCallId: "call-bash", toolName: "Bash" },
  ];

  const result = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1 },
    messages,
  });

  const readMsg = result.messages.find((m) => m.toolCallId === "call-read") as Msg | undefined;
  assert.ok(readMsg);
  // 已清除过的不应再次进入清除集合：内容保持原样（不被改写、不叠加指针）
  assert.equal(contentOf(readMsg), alreadyCleared);
});

test("Grep 结果被清除时保留 pattern/path 指针", () => {
  const messages: Msg[] = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: "call",
      toolCalls: [
        { id: "call-grep", name: "Grep", input: { pattern: "foo", path: "/tmp/dir" } },
      ],
    },
    { role: "tool", content: "x".repeat(4000), toolCallId: "call-grep", toolName: "Grep" },
    {
      role: "assistant",
      content: "call2",
      toolCalls: [{ id: "call-bash", name: "Bash", input: { command: "ls" } }],
    },
    { role: "tool", content: "y".repeat(4000), toolCallId: "call-bash", toolName: "Bash" },
  ];

  const result = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1 },
    messages,
  });

  const cleared = result.messages.find((m) => m.toolCallId === "call-grep") as Msg | undefined;
  assert.ok(cleared);
  const text = contentOf(cleared);
  assert.ok(text.includes('Grep(pattern="foo"'), "指针应含 pattern");
  assert.ok(text.includes('path="/tmp/dir"'), "指针应含 path");
});
