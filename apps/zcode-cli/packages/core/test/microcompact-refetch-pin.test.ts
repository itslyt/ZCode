import assert from "node:assert/strict";
import test from "node:test";
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX,
  maybeLocalMicrocompactMessages,
} from "../src/compact/microcompact.js";

// 「清除 → 重取 → 再清除」是一个真实存在的循环：可压类别被清空不可逆，
// 模型按指针重取回来的结果，下一轮又落在「保留最新 N 条」之外被清掉。
// 实测最极端的一例同一文件被读 78 次。见 specs/context-compaction-optimization.md §14。
//
// 断环规则（所有者：本文件的纯函数）：
//   一个重取目标**曾被清过**、且候选里**还有存活副本**时，
//   钉住该目标的**最新**一条，永不再清。
//
// 注意判据为什么是合取：已清除的条目在收集阶段就被跳过（幂等），
// 所以「一清除 + 一存活」这种循环样本在候选里**只剩 1 条**——
// 只看「候选出现 ≥2 次」会漏掉它们（实测两个长会话正是这种形态）。

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

const CLEARED_READ = `${MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX}\nRe-fetch with: Read(file_path="/tmp/loop.ts")`;

function readRound(callId: string, filePath: string, content: string): Msg[] {
  return [
    {
      role: "assistant",
      content: "call",
      toolCalls: [{ id: callId, name: "Read", input: { file_path: filePath } }],
    },
    { role: "tool", content, toolCallId: callId, toolName: "Read" },
  ];
}

function fillerRead(callId: string): Msg[] {
  return readRound(callId, "/tmp/filler.ts", "y".repeat(4000));
}

/** 本文件只验 pin 行为，阈值门槛显式压低；keepRecent=1 让绝大多数候选落入清除集合。 */
const PIN_CONFIG = {
  enabled: true,
  thresholdTokens: 1,
  keepRecentToolResults: 1,
  minTokenSavings: 1,
} as const;

test("循环目标：曾被清过 + 还有存活副本 → 存活副本被钉住，不再被清", () => {
  const messages: Msg[] = [
    { role: "user", content: "start" },
    // 第一份已被清除（只留下带指针的占位符）
    ...readRound("call-loop-old", "/tmp/loop.ts", CLEARED_READ),
    // 模型按指针重取回来的存活副本
    ...readRound("call-loop-new", "/tmp/loop.ts", "z".repeat(4000)),
    // 无关填充，把上面的存活副本顶进清除集合
    ...fillerRead("call-filler-a"),
    ...fillerRead("call-filler-b"),
  ];

  const result = maybeLocalMicrocompactMessages({ config: PIN_CONFIG, messages });

  assert.equal(result.decision.reason, "applied", "无关填充仍应被清，说明本批没有整体回滚");
  const loopCopy = result.messages.find((m) => m.toolCallId === "call-loop-new") as Msg | undefined;
  assert.ok(loopCopy, "重取回来的副本应仍在");
  assert.equal(
    contentOf(loopCopy),
    "z".repeat(4000),
    "被重取过的目标必须保住最新一份，否则下一轮又要重取——这就是循环",
  );
  // 对照组：填充照常被清，证明 pin 只保护循环目标，没有把整批放过
  const filler = result.messages.find((m) => m.toolCallId === "call-filler-a") as Msg | undefined;
  assert.ok(filler && contentOf(filler).startsWith(MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX));
});

test("同一目标读了两次但从未被清 → 不 pin（没有循环，照常清）", () => {
  const messages: Msg[] = [
    { role: "user", content: "start" },
    ...readRound("call-dup-1", "/tmp/dup.ts", "a".repeat(4000)),
    ...readRound("call-dup-2", "/tmp/dup.ts", "b".repeat(4000)),
    ...fillerRead("call-filler"),
  ];

  const result = maybeLocalMicrocompactMessages({ config: PIN_CONFIG, messages });

  assert.equal(result.decision.reason, "applied");
  // 只按「出现次数」判会误 pin 这里；按「曾被清过」判才不会。
  for (const callId of ["call-dup-1", "call-dup-2"]) {
    const msg = result.messages.find((m) => m.toolCallId === callId) as Msg | undefined;
    assert.ok(msg);
    assert.ok(
      contentOf(msg).startsWith(MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX),
      `${callId} 从未被清过，不构成循环，应照常清除`,
    );
  }
});

test("同一文件的不同区间是不同目标：一个被清不代表另一个被钉住", () => {
  const clearedOffset1 = `${MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX}\nRe-fetch with: Read(file_path="/tmp/ranged.ts" offset=1 limit=-)`;
  const messages: Msg[] = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: "call",
      toolCalls: [{ id: "call-old", name: "Read", input: { file_path: "/tmp/ranged.ts" } }],
    },
    { role: "tool", content: clearedOffset1, toolCallId: "call-old", toolName: "Read" },
    {
      role: "assistant",
      content: "call",
      toolCalls: [
        {
          id: "call-other-range",
          name: "Read",
          input: { file_path: "/tmp/ranged.ts", offset: 500, limit: 60 },
        },
      ],
    },
    {
      role: "tool",
      content: "c".repeat(4000),
      toolCallId: "call-other-range",
      toolName: "Read",
    },
    ...fillerRead("call-filler"),
  ];

  const result = maybeLocalMicrocompactMessages({ config: PIN_CONFIG, messages });

  assert.equal(result.decision.reason, "applied");
  const other = result.messages.find((m) => m.toolCallId === "call-other-range") as Msg | undefined;
  assert.ok(other);
  assert.ok(
    contentOf(other).startsWith(MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX),
    "offset=500 是另一个目标，不因 offset=1 被清过而被钉住",
  );
});

test("pin 后无可清项时返回 nothing_to_clear，不产生空的 applied 事件", () => {
  const messages: Msg[] = [
    { role: "user", content: "start" },
    ...readRound("call-loop-old", "/tmp/only.ts", CLEARED_READ),
    ...readRound("call-loop-new", "/tmp/loop.ts", "z".repeat(4000)),
  ];

  const result = maybeLocalMicrocompactMessages({ config: PIN_CONFIG, messages });

  // 唯一候选就是被钉住的那条 → 没有可清项
  assert.equal(result.decision.reason, "nothing_to_clear");
  assert.equal(result.payload, undefined, "nothing_to_clear 不应带 boundary payload");
});

test("禁用 microcompact 时不产生 pin，行为与既有分支一致", () => {
  const messages: Msg[] = [
    { role: "user", content: "start" },
    ...readRound("call-loop-old", "/tmp/loop.ts", CLEARED_READ),
    ...readRound("call-loop-new", "/tmp/loop.ts", "z".repeat(4000)),
    ...fillerRead("call-filler"),
  ];

  const result = maybeLocalMicrocompactMessages({
    config: { ...PIN_CONFIG, enabled: false },
    messages,
  });

  assert.equal(result.decision.reason, "disabled");
  // 内容原样（禁用路径返回克隆后的同一内容）
  const loopCopy = result.messages.find((m) => m.toolCallId === "call-loop-new") as Msg | undefined;
  assert.equal(contentOf(loopCopy as Msg), "z".repeat(4000));
});
