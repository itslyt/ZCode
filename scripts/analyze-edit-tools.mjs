// 编辑工具使用情况分析：EditAnchored / Edit 的调用比、失败原因分布、恢复代价、连续失败与降级遵守率。
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
// 两条必须遵守的口径：
//
// 1. 原因分类用 part 表的 state.error 文本，不用日志的 error.context.code——
//    实测两者存在错位（unserved 会被记成别的 code）。日志那一路只作交叉校验。
//    09-24 之前的构建所有 EditAnchored 失败都是 code=1，原因不可分，所以跨版本
//    比较必须按天分段看。
// 2. 剔除自测造数。真实会话里会出现人为构造的假锚点（"abc"、ZZZZ、
//    zcode-anchor-verify 之类），会把「测试流量」算成「真实缺陷」。见 ARTIFACT_PATTERN。

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EDIT_TOOLS = ["EditAnchored", "Edit"];

/** 自测/构造数据里出现的假锚点，不是真实缺陷。 */
const ARTIFACT_PATTERN = /ZZZZ|2CAP|WB9Z|PHZF|DK0B|"abc"|not-an-anchor/;

/**
 * 失败原因分类。顺序有意义：schema 与 malformed 要先判，因为它们的文案里
 * 可能同时出现行号字样；ambiguous 要在 stale 之前判。
 */
const FAILURE_KINDS = [
  ["schema", /inputSchema validation/i],
  ["malformed", /malformed anchor/i],
  ["unserved", /never (been )?shown/i],
  ["stale", /no longer exists/i],
  ["ambiguous", /matches \d+ lines/i],
  ["reversed", /remove_from after remove_to/i],
  ["overlap", /overlap/i],
  ["other", /.*/],
];

const kindOf = (text) => FAILURE_KINDS.find(([, re]) => re.test(text))?.[0] ?? "other";

const sessionFilter = process.argv[2];
const dbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const logDir = join(homedir(), ".zcode", "cli", "log");

const localDay = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 10);
const pct = (n, d) => (d === 0 ? "-" : `${((n / d) * 100).toFixed(1)}%`);
const baseName = (p) => String(p ?? "").split("/").slice(-1)[0];

const parseInput = (raw) => {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
};

const isArtifact = (p) => ARTIFACT_PATTERN.test(`${p.input ?? ""} ${p.error ?? ""}`);

function loadParts() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const where = sessionFilter ? "AND session_id = ?" : "";
  const query = `
    SELECT json_extract(data, '$.tool') AS tool,
           json_extract(data, '$.state.status') AS status,
           json_extract(data, '$.state.input') AS input,
           json_extract(data, '$.state.error') AS error,
           session_id AS sid,
           time_created AS t
    FROM part
    WHERE json_extract(data, '$.type') = 'tool' ${where}
    ORDER BY session_id, time_created`;
  return sessionFilter ? db.prepare(query).all(sessionFilter) : db.prepare(query).all();
}

function loadFailureEvents() {
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
        message: String(row.error?.context?.toolHandlerFailure?.message ?? row.error?.message ?? ""),
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
  const clean = parts.filter((p) => !isArtifact(p));
  const dropped = parts.length - clean.length;
  if (dropped > 0) console.log(`  （已剔除 ${dropped} 个造数部件）`);
  for (const tool of EDIT_TOOLS) {
    const list = clean.filter((p) => p.tool === tool);
    if (!list.length) continue;
    const err = list.filter((p) => p.status === "error").length;
    console.log(
      `  ${tool.padEnd(14)} ${list.length - err} 成功 / ${err} 失败  = ${pct(err, list.length)}（共 ${list.length} 次）`,
    );
  }
  console.log();
}

function reportReasons(parts, events) {
  console.log("## 3. 失败原因\n");
  const failures = parts.filter((p) => p.tool === "EditAnchored" && p.status === "error" && !isArtifact(p));
  if (!failures.length) {
    console.log("  （无失败记录）\n");
    return;
  }
  const byKind = new Map();
  const byDayKind = new Map();
  for (const f of failures) {
    const kind = kindOf(String(f.error ?? ""));
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    byDayKind.set(`${localDay(f.t)}|${kind}`, (byDayKind.get(`${localDay(f.t)}|${kind}`) ?? 0) + 1);
  }
  console.log(`  按原因（state.error 文本，共 ${failures.length} 次）:`);
  [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`    ${k.padEnd(11)} ${String(n).padStart(3)}  ${pct(n, failures.length)}`));

  console.log("\n  按天:");
  const days = [...new Set([...byDayKind.keys()].map((k) => k.split("|")[0]))].sort();
  for (const day of days) {
    const cells = [...byDayKind.entries()]
      .filter(([k]) => k.startsWith(`${day}|`))
      .sort()
      .map(([k, n]) => `${k.split("|")[1]}=${n}`);
    console.log(`    ${day}: ${cells.join("  ")}`);
  }

  // 交叉校验：日志原因码与 state.error 分类是否一致（不一致时以 state.error 为准）。
  const codes = new Map();
  for (const e of events) codes.set(`code=${e.code}`, (codes.get(`code=${e.code}`) ?? 0) + 1);
  if (codes.size) {
    console.log("\n  日志原因码（交叉校验，可能与上面不一致）:");
    [...codes.entries()].sort().forEach(([k, n]) => console.log(`    ${k}  ×${n}`));
  }
  console.log();
}

function reportRecoveryCost(parts) {
  console.log("## 4. 恢复代价（失败后到同文件下一次编辑之间的其它工具调用数）\n");
  const clean = parts.filter((p) => !isArtifact(p));
  const isEdit = (t) => EDIT_TOOLS.includes(t) || t === "Write";
  const stats = new Map();
  for (let i = 0; i < clean.length; i += 1) {
    const r = clean[i];
    if (r.tool !== "EditAnchored" || r.status !== "error") continue;
    const kind = kindOf(String(r.error ?? ""));
    const file = parseInput(r.input).file_path;
    if (!stats.has(kind)) stats.set(kind, { n: 0, calls: 0, reads: 0, nextOk: 0, lost: 0, switched: 0 });
    const s = stats.get(kind);
    s.n += 1;
    let next = null;
    let calls = 0;
    let reads = 0;
    for (let j = i + 1; j < clean.length; j += 1) {
      const q = clean[j];
      if (q.sid !== r.sid) break;
      if (isEdit(q.tool) && parseInput(q.input).file_path === file) {
        next = q;
        break;
      }
      calls += 1;
      if (q.tool === "Read" && parseInput(q.input).file_path === file) reads += 1;
    }
    if (!next) {
      s.lost += 1;
      continue;
    }
    s.calls += calls;
    s.reads += reads;
    if (next.status === "completed") s.nextOk += 1;
    else s.lost += 1;
    if (next.tool !== "EditAnchored") s.switched += 1;
  }
  console.log("  原因         次数   总额外调用  平均   其中Read  下一步成功  放弃/换工具");
  [...stats.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .forEach(([kind, s]) =>
      console.log(
        `  ${kind.padEnd(12)}${String(s.n).padStart(4)}${String(s.calls).padStart(10)}` +
          `${(s.calls / s.n).toFixed(2).padStart(8)}${(s.reads / s.n).toFixed(2).padStart(9)}` +
          `${String(s.nextOk).padStart(10)}${String(s.lost).padStart(12)}`,
      ),
    );
  const totalCalls = [...stats.values()].reduce((a, s) => a + s.calls, 0);
  console.log(`\n  累计额外工具调用: ${totalCalls}\n`);
}

function reportRemoveToAdoption(parts) {
  console.log("## 5. remove_to 采用情况（成功调用）\n");
  const clean = parts.filter((p) => p.tool === "EditAnchored" && p.status === "completed" && !isArtifact(p));
  let total = 0;
  let omitted = 0;
  let sameAnchor = 0;
  let multiLine = 0;
  for (const p of clean) {
    const edits = parseInput(p.input).edits;
    if (!Array.isArray(edits)) continue;
    for (const e of edits) {
      total += 1;
      if (e?.remove_to == null || e.remove_to === "") omitted += 1;
      else if (e.remove_to === e.remove_from) sameAnchor += 1;
      else multiLine += 1;
    }
  }
  if (!total) {
    console.log("  （无数据）\n");
    return;
  }
  console.log(`  锚点编辑总数 ${total}：省略 remove_to（单行）= ${omitted}，显式重复同锚点 = ${sameAnchor}，真实多行区间 = ${multiLine}`);
  console.log(
    `  单行编辑占比 ${pct(omitted + sameAnchor, total)}；其中仍写两遍同一锚点的 ${pct(sameAnchor, total)}\n`,
  );
}

function reportBareHash(parts) {
  console.log("## 6. malformed 锚点样本（判断是否「只给哈希不给行号」）\n");
  const malformed = parts.filter(
    (p) => p.tool === "EditAnchored" && p.status === "error" && /malformed anchor/i.test(String(p.error ?? "")),
  );
  if (!malformed.length) {
    console.log("  （无 malformed 失败）\n");
    return;
  }
  const seen = new Map();
  for (const f of malformed) {
    const anchors = (parseInput(f.input).edits ?? []).map((e) => String(e?.remove_from ?? ""));
    for (const a of anchors) {
      if (/^[0-9A-Za-z]{4}$/.test(a.trim())) seen.set(a, (seen.get(a) ?? 0) + 1);
    }
  }
  console.log(`  失败调用 ${malformed.length} 次；其中裸哈希锚点:`);
  [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([a, n]) => console.log(`    ×${n}  ${JSON.stringify(a)}   ← 缺行号`));
  console.log(
    `\n  裸哈希 ${seen.size} 种 — 这属于「少写行号」，不是非法锚点；若规范化后能唯一命中原行，\n  应当直接解析而不是判 malformed。\n`,
  );
}

const parts = loadParts();
const events = loadFailureEvents();
console.log(`# 编辑工具使用分析${sessionFilter ? `（会话 ${sessionFilter}）` : "（全局）"}`);
console.log(`工具调用 ${parts.length} 次；日志失败事件 ${events.length} 条\n`);
reportRatio(parts);
reportFailureRate(parts);
reportReasons(parts, events);
reportRecoveryCost(parts);
reportRemoveToAdoption(parts);
reportBareHash(parts);
