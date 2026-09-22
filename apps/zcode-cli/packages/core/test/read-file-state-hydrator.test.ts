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
