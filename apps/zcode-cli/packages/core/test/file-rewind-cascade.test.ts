import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts } from "../src/runtime/deps.js";
import {
  activeSuffixMessageIdsForRewind,
  resolveFileRewindTargetMessageIds,
} from "../src/runtime/helpers/rewind.js";

// 编辑第 N 轮 = 对话截断到第 N 轮，所以文件回滚也必须从第 N 轮级联到活跃分支末尾。
// 只回滚第 N 轮会让第 N+1.. 轮的改动留在盘上，与截断后的对话矛盾，且后续轮 checkpoint
// 会基于已回滚的内容再次回滚。见 specs/edit-history-message-rewind.md §2.3。

function message(id: string): MessageWithParts {
  return { info: { id, role: "user" } } as unknown as MessageWithParts;
}

const messages = [message("m1"), message("m2"), message("m3"), message("m4")];

test("cascade 从目标轮展开到活跃分支末尾", () => {
  assert.deepEqual(
    resolveFileRewindTargetMessageIds({
      cascade: true,
      targetMessageId: "m2" as never,
      activeMessages: messages,
    }),
    ["m2", "m3", "m4"],
  );
});

test("目标就是最后一轮时 cascade 退化为单轮", () => {
  assert.deepEqual(
    resolveFileRewindTargetMessageIds({
      cascade: true,
      targetMessageId: "m4" as never,
      activeMessages: messages,
    }),
    ["m4"],
  );
});

test("目标不在活跃分支（已被 revert 裁掉）时退回单值语义", () => {
  // 与 rewindWorkspaceCascadeToMessage 的 suffix.length > 0 ? suffix : [target] 一致：
  // 不能因为展开为空就静默变成「不回滚任何文件」。
  assert.deepEqual(
    resolveFileRewindTargetMessageIds({
      cascade: true,
      targetMessageId: "gone" as never,
      activeMessages: messages,
    }),
    ["gone"],
  );
});

test("未开启 cascade 时完全走显式 targetMessageIds，不做任何展开", () => {
  assert.deepEqual(
    resolveFileRewindTargetMessageIds({
      targetMessageId: "m2" as never,
      targetMessageIds: ["only-this"] as never,
      activeMessages: messages,
    }),
    ["only-this"],
  );
  assert.equal(
    resolveFileRewindTargetMessageIds({ activeMessages: messages }),
    undefined,
  );
});

test("activeSuffixMessageIdsForRewind 对空活跃集返回空，不抛错", () => {
  assert.deepEqual(activeSuffixMessageIdsForRewind([], "m1" as never), []);
});
