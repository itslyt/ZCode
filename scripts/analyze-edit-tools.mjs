// 编辑工具使用情况分析：EditAnchored / Edit 的调用比、失败原因分布、连续失败与降级遵守率。
//
// 用法：
//   node scripts/analyze-edit-tools.mjs                 # 全局
//   node scripts/analyze-edit-tools.mjs sess_xxxx       # 只看某个会话
//
// 只读：DB 以 readOnly 打开，日志只读。
//
// 数据源与字段说明（改这个脚本前先读这段）：
// - ~/.zcode/cli/db/db.sqlite 的 part 表：每个工具调用一个部件。
//     json_extract(data,'$.type')      = 'tool'
//     json_extract(data,'$.tool')      工具名
//     json_extract(data,'$.state.status')  'completed' | 'error'
//     json_extract(data,'$.state.input')   调用参数（含 file_path）
//     json_extract(data,'$.state.error')   失败详情
//     session_id / time_created（毫秒，注意是 integer）
// - ~/.zcode/cli/log/zcode-<日期>.jsonl：失败事件带原因码。
//     event == 'tool.call.failed'
//     顶层 sessionId / context.toolName
//     error.context.code                    handler 返回的 errorCode（按工具命名空间）
//     error.context.toolHandlerFailure.message  人读的原因
//
// 重要口径：失败原因优先用 error.context.code 统计；消息文本只用于交叉校验与归类
// （本仓禁止依赖错误文本做流程判断，分析用途除外）。09-24 之前的构建所有 EditAnchored
// 失败都是 code=1，原因不可分，所以跨版本比较必须按天分段看。

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EDIT_TOOLS = ["EditAnchored", "Edit"];
const FAILURE_BUCKETS = [
  ["malformed", /malformed anchor/i],
  ["unserved", /never (been )?shown|was never shown/i],
  ["stale", /no longer exists/i],
  ["ambiguous", /ambiguous|matches \d+ lines/i],
  ["reversed", /reversed|remove_from.*greater/i],
  ["overlap", /overlap/i],
  ["other", /.*/],
];

const sessionFilter = process.argv[2];
const dbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const logDir = join(homedir(), ".zcode", "cli", "log");

const localDay = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 10);
const utcTime = (ms) => new Date(Number(ms)).toISOString().slice(11, 19);
const pct = (n, d) => (d === 0 ? "-" : `${((n / d) * 100).toFixed(1)}%`);

function loadParts() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const where = sessionFilter ? "AND session_id = ?" : "";
  const query = `
    SELECT json_extract(data, '$.tool') AS tool,
           json_extract(data, '$.state.status') AS status,
           json_extract(data, '$.state.input') AS input,
           session_id AS sid,
           time_created AS t
    FROM part
    WHERE json_extract(data, '$.type') = 'tool' ${where}
    ORDER BY time_created`;
  return sessionFilter ? db.prepare(query).all(sessionFilter) : db.prepare(query).all();
}

function loadFailures() {
  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const out = [];
  for (const file of files) {
    for (const line of readFileSync(join(logDir, file), "utf8").split("\n")) {
      if (!line.includes("tool.call.failed")) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (sessionFilter && row.sessionId !== sessionFilter) continue;
      const tool = row.context?.toolName;
      if (!EDIT_TOOLS.includes(tool)) continue;
      out.push({
        day: (file.match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? file,
        tool,
        code: row.error?.context?.code,
        message: String(
          row.error?.context?.toolHandlerFailure?.message ?? row.error?.message ?? "",
        ),
        sessionId: row.sessionId,
      });
    }
  }
  return out;
}

function reportRatio(parts) {
  console.log("## 1. 调用比（按天，本地时区）\n");
  const perDay = new Map();
  for (const p of parts) {
    if (!EDIT_TOOLS.includes(p.tool)) continue;
    const key = `${localDay(p.t)}|${p.tool}|${p.status}`;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const days = [...new Set([...perDay.keys()].map((k) => k.split("|")[0]))].sort();
  console.log("  日期         EditAnchored(ok/err)   Edit(ok/err)   EA 占比");
  for (const day of days) {
    const get = (tool, status) => perDay.get(`${day}|${tool}|${status}`) ?? 0;
    const ea = get("EditAnchored", "completed") + get("EditAnchored", "error");
    const ed = get("Edit", "completed") + get("Edit", "error");
    console.log(
      `  ${day}   ${String(get("EditAnchored", "completed")).padStart(4)}/${String(get("EditAnchored", "error")).padEnd(4)}` +
        `          ${String(get("Edit", "completed")).padStart(4)}/${String(get("Edit", "error")).padEnd(4)}` +
        `     ${pct(ea, ea + ed)}`,
    );
  }
  console.log();
}

function reportFailureRate(parts) {
  console.log("## 2. 失败率\n");
  for (const tool of EDIT_TOOLS) {
    const list = parts.filter((p) => p.tool === tool);
    if (!list.length) continue;
    const err = list.filter((p) => p.status === "error").length;
    console.log(
      `  ${tool.padEnd(14)} ${list.length - err} 成功 / ${err} 失败  = ${pct(err, list.length)}（共 ${list.length} 次）`,
    );
  }
  console.log();
}

function reportReasons(failures) {
  console.log("## 3. 失败原因\n");
  if (!failures.length) {
    console.log("  （无失败记录）\n");
    return;
  }
  const byCode = new Map();
  const byBucket = new Map();
  const byDayBucket = new Map();
  for (const f of failures) {
    byCode.set(`${f.tool} code=${f.code}`, (byCode.get(`${f.tool} code=${f.code}`) ?? 0) + 1);
    const bucket = FAILURE_BUCKETS.find(([, re]) => re.test(f.message))?.[0] ?? "other";
    byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
    byDayBucket.set(`${f.day}|${bucket}`, (byDayBucket.get(`${f.day}|${bucket}`) ?? 0) + 1);
  }
  console.log("  按原因码（日志里 error.context.code）:");
  [...byCode.entries()].sort().forEach(([k, n]) => console.log(`    ${k}  ×${n}`));
  console.log("\n  按消息归类（交叉校验用）:");
  const total = failures.length;
  [...byBucket.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) =>
      console.log(`    ${k.padEnd(11)} ${String(n).padStart(3)}  ${pct(n, total)}`),
    );
  console.log("\n  按天:");
  const days = [...new Set([...byDayBucket.keys()].map((k) => k.split("|")[0]))].sort();
  for (const day of days) {
    const parts = [...byDayBucket.entries()]
      .filter(([k]) => k.startsWith(`${day}|`))
      .map(([k, n]) => `${k.split("|")[1]}=${n}`);
    console.log(`    ${day}: ${parts.join("  ")}`);
  }
  console.log();
}

function reportRuns(parts) {
  console.log("## 4. 连续失败与降级遵守率\n");
  const byFile = new Map();
  for (const p of parts) {
    if (!EDIT_TOOLS.includes(p.tool)) continue;
    let file;
    try {
      file = JSON.parse(p.input ?? "{}").file_path;
    } catch {
      file = undefined;
    }
    if (!file) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(p);
  }
  let runs = 0;
  let degraded = 0;
  let stuck = 0;
  let noNext = 0;
  for (const list of byFile.values()) {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].status !== "error") continue;
      let j = i;
      while (j + 1 < list.length && list[j + 1].status === "error") j += 1;
      if (j - i + 1 < 2) {
        i = j;
        continue;
      }
      runs += 1;
      const next = list[j + 1];
      if (!next) noNext += 1;
      else if (next.tool === "Edit") degraded += 1;
      else stuck += 1;
      i = j;
    }
  }
  const decided = degraded + stuck;
  console.log(`  同一文件连续失败 ≥2 次的片段: ${runs}`);
  console.log(`    改用 Edit（降级生效）: ${degraded}`);
  console.log(`    仍用 EditAnchored     : ${stuck}`);
  console.log(`    该文件无后续编辑      : ${noNext}`);
  console.log(`  降级遵守率（仅看有下一次编辑的）: ${pct(degraded, decided)}`);
  console.log();
}

function reportUnservedDetail(failures) {
  const malformed = failures.filter((f) => /malformed anchor/i.test(f.message));
  if (!malformed.length) return;
  console.log("## 5. malformed 锚点样本（判断是否「只给哈希不给行号」）\n");
  const seen = new Map();
  for (const f of malformed) {
    const m = f.message.match(/malformed anchor: "([^"]*)"/);
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const hashOnly = [...seen.keys()].filter((a) => /^[0-9A-Z]{4}$/.test(a));
  [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([a, n]) => {
      console.log(
        `    ×${n}  ${JSON.stringify(a)}${/^[0-9A-Z]{4}$/.test(a) ? "   ← 裸哈希（缺行号）" : ""}`,
      );
    });
  console.log(
    `\n  其中裸哈希 ${hashOnly.length} / ${seen.size} 种 — 裸哈希若在文件内唯一，行号是冗余信息，可直接解析。\n`,
  );
}

const parts = loadParts();
const failures = loadFailures();
console.log(`# 编辑工具使用分析${sessionFilter ? `（会话 ${sessionFilter}）` : "（全局）"}`);
console.log(`工具调用 ${parts.length} 次；编辑类失败事件 ${failures.length} 条\n`);
reportRatio(parts);
reportFailureRate(parts);
reportReasons(failures);
reportRuns(parts);
reportUnservedDetail(failures);
