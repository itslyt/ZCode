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
    // 本 fork 默认开启：上游是 `=== true`（opt-in），实测日志里一直是 `reason: "disabled"`，
    // 于是这一层从未生效，旧工具结果一路堆到全量压缩阈值。改成 `!== false`：默认开，
    // 需要时仍可显式关闭。它是便宜层（只清旧工具结果的内容，保留最近若干条），
    // 触发阈值也低于全量压缩，本就应该先它一步生效。
    enabled: config.microcompact?.enabled !== false,
    thresholdTokens:
      config.microcompact?.thresholdTokens ??
      buildDefaultMicrocompactThreshold(fullCompactThreshold),
  };
}
