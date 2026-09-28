import assert from "node:assert/strict";
import test from "node:test";
import { DefaultLogRedactor } from "../src/logging/serialize.js";

/**
 * 日志脱敏的键名判定。
 *
 * 背景缺陷：原实现用单一正则 `/(?:api[-_]?key|...|token)/i` 判定敏感键，
 * 它会把**计数字段**也匹配上（`inputTokens` / `totalTokens` / `tokensSaved` /
 * `preMicrocompactTokenCount` 都含字面 `token`），整串写成 `[Redacted]`。
 * 实测 2026-09-28 一天有 27000+ 个字段值被误抹，其中 `tokensSaved` 1862 条、
 * `preMicrocompactTokenCount` 1862 条——导致「microcompact 每次回收多少 token」
 * 完全无法统计。
 *
 * 修法：凭据侧正则强度不变，另加计数字段豁免名单（白名单，而非放宽 `token`）。
 *
 * 下面两组用例的字段名取自 `~/.zcode/cli/log/*.jsonl` 的真实键名，
 * 不是构造的理想形态。
 */

const redactor = new DefaultLogRedactor();

test("计数字段不被误抹（真实日志键名）", () => {
  // 取自 ~/.zcode/cli/log 实测统计的字段
  const metrics = {
    inputTokens: 88014,
    outputTokens: 6500,
    reasoningTokens: 6500,
    totalTokens: 13084,
    cacheWriteTokens: 1,
    cacheReadTokens: 2,
    usageTotalTokens: 3,
    maxOutputTokens: 64000,
    tokensSaved: 1862, // microcompact 每次回收量
    preMicrocompactTokenCount: 88,
    postMicrocompactTokenCount: 12,
    percentTokens: 7,
    tokenizer: "cl100k",
    tokenMethod: "estimate",
  };

  const out = redactor.redact(metrics) as Record<string, unknown>;
  for (const [key, value] of Object.entries(metrics)) {
    assert.equal(out[key], value, `${key} 不应被打码`);
  }
});

test("凭据字段仍然打码（不因豁免而放宽）", () => {
  const credentials = {
    apiKey: "sk-live-x",
    api_key: "sk-live-y",
    authorization: "Bearer z",
    cookie: "a=b",
    credential: "c",
    password: "p",
    secret: "s",
    token: "t",
    accessToken: "at",
    refreshToken: "rt",
    authToken: "aut",
    token_value: "tv",
    secretKey: "sk2",
    apiKeyValue: "akv",
  };

  const out = redactor.redact(credentials) as Record<string, unknown>;
  for (const key of Object.keys(credentials)) {
    assert.equal(out[key], "[Redacted]", `${key} 必须打码`);
  }
});

test("嵌套结构中的计数字段同样保留", () => {
  const out = redactor.redact({
    usage: { inputTokens: 100, tokensSaved: 20 },
    session: { preMicrocompactTokenCount: 50 },
  }) as Record<string, Record<string, unknown>>;

  assert.equal(out.usage.inputTokens, 100);
  assert.equal(out.usage.tokensSaved, 20);
  assert.equal(out.session.preMicrocompactTokenCount, 50);
});
