import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactSummaryMessage } from "../src/compact/prompt.js";

// 压缩把旧消息从模型面抹掉，但原文仍在会话库（message/part 表不删）。
// 摘要消息必须告知可回读通道，否则模型会把「看不见」当成「不存在」，
// 重做已完成的工作或凭空猜测。见 specs/context-compaction-optimization.md §12。
//
// 用已有的 ReadSessionContext（built-in，始终在工具面）而非新增工具：
// 否则又要维护一套权限/可见性/子 runtime 的边界。

test("给了 sessionId 时摘要消息带本会话回读指引", () => {
  const message = buildCompactSummaryMessage("some summary", {
    sessionId: "sess_abc123",
  });

  assert.ok(message.includes("ReadSessionContext"), "应点名可用的回读工具");
  assert.ok(
    message.includes('sessionId="sess_abc123"'),
    "应给出确切的本会话 id，避免模型去猜或读错会话",
  );
  assert.ok(
    /still persisted/i.test(message),
    "应说明原文仍在，而不是已被销毁",
  );
});

test("没给 sessionId 时不出现回读指引（保持既有摘要文案）", () => {
  const message = buildCompactSummaryMessage("some summary", {
    suppressFollowup: true,
  });

  assert.ok(!message.includes("ReadSessionContext"));
  assert.ok(message.includes("some summary"));
});

test("回读指引与既有选项可共存，且不吞掉后续段落", () => {
  const message = buildCompactSummaryMessage("s", {
    sessionId: "sess_x",
    suppressFollowup: true,
  });

  assert.ok(message.includes("ReadSessionContext"));
  // suppressFollowup 段落必须仍在——回归保护：插入位置曾把后续分支挤掉。
  assert.ok(
    message.includes("Pick up the last task as if the break never happened."),
    "suppressFollowup 段不能被回读指引吞掉",
  );
});
