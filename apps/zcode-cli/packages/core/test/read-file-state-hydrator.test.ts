import assert from "node:assert/strict";
import test from "node:test";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap } from "../src/tool/types.js";

/**
 * resume 时读状态的恢复。
 *
 * 这组测试盯的是一个具体回归：hydrator 原先只匹配 `part.tool === "Edit"`，
 * 而锚点编辑的部件名是 `EditAnchored`，于是它写的读状态（含 served 集合）在 resume
 * 后整个丢掉，之前建立的 served 归零，之后第一次锚点编辑大概率撞 unserved。
 */

const EDIT_FILE = "/tmp/hydrator-edit.ts";
const ANCHORED_FILE = "/tmp/hydrator-anchored.ts";

function editMetadata(path: string, content: string, tool: string) {
  return {
    readFileState: {
      schemaVersion: 1,
      tool,
      path,
      content,
      isPartialView: false,
      readAtMs: Date.now(),
      revisionId: `rev-${tool}`,
      mtimeMs: 1_700_000_000_000,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      servedAnchors: ["AAAA", "BBBB"],
    },
  };
}

function assistantMessageWith(parts: unknown[]) {
  return {
    info: { id: "msg_1", role: "assistant", sessionID: "sess_1" },
    parts,
  };
}

function completedToolPart(input: { id: string; tool: string; path: string; content: string }) {
  return {
    id: input.id,
    type: "tool",
    callID: `call_${input.id}`,
    tool: input.tool,
    state: {
      status: "completed",
      input: { file_path: input.path },
      output: {},
      metadata: editMetadata(input.path, input.content, input.tool),
    },
  };
}

test("resume 同时恢复 Edit 与 EditAnchored 写下的读状态", async () => {
  const readFileState: ReadFileStateMap = new Map();

  const result = await hydrateReadFileStateFromSession({
    messages: [
      assistantMessageWith([
        completedToolPart({ id: "p1", tool: "Edit", path: EDIT_FILE, content: "const a = 2;" }),
        completedToolPart({
          id: "p2",
          tool: "EditAnchored",
          path: ANCHORED_FILE,
          content: "const b = 2;",
        }),
      ]),
    ],
    readFileState,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  } as never);

  assert.equal(result.restoredCount, 2, "两条读状态都应恢复");
  assert.ok(readFileState.has(createReadFileStateKey(EDIT_FILE, 1, undefined)));
  assert.ok(
    readFileState.has(createReadFileStateKey(ANCHORED_FILE, 1, undefined)),
    "EditAnchored 的读状态不能丢",
  );
});

test("恢复出来的 served 集合可用", async () => {
  const readFileState: ReadFileStateMap = new Map();

  await hydrateReadFileStateFromSession({
    messages: [
      assistantMessageWith([
        completedToolPart({
          id: "p1",
          tool: "EditAnchored",
          path: ANCHORED_FILE,
          content: "const b = 2;",
        }),
      ]),
    ],
    readFileState,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  } as never);

  const entry = readFileState.get(createReadFileStateKey(ANCHORED_FILE, 1, undefined));
  assert.deepEqual(entry?.servedAnchors, ["AAAA", "BBBB"]);
});

function failedToolPart(input: {
  id: string;
  tool: string;
  path: string;
  content: string;
  metadata?: unknown;
}) {
  return {
    id: input.id,
    type: "tool",
    callID: `call_${input.id}`,
    tool: input.tool,
    state: {
      status: "error",
      input: { file_path: input.path },
      error: "anchor no longer exists",
      metadata: input.metadata ?? editMetadata(input.path, input.content, input.tool),
    },
  };
}

test("resume 从失败的 EditAnchored 部件恢复 served（跨会话的 reject-and-serve）", async () => {
  const readFileState: ReadFileStateMap = new Map();

  const result = await hydrateReadFileStateFromSession({
    messages: [
      assistantMessageWith([
        failedToolPart({
          id: "p1",
          tool: "EditAnchored",
          path: ANCHORED_FILE,
          content: "const b = 2;",
        }),
      ]),
    ],
    readFileState,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  } as never);

  assert.equal(result.restoredCount, 1, "失败部件上的读状态也要恢复");
  const entry = readFileState.get(createReadFileStateKey(ANCHORED_FILE, 1, undefined));
  assert.deepEqual(
    entry?.servedAnchors,
    ["AAAA", "BBBB"],
    "拒绝信息里回传的锚点必须算看过，否则重发撞 unserved",
  );
});

test("失败部件没带读状态时不会凭空造出已读", async () => {
  const readFileState: ReadFileStateMap = new Map();

  const result = await hydrateReadFileStateFromSession({
    messages: [
      assistantMessageWith([
        failedToolPart({ id: "p1", tool: "Write", path: EDIT_FILE, content: "x", metadata: {} }),
      ]),
    ],
    readFileState,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  } as never);

  assert.equal(result.restoredCount, 0);
  assert.equal(readFileState.size, 0, "没有 readFileState 的失败件不能凭空变成已读");
});

/**
 * 恢复是按「部件带没带合法读状态」判的，**不是**按工具名是不是 `EditAnchored`。
 *
 * 写成测试是因为这一点容易被误读成「其它工具的 error 部件天然被跳过」——实际不成立：
 * `Write` / `Edit` 的 error 部件只要带了合法 metadata 就会被恢复。这是有意为之，因为
 * 读状态与调用成功与否无关：这两个 handler 只在**写入成功之后**才记读状态，所以模型的
 * 视图是准的，调用后来因为 serialize / emit 抛错而被报成失败并不让视图变错。
 *
 * 真正的不变式在 handler 一侧：只有确实读过或写过文件的 handler 才写读状态。
 * 通用层不应该按 tool 名特判（`executor/errors.ts` 的注释就是为这条原则写的）。
 */
test("带合法读状态的 Write 失败件也会恢复（恢复不按工具名特判）", async () => {
  const readFileState: ReadFileStateMap = new Map();

  const result = await hydrateReadFileStateFromSession({
    messages: [
      assistantMessageWith([
        failedToolPart({ id: "p1", tool: "Write", path: EDIT_FILE, content: "const a = 2;" }),
      ]),
    ],
    readFileState,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  } as never);

  assert.equal(result.restoredCount, 1);
  assert.deepEqual(
    readFileState.get(createReadFileStateKey(EDIT_FILE, 1, undefined))?.servedAnchors,
    ["AAAA", "BBBB"],
  );
});

test("失败部件里 tool 名不认识时同样拒绝恢复", async () => {
  const readFileState: ReadFileStateMap = new Map();

  const result = await hydrateReadFileStateFromSession({
    messages: [
      assistantMessageWith([
        failedToolPart({
          id: "p1",
          tool: "EditAnchored",
          path: ANCHORED_FILE,
          content: "x",
          metadata: editMetadata(ANCHORED_FILE, "x", "SomethingElse"),
        }),
      ]),
    ],
    readFileState,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  } as never);

  assert.equal(result.restoredCount, 0);
  assert.equal(readFileState.size, 0);
});

test("metadata 里 tool 名不认识时拒绝恢复，不静默当成功", async () => {
  const readFileState: ReadFileStateMap = new Map();

  const result = await hydrateReadFileStateFromSession({
    messages: [
      assistantMessageWith([
        {
          ...completedToolPart({ id: "p1", tool: "Edit", path: EDIT_FILE, content: "x" }),
          state: {
            status: "completed",
            input: {},
            output: {},
            metadata: editMetadata(EDIT_FILE, "x", "SomethingElse"),
          },
        },
      ]),
    ],
    readFileState,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  } as never);

  assert.equal(result.restoredCount, 0);
  assert.equal(readFileState.size, 0);
});
