import { useSessionStats } from "@/hooks/useSessionStats.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildSessionStatsView,
  formatSessionStatsDuration,
  formatSessionStatsTokenCount,
} from "@/v4/sessionStatsView.js";

function Stat({
  label,
  value,
  valueClassName = "font-mono text-foreground",
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="shrink-0 text-foreground-subtle">{label}</span>
      <span className={`shrink-0 ${valueClassName}`}>{value}</span>
    </span>
  );
}

/**
 * 会话底部统计条：模型/工具用时、平均 TTFT、输出速度与 Token 用量（含缓存拆分）。
 * 数据按 sessionId 查询，切会话即展示目标会话自己的统计。
 */
export function SessionStatsBar({
  workspacePath,
  workspaceIdentity,
  sessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const usage = useSessionStats({ workspacePath, workspaceIdentity, sessionId });
  if (!usage) return null;
  const view = buildSessionStatsView(usage);
  if (!view.hasActivity) return null;
  const tokensPerSecond =
    view.tokensPerSecond === null ? null : Math.max(1, Math.round(view.tokensPerSecond));

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 text-ui-xs tabular-nums"
      data-testid="session-stats-bar"
    >
      <Stat
        label={intl.formatMessage({ id: "chat.sessionStats.modelDuration" })}
        value={formatSessionStatsDuration(locale, view.modelDurationMs)}
      />
      <Stat
        label={intl.formatMessage({ id: "chat.sessionStats.toolDuration" })}
        value={formatSessionStatsDuration(locale, view.toolDurationMs)}
      />
      {view.ttftAvgMs !== null ? (
        <Stat
          label={intl.formatMessage({ id: "chat.sessionStats.ttftAvg" })}
          value={formatSessionStatsDuration(locale, view.ttftAvgMs)}
        />
      ) : null}
      {tokensPerSecond !== null ? (
        <Stat
          label={intl.formatMessage({ id: "chat.sessionStats.tps" })}
          value={`${tokensPerSecond} tok/s`}
          valueClassName="font-mono text-warning"
        />
      ) : null}
      <span className="flex min-w-0 items-center gap-1">
        <span className="shrink-0 text-foreground-subtle">
          {intl.formatMessage({ id: "chat.sessionStats.tokenUsage" })}
        </span>
        <span className="shrink-0 font-mono text-foreground">
          {formatSessionStatsTokenCount(locale, view.totalTokens)} tok
        </span>
        <span className="truncate text-foreground-subtle">
          ({intl.formatMessage({ id: "chat.sessionStats.cacheHit" })}{" "}
          {view.cacheHitRate === null ? "-" : `${Math.round(view.cacheHitRate * 100)}%`} ·{" "}
          {intl.formatMessage({ id: "chat.sessionStats.uncachedInput" })}{" "}
          {formatSessionStatsTokenCount(locale, view.uncachedInputTokens)} ·{" "}
          {intl.formatMessage({ id: "chat.sessionStats.cacheRead" })}{" "}
          {formatSessionStatsTokenCount(locale, view.cacheReadTokens)} ·{" "}
          {intl.formatMessage({ id: "chat.sessionStats.output" })}{" "}
          {formatSessionStatsTokenCount(locale, view.outputTokens)})
        </span>
      </span>
    </div>
  );
}
