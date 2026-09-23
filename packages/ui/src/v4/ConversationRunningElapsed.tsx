import { TID_V4_RUNNING_ELAPSED } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";

/**
 * 执行中常驻时长条。
 *
 * 轮顶的「工作中 N 秒」会随轮次变长被滚出视口，用户必须往上拉回问题处才能看到
 * 已经执行了多久。这里在 composer dock 顶部复述同一事实：同一段 workStatus.durationMs、
 * 同一个 `chat.history.workingFor` 文案与同一套时长写法，两处必须逐字一致。
 *
 * 时钟不在这里：宿主 `ConversationTimeline` 的 liveNowMs 每秒重建 render unit，
 * 本组件只做展示，避免出现第二个计时器与第二个读数。
 */
export function ConversationRunningElapsed({ durationMs }: { durationMs: number }) {
  const { intl, locale } = useZCodeIntl();
  const durationLabel = formatConversationWorkDuration(durationMs, intl, locale) ?? "";

  return (
    <div
      data-testid={TID_V4_RUNNING_ELAPSED}
      className="pb-2 text-ui-base tabular-nums text-foreground-subtle"
    >
      {intl.formatMessage({ id: "chat.history.workingFor" }, { duration: durationLabel })}
    </div>
  );
}
