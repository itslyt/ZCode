import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import { resolveTaskMoveBlockedReason } from "../src/lib/taskMoveEligibility.js";

test("local idle task with no open pane can move", () => {
  assert.equal(
    resolveTaskMoveBlockedReason({
      task: { status: "completed", workspaceIdentity: undefined },
      taskId: "sess-1",
      activeTaskId: "sess-2",
    }),
    null,
  );
});

test("remote workspace source is blocked", () => {
  assert.equal(
    resolveTaskMoveBlockedReason({
      task: {
        status: "completed",
        workspaceIdentity: buildRemoteWorkspaceIdentity("/srv/app", {
          kind: "ssh",
          host: "host-a",
          port: 22,
          username: "dev",
        }),
      },
      taskId: "sess-1",
    }),
    "taskList.moveToProjectRemoteBlocked",
  );
});

test("running task is blocked by persisted status or live runtime status", () => {
  assert.equal(
    resolveTaskMoveBlockedReason({
      task: { status: "running", workspaceIdentity: undefined },
      taskId: "sess-1",
    }),
    "taskList.moveToProjectRunningBlocked",
  );
  assert.equal(
    resolveTaskMoveBlockedReason({
      task: { status: "completed", workspaceIdentity: undefined },
      taskId: "sess-1",
      runtimeStatus: "streaming",
    }),
    "taskList.moveToProjectRunningBlocked",
  );
});

test("task open as the workspace active task is blocked", () => {
  assert.equal(
    resolveTaskMoveBlockedReason({
      task: { status: "completed", workspaceIdentity: undefined },
      taskId: "sess-1",
      activeTaskId: "sess-1",
    }),
    "taskList.moveToProjectOpenBlocked",
  );
});
