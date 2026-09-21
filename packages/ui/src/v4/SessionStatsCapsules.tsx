import { DatabaseIcon, GaugeIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useSessionStats } from "@/hooks/useSessionStats.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import {
  buildSessionStatsView,
  formatSessionStatsDuration,
  formatSessionStatsTokenCount,
} from "@/v4/sessionStatsView.js";

const CAPSULE_CLASS =
  "flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-ui-xs tabular-nums text-foreground-subtle hover:bg-muted/70 hover:text-foreground";

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-foreground-subtle">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/**
 * 会话统计胶囊（DSH 式）：速度/轮步一枚、Token 用量一枚，点击展开详情浮层。
 * 嵌在 composer 卡片内底行居中；数据按 sessionId 查询，切会话展示目标会话统计。
 */
export function SessionStatsCapsules({
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
  const tps = view.tokensPerSecond === null ? null : Math.max(1, Math.round(view.tokensPerSecond));
  const cacheHitPercent = view.cacheHitRate === null ? null : Math.round(view.cacheHitRate * 100);

  return (
    <div
      className="flex shrink-0 items-center gap-2 self-center"
      data-testid="session-stats-capsules"
    >
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={CAPSULE_CLASS}>
            <GaugeIcon className="size-3 shrink-0" />
            <span>
              {intl.formatMessage({ id: "chat.sessionStats.turns" }, { count: view.turnCount })}
            </span>
            <span>
              {intl.formatMessage({ id: "chat.sessionStats.steps" }, { count: view.toolCallCount })}
            </span>
            {tps !== null ? <span className="font-mono text-warning">· {tps} tok/s</span> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-64 gap-2">
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.modelDuration" })}
            value={formatSessionStatsDuration(locale, view.modelDurationMs)}
          />
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.toolDuration" })}
            value={formatSessionStatsDuration(locale, view.toolDurationMs)}
          />
          {view.ttftAvgMs !== null ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.sessionStats.ttftAvg" })}
              value={formatSessionStatsDuration(locale, view.ttftAvgMs)}
            />
          ) : null}
          {tps !== null ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.sessionStats.tps" })}
              value={`${tps} tok/s`}
            />
          ) : null}
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={CAPSULE_CLASS}>
            <DatabaseIcon className="size-3 shrink-0" />
            <span className="font-mono">{formatCompactTokenNumber(locale, view.totalTokens)}</span>
            <span>tok</span>
            {cacheHitPercent !== null ? (
              <span>
                · {intl.formatMessage({ id: "chat.sessionStats.cacheHit" })} {cacheHitPercent}%
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-72 gap-2">
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.tokenUsage" })}
            value={`${formatSessionStatsTokenCount(locale, view.totalTokens)} tok`}
          />
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.cacheHit" })}
            value={cacheHitPercent === null ? "-" : `${cacheHitPercent}%`}
          />
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.uncachedInput" })}
            value={`${formatSessionStatsTokenCount(locale, view.uncachedInputTokens)} tok`}
          />
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.cacheRead" })}
            value={`${formatSessionStatsTokenCount(locale, view.cacheReadTokens)} tok`}
          />
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.output" })}
            value={`${formatSessionStatsTokenCount(locale, view.outputTokens)} tok`}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
