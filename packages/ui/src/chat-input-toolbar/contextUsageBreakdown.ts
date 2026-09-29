import type { ZCodeContextUsageBreakdownItem } from "@zcode/shared";

export type ContextUsageBreakdownSource = ZCodeContextUsageBreakdownItem["source"];

export interface ContextUsageBreakdownSegment {
  chars: number;
  percent: number;
  source: ContextUsageBreakdownSource;
  /** 估算 token 原值；旧快照缺该字段时为 0，此时只展示占比。 */
  tokens: number;
}

const BREAKDOWN_SOURCE_ORDER: Record<ContextUsageBreakdownSource, number> = {
  messages: 0,
  system_prompt: 1,
  meta_user_context: 2,
  skills: 3,
  tool_prompt: 4,
  system_tool_schemas: 5,
  mcp_tool_schemas: 6,
};

/**
 * 分项展示模型。
 *
 * `percent` 与 `tokens` 同源（都按估算 token 算），但两者性质不同：
 * 百分比是“该项估算 / 各分项估算之和”的比值，系统性估算偏差在分子分母间相消，可信；
 * `tokens` 是该项的估算原值，与 DSH 的 `contextBreakdown` 口径一致，**不按顶部 provider 实测
 * `used` 缩放**——顶部 `used` 含 output token，拿它乘纯输入侧的占比会把 output 摊进每个静态项，
 * 且缩放系数随“实测/估算”比值漂移，使内容未变的静态项来回跳。代价是分项之和不再等于顶部已用
 * （DSH 亦然），故渲染时以 `~` 前缀标记为估算。
 */
export function buildContextUsageBreakdownSegments(
  breakdown: readonly ZCodeContextUsageBreakdownItem[] | undefined,
): ContextUsageBreakdownSegment[] {
  const charsBySource = new Map<ContextUsageBreakdownSource, number>();
  const tokensBySource = new Map<ContextUsageBreakdownSource, number>();
  for (const item of breakdown ?? []) {
    if (!Number.isFinite(item.chars) || item.chars <= 0) {
      continue;
    }
    charsBySource.set(item.source, (charsBySource.get(item.source) ?? 0) + item.chars);
    tokensBySource.set(item.source, (tokensBySource.get(item.source) ?? 0) + (item.tokens ?? 0));
  }

  const totalChars = [...charsBySource.values()].reduce((sum, chars) => sum + chars, 0);
  if (totalChars <= 0) {
    return [];
  }

  // 占比用估算 token 算（旧快照只有 chars 时退回字符占比）。
  const totalTokens = [...tokensBySource.values()].reduce((sum, tokens) => sum + tokens, 0);
  const useTokens = totalTokens > 0;

  return [...charsBySource.entries()]
    .map(([source, chars]) => {
      const percent = useTokens
        ? (tokensBySource.get(source) ?? 0) / totalTokens
        : chars / totalChars;
      return {
        chars,
        percent,
        source,
        // K 用估算原值；旧快照无 `tokens` 时记 0，渲染侧只展示占比，不拿 chars 冒充 token。
        tokens: tokensBySource.get(source) ?? 0,
      };
    })
    .sort(
      (left, right) =>
        right.tokens - left.tokens ||
        right.chars - left.chars ||
        BREAKDOWN_SOURCE_ORDER[left.source] - BREAKDOWN_SOURCE_ORDER[right.source],
    );
}
