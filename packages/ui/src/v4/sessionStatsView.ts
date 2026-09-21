import type { V4ConversationUsageResult } from "@zcode/shared/zcode-protocol-v4";

export interface SessionStatsView {
  hasActivity: boolean;
  modelDurationMs: number;
  toolDurationMs: number;
  ttftAvgMs: number | null;
  tokensPerSecond: number | null;
  totalTokens: number;
  cacheHitRate: number | null;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** 会话级统计展示模型：全部由 v4/conversation/usage 的 DB 聚合派生，无窗口/条数限制；Token 用量与缓存拆分为提供商原始口径。 */
export function buildSessionStatsView(usage: V4ConversationUsageResult): SessionStatsView {
  const uncachedInput = usage.rawInputTokens;
  const cacheRead = usage.rawCacheReadTokens;
  const inputSide = uncachedInput + cacheRead;
  return {
    hasActivity: usage.modelRequestCount > 0 || usage.totalTokens > 0,
    modelDurationMs: usage.modelDurationMs,
    toolDurationMs: usage.toolDurationMs,
    ttftAvgMs: usage.ttftSampleCount > 0 ? usage.ttftTotalMs / usage.ttftSampleCount : null,
    tokensPerSecond:
      usage.decodeWindowMs > 0 ? (usage.outputTokens * 1000) / usage.decodeWindowMs : null,
    totalTokens: uncachedInput + cacheRead + usage.outputTokens,
    cacheHitRate: inputSide > 0 ? cacheRead / inputSide : null,
    uncachedInputTokens: uncachedInput,
    cacheReadTokens: cacheRead,
    outputTokens: usage.outputTokens,
  };
}

/** 时长展示：1 分钟内秒带 1 位小数，满 1 分钟取整分秒（秒为 0 省略）。 */
export function formatSessionStatsDuration(locale: string, ms: number): string {
  const zh = locale.toLowerCase().startsWith("zh");
  const seconds = ms / 1000;
  if (seconds < 60) {
    const text = seconds < 10 ? trimTrailingZero(seconds.toFixed(1)) : String(Math.round(seconds));
    return zh ? `${text}秒` : `${text}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (rest === 0) return zh ? `${minutes}分` : `${minutes}m`;
  return zh ? `${minutes}分${rest}秒` : `${minutes}m ${rest}s`;
}

export function formatSessionStatsTokenCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

function trimTrailingZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}
