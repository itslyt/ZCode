import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuiltInToolAllowlist } from "../src/runtime/helpers/tool-allowlist.js";
import { buildReferencedSessionContextReminderBody } from "../src/session-context/references.js";

// 「引用 #sess_xxx」的提醒会告诉模型用什么去读那个会话的历史。
// 曾经它无条件写死 `call ReadSessionContext`，而该工具不在本 fork 的工具面里——
// 实测 sess_f7d418fa（2026-09-29T02:15:56）的请求里提醒在场、toolNames 却没有它。
// 同一类缺陷在压缩摘要里也有一处。见 specs/context-compaction-optimization.md §15。
//
// 修正分两层：
//   1. ReadSessionContext 加回 CODING_ONLY_TOOLS（默认面），让提示与能力一致；
//   2. 提醒是否点名它仍按**实际注册结果**决定，因为会话可用 toolAllowlist 收窄掉它。

const REFERENCED = "check #sess_f24fbcc0-5e57-48d4-8b44-e655a3ecad3d please";

test("默认工具面里有 ReadSessionContext（引用会话的提示依赖它）", () => {
  const allowlist = resolveBuiltInToolAllowlist({} as never) ?? [];
  assert.ok(
    allowlist.includes("ReadSessionContext"),
    "提示会叫模型调它，它就必须真的在面里——否则提示指向一个不存在的工具",
  );
});

test("默认面下引用会话：提醒点名 ReadSessionContext，并带上被引用的 id", () => {
  const body = buildReferencedSessionContextReminderBody(REFERENCED, {
    canReadSessionContext: true,
  });
  assert.ok(body, "有 #sess_ 引用就该产出提醒");
  assert.ok(body.includes("ReadSessionContext"), "工具在面里时应点名它");
  assert.ok(
    body.includes("sess_f24fbcc0-5e57-48d4-8b44-e655a3ecad3d"),
    "应列出被引用的确切 sessionId",
  );
  assert.ok(/not automatically expanded/i.test(body), "仍须说明引用不会自动展开");
  assert.ok(/untrusted/i.test(body), "仍须把历史标为不可信背景");
});

test("工具被 toolAllowlist 收窄掉时，提醒不得点名它", () => {
  const body = buildReferencedSessionContextReminderBody(REFERENCED, {
    canReadSessionContext: false,
  });
  assert.ok(body);
  assert.ok(
    !body.includes("ReadSessionContext"),
    "工具不在面里时点名它是失实指引，模型会白跑一次工具调用",
  );
  assert.ok(/persisted history/i.test(body ?? ""), "仍须告知可从会话存储读到");
});

test("没有 #sess_ 引用时不产出提醒（不改变既有行为）", () => {
  assert.equal(buildReferencedSessionContextReminderBody("just a normal prompt"), null);
  assert.equal(
    buildReferencedSessionContextReminderBody("just a normal prompt", {
      canReadSessionContext: false,
    }),
    null,
  );
});

test("ReadSessionContext 的 provider 体积有上限（防止它悄悄变胖）", () => {
  // 加回工具面时记录的量级：987 字符 ≈ 329 token，占 450K 窗口 0.07%。
  // 这条断言是提醒——若它明显变大，应该重新评估是否值得留在默认面里。
  const body = buildReferencedSessionContextReminderBody(REFERENCED, {
    canReadSessionContext: true,
  });
  assert.ok(body && body.length < 1_200, "提醒本身不应膨胀");
});
