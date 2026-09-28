import assert from "node:assert/strict";
import test from "node:test";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../src/tool/types.js";

/**
 * Read 的未变更短路已删除（specs/read-unchanged-stub.md）。
 *
 * 原行为：缓存命中且文件未变时，返回
 * `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`
 * 而不返回内容。这条引用在构造上可能无法满足——被指的 earlier tool_result 可能已经不在
 * 本次请求的上下文里（实测成因是请求窗口截断 `messagesKind: tail/delta`）。届时模型既拿不到
 * 内容、又指不到任何东西，只能绕道 Bash `sed -n`；而 Bash 读文件又按同一 key 回填
 * readFileState（bash-read-file-state.ts），把短路重新装填好，形成自我维持的循环。
 *
 * 这里钉的是：文件未变 + 缓存命中时，Read 必须照常返回内容与锚点。
 */

const PATH = "/tmp/unchanged-read.ts";
const KEY = createReadFileStateKey(PATH, 1, undefined);

const lines = Array.from({ length: 12 }, (_, index) => `const row${index + 1} = ${index + 1};`);
const diskContent = lines.join("\n");

function cachedEntry(): ReadFileStateEntry {
  return {
    path: PATH,
    content: diskContent,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(Date.now() - 60_000),
    sourceTool: "Read",
    revisionId: "rev-same",
    mtimeMs: 1,
    sizeBytes: diskContent.length,
    servedAnchors: [],
  };
}

/** stat 返回与缓存记载完全一致的 revision —— 即「文件未变」。 */
function createContext(readFileState: ReadFileStateMap) {
  return {
    fileSystemPort: {
      async readTextFileRange() {
        return {
          path: PATH,
          content: diskContent,
          encoding: "utf8",
          lineEndings: "LF",
          bytesRead: diskContent.length,
          sizeBytes: diskContent.length,
          truncated: false,
          revision: { id: "rev-same", mtimeMs: 1, sizeBytes: diskContent.length },
        };
      },
      async stat() {
        // 顶层 mtimeMs/sizeBytes 必须与缓存一致，否则 isCachedReadFresh 返回 false、
        // 根本走不到短路分支，测试会变成假阳性（不命中缓存 ⇒ 永远通过）。
        return {
          path: PATH,
          mtimeMs: 1,
          sizeBytes: diskContent.length,
          revision: { id: "rev-same", mtimeMs: 1, sizeBytes: diskContent.length },
        };
      },
      async readTextFile() {
        return {
          path: PATH,
          content: diskContent,
          encoding: "utf8",
          lineEndings: "LF",
          bytesRead: diskContent.length,
          sizeBytes: diskContent.length,
          truncated: false,
          revision: { id: "rev-same", mtimeMs: 1, sizeBytes: diskContent.length },
        };
      },
    },
    readFileState,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    sessionId: "sess_test",
    turnId: "turn_test",
    traceId: "trace_test",
    spanId: "span_test",
    parentSpanId: undefined,
    toolCallId: "call_test",
  } as never;
}

test("文件未变且缓存命中时，Read 返回内容而不是 stub", async () => {
  const readFileState: ReadFileStateMap = new Map();
  readFileState.set(KEY, cachedEntry());

  const result = (await readToolEntry.handler(
    { file_path: PATH },
    createContext(readFileState),
  )) as { output?: unknown; type?: string; text?: string };

  const serialized = JSON.stringify(result);
  assert.ok(
    !serialized.includes("Wasted call"),
    `不得再返回未变更短路（实际：${serialized.slice(0, 300)}）`,
  );
  assert.ok(
    !serialized.includes("file_unchanged"),
    "不得再产出 file_unchanged 结果",
  );
  assert.ok(
    serialized.includes("row1") && serialized.includes("row12"),
    `应当返回文件内容（实际：${serialized.slice(0, 300)}）`,
  );
});
