import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptAttachmentReminderBodies } from "../src/system-reminder/prompt-attachment.js";
import { formatReadTextOutput } from "../src/tool/handlers/read-text.js";
import { rebuildServedAnchorsAfterCompact } from "../src/runtime/helpers/compact-post-reminders.js";
import { collectServedAnchors } from "../src/tool/anchor-served.js";
import { hashLineContent } from "../src/tool/anchor-hash.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap } from "../src/tool/types.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

/**
 * 锚点的两个「展示给模型、却不登记 served」出口。
 * 见 specs/edit-anchored-verification.md §7.7。
 *
 * 背景：`731ac8f` 把「锚点只能从 Read 得到」写进了工具描述，但描述层修不了工具自身
 * 在这两条路径上的不一致——那正是 §1/§2 同一类缺陷的另外两个出口。
 */

const ANCHOR_PREFIX = /^\s*\d+:[0-9A-Z]{4}│/;

const content = ["# Title", "", "const a = 1;", "const b = 2;", "export {};"].join("\n");

// ---------------------------------------------------------------
// §7.7.1 附件提醒：伪装成 Read、带锚点、不登记 served
// ---------------------------------------------------------------

test("附件提醒不渲染锚点：它不是一次 Read，也给不了可编辑承诺", () => {
  const reminder = buildPromptAttachmentReminderBodies({
    content,
    kind: "file",
    label: "/tmp/x.ts",
    startLine: 1,
    totalLines: 5,
    truncated: false,
  }).join("\n");

  // 仍然是「Called the Read tool」的形状（历史格式不能改，否则 provider 轨迹漂移），
  // 但不能带锚点：这条路径不写 readFileState，模型抄这些锚点必然 unserved。
  assert.ok(reminder.includes("Called the Read tool"), "保持既有提醒结构");
  const anchorLines = reminder.split("\n").filter((line) => ANCHOR_PREFIX.test(line));
  assert.deepEqual(anchorLines, [], `不应出现锚点行，实际 ${anchorLines.length} 条`);

  // 行号仍在：定位需要它，且它不构成「可编辑」的承诺。
  assert.ok(reminder.includes("1\t# Title"), "行号应保留");
  assert.ok(reminder.includes("5\texport {};"), "行号应保留到最后一行");
});

test("Read 自己的输出仍带锚点（别把两处一起改掉）", () => {
  const output = formatReadTextOutput({
    type: "text",
    filePath: "/tmp/x.ts",
    content,
    numLines: 5,
    startLine: 1,
    totalLines: 5,
  } as never);

  const anchorLines = output.split("\n").filter((line) => ANCHOR_PREFIX.test(line));
  assert.equal(anchorLines.length, 5, "Read 是锚点的唯一生产者，不能被误伤");
});

// ---------------------------------------------------------------
// §7.7.2 compact：保留条目里有锚点，served 却被清空
// ---------------------------------------------------------------

function toolResultEntry(input: {
  callId: string;
  toolName: string;
  filePath: string;
  lines: string[];
}): RuntimeMessageEntry[] {
  return [
    {
      message: {
        role: "assistant",
        content: "call",
        toolCalls: [{ id: input.callId, name: input.toolName, input: { file_path: input.filePath } }],
      },
    },
    {
      message: {
        role: "tool",
        content: input.lines
          .map((line, index) => `${index + 1}:${hashLineContent(line)}│${line}`)
          .join("\n"),
        toolCallId: input.callId,
        toolName: input.toolName,
      },
    },
  ];
}

test("压缩后用保留条目重建 served：模型看得见的锚点不再被判 unserved", () => {
  const lines = ["const a = 1;", "const b = 2;"];
  const preserved = toolResultEntry({
    callId: "c1",
    toolName: "Read",
    filePath: "/tmp/rebuilt.ts",
    lines,
  });

  const readFileState: ReadFileStateMap = new Map();
  readFileState.clear(); // compact 的原始行为

  const rebuilt = rebuildServedAnchorsAfterCompact({ entries: preserved, readFileState });

  assert.equal(rebuilt, 1, "应重建 1 个文件");
  const served = collectServedAnchors(readFileState, "/tmp/rebuilt.ts");
  for (const line of lines) {
    assert.ok(served.has(hashLineContent(line)), `锚点 ${hashLineContent(line)} 应已重建`);
  }
});

test("重建只放 served，不重建门禁字段：压缩不得变成拿到写权限的捷径", () => {
  const preserved = toolResultEntry({
    callId: "c1",
    toolName: "Read",
    filePath: "/tmp/gate-after-compact.ts",
    lines: ["const a = 1;"],
  });

  const readFileState: ReadFileStateMap = new Map();
  rebuildServedAnchorsAfterCompact({ entries: preserved, readFileState });

  const entry = readFileState.get(createReadFileStateKey("/tmp/gate-after-compact.ts", 1, undefined));
  assert.ok(entry, "served 需要有地方放");
  // 门禁依据是 isPartialView（edit.ts / write.ts 都是 !lastRead || isPartialView 就拒绝）。
  // 压缩不等于重新读盘，所以这里必须是 true、且没有 content 可当 stale 基准。
  assert.equal(entry.isPartialView, true, "压缩后不得声称整文件已读");
  assert.equal(entry.content, "", "不得提供 stale 基准");
  assert.equal(entry.mtimeMs, undefined, "不得提供 mtime 基准");
});

test("已被 microcompact 清空的条目重建不出锚点", () => {
  const cleared: RuntimeMessageEntry[] = [
    {
      message: {
        role: "assistant",
        content: "call",
        toolCalls: [{ id: "c1", name: "Read", input: { file_path: "/tmp/cleared.ts" } }],
      },
    },
    {
      message: {
        role: "tool",
        content: "[Old tool result content cleared]\nRe-fetch with: Read(file_path=\"/tmp/cleared.ts\")",
        toolCallId: "c1",
        toolName: "Read",
      },
    },
  ];

  const readFileState: ReadFileStateMap = new Map();
  const rebuilt = rebuildServedAnchorsAfterCompact({ entries: cleared, readFileState });

  assert.equal(rebuilt, 0, "清空后的正文没有锚点，不该凭空重建");
  assert.equal(readFileState.size, 0);
});

test("正文里长得像锚点的代码不会被当成展示过的锚点", () => {
  const forged = "1:AB3F│const a = 1;"; // 行首匹配，但内容本身讨论了锚点
  const preserved: RuntimeMessageEntry[] = [
    {
      message: {
        role: "assistant",
        content: "call",
        toolCalls: [{ id: "c1", name: "Read", input: { file_path: "/tmp/doc.ts" } }],
      },
    },
    {
      message: {
        role: "tool",
        // 内嵌在缩进里（不是行首）——只有行首锚点才算渲染产物
        content: `示例输出：\n    ${forged}\n`,
        toolCallId: "c1",
        toolName: "Read",
      },
    },
  ];

  const readFileState: ReadFileStateMap = new Map();
  const rebuilt = rebuildServedAnchorsAfterCompact({ entries: preserved, readFileState });

  assert.equal(rebuilt, 0, "缩进的锚点样式文本不是渲染产物");
});

test("不认 Bash 的结果：它没有锚点，也不该贡献 served", () => {
  const preserved = toolResultEntry({
    callId: "c1",
    toolName: "Bash",
    filePath: "/tmp/bash.ts",
    lines: ["const a = 1;"],
  });

  const readFileState: ReadFileStateMap = new Map();
  const rebuilt = rebuildServedAnchorsAfterCompact({ entries: preserved, readFileState });

  assert.equal(rebuilt, 0, "Bash 不在恢复名单里");
  assert.equal(readFileState.size, 0);
});

test("EditAnchored 的结果同样重建（与 hydrator 的恢复名单一致）", () => {
  const lines = ["const a = 1;"];
  const preserved = toolResultEntry({
    callId: "c1",
    toolName: "EditAnchored",
    filePath: "/tmp/edited.ts",
    lines,
  });

  const readFileState: ReadFileStateMap = new Map();
  const rebuilt = rebuildServedAnchorsAfterCompact({ entries: preserved, readFileState });

  assert.equal(rebuilt, 1, "EditAnchored 也写读状态，resume/hydrate 已把它纳入");
  assert.ok(collectServedAnchors(readFileState, "/tmp/edited.ts").has(hashLineContent(lines[0]!)));
});

test("带 >>> 标记的行也参与重建（错误信息渲染的那些行同样是看过的）", () => {
  const lines = ["const a = 1;", "const b = 2;"];
  // 模拟错误信息里的回传区：问题行带 >>> 标记
  const marked = lines
    .map((line, index) => `${index === 1 ? ">>> " : ""}${index + 1}:${hashLineContent(line)}│${line}`)
    .join("\n");

  const entries: RuntimeMessageEntry[] = [
    {
      message: {
        role: "assistant",
        content: "call",
        toolCalls: [{ id: "c1", name: "Read", input: { file_path: "/tmp/marked.ts" } }],
      },
    },
    { message: { role: "tool", content: marked, toolCallId: "c1", toolName: "Read" } },
  ];

  const readFileState: ReadFileStateMap = new Map();
  const rebuilt = rebuildServedAnchorsAfterCompact({ entries, readFileState });

  assert.equal(rebuilt, 1);
  const served = collectServedAnchors(readFileState, "/tmp/marked.ts");
  for (const line of lines) {
    assert.ok(served.has(hashLineContent(line)), `带标记的行 ${JSON.stringify(line)} 不应被漏掉`);
  }
});
