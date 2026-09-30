import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAnchorEdits,
} from "../src/tool/anchor-resolve.js";
import {
  createAnchorFailureMessage,
} from "../src/tool/anchor-render.js";
import { hashLineContent } from "../src/tool/anchor-hash.js";
import {
  collectServedAnchors,
  isHashServedInOtherFileOnly,
} from "../src/tool/anchor-served.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import { editAnchoredToolEntry } from "../src/tool/handlers/edit-anchored.js";

/**
 * 第九轮：ambiguous 逐条列出候选 + unserved 点明「哈希来自别的文件」。
 * 见 specs/edit-anchored-verification.md §7.11。
 *
 * 依据（全库实测）：
 * - 21/21 次 ambiguous 的回传区只覆盖部分候选（±3 行），模型看到「命中 6 行」
 *   却只看到其中 1 行的周围内容。命中数分布绝大多数 ≤10（2 行 19 次）。
 * - 3 次 unserved 全是「把 A 文件看到的 `13:C27G` 用到 B 文件上」，
 *   而 `C27G` 是 `import {` 这类高频行。
 */

const DUP_LINES = ["def f():", "    continue", "x = 1", "    continue", "y = 2", "    continue", "z = 3"];
const DUP_CONTENT = DUP_LINES.join("\n");
const DUP_HASH = hashLineContent("    continue");
const servedAll = new Set(DUP_LINES.map(hashLineContent));

// ---------------------------------------------------------------
// ① ambiguous 逐条列出候选
// ---------------------------------------------------------------

test("ambiguous 把全部候选行逐条列出（含行号与内容）", () => {
  const result = resolveAnchorEdits(DUP_CONTENT, servedAll, [
    { removeFrom: `5:${DUP_HASH}`, removeTo: `5:${DUP_HASH}`, replacementText: "    pass" },
  ]);
  assert.equal(result.status, "failed");
  const msg = createAnchorFailureMessage({ content: DUP_CONTENT, failure: result, total: 1 });

  assert.ok(msg.text.includes("All 3 matching lines:"), "要声明列出全部候选");
  for (const line of [2, 4, 6]) {
    assert.ok(
      msg.text.includes(`  ${line}:${DUP_HASH}│    continue`),
      `候选行 ${line} 应逐条列出（模型不用再回去重读）`,
    );
  }
});

test("列出的候选行进 served（照抄必须能直接用）", () => {
  const result = resolveAnchorEdits(DUP_CONTENT, servedAll, [
    { removeFrom: `5:${DUP_HASH}`, removeTo: `5:${DUP_HASH}`, replacementText: "    pass" },
  ]);
  const msg = createAnchorFailureMessage({ content: DUP_CONTENT, failure: result, total: 1 });
  // 候选区以外的行（例如第 3 行 x = 1）不在回传区，但候选行必须在
  assert.ok(msg.text.includes("All 3 matching lines:"));
  const candidateRows = msg.text.split("\n").filter((l) => l.startsWith("  ") && l.includes("│"));
  assert.equal(candidateRows.length, 3);
  for (const row of candidateRows) {
    const hash = row.slice(row.indexOf(":") + 1, row.indexOf("│"));
    assert.ok(msg.servedHashes.includes(hash), `${hash} 应进 served`);
  }
});

test("候选过多时退回只报计数（不淹上下文）", () => {
  // 30 行同内容 → 超过 MAX_LISTED_CANDIDATES(12)。
  // 用越界行号触发 ambiguous（行号若对就直接命中了，不走候选）。
  const many = Array.from({ length: 30 }, () => "    pass");
  const content = many.join("\n");
  const h = hashLineContent("    pass");
  const served = new Set([h]);
  const result = resolveAnchorEdits(content, served, [
    { removeFrom: `99:${h}`, removeTo: `99:${h}`, replacementText: "    ok" },
  ]);
  assert.equal(result.status, "failed");
  const msg = createAnchorFailureMessage({ content, failure: result, total: 1 });
  assert.ok(!msg.text.includes("All 30 matching lines:"), "不应列出全部 30 行");
  assert.ok(/matches 30 lines/.test(msg.text), "仍要报计数");
});

// ---------------------------------------------------------------
// ② unserved 点明「哈希来自别的文件」
// ---------------------------------------------------------------

const FILE_A = "/repo/a.ts";
const FILE_B = "/repo/b.ts";
const IMPORT_HASH = hashLineContent("import {");

function stateWithOtherFile(): Map<string, unknown> {
  const map = new Map<string, unknown>();
  map.set(createReadFileStateKey(FILE_A, 1, undefined), {
    path: FILE_A,
    content: "import {",
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    servedAnchors: [IMPORT_HASH],
  });
  return map as never;
}

test("跨文件检测：该哈希只在别的文件展示过时返回 true", () => {
  const map = stateWithOtherFile();
  assert.equal(isHashServedInOtherFileOnly(map as never, FILE_B, IMPORT_HASH), true);
  // 本文件（A）不算「别的文件」
  assert.equal(isHashServedInOtherFileOnly(map as never, FILE_A, IMPORT_HASH), false);
});

test("unserved 时点明「这是别的文件的锚点」", () => {
  const bContent = ["const x = 1;", "const y = 2;"].join("\n");
  const result = resolveAnchorEdits(bContent, new Set(), [
    { removeFrom: `1:${IMPORT_HASH}`, removeTo: `1:${IMPORT_HASH}`, replacementText: "X" },
  ]);
  assert.equal(result.status, "failed");

  const msg = createAnchorFailureMessage({
    content: bContent,
    failure: result,
    total: 1,
    hashServedInOtherFile: true,
  });
  assert.ok(/was shown to you in a DIFFERENT file/i.test(msg.text), "要明说来自别的文件");
  assert.ok(/Anchors are per-file/i.test(msg.text), "给出规则");
});

test("不是跨文件的情况不给该提示（不留噪音）", () => {
  const bContent = ["const x = 1;", "const y = 2;"].join("\n");
  const result = resolveAnchorEdits(bContent, new Set(), [
    { removeFrom: `1:${IMPORT_HASH}`, removeTo: `1:${IMPORT_HASH}`, replacementText: "X" },
  ]);
  const msg = createAnchorFailureMessage({
    content: bContent,
    failure: result,
    total: 1,
    hashServedInOtherFile: false,
  });
  assert.ok(!/DIFFERENT file/i.test(msg.text));
});

// ---------------------------------------------------------------
// 描述层：跨文件约束
// ---------------------------------------------------------------

test("描述讲清「锚点按文件隔离」", () => {
  const d = editAnchoredToolEntry.metadata.description ?? "";
  assert.ok(/Anchors are per-file/i.test(d));
  assert.ok(/a hash you saw in file A is meaningless in file B/i.test(d));
  assert.ok(/import \{/.test(d), "点出高频行这一类典型");
});

test("collectServedAnchors 仍只聚合本文件（跨文件检测不污染它）", () => {
  const map = stateWithOtherFile();
  assert.equal(collectServedAnchors(map as never, FILE_B).size, 0, "B 文件没有任何 served");
  assert.equal(collectServedAnchors(map as never, FILE_A).has(IMPORT_HASH), true);
});
