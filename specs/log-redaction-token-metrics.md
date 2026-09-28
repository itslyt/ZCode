# 日志脱敏：计数字段被误判为凭据

## 0. 缺陷

`adapters/src/logging/serialize.ts` 的 `DefaultLogRedactor` 用单条正则判定敏感键：

```ts
/(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;
```

`token` 是**裸子串**匹配，因此所有含字面 `token` 的**计数字段**一并被写成 `[Redacted]`。

### 0.1 影响（实测）

`~/.zcode/cli/log/zcode-2026-09-28.jsonl` 中，被误抹的字段名全部是度量值，
无一是凭据：

```
inputTokens / outputTokens / reasoningTokens / totalTokens
cacheWriteTokens / cacheReadTokens / usageTotalTokens / maxOutputTokens
tokensSaved / preMicrocompactTokenCount / postMicrocompactTokenCount
percentTokens / tokenizer / tokenMethod
```

当天 27000+ 个字段值被抹。其中最要紧的两项：

```
tokensSaved              1862 条   ← microcompact 每次实际回收的 token
preMicrocompactTokenCount 1862 条
```

**后果**：`tokensSaved` 在 `core/src/compact/microcompact.ts:148` 已被正确计算
（`Math.max(0, estimatedTokenCount - postTokenCount)`），但写入日志时被抹掉，
于是「microcompact 每次回收多少、值不值得开」这个关键判断**没有任何观测数据**。
本次调查中一度因此无法回答「该不该开 microcompact」。

### 0.2 为何是缺陷而非有意设计

`token` 出现在凭据命名里通常是**后缀或分隔形态**（`accessToken` / `refresh_token` /
`token_value`），而出现在计数字段里是**前缀**（`token*Count` / `*Tokens` / `tokensSaved`）。
裸子串匹配无法区分这两类，属于判定粒度过粗。

## 1. 修法

**凭据侧正则强度不变**，另加计数字段豁免名单（白名单）：

```ts
private readonly sensitiveKeyPattern =
  /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;

private readonly tokenMetricKeyPattern =
  /(?:Tokens|TokenCount|tokensSaved|percentTokens|tokenizer|tokenMethod|maxOutputTokens)$/i;
```

判定式：

```ts
this.sensitiveKeyPattern.test(key) && !this.tokenMetricKeyPattern.test(key);
```

### 1.1 为何用白名单而不是收紧 `token`

收紧 `token` 正则有两条路，都会漏：

- 要求词边界：`accessToken` 里的 `Token` 后接词尾，仍会被误判为计数字段
- 要求分隔符：`token_value` 能覆盖，但 `apiKeyValue` 这类无分隔的凭据命名会漏

白名单的取舍是**明确、可审计**：凭据识别规则保持原有强度（不因本次修复而放宽），
只对已知的度量字段开口。新增度量字段时在 `tokenMetricKeyPattern` 追加，
改动点集中在一处。

## 2. 验收场景

1. 实测键名（`inputTokens` / `tokensSaved` / `preMicrocompactTokenCount` 等 14 个）
   在脱敏后**保留原值**。
2. 凭据键名（`apiKey` / `accessToken` / `refreshToken` / `token` / `token_value` /
   `secretKey` / `apiKeyValue` 等 14 个）仍然输出 `[Redacted]`。
3. 嵌套对象中的计数字段同样保留（`{ usage: { inputTokens } }`）。
4. 循环引用防护（`WeakSet`）与深度上限行为不变。

验证：`apps/zcode-cli/packages/adapters/test/log-redactor.test.ts` 3 条通过；
把判定式还原为不豁免后，其中 2 条必失败（双向验证）。

## 3. 边界

- 本次只改键名判定，不改值侧的处理（超长截断、循环引用、深度上限）。
- `tokenizer` / `tokenMethod` 不是计数值也不敏感，但豁免名单按「非凭据」一并放过；
  它们本就无泄露含义。
- **不要**把 `tokenMetricKeyPattern` 改成「包含 token 且是数字就放过」这类值侧推断 ——
  那会把 `token: "sk-..."` 之类真凭据漏掉。
