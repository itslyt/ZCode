import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("./todo-closeout.mjs", import.meta.url));

let stateDir;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "todo-closeout-test-"));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** 用真实进程跑 hook，验证 stdin/stdout 契约而不只是内部函数。 */
function runHook(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ZCODE_TODO_CLOSEOUT_STATE_DIR: stateDir },
  });
  assert.equal(result.status, 0, `hook must exit 0, got ${result.status}: ${result.stderr}`);
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function todoWriteEvent(sessionId, todos) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    session_id: sessionId,
    tool_input: { todos },
  };
}

function stopEvent(sessionId, extra = {}) {
  return { hook_event_name: "Stop", session_id: sessionId, ...extra };
}

const openTodo = { content: "实现 hook", status: "in_progress", priority: "high" };
const doneTodo = { content: "写 spec", status: "completed", priority: "high" };

describe("todo-closeout hook", () => {
  it("本轮写过列表且仍有未完成项 → 继续本轮并注入提醒", () => {
    const session = "sess_open";
    runHook(todoWriteEvent(session, [doneTodo, openTodo]));
    const { stdout } = runHook(stopEvent(session));
    assert.notEqual(stdout, "", "expected a steer on stdout");
    const output = JSON.parse(stdout);
    assert.equal(output.continue, true);
    assert.match(output.additionalContext, /items still open/);
    assert.match(output.additionalContext, /Never mark unfinished work complete/);
  });

  it("同一轮第二次 Stop（stop_hook_active）→ 不重复提醒", () => {
    const session = "sess_second_stop";
    runHook(todoWriteEvent(session, [openTodo]));
    const first = runHook(stopEvent(session));
    assert.notEqual(first.stdout, "");
    const second = runHook(stopEvent(session, { stop_hook_active: true }));
    assert.equal(second.stdout, "");
  });

  it("已消费的列表在后续轮次不再提醒", () => {
    const session = "sess_consumed";
    runHook(todoWriteEvent(session, [openTodo]));
    assert.notEqual(runHook(stopEvent(session)).stdout, "");
    assert.equal(runHook(stopEvent(session)).stdout, "", "second turn must stay silent");
  });

  it("本轮列表全部完成 → 不提醒", () => {
    const session = "sess_all_done";
    runHook(todoWriteEvent(session, [doneTodo]));
    assert.equal(runHook(stopEvent(session)).stdout, "");
  });

  it("本轮没写过 TodoWrite → 不提醒", () => {
    assert.equal(runHook(stopEvent("sess_no_todo")).stdout, "");
  });

  it("非 TodoWrite 的 PostToolUse 不建立状态", () => {
    const session = "sess_other_tool";
    runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      session_id: session,
      tool_input: {},
    });
    assert.equal(runHook(stopEvent(session)).stdout, "");
  });

  it("空列表写入不建立状态（清空列表不该被提醒）", () => {
    const session = "sess_empty";
    runHook(todoWriteEvent(session, []));
    assert.equal(runHook(stopEvent(session)).stdout, "");
  });

  it("非法 stdin / 缺 session_id / 未知事件 → 静默退出 0", () => {
    assert.equal(runHook("{not json").stdout, "");
    assert.equal(runHook({ hook_event_name: "Stop" }).stdout, "");
    assert.equal(runHook({ hook_event_name: "SessionStart", session_id: "sess_x" }).stdout, "");
    assert.equal(runHook("").stdout, "");
  });

  it("状态文件损坏时按无状态处理", async () => {
    const session = "sess_corrupt";
    await writeFile(join(stateDir, `${session}.json`), "{broken", "utf8");
    assert.equal(runHook(stopEvent(session)).stdout, "");
  });

  it("状态写入可被后续进程读到（跨进程持久化）", async () => {
    const session = "sess_persist";
    runHook(todoWriteEvent(session, [openTodo]));
    const raw = await readFile(join(stateDir, `${session}.json`), "utf8");
    const state = JSON.parse(raw);
    assert.equal(typeof state.writtenAt, "number");
    assert.equal(state.todos.length, 1);
  });
});
