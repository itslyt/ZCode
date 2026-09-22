#!/usr/bin/env node
/**
 * todo-closeout — ZCode hook（配置级机制，非 fork 源码改动）。
 *
 * 根因：ZCode 的待办列表是跨轮持久化的模型自有状态，一轮「活干完了但列表还开着」结束时，
 * 用户看到的是假状态。提示词只能请求模型收尾，不能强制；本 hook 在 Stop 边界上强制执行。
 * 移植自 DSH preset `code-max-omni` 的 todo-closeout.mjs（in-process 插件），
 * 按 ZCode 的 hook 契约改写：见 specs/hooks-todo-closeout.md。
 *
 * 两个事件共用本脚本，按 stdin 的 hook_event_name 分派：
 *  - PostToolUse(TodoWrite)：记录列表与 writtenAt
 *  - Stop：本轮写过列表且有未完成项 → {"continue": true, "additionalContext": ...}
 *
 * 任何异常都静默退出（exit 0），绝不影响对话。
 */

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const NOTICE_TEXT = [
  "Todo check: this turn wrote your todo list and is now ending with items still open.",
  "If any of that work is actually finished, mark it completed with TodoWrite now.",
  "If it is genuinely unfinished, keep it open and say which items remain and why.",
  "Never mark unfinished work complete just to close the list.",
].join(" ");

const OPEN_STATUSES = new Set(["pending", "in_progress"]);
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STATE_FILES = 200;

function stateDir() {
  const override = process.env.ZCODE_TODO_CLOSEOUT_STATE_DIR;
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  return join(homedir(), ".zcode", "hooks", "state", "todo-closeout");
}

function statePath(sessionId) {
  // session id 由 ZCode 生成（sess_<uuid>），仍做一次白名单过滤，避免路径穿越。
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(stateDir(), `${safe}.json`);
}

async function readState(sessionId) {
  try {
    const raw = await readFile(statePath(sessionId), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeState(sessionId, state) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(sessionId), `${JSON.stringify(state)}\n`, "utf8");
  await pruneStateFiles(dir);
}

/** 状态文件按 mtime 清理，避免无限增长。 */
async function pruneStateFiles(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  if (names.length <= MAX_STATE_FILES) {
    const now = Date.now();
    await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (now - info.mtimeMs > STATE_TTL_MS) await rm(path, { force: true });
        } catch {
          // 清理失败不影响本轮
        }
      }),
    );
    return;
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      try {
        return { path, mtimeMs: (await stat(path)).mtimeMs };
      } catch {
        return { path, mtimeMs: 0 };
      }
    }),
  );
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(entries.slice(MAX_STATE_FILES).map((entry) => rm(entry.path, { force: true })));
}

function normalizeTodos(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((todo) => typeof todo === "object" && todo !== null)
    .map((todo) => ({
      content: typeof todo.content === "string" ? todo.content : "",
      status: typeof todo.status === "string" ? todo.status : "",
    }));
}

/** 诊断日志：ZCODE_TODO_CLOSEOUT_DEBUG=1 时记录每次调用与决策，便于排查“为什么没提醒/重复提醒”。 */
async function debugLog(sessionId, event, detail) {
  try {
    const dir = stateDir();
    await mkdir(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${event} session=${sessionId} ${JSON.stringify(detail)}\n`;
    await appendFile(join(dir, "debug.log"), line, "utf8");
  } catch {
    // 诊断失败不影响机制
  }
}

async function handlePostToolUse(payload) {
  if (payload.tool_name !== "TodoWrite") return;
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  const todos = normalizeTodos(payload.tool_input?.todos);
  if (todos.length === 0) return;
  await writeState(sessionId, { writtenAt: Date.now(), todos });
}

async function handleStop(payload) {
  // ZCode 已经因为本轮的 Stop hook 续跑过一次：不再提醒。
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  const state = await readState(sessionId);
  const debug = process.env.ZCODE_TODO_CLOSEOUT_DEBUG === "1";
  if (debug)
    await debugLog(sessionId, "stop", {
      active: payload.stop_hook_active === true,
      consumed: state?.consumedAt === state?.writtenAt,
      open: normalizeTodos(state?.todos).filter((todo) => OPEN_STATUSES.has(todo.status)).length,
    });
  // ZCode 已经因为本轮的 Stop hook 续跑过一次：不再提醒。
  if (payload.stop_hook_active === true) return;
  if (!state || typeof state.writtenAt !== "number") return;
  // 本轮没写过列表（writtenAt 已被消费）→ 不说话。
  if (state.consumedAt === state.writtenAt) return;
  const open = normalizeTodos(state.todos).filter((todo) => OPEN_STATUSES.has(todo.status));
  if (open.length === 0) {
    await writeState(sessionId, { ...state, consumedAt: state.writtenAt });
    return;
  }
  await writeState(sessionId, { ...state, consumedAt: state.writtenAt });
  if (debug) await debugLog(sessionId, "steer", { open: open.length });
  process.stdout.write(`${JSON.stringify({ continue: true, additionalContext: NOTICE_TEXT })}\n`);
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof payload !== "object" || payload === null) return;
  switch (payload.hook_event_name) {
    case "PostToolUse":
      await handlePostToolUse(payload);
      return;
    case "Stop":
      await handleStop(payload);
      return;
    default:
      return;
  }
}

main().catch((error) => {
  // 一次性降级：机制失败绝不影响对话边界。
  process.stderr.write(`todo-closeout: ${String(error?.message ?? error)}\n`);
  process.exitCode = 0;
});
