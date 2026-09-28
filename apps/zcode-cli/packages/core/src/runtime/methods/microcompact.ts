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
    // 默认关闭（opt-in，与上游一致）。
    //
    // 历史：上游是 `=== true`（默认关）。本 fork 曾改成 `!== false`（默认开），
    // 理由是上游那版日志里一直 `reason: "disabled"`、这层从未生效。
    //
    // 改回默认关的原因（实测 2026-09-28 日志，196 条 applied 事件，来自 2 个长会话）：
    //   tokensSaved 中位 800、p90 2276、max 610791；clearedMessageCount 中位 2
    //   → 典型情况是「为回收不到 1K token 就销毁工具结果证据」，性价比接近纯亏；
    //   且触发极频繁（当日 model.request.completed 共 5825 条，其中 193 条 token_pressure）。
    //   注意：收益是重尾分布（max 610K），并非每次都很小——所以这是权衡取舍，
    //   不是无条件正收益；需拿到真实 token 口径的对照数据后再定。
    //
    // 保留显式开启通道，便于对照实验与后续按数据决策。
    enabled: config.microcompact?.enabled === true,
    thresholdTokens:
      config.microcompact?.thresholdTokens ??
      buildDefaultMicrocompactThreshold(fullCompactThreshold),
  };
}
