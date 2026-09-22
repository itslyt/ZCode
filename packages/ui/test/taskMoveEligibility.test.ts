import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import { resolveTaskMoveBlockedReason } from "../src/lib/taskMoveEligibility.js";

test("local idle task can move", () => {
  assert.equal(
    resolveTaskMoveBlockedReason({
      task: { status: "completed", workspaceIdentity: undefined },
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
    }),
    "taskList.moveToProjectRemoteBlocked",
  );
});

test("running task is blocked by persisted status or live runtime status", () => {
  assert.equal(
    resolveTaskMoveBlockedReason({
      task: { status: "running", workspaceIdentity: undefined },
    }),
    "taskList.moveToProjectRunningBlocked",
  );
  assert.equal(
    resolveTaskMoveBlockedReason({
      task: { status: "completed", workspaceIdentity: undefined },
      runtimeStatus: "streaming",
    }),
    "taskList.moveToProjectRunningBlocked",
  );
});

test("stale persisted running yields to a live non-running runtime state", () => {
  assert.equal(
    resolveTaskMoveBlockedReason({
      task: { status: "running", workspaceIdentity: undefined },
      runtimeStatus: "completed",
    }),
    null,
  );
});
