import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import type { ComposerTurnStatsView } from "@/v4/composer/composerTurnStats.js";

function Separator() {
  return <span className="shrink-0 text-foreground-subtle">·</span>;
}

/**
 * 输入框工具栏居中的 TPS 统计胶囊：展示当前会话最新一轮的时间、首 token 耗时、
 * 即时速度与累计输出。流式中显示速度，结束后显示首 token 耗时。
 */
export function ComposerTpsCapsule({ view }: { view: ComposerTurnStatsView }) {
  const { intl, locale } = useZCodeIntl();
  const clock = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(view.startedAt);
  const tokensPerSecond =
    view.tokensPerSecond === null ? null : Math.max(1, Math.round(view.tokensPerSecond));

  return (
    <div
      className="pointer-events-none absolute left-1/2 top-1/2 flex max-w-[50%] -translate-x-1/2 -translate-y-1/2 items-center gap-1 overflow-hidden whitespace-nowrap text-ui-xs tabular-nums"
      data-testid="composer-tps-capsule"
    >
      <span
        className={
          view.streaming
            ? "size-1.5 shrink-0 rounded-full bg-success shadow-[0_0_4px_0] shadow-success"
            : "size-1.5 shrink-0 rounded-full bg-success/60"
        }
      />
      <span className="shrink-0 font-mono text-foreground">{clock}</span>
      {view.streaming && tokensPerSecond !== null ? (
        <>
          <Separator />
          <span className="shrink-0 font-mono text-warning">{tokensPerSecond} tok/s</span>
        </>
      ) : null}
      {!view.streaming && view.firstTokenMs !== null ? (
        <>
          <Separator />
          <span className="shrink-0 text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolbar.tpsStats.firstToken" })}
          </span>
          <span className="shrink-0 font-mono text-foreground">
            {Math.max(1, Math.round(view.firstTokenMs / 1000))}s
          </span>
        </>
      ) : null}
      {view.outTokens !== null ? (
        <>
          <Separator />
          <span className="shrink-0 text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolbar.tpsStats.out" })}
          </span>
          <span className="shrink-0 font-mono text-foreground">
            {formatCompactTokenNumber(locale, view.outTokens)}
          </span>
        </>
      ) : null}
    </div>
  );
}
