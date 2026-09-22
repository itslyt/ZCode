import assert from "node:assert/strict";
import test from "node:test";
import { editAnchoredToolEntry } from "../src/tool/handlers/edit-anchored.js";
import { createReadFileStateKey, findLatestReadFileState } from "../src/tool/read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../src/tool/types.js";

/**
 * `EditAnchored` 不得改写 `Edit`/`Write` 的读门禁字段。
 *
 * 门禁依据是 `isPartialView`（`edit.ts:494` 与 `write.ts:284` 都是
 * `!lastRead || lastRead.isPartialView` 就拒绝）。锚点编辑曾经把整份读状态条目
 * 重写一遍、无条件 `isPartialView: false`，于是模型只要触发一次会被拒绝的锚点编辑
 * （stale 很常见——外部 formatter、手动保存都会触发），就拿到了「整文件已读」，
 * 随后能用 `Edit`/`Write` 覆盖它从未读过的位置。被拒绝的操作本该零副作用。
 *
 * 这里断言的是那个函数写出的**另一个字段**——此前的测试只盯 `servedAnchors`，
 * 所以对这类缺陷结构上是盲的。
 */

const PATH = "/tmp/gate.ts";
const KEY = createReadFileStateKey(PATH, 1, undefined);

const visibleLines = Array.from({ length: 30 }, (_, index) => `const row${index + 1} = ${index + 1};`);
const hiddenLines = Array.from({ length: 90 }, (_, index) => `const row${index + 31} = ${index + 31};`);
const diskContent = [...visibleLines, ...hiddenLines].join("\n");

function partialReadEntry(): ReadFileStateEntry {
  return {
    path: PATH,
    // 模型只看到前 30 行，Read 因 token cap 把它标成 partial view
    content: visibleLines.join("\n"),
    offset: undefined,
    limit: undefined,
    isPartialView: true,
    readAt: new Date(Date.now() - 60_000),
    sourceTool: "Read",
    revisionId: "rev-old",
    mtimeMs: 1,
    sizeBytes: 1,
    servedAnchors: ["ZZZZ"],
  };
}

function createContext(readFileState: ReadFileStateMap, onWrite: (content: string) => void) {
  return {
    fileSystemPort: {
      async readTextFile() {
        return {
          path: PATH,
          content: diskContent,
          encoding: "utf8",
          lineEndings: "LF",
          bytesRead: diskContent.length,
          sizeBytes: diskContent.length,
          truncated: false,
          revision: { id: "rev-new", mtimeMs: 2, sizeBytes: diskContent.length },
        };
      },
      async writeTextFile(input: { content: string }) {
        onWrite(input.content);
        return { revision: { id: "rev-write", mtimeMs: 3, sizeBytes: input.content.length } };
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

test("stale 拒绝后，partial view 标记必须保留", async () => {
  const readFileState: ReadFileStateMap = new Map();
  readFileState.set(KEY, partialReadEntry());

  let written: string | undefined;
  const result = (await editAnchoredToolEntry.handler(
    { file_path: PATH, edits: [{ remove_from: "3:ZZZZ", remove_to: "3:ZZZZ", replacement_text: "x" }] },
    createContext(readFileState, (content) => {
      written = content;
    }),
  )) as { result?: boolean };

  assert.equal(result.result, false, "锚点不存在于文件里，应当被拒绝");
  assert.equal(written, undefined, "被拒绝的调用不允许落盘");

  // 门禁（edit.ts:494 / write.ts:284）就是看这个选择器选中的条目
  const gateEntry = findLatestReadFileState(readFileState, PATH);
  assert.equal(gateEntry?.isPartialView, true, "拒绝不得把 partial view 翻成整文件已读");
  assert.equal(gateEntry?.content, visibleLines.join("\n"), "拒绝不得把内容换成整文件");
});

test("stale 拒绝后，模型手里的 served 锚点仍然并了进去", async () => {
  const readFileState: ReadFileStateMap = new Map();
  readFileState.set(KEY, partialReadEntry());

  await editAnchoredToolEntry.handler(
    { file_path: PATH, edits: [{ remove_from: "3:ZZZZ", remove_to: "3:ZZZZ", replacement_text: "x" }] },
    createContext(readFileState, () => {}),
  );

  // 拒绝信息里回传了区域锚点，这些哈希必须算「看过」，否则照抄重发会撞 unserved
  assert.ok((readFileState.get(KEY)?.servedAnchors?.length ?? 0) > 1);
});

test("成功的锚点编辑在 partial view 下也不得放宽门禁", async () => {
  const readFileState: ReadFileStateMap = new Map();
  const entry = partialReadEntry();
  // 让第 3 行的锚点可用：模型确实看过这 30 行
  const { hashLineContent } = await import("../src/tool/anchor-hash.js");
  entry.servedAnchors = [hashLineContent(visibleLines[2]!)];
  readFileState.set(KEY, entry);

  let written: string | undefined;
  const result = (await editAnchoredToolEntry.handler(
    {
      file_path: PATH,
      edits: [
        {
          remove_from: `3:${hashLineContent(visibleLines[2]!)}`,
          remove_to: `3:${hashLineContent(visibleLines[2]!)}`,
          replacement_text: "const row3 = 300;",
        },
      ],
    },
    createContext(readFileState, (content) => {
      written = content;
    }),
  )) as { result?: boolean };

  assert.notEqual(result.result, false, "锚点有效，应当成功");
  assert.match(written ?? "", /const row3 = 300;/);

  const gateEntry = findLatestReadFileState(readFileState, PATH);
  assert.equal(gateEntry?.isPartialView, true, "模型只读了 30 行，编辑后仍然是 partial view");
});

test("整文件读过时，编辑后门禁不得反被降级", async () => {
  const readFileState: ReadFileStateMap = new Map();
  const { hashLineContent } = await import("../src/tool/anchor-hash.js");
  readFileState.set(KEY, {
    ...partialReadEntry(),
    content: diskContent,
    isPartialView: false,
    servedAnchors: [hashLineContent(visibleLines[2]!)],
  });

  const result = (await editAnchoredToolEntry.handler(
    {
      file_path: PATH,
      edits: [
        {
          remove_from: `3:${hashLineContent(visibleLines[2]!)}`,
          remove_to: `3:${hashLineContent(visibleLines[2]!)}`,
          replacement_text: "const row3 = 300;",
        },
      ],
    },
    createContext(readFileState, () => {}),
  )) as { result?: boolean };

  assert.notEqual(result.result, false);
  // 模型本来就有整文件视图，保持 false；否则会把「读过了还要重读」变成常态
  assert.equal(findLatestReadFileState(readFileState, PATH)?.isPartialView, false);
});
