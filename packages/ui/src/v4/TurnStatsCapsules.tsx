import { DatabaseIcon, TimerIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import {
  buildTurnStatsView,
  formatSessionStatsDuration,
  formatSessionStatsPercent,
  formatSessionStatsTokenCount,
} from "@/v4/sessionStatsView.js";
import { useTurnStatsMap } from "@/v4/turnStatsContext.js";

const CAPSULE_CLASS =
  "flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-ui-xs tabular-nums text-foreground-subtle hover:bg-muted/70 hover:text-foreground";

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-foreground-subtle">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/** 每轮动作行上的用量/用时胶囊（DSH 式），数据来自 TurnStatsContext 的逐轮聚合。 */
export function TurnStatsCapsules({ turnId }: { turnId: string }) {
  const { intl, locale } = useZCodeIntl();
  const turn = useTurnStatsMap()[turnId];
  if (!turn) return null;
  const view = buildTurnStatsView(turn);
  const cacheHitPercent =
    view.cacheHitRate === null ? null : formatSessionStatsPercent(view.cacheHitRate);

  return (
    <span className="flex items-center gap-1.5" data-testid="turn-stats-capsules">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={CAPSULE_CLASS}>
            <DatabaseIcon className="size-3 shrink-0" />
            <span>{intl.formatMessage({ id: "chat.sessionStats.turnUsage" })}</span>
            <span className="font-mono">{formatCompactTokenNumber(locale, view.totalTokens)}</span>
            <span>tok</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-72 gap-2">
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.turnUsage" })}
            value={`${formatSessionStatsTokenCount(locale, view.totalTokens)} tok`}
          />
          {view.providerModel ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.sessionStats.providerModel" })}
              value={view.providerModel}
            />
          ) : null}
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
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={CAPSULE_CLASS}>
            <TimerIcon className="size-3 shrink-0" />
            <span>{intl.formatMessage({ id: "chat.sessionStats.duration" })}</span>
            <span className="font-mono">{formatSessionStatsDuration(locale, view.durationMs)}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-64 gap-2">
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.turnDuration" })}
            value={formatSessionStatsDuration(locale, view.durationMs)}
          />
          {view.tokensPerSecond !== null ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.sessionStats.speed" })}
              value={`${Math.max(1, Math.round(view.tokensPerSecond))} tok/s`}
            />
          ) : null}
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.modelDuration" })}
            value={formatSessionStatsDuration(locale, view.modelDurationMs)}
          />
          <DetailRow
            label={intl.formatMessage({ id: "chat.sessionStats.toolDuration" })}
            value={formatSessionStatsDuration(locale, view.toolDurationMs)}
          />
          {view.ttftMs !== null ? (
            <DetailRow
              label={intl.formatMessage({ id: "chat.sessionStats.ttftAvg" })}
              value={formatSessionStatsDuration(locale, view.ttftMs)}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </span>
  );
}
