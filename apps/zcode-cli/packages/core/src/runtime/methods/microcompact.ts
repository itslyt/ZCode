import {
  CompactPhase,
  SessionEventType,
  buildDefaultMicrocompactThreshold,
  getAutoCompactThreshold,
  traceContextToLogContext,
} from "../deps.js";
import type {
  AutoCompactPolicyConfig,
  LocalMicrocompactPolicyConfig,
  Model,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import { maybeLocalMicrocompactRuntimeEntries, throwIfTurnAborted } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

export async function microcompactIfNeeded(
  this: AgentRuntimeInternal,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: {
    model: Model;
    modelStepIndex: number;
    phase: CompactPhase;
    turnRequestState: TurnRequestState;
  },
): Promise<void> {
  if (this.config.compact?.enabled === false) return;
  throwIfTurnAborted(abortSignal);

  const autoConfig: AutoCompactPolicyConfig = {
    contextWindow: context.model.properties.contextWindow,
    ...this.config.compact,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: context.model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
  };
  const microcompactConfig = resolveLocalMicrocompactConfig(autoConfig);
  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    context.model.properties.supportsMidConversationSystem;
  const result = maybeLocalMicrocompactRuntimeEntries({
    config: microcompactConfig,
    entries: context.turnRequestState.entries,
    lastAssistantCompletedAtMs: this.lastAssistantCompletedAtMs,
    useMidConversationSystem,
  });

  if (!result.payload) {
    this.logger?.debug("Microcompact skipped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.micro.skipped",
      estimatedTokenCount: result.decision.estimatedTokenCount,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      reason: result.decision.reason,
      thresholdTokens: result.decision.thresholdTokens,
      trigger: result.decision.trigger,
    });
    return;
  }

  const recordableEntries = filterOutputTokenContinuationEntries(result.entries);
  this.messageHistory.replaceMessages(
    preserveCanonicalContextPrefix(
      this.messageHistory.borrowReadOnlyRuntimeEntries(),
      recordableEntries,
    ),
  );
  context.turnRequestState.entries = result.entries;

  const payload = {
    ...result.payload,
    traceId: turnTraceContext.traceId,
    turnId: turnTraceContext.turnId,
  };
  const event = this.createEvent(SessionEventType.MicrocompactBoundary, payload, turnTraceContext);
  await this.appendEvent(event, turnTraceContext);
  events.push(event);

  this.logger?.info("Microcompact applied", {
    ...traceContextToLogContext(turnTraceContext),
    clearedMessageCount: payload.clearedMessageCount,
    event: "compact.micro.applied",
    modelStepIndex: context.modelStepIndex,
    module: "core.runtime",
    phase: context.phase,
    postMicrocompactTokenCount: payload.postMicrocompactTokenCount,
    preMicrocompactTokenCount: payload.preMicrocompactTokenCount,
    tokensSaved: payload.tokensSaved,
    trigger: payload.trigger,
  });
}

export function resolveLocalMicrocompactConfig(
  config: AutoCompactPolicyConfig,
): LocalMicrocompactPolicyConfig {
  const fullCompactThreshold = getAutoCompactThreshold(config);
  return {
    ...config.microcompact,
    // 默认开启（本 fork 自选）。
    //
    // 历史：上游 `=== true`（opt-in）→ 本 fork 改 `!== false`（默认开）→ 因「中位只回收
    // 800 token 却销毁证据」回退为默认关 → 2026-09-28 重新开启，但换成**只压可重取的类别**。
    //
    // 关键修正（对真实数据的模拟）：先前以为「提高 minTokenSavings 就能少销毁证据」，
    // 实测不成立——清空不可逆且每次清「除最新 5 条外全部」，阈值 256→2000 时
    // 销毁条数仍是 ~92%，只是操作数从 332 降到 107。
    // 真正让销毁量从 ~92% 降到 ~15% 的是**把不可重取的 Bash/Edit/Write 移出可压名单**，
    // 见 DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS；阈值只负责降低触发频率。
    enabled: config.microcompact?.enabled !== false,
    thresholdTokens:
      config.microcompact?.thresholdTokens ??
      buildDefaultMicrocompactThreshold(fullCompactThreshold),
  };
}
