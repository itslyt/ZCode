export function formatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  // token 数值仍应走本地化 compact；中文展示万/亿，英文展示 K/M/B。
  // 之前为了修 Start Plan 的英文 long unit 误把所有 locale 都强制成 K/M/B。
  return new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatModelContextWindowLabel(contextWindow: number, _locale = "en-US"): string {
  // 模型列表的容量 badge 是技术规格，不应随中文 locale 变成“万/亿”。
  return formatCompactTokenNumber("en-US", contextWindow);
}

/**
 * 固定 K 单位（不随 locale 变万/亿）：上下文容量面板要跟 provider 的技术口径对齐，
 * “1.1万” 这种本地化读法在该面板里难和 token 数对账。保留一位小数。
 */
export function formatTokenCountK(value: number, maximumFractionDigits = 1): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  if (Math.abs(value) < 1_000) {
    return String(Math.round(value));
  }

  return `${(value / 1_000).toFixed(maximumFractionDigits).replace(/\.0+$/, "")}K`;
}
