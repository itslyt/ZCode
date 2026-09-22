import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

function createMeta(workspacePath: string) {
  return {
    taskId: "sess-move-example",
    traceId: "trace-move-example",
    workspacePath,
    title: "移动示例",
    mode: "build" as const,
    provider: "glm" as const,
    createdAt: 1,
    updatedAt: 2,
  };
}

test("moveTask re-keys the index row and preserves task state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-move-"));
  try {
    const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
    await repo.syncTaskMeta({ meta: createMeta("/example/source") });
    await repo.updateTaskState({
      workspacePath: "/example/source",
      taskId: "sess-move-example",
      patch: { pinned: true, unreadAt: 5 },
    });

    const moved = await repo.moveTask({
      workspacePath: "/example/source",
      taskId: "sess-move-example",
      targetWorkspacePath: "/example/target",
    });
    assert.equal(moved?.workspacePath, "/example/target");
    assert.equal(moved?.title, "移动示例");
    assert.equal(moved?.unreadAt, 5);
    const pinnedTarget = await repo.listTaskMetas({
      workspacePath: "/example/target",
      pinned: true,
    });
    assert.equal(pinnedTarget.length, 1);

    const source = await repo.listTaskMetas({ workspacePath: "/example/source" });
    assert.equal(source.length, 0);
    const target = await repo.listTaskMetas({ workspacePath: "/example/target" });
    assert.equal(target.length, 1);
    assert.equal(target[0]?.taskId, "sess-move-example");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("moveTask is idempotent when the source row is already gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-move-idempotent-"));
  try {
    const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
    await repo.syncTaskMeta({ meta: createMeta("/example/source") });

    await repo.moveTask({
      workspacePath: "/example/source",
      taskId: "sess-move-example",
      targetWorkspacePath: "/example/target",
    });
    const repeated = await repo.moveTask({
      workspacePath: "/example/source",
      taskId: "sess-move-example",
      targetWorkspacePath: "/example/target",
    });
    assert.equal(repeated?.workspacePath, "/example/target");
    const target = await repo.listTaskMetas({ workspacePath: "/example/target" });
    assert.equal(target.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
