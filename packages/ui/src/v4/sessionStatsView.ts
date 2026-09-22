import type {
  V4ConversationUsageResult,
  V4ConversationTurnUsageRow,
} from "@zcode/shared/zcode-protocol-v4";

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
  turnCount: number;
  toolCallCount: number;
}

/** 会话级统计展示模型：全部由 v4/conversation/usage 的 DB 聚合派生，无窗口/条数限制；Token 用量与缓存拆分为提供商原始口径。 */
export function buildSessionStatsView(usage: V4ConversationUsageResult): SessionStatsView {
  // 用量库的 inputTokens 已是 total input（含缓存命中），cache 字段只是 breakdown；
  // 分母不能再加 cacheRead，否则命中率会被压低一半（同 usage-stats-builder 的注释）。
  const inputSide = usage.rawInputTokens;
  const cacheRead = Math.min(usage.rawCacheReadTokens, inputSide);
  const uncachedInput = Math.max(0, inputSide - cacheRead);
  return {
    hasActivity: usage.modelRequestCount > 0 || usage.totalTokens > 0,
    modelDurationMs: usage.modelDurationMs,
    toolDurationMs: usage.toolDurationMs,
    ttftAvgMs: usage.ttftSampleCount > 0 ? usage.ttftTotalMs / usage.ttftSampleCount : null,
    tokensPerSecond:
      usage.decodeWindowMs > 0 ? (usage.outputTokens * 1000) / usage.decodeWindowMs : null,
    totalTokens: inputSide + usage.outputTokens,
    cacheHitRate: inputSide > 0 ? cacheRead / inputSide : null,
    uncachedInputTokens: uncachedInput,
    cacheReadTokens: cacheRead,
    outputTokens: usage.outputTokens,
    turnCount: usage.turnCount,
    toolCallCount: usage.toolCallCount,
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

/** 缓存命中率统一展示一位小数：状态栏胶囊与上下文面板必须同口径同精度。 */
export function formatSessionStatsPercent(rate: number): string {
  return (Math.max(0, rate) * 100).toFixed(1);
}

function trimTrailingZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

export interface TurnStatsView {
  totalTokens: number;
  cacheHitRate: number | null;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  durationMs: number;
  modelDurationMs: number;
  toolDurationMs: number;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  providerModel: string | null;
}

function decodeWindowMs(turn: V4ConversationTurnUsageRow): number {
  return Math.max(0, turn.modelDurationMs - (turn.timeToFirstTokenMs ?? 0));
}

/** 逐轮胶囊展示模型：turn_usage 原始口径直接派生。 */
export function buildTurnStatsView(turn: V4ConversationTurnUsageRow): TurnStatsView {
  // 同上：turn.inputTokens 已是 total input，命中率分母就是它本身。
  const cacheRead = Math.min(turn.cacheReadTokens, turn.inputTokens);
  return {
    totalTokens: turn.totalTokens,
    cacheHitRate: turn.inputTokens > 0 ? cacheRead / turn.inputTokens : null,
    uncachedInputTokens: Math.max(0, turn.inputTokens - cacheRead),
    cacheReadTokens: cacheRead,
    outputTokens: turn.outputTokens,
    durationMs: turn.durationMs,
    modelDurationMs: turn.modelDurationMs,
    toolDurationMs: turn.toolDurationMs,
    ttftMs: turn.timeToFirstTokenMs,
    tokensPerSecond:
      decodeWindowMs(turn) > 0 ? (turn.outputTokens * 1000) / decodeWindowMs(turn) : null,
    providerModel: turn.providerId && turn.modelId ? `${turn.providerId}/${turn.modelId}` : null,
  };
}
