import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MICROCOMPACT_PIN_RECENCY_STEPS,
  DEFAULT_MICROCOMPACT_PIN_TOKEN_BUDGET,
  MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX,
  maybeLocalMicrocompactMessages,
} from "../src/compact/microcompact.js";

// pin 此前没有有效期，靠「占位符还在窗口里」维持——结果一个 20 步前重取过的文件
// 会一直占常驻（实测增量 +14K~24K token），而会话常驻已贴着 416K 的 autocompact 阈值。
// 见 specs/context-compaction-optimization.md §16.2。
//
// 有效期 = 合取：
//   近期性：只在最近 M 个 model step 内重取过才 pin（持续重取=续租）
//   总量上限：所有生效 pin 的合计估算 token ≤ cap
// 两者缺一不可：近期性防不了总量（一轮内可重取多个大文件），总量防不了陈旧。

interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{ id: string; input: unknown; name: string }>;
  toolCallId?: string;
  toolName?: string;
}

const CLEARED_PREFIX = MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX;
const contentOf = (m: Msg): string => (typeof m.content === "string" ? m.content : "");

function readRound(callId: string, filePath: string, size = 100): Msg[] {
  return [
    {
      role: "assistant",
      content: "t",
      toolCalls: [{ id: callId, name: "Read", input: { file_path: filePath } }],
    },
    { role: "tool", content: "x".repeat(size), toolCallId: callId, toolName: "Read" },
  ];
}

/** 一条「已被清除」的历史副本：让该目标的 key 进入 clearedRefetchKeys。 */
function clearedRound(callId: string, filePath: string): Msg[] {
  return readRound(callId, filePath).map((m) =>
    m.role === "tool"
      ? { ...m, content: `${CLEARED_PREFIX}\nRe-fetch with: Read(file_path="${filePath}")` }
      : m,
  );
}

const base = {
  enabled: true,
  thresholdTokens: 1,
  minTokenSavings: 1,
  keepRecentToolResults: 1,
} as const;

test("近期性：pin 目标在 M 步内 → 仍被钉住", () => {
  const messages: Msg[] = [
    { role: "user", content: "q" },
    ...clearedRound("old", "/tmp/loop.ts"),
    ...readRound("fresh", "/tmp/loop.ts", 4000), // 重取回来的副本，紧邻末尾
    ...readRound("filler", "/tmp/other.ts", 4000),
  ];
  const result = maybeLocalMicrocompactMessages({ config: base, messages });
  // 三个候选里 pin 保住 1 个，但 keep=1 剩余可清的是 filler，所以仍会 applied。
  // 若 pin 把全部候选都保住，reason 会是 nothing_to_clear（见下一条）。
  assert.ok(["applied", "nothing_to_clear"].includes(result.decision.reason));
  assert.equal(result.decision.observation?.pinnedTargetCount, 1, "重取副本在 M 步内，应被 pin");
  assert.equal(result.decision.observation?.pinnedDroppedByRecency, 0);
  const fresh = result.messages.find((m) => m.toolCallId === "fresh") as Msg;
  assert.equal(contentOf(fresh), "x".repeat(4000), "被 pin 的副本必须保住原文");
});

test("近期性：pin 目标超出 M 步 → pin 失效，照常清（意图可能已变）", () => {
  const messages: Msg[] = [
    { role: "user", content: "q" },
    ...clearedRound("old", "/tmp/loop.ts"),
    ...readRound("stale", "/tmp/loop.ts", 4000), // 重取过，但之后又走了 M 步以上
    ...readRound("f1", "/tmp/a.ts", 4000),
    ...readRound("f2", "/tmp/b.ts", 4000),
    ...readRound("f3", "/tmp/c.ts", 4000),
    ...readRound("f4", "/tmp/d.ts", 4000),
  ];
  const result = maybeLocalMicrocompactMessages({ config: base, messages });
  assert.equal(result.decision.reason, "applied");
  assert.equal(result.decision.observation?.pinnedTargetCount, 0, "超期后不再 pin");
  assert.equal(result.decision.observation?.pinnedDroppedByRecency, 1);
  const stale = result.messages.find((m) => m.toolCallId === "stale") as Msg;
  assert.ok(
    contentOf(stale).startsWith(CLEARED_PREFIX),
    "超期的 pin 必须真的被清掉——否则常驻没有上限",
  );
});

test("近期性边界：正好 M 步内保留、第 M+1 步失效", () => {
  // recencySteps=2：pin 目标之后放 1 步 → 仍在；放 2 步 → 失效
  const within = maybeLocalMicrocompactMessages({
    config: { ...base, pinRecencySteps: 2 },
    messages: [
      { role: "user", content: "q" },
      ...clearedRound("old", "/tmp/loop.ts"),
      ...readRound("copy", "/tmp/loop.ts", 4000),
      ...readRound("f1", "/tmp/a.ts", 4000),
    ],
  });
  assert.equal(within.decision.observation?.pinnedTargetCount, 1, "pin 目标距末尾 1 步 < 2 → 保留");

  const beyond = maybeLocalMicrocompactMessages({
    config: { ...base, pinRecencySteps: 2 },
    messages: [
      { role: "user", content: "q" },
      ...clearedRound("old", "/tmp/loop.ts"),
      ...readRound("copy", "/tmp/loop.ts", 4000),
      ...readRound("f1", "/tmp/a.ts", 4000),
      ...readRound("f2", "/tmp/b.ts", 4000),
    ],
  });
  assert.equal(beyond.decision.observation?.pinnedTargetCount, 0, "距末尾 2 步 ≥ 2 → 失效");
  assert.equal(beyond.decision.observation?.pinnedDroppedByRecency, 1);
});

test("总量上限：多个大文件超预算时按「优先保近期」丢弃", () => {
  // 预算设很小，让最多只能容纳一份
  const messages: Msg[] = [
    { role: "user", content: "q" },
    ...clearedRound("old-a", "/tmp/a.ts"),
    ...clearedRound("old-b", "/tmp/b.ts"),
    ...readRound("copy-a", "/tmp/a.ts", 30_000),
    ...readRound("copy-b", "/tmp/b.ts", 30_000),
  ];
  const result = maybeLocalMicrocompactMessages({
    config: { ...base, pinTokenBudget: 12_000 },
    messages,
  });
  assert.equal(result.decision.reason, "applied");
  assert.equal(result.decision.observation?.pinnedTargetCount, 1, "预算只够一份");
  assert.equal(result.decision.observation?.pinnedDroppedByCap, 1);
  // 后出现的 copy-b 更近，应优先保住它
  const b = result.messages.find((m) => m.toolCallId === "copy-b") as Msg;
  const a = result.messages.find((m) => m.toolCallId === "copy-a") as Msg;
  assert.equal(contentOf(b), "x".repeat(30_000), "预算不足时优先保近期的那份");
  assert.ok(contentOf(a).startsWith(CLEARED_PREFIX));
});

test("总量上限：预算足够时全部保住（不误伤）", () => {
  const result = maybeLocalMicrocompactMessages({
    config: { ...base, pinTokenBudget: DEFAULT_MICROCOMPACT_PIN_TOKEN_BUDGET },
    messages: [
      { role: "user", content: "q" },
      ...readRound("copy", "/tmp/loop.ts", 3000),
      ...readRound("filler", "/tmp/other.ts", 3000),
    ],
  });
  assert.equal(result.decision.reason, "applied");
  assert.equal(result.decision.observation?.pinnedDroppedByCap, 0);
});

test("观测字段始终与判定一致：pinnedTokenCount 等于被保住各份的合计", () => {
  const messages: Msg[] = [
    { role: "user", content: "q" },
    ...clearedRound("old", "/tmp/loop.ts"),
    ...readRound("copy", "/tmp/loop.ts", 9000),
    ...readRound("filler", "/tmp/other.ts", 9000),
  ];
  const result = maybeLocalMicrocompactMessages({
    config: { ...base, modelStepIndex: 0 },
    messages,
  });
  assert.equal(result.decision.observation?.pinnedTargetCount, 1);
  assert.ok((result.decision.observation?.pinnedTokenCount ?? 0) > 0, "必须回报 pin 的体积，供调参");
  // pin 的体积只能是总估算的一小部分（它就是被保住那一份），不能超出总量。
  assert.ok(
    (result.decision.observation?.pinnedTokenCount ?? 0) <= result.decision.estimatedTokenCount,
  );
});

test("默认值符合 spec §16.2（M=3、cap=20K）", () => {
  assert.equal(DEFAULT_MICROCOMPACT_PIN_RECENCY_STEPS, 3);
  assert.equal(DEFAULT_MICROCOMPACT_PIN_TOKEN_BUDGET, 20_000);
});

test("无 clearedRefetchKeys 时不产生任何 pin（有效期不影响基础判据）", () => {
  const result = maybeLocalMicrocompactMessages({
    config: base,
    messages: [
      { role: "user", content: "q" },
      ...readRound("a", "/tmp/a.ts", 4000),
      ...readRound("b", "/tmp/b.ts", 4000),
    ],
  });
  assert.equal(result.decision.observation?.pinnedTargetCount, 0);
  assert.equal(result.decision.observation?.pinnedDroppedByRecency, 0);
  assert.equal(result.decision.observation?.pinnedDroppedByCap, 0);
});
