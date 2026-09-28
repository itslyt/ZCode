import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactSummaryMessage } from "../src/compact/prompt.js";

// 压缩把旧消息从模型面抹掉，但原文仍在会话库（message/part 表不删）。
// 摘要消息必须告知可回读通道，否则模型会把「看不见」当成「不存在」，
// 重做已完成的工作或凭空猜测。见 specs/context-compaction-optimization.md §12、§14.3。
//
// 关键修正（§14.3）：不能无条件写死 `call ReadSessionContext`。
// 本 fork 的默认工具面由 CODING_ONLY_TOOLS 收窄，名单里**没有** ReadSessionContext，
// 写死的指引等于指向一个模型没有的工具——与 024c6f3 修掉的同类缺陷。
// 所以文案必须由「该工具是否真的注册」决定。

test("工具面里有 ReadSessionContext 时，指引点名它并给出本会话 id", () => {
  const message = buildCompactSummaryMessage("some summary", {
    recoveryPointer: { sessionId: "sess_abc123", canReadSessionContext: true },
  });

  assert.ok(message.includes("ReadSessionContext"), "应点名实际可用的回读工具");
  assert.ok(
    message.includes('sessionId="sess_abc123"'),
    "应给出确切的本会话 id，避免模型去猜或读错会话",
  );
  assert.ok(/still persisted/i.test(message), "应说明原文仍在，而不是已被销毁");
});

test("工具面里没有 ReadSessionContext 时，不得点名它（本 fork 的默认形态）", () => {
  const message = buildCompactSummaryMessage("some summary", {
    recoveryPointer: { sessionId: "sess_default", canReadSessionContext: false },
  });

  // 这是本 fork 的默认路径：CODING_ONLY_TOOLS 不含该工具，实测请求 toolNames 也没有它。
  assert.ok(
    !message.includes("ReadSessionContext"),
    "工具不在工具面时点名它是失实指引，模型会白跑一次工具调用",
  );
  assert.ok(/still persisted/i.test(message), "仍须告知原文没丢、只是没进模型面");
});

test("没给 recoveryPointer 时不出现回读指引（保持既有摘要文案）", () => {
  const message = buildCompactSummaryMessage("some summary", {
    suppressFollowup: true,
  });

  assert.ok(!message.includes("ReadSessionContext"));
  assert.ok(!/still persisted/i.test(message));
  assert.ok(message.includes("some summary"));
});

test("回读指引与既有选项可共存，且不吞掉后续段落", () => {
  const message = buildCompactSummaryMessage("s", {
    recoveryPointer: { sessionId: "sess_x", canReadSessionContext: true },
    suppressFollowup: true,
  });

  assert.ok(message.includes("ReadSessionContext"));
  // suppressFollowup 段落必须仍在——回归保护：插入位置曾把后续分支挤掉。
  assert.ok(
    message.includes("Pick up the last task as if the break never happened."),
    "suppressFollowup 段不能被回读指引吞掉",
  );
});
