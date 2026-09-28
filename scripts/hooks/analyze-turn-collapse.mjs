#!/usr/bin/env node
/**
 * 会话「正文段」诊断 —— 量化 mid-turn 注入造成的正文切分与折叠伤害。
 *
 * 背景（详见 specs/hooks-todo-closeout.md）：ZCode 允许在 product turn 中途注入合成消息
 * （内置 todo 提醒、Stop hook 续跑等）后继续同一轮。这使一轮出现多段 assistant 正文，
 * 而轮渲染只把**最后一段**当可见正文（conversationTurnRenderUnits.ts 的
 * latestAssistantTextRow），其余正文落进过程折叠组，用户要展开「已工作 N 秒」才能看到。
 *
 * 本脚本只读会话库（`~/.zcode/cli/db/db.sqlite`），不修改任何状态，用于：
 *   1. 量化规模：多少比例的轮次正文被切成两截、其中多少真答案被折。
 *   2. 归因：切分来自哪一类注入（实测内置 todo 提醒占绝大多数）。
 *   3. 解剖：指定会话逐轮列出「正文段 / 注入行」，用于人工核对。
 *
 * 口径：一次真实用户输入（uiVisibility != "hidden" 的 user 行）开启一个 product turn；
 * 一个 assistant 消息里的每个 text part 记作一段正文；注入行是 uiVisibility == "hidden"
 * 的 user 行。注入与正文按 sequence 交错，因此用有序 token 序列建模，不能分开存。
 *
 * 用法：
 *   node scripts/hooks/analyze-turn-collapse.mjs                 # 全局统计
 *   node scripts/hooks/analyze-turn-collapse.mjs --session <id>  # 附加逐轮解剖
 *   node scripts/hooks/analyze-turn-collapse.mjs --db <path>     # 指定会话库
 */

import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const onlySession = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
const dbIndex = args.indexOf("--db");
const DB = dbIndex >= 0 ? args[dbIndex + 1] : join(homedir(), ".zcode", "cli", "db", "db.sqlite");

const INJECTION_LABELS = {
  todo_reminder: "ZCode 内置 todo 提醒",
  system_reminder: "系统提醒",
  background_notification: "后台通知",
  compact_summary: "压缩摘要",
  fork_notice: "分叉提示",
  hook_context: "Stop hook 续跑",
};

async function sql(query) {
  const { stdout } = await execFile("sqlite3", ["-json", `file:${DB}?mode=ro`, query], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

/** 每轮建模为有序 token：{kind:"text", text} 与 {kind:"injection", name} 按 sequence 排列。 */
async function loadTurns() {
  const sessions = await sql("SELECT id FROM session");
  const turns = [];
  for (const { id: sessionId } of sessions) {
    const messages = await sql(
      `SELECT id AS messageId, data FROM message WHERE session_id='${sessionId}' ORDER BY sequence`,
    );
    let tokens = null;
    const finish = () => {
      if (tokens && tokens.some((token) => token.kind === "text"))
        turns.push({ sessionId, tokens });
    };
    for (const { messageId, data } of messages) {
      const message = JSON.parse(data);
      const semantics = message.semantics ?? {};
      if (message.role === "user" && semantics.uiVisibility !== "hidden") {
        finish();
        tokens = [];
        continue;
      }
      if (!tokens) continue;
      if (message.role === "user" && semantics.uiVisibility === "hidden") {
        tokens.push({ kind: "injection", name: semantics.kind ?? "unknown" });
        continue;
      }
      if (message.role !== "assistant") continue;
      const parts = await sql(
        `SELECT data FROM part WHERE message_id='${messageId}' ORDER BY sequence`,
      );
      for (const { data: partData } of parts) {
        const part = JSON.parse(partData);
        if (part.type === "text" && (part.text ?? "").trim()) {
          tokens.push({ kind: "text", text: part.text.trim() });
        }
      }
    }
    finish();
  }
  return turns;
}

const ratio = (numerator, denominator) =>
  denominator === 0 ? "n/a" : `${((numerator / denominator) * 100).toFixed(1)}%`;

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const textLengths = (tokens) => tokens.filter((t) => t.kind === "text").map((t) => t.text.length);

/** 注入是否夹在「两段正文之间」——这才是会切分正文的注入。 */
function injectionSplitsText(tokens) {
  const textPositions = tokens.map((t, i) => (t.kind === "text" ? i : -1)).filter((i) => i >= 0);
  for (let i = 0; i + 1 < textPositions.length; i += 1) {
    const between = tokens.slice(textPositions[i] + 1, textPositions[i + 1]);
    if (between.some((t) => t.kind === "injection")) return true;
  }
  return false;
}

const turns = await loadTurns();
const segmentCounts = turns.map((turn) => textLengths(turn.tokens).length);
const totalSegments = segmentCounts.reduce((a, b) => a + b, 0);

console.log(`会话库：${DB}`);
console.log(`样本：${turns.length} 个 product turn，${totalSegments} 段正文\n`);

console.log("=== 每轮正文段数 ===");
console.log(`  中位 ${median(segmentCounts)}  最大 ${Math.max(...segmentCounts)}`);
for (const [from, to] of [
  [1, 1],
  [2, 3],
  [4, 7],
  [8, Infinity],
]) {
  const count = segmentCounts.filter((n) => n >= from && n <= to).length;
  const label = to === Infinity ? `>=${from}` : from === to ? `${from}` : `${from}-${to}`;
  console.log(
    `  ${label.padStart(5)} 段：${String(count).padStart(4)} 轮  ${ratio(count, turns.length)}`,
  );
}

const allLengths = turns.flatMap((turn) => textLengths(turn.tokens));
const shortCount = allLengths.filter((n) => n < 200).length;
console.log(
  `\n  短于 200 字符的段：${shortCount}/${totalSegments} = ${ratio(shortCount, totalSegments)}` +
    `（工具间旁白，是全展开方案的主要噪音源）`,
);

console.log("\n=== 注入切分与折叠伤害 ===");
const splitTurns = turns.filter((turn) => injectionSplitsText(turn.tokens));
const harmedTurns = splitTurns.filter((turn) => {
  const lengths = textLengths(turn.tokens);
  return lengths[lengths.length - 1] < Math.max(...lengths.slice(0, -1));
});
console.log(
  `  正文被注入切成两截：${splitTurns.length}/${turns.length} = ${ratio(splitTurns.length, turns.length)}`,
);
console.log(
  `  其中末段短于前文最长段（真答案可能被折）：${harmedTurns.length}/${turns.length} = ${ratio(harmedTurns.length, turns.length)}`,
);

console.log("\n=== 注入来源 ===");
const injectionCounts = new Map();
for (const turn of turns) {
  for (const token of turn.tokens) {
    if (token.kind === "injection") {
      injectionCounts.set(token.name, (injectionCounts.get(token.name) ?? 0) + 1);
    }
  }
}
const totalInjections = [...injectionCounts.values()].reduce((a, b) => a + b, 0);
for (const [name, count] of [...injectionCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(
    `  ${(INJECTION_LABELS[name] ?? name).padEnd(24)} ${String(count).padStart(5)}  ${ratio(count, totalInjections)}`,
  );
}

if (onlySession) {
  console.log(`\n=== 会话解剖：${onlySession} ===`);
  const scoped = turns.filter((turn) => turn.sessionId === onlySession);
  const multi = scoped.filter((turn) => textLengths(turn.tokens).length > 1);
  console.log(`  共 ${scoped.length} 轮，其中多段正文 ${multi.length} 轮\n`);
  for (const [index, turn] of scoped.entries()) {
    const lengths = textLengths(turn.tokens);
    if (lengths.length < 2) continue;
    const injections = turn.tokens.filter((t) => t.kind === "injection").map((t) => t.name);
    console.log(`  --- 第 ${index + 1} 轮：${lengths.length} 段正文，${injections.length} 次注入`);
    if (injections.length > 0) {
      const labels = [...new Set(injections)].map((n) => INJECTION_LABELS[n] ?? n);
      console.log(`      注入：${labels.join("、")}`);
    }
    let textIndex = 0;
    for (const token of turn.tokens) {
      if (token.kind !== "text") continue;
      textIndex += 1;
      const marker = textIndex === lengths.length ? "可见" : "折叠";
      console.log(
        `      [${marker} ${String(token.text.length).padStart(4)}字] ${token.text.slice(0, 60).replace(/\n/g, " ")}`,
      );
    }
  }
}
