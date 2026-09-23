import assert from "node:assert/strict";
import test from "node:test";
import { hashLineContent } from "../src/tool/anchor-hash.js";
import { editAnchoredToolEntry } from "../src/tool/handlers/edit-anchored.js";
import { createToolHandlerFailureError } from "../src/tool/executor/errors.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../src/tool/types.js";

/**
 * 每条失败路径都要有稳定的原因码。
 *
 * 为什么值得单独测：主备切到 `EditAnchored` 之后要靠真实使用数据看报错分布，而分布的唯一
 * 结构化来源是日志 `tool.call.failed` 里的 `error.context.code`。若所有原因共用一个码，
 * 统计就只能解消息文本——本仓明确禁止依赖错误文本做判断。这里把「一个原因一个码」钉住，
 * 顺便防止将来新增 reason 时默默落到默认值上。
 */

const PATH = "/tmp/failure-code.ts";
const KEY = createReadFileStateKey(PATH, 1, undefined);
const LINES = ["const alpha = 1;", "const beta = 2;", "const gamma = 3;", "const delta = 4;"];
const CONTENT = LINES.join("\n");

function readState(servedAnchors: string[]): ReadFileStateMap {
  const entry: ReadFileStateEntry = {
    path: PATH,
    content: CONTENT,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: "Read",
    revisionId: "rev-1",
    mtimeMs: 1,
    sizeBytes: CONTENT.length,
    servedAnchors,
  };
  return new Map([[KEY, entry]]);
}

function servedAll(): string[] {
  return LINES.map((line) => hashLineContent(line));
}

function context(readFileState: ReadFileStateMap, path = PATH, content = CONTENT) {
  return {
    fileSystemPort: {
      async readTextFile() {
        return {
          path,
          content,
          encoding: "utf8",
          lineEndings: "LF",
          bytesRead: content.length,
          sizeBytes: content.length,
          truncated: false,
          revision: { id: "rev-1", mtimeMs: 1, sizeBytes: content.length },
        };
      },
      async writeTextFile() {
        return { revision: { id: "rev-2", mtimeMs: 2, sizeBytes: content.length } };
      },
    },
    readFileState,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    sessionId: "sess_test",
    turnId: "turn_test",
    traceId: "trace_test",
    spanId: "span_test",
    toolCallId: "call_test",
  } as never;
}

async function failureCode(
  edits: { remove_from: string; remove_to: string; replacement_text: string }[],
  options: { served?: string[]; path?: string } = {},
): Promise<number | undefined> {
  const path = options.path ?? PATH;
  const result = (await editAnchoredToolEntry.handler(
    { file_path: path, edits },
    context(readState(options.served ?? servedAll()), path),
  )) as { result?: boolean; errorCode?: number };
  assert.equal(result.result, false, "这个用例预期失败");
  return result.errorCode;
}

test("每种失败原因都有自己的码，且互不相同", async () => {
  const one = (line: number, text = "x") => [
    {
      remove_from: `${line}:${hashLineContent(LINES[line - 1]!)}`,
      remove_to: `${line}:${hashLineContent(LINES[line - 1]!)}`,
      replacement_text: text,
    },
  ];

  const codes = {
    malformed_anchor: await failureCode([
      { remove_from: "not-an-anchor", remove_to: "not-an-anchor", replacement_text: "x" },
    ]),
    unserved: await failureCode(one(1), { served: [] }),
    // stale 的定义是「哈希在 served 里、但文件里已经没有它」；只在 served 里才有意义
    stale: await failureCode([
      { remove_from: "1:ZZZZ", remove_to: "1:ZZZZ", replacement_text: "x" },
    ], { served: [...servedAll(), "ZZZZ"] }),
    reversed_range: await failureCode([
      {
        remove_from: `3:${hashLineContent(LINES[2]!)}`,
        remove_to: `1:${hashLineContent(LINES[0]!)}`,
        replacement_text: "x",
      },
    ]),
    overlapping_edits: await failureCode([
      {
        remove_from: `1:${hashLineContent(LINES[0]!)}`,
        remove_to: `3:${hashLineContent(LINES[2]!)}`,
        replacement_text: "x",
      },
      {
        remove_from: `3:${hashLineContent(LINES[2]!)}`,
        remove_to: `4:${hashLineContent(LINES[3]!)}`,
        replacement_text: "y",
      },
    ]),
    notebook_file: await failureCode(one(1), { path: "/tmp/failure-code.ipynb" }),
  };

  const values = Object.values(codes);
  assert.ok(
    values.every((code) => typeof code === "number"),
    `每个失败都要带码，实际: ${JSON.stringify(codes)}`,
  );
  assert.equal(
    new Set(values).size,
    values.length,
    `码必须互不相同，否则日志里分不出原因: ${JSON.stringify(codes)}`,
  );
});

/**
 * 码必须能从 handler 一路走到日志里那个字段。
 *
 * `tool.call.failed` 日志打的是 `error.context.code`，它由 `createToolHandlerFailureError`
 * 从 `failure.errorCode` 填进去（`executor/errors.ts:81`）。这条断言盯的就是这一段：
 * handler 返回的原因码不丢、不被包成别的值。
 */
test("原因码会原样进入错误的 context.code（即日志里分组的那个字段）", async () => {
  const failure = (await editAnchoredToolEntry.handler(
    {
      file_path: PATH,
      edits: [
        { remove_from: "not-an-anchor", remove_to: "not-an-anchor", replacement_text: "x" },
      ],
    },
    context(readState(servedAll())),
  )) as { result?: boolean; errorCode?: number };

  assert.equal(failure.result, false);
  const wrapped = createToolHandlerFailureError(
    { id: "call_test", name: "EditAnchored", input: {} } as never,
    failure as never,
  );
  assert.equal((wrapped as { context?: { code?: number } }).context?.code, failure.errorCode);
});

test("ambiguous 也有自己的码（哈希在多处命中）", async () => {
  const duplicated = ["const dup = 1;", "const dup = 1;", "const other = 2;"];
  const content = duplicated.join("\n");
  const readFileState: ReadFileStateMap = new Map([
    [
      KEY,
      {
        path: PATH,
        content,
        offset: undefined,
        limit: undefined,
        isPartialView: false,
        readAt: new Date(),
        sourceTool: "Read",
        revisionId: "rev-1",
        mtimeMs: 1,
        sizeBytes: content.length,
        servedAnchors: [hashLineContent("const dup = 1;")],
      } satisfies ReadFileStateEntry,
    ],
  ]);

  const result = (await editAnchoredToolEntry.handler(
    {
      file_path: PATH,
      edits: [
        {
          // 行号故意写 9（不存在）：行号命中会先解掉锚点，只有行号对不上、
          // 而哈希在多行命中时才是 ambiguous
          remove_from: `9:${hashLineContent("const dup = 1;")}`,
          remove_to: `9:${hashLineContent("const dup = 1;")}`,
          replacement_text: "x",
        },
      ],
    },
    context(readFileState, PATH, content),
  )) as { result?: boolean; errorCode?: number };

  assert.equal(result.result, false);
  // 与 unserved(2) / stale(3) 区分开：它是「内容还在但命中多处」，模型该做的是加范围而不是重读
  assert.equal(typeof result.errorCode, "number");
  assert.notEqual(result.errorCode, 2);
  assert.notEqual(result.errorCode, 3);
});
