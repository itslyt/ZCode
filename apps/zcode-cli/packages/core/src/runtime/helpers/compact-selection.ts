import {
  COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
  CompactTrigger,
  MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
  countContextPrefixMessages,
  estimateMessageTokens,
  modelMessageContentToText,
  traceContextToLogContext,
} from "../deps.js";
import type { TraceContext } from "../deps.js";
import {
  cloneRuntimeMessageEntry,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { groupByAssistantStartedRounds } from "../../compact/rounds.js";
import { buildProviderRequestMessages } from "./provider-request-messages.js";

interface CompactRetryLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * 原样保留尾部的默认 token 预算。
 *
 * 取值依据（实测 3 个长会话，按 assistant 轮分组）：
 *   每轮 token 中位 ~1.0–1.6K、p90 ~4.5–5.4K、max ~20.6K。
 *   所以旧行为「只保留 1 轮」中位仅留下 ~1K token —— 几乎等于不留，
 *   而压缩后的可用预算（摘要上限 20K）远大于它。
 * 20K 相当于「典型约 15 轮 / 重尾时 1 轮」，与 Codex 的
 * COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000 同量级，远低于 dsh 的 16%(~68K)，
 * 故意偏保守：保留量越大，压缩后越可能立即再次超过阈值。
 */
export const DEFAULT_COMPACT_RETAIN_TOKENS = 20_000;

export interface CompactEntrySelection {
  entriesForSummary: RuntimeMessageEntry[];
  groupsPreserved: number;
  preservedEntries: RuntimeMessageEntry[];
  totalGroups: number;
}

export function selectCompactEntries(input: {
  entries: readonly RuntimeMessageEntry[];
  minimumGroupsToPreserve?: number;
  /**
   * 原样保留的尾部 token 预算。在至少保留 1 轮的基础上，从尾往前整轮累计，
   * 只要不超过该预算就继续多留——在「留轮」与「留量」之间取实际能留住的。
   * 见 specs/context-compaction-optimization.md §13。
   */
  retainTokens?: number;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}): CompactEntrySelection {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  // 先确定下限：自动/被动压缩至少原样保留最近 1 轮（手动压缩不保留）。
  const baseGroupsToPreserve = split.shouldPreserveRecent && split.groups.length > 1 ? 1 : 0;
  const floorGroupsToPreserve = Math.max(
    baseGroupsToPreserve,
    positiveInt(input.minimumGroupsToPreserve) ?? 0,
  );
  const maxGroupsToPreserve = Math.max(0, split.groups.length - 1);
  // 再按 token 预算向上扩展：
  //   保留单位是 assistant 轮，而实测每轮 token 中位仅 ~1K、p90 ~4.5K、max ~20K
  //   （按 user-turn 口径会得出「一轮可能上百个工具调用」，那是错的单位）。
  //   所以「只留 1 轮」＝典型的只留 1K token，几乎等于不留；而「留 N 轮」在参数里
  //   无法表达容量。改成：先把下限补齐，再在不超预算的前提下尽量多留整轮，
  //   既保证工具配对不被切断（整轮），又让保留量随预算而非轮数走。
  const retainedGroupCount = split.shouldPreserveRecent
    ? resolveGroupsWithinTokenBudget({
        groups: split.groups,
        floorGroups: floorGroupsToPreserve,
        maxGroups: maxGroupsToPreserve,
        retainTokens: positiveInt(input.retainTokens) ?? DEFAULT_COMPACT_RETAIN_TOKENS,
        useMidConversationSystem: input.useMidConversationSystem,
      })
    : 0;
  const groupsToPreserve = retainedGroupCount;
  const summaryGroups =
    groupsToPreserve > 0
      ? split.groups.slice(0, split.groups.length - groupsToPreserve)
      : split.groups;
  const preservedGroups = groupsToPreserve > 0 ? split.groups.slice(-groupsToPreserve) : [];

  return {
    entriesForSummary: [...split.prefixEntries, ...summaryGroups.flat()].map(cloneRuntimeEntry),
    groupsPreserved: groupsToPreserve,
    preservedEntries: preservedGroups.flat().map(cloneRuntimeEntry),
    totalGroups: split.groups.length,
  };
}

export function selectCompactEntriesAfterPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
  currentGroupsPreserved: number;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length < 2) {
    return null;
  }

  const maxGroupsToPreserve = split.groups.length - 1;
  if (input.currentGroupsPreserved >= maxGroupsToPreserve) {
    return null;
  }

  const summarizedGroupCount = split.groups.length - input.currentGroupsPreserved;
  const groupsForSummary = split.groups.slice(0, summarizedGroupCount);
  if (groupsForSummary.length < 2) {
    return null;
  }

  const groupsToMove = countRecentGroupsToPreserveAfterPromptTooLong(
    groupsForSummary,
    input.promptTooLongCause,
    { useMidConversationSystem: input.useMidConversationSystem },
  );
  const nextGroupsPreserved = Math.min(
    maxGroupsToPreserve,
    input.currentGroupsPreserved + groupsToMove,
  );
  if (nextGroupsPreserved <= input.currentGroupsPreserved) {
    return null;
  }

  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: nextGroupsPreserved,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

export function selectCompactEntriesForInitialPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length <= 3) {
    return null;
  }

  const tokenGap = getPromptTooLongTokenGap(input.promptTooLongCause);
  if (tokenGap === undefined) {
    return null;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(split.groups, {
    useMidConversationSystem: input.useMidConversationSystem,
  });
  const alreadyPreservedTokens = groupTokenEstimates.at(-1) ?? 0;
  const remainingTokenGap = tokenGap - alreadyPreservedTokens;
  if (remainingTokenGap <= 0) {
    return null;
  }

  const additionalGroupsToPreserve = countRecentGroupsToCoverTokenGap(
    groupTokenEstimates,
    split.groups.length - 1,
    remainingTokenGap,
  );
  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: 1 + additionalGroupsToPreserve,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

export function getRuntimeEntriesToSummarize(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  return entries.filter((entry) => !isRuntimeContextPrefixEntry(entry)).map(cloneRuntimeEntry);
}

export function hasEnoughRuntimeEntriesToCompact(entries: readonly RuntimeMessageEntry[]): boolean {
  const entriesToSummarize = getRuntimeEntriesToSummarize(entries);
  return (
    groupRuntimeEntriesByCompactRound(entriesToSummarize).length >= 2 &&
    entriesToSummarize.some((entry) => runtimeEntryRole(entry) === "assistant")
  );
}

export function estimateRuntimeEntryTokens(
  entries: readonly RuntimeMessageEntry[],
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const providerMessages = buildProviderRequestMessages({
    entries,
    applyCacheControl: false,
    useMidConversationSystem: options.useMidConversationSystem,
  }).messages;
  return estimateMessageTokens(providerMessages);
}

export function truncateCompactSummaryRequestEntriesAfterPromptTooLong(options: {
  attempt: number;
  cause: unknown;
  entriesForSummary: readonly RuntimeMessageEntry[];
  logger?: CompactRetryLogger;
  traceContext: TraceContext;
  useMidConversationSystem?: boolean;
}): RuntimeMessageEntry[] | null {
  if (options.attempt >= MAX_COMPACT_PROMPT_TOO_LONG_RETRIES) {
    options.logger?.warn("Compact summary prompt was too long; retry limit reached", {
      ...traceContextToLogContext(options.traceContext),
      attempt: options.attempt,
      event: "compact.prompt_too_long.retry_limit",
      maxAttempts: MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
      module: "core.runtime",
      remainingMessages: options.entriesForSummary.length,
    });
    return null;
  }

  const truncated = truncateRuntimeEntriesForCompactRetry(
    options.entriesForSummary,
    options.cause,
    { useMidConversationSystem: options.useMidConversationSystem },
  );
  if (!truncated) {
    return null;
  }

  options.logger?.warn("Compact summary prompt was too long; retrying with older rounds dropped", {
    ...traceContextToLogContext(options.traceContext),
    attempt: options.attempt + 1,
    droppedMessages: options.entriesForSummary.length - truncated.length,
    event: "compact.prompt_too_long.retry",
    maxAttempts: MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
    module: "core.runtime",
    remainingMessages: truncated.length,
  });

  return truncated;
}

/**
 * 从尾部按整轮累计，在不超过 `retainTokens` 预算的前提下尽量多保留。
 *
 * 语义：
 *  - 下限 `floorGroups` 无条件满足（即使已超预算）——它编码的是「至少留最近一轮」
 *    这类硬要求，不能被预算推翻。
 *  - 上限 `maxGroups` 已保证至少有一轮进入摘要（否则压缩无意义）。
 *  - 无 `retainTokens` 时保持旧行为：只保下限，不多留。
 */
function resolveGroupsWithinTokenBudget(input: {
  groups: readonly { length: number }[];
  floorGroups: number;
  maxGroups: number;
  retainTokens?: number;
  useMidConversationSystem?: boolean;
}): number {
  const floor = Math.min(input.floorGroups, input.maxGroups);
  const budget = input.retainTokens;
  if (budget === undefined) return floor;

  // 先满足下限，再逐轮向前扩，直到再加一轮就会超预算。
  let kept = floor;
  let accumulated = sumLastGroupTokens(input.groups, kept, input.useMidConversationSystem);
  while (kept < input.maxGroups) {
    const nextTokens = estimateRuntimeEntryTokens(
      input.groups[input.groups.length - kept - 1] as RuntimeMessageEntry[],
      { useMidConversationSystem: input.useMidConversationSystem },
    );
    if (accumulated + nextTokens > budget) break;
    accumulated += nextTokens;
    kept += 1;
  }
  return kept;
}

function sumLastGroupTokens(
  groups: readonly { length: number }[],
  count: number,
  useMidConversationSystem: boolean | undefined,
): number {
  let total = 0;
  for (let index = groups.length - count; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) continue;
    total += estimateRuntimeEntryTokens(group as RuntimeMessageEntry[], { useMidConversationSystem });
  }
  return total;
}

function splitRuntimeEntriesForCompactSelection(
  inputEntries: readonly RuntimeMessageEntry[],
  trigger: CompactTrigger,
): {
  groups: RuntimeMessageEntry[][];
  prefixEntries: RuntimeMessageEntry[];
  shouldPreserveRecent: boolean;
} {
  const entries = inputEntries.map(cloneRuntimeEntry);
  const prefixCount = countContextPrefixMessages(entries);
  const prefixEntries = entries.slice(0, prefixCount);
  const bodyEntries = entries.slice(prefixCount);

  return {
    groups: groupRuntimeEntriesByCompactRound(bodyEntries),
    prefixEntries,
    shouldPreserveRecent: trigger === CompactTrigger.Auto || trigger === CompactTrigger.Reactive,
  };
}

function countRecentGroupsToPreserveAfterPromptTooLong(
  groupsForSummary: readonly RuntimeMessageEntry[][],
  promptTooLongCause: unknown,
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const tokenGap = getPromptTooLongTokenGap(promptTooLongCause);
  if (tokenGap === undefined) {
    return 1;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(groupsForSummary, {
    useMidConversationSystem: options.useMidConversationSystem,
  });
  return countRecentGroupsToCoverTokenGap(groupTokenEstimates, groupsForSummary.length, tokenGap);
}

function countRecentGroupsToCoverTokenGap(
  groupTokenEstimates: readonly number[],
  groupCount: number,
  tokenGap: number,
): number {
  if (tokenGap <= 0 || groupCount <= 0) {
    return 0;
  }

  let tokensCovered = 0;
  let groupsCovered = 0;
  for (let index = groupCount - 1; index >= 0; index -= 1) {
    tokensCovered += groupTokenEstimates[index] ?? 0;
    groupsCovered += 1;
    if (tokensCovered >= tokenGap) break;
  }

  if (groupsCovered >= groupCount - 1) {
    return Math.max(1, Math.floor(groupCount / 2));
  }
  return Math.max(1, groupsCovered);
}

function estimateCompactGroupTokens(
  groups: readonly RuntimeMessageEntry[][],
  options: { useMidConversationSystem?: boolean } = {},
): number[] {
  return groups.map((group) =>
    estimateRuntimeEntryTokens(group, {
      useMidConversationSystem: options.useMidConversationSystem,
    }),
  );
}

function truncateRuntimeEntriesForCompactRetry(
  entries: readonly RuntimeMessageEntry[],
  promptTooLongCause: unknown,
  options: { useMidConversationSystem?: boolean } = {},
): RuntimeMessageEntry[] | null {
  const prefix: RuntimeMessageEntry[] = [];
  let index = 0;
  while (index < entries.length && isRuntimeContextPrefixEntry(entries[index]!)) {
    prefix.push(cloneRuntimeEntry(entries[index]!));
    index += 1;
  }

  let candidates = entries.slice(index);
  if (candidates[0] && isCompactPromptTooLongRetryMarker(candidates[0])) {
    candidates = candidates.slice(1);
  }

  const groups = groupRuntimeEntriesByCompactRound(candidates);
  if (groups.length < 2) return null;

  const tokenGap = getPromptTooLongTokenGap(promptTooLongCause);
  let dropCount = 0;
  if (tokenGap !== undefined) {
    let droppedTokens = 0;
    for (const group of groups) {
      droppedTokens += estimateRuntimeEntryTokens(group, {
        useMidConversationSystem: options.useMidConversationSystem,
      });
      dropCount += 1;
      if (droppedTokens >= tokenGap) break;
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2));
  }

  dropCount = Math.min(dropCount, groups.length - 1);
  if (dropCount < 1) return null;

  const sliced = groups.slice(dropCount).flat().map(cloneRuntimeEntry);
  if (sliced.length === 0) return null;

  const needsMarker = sliced[0] && runtimeEntryRole(sliced[0]) === "assistant";
  return [
    ...prefix,
    ...(needsMarker
      ? [
          {
            message: {
              role: "user" as const,
              content: COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
            },
          },
        ]
      : []),
    ...sliced,
  ];
}

function isRuntimeContextPrefixEntry(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) {
    return entry.metadata.source === "context_prefix" || entry.metadata.source === "skills_listing";
  }
  if (entry.message.role === "system") return true;
  if (entry.message.role !== "user") return false;
  if (entry.metadata) {
    return entry.metadata.source === "context_prefix" || entry.metadata.source === "skills_listing";
  }
  return modelMessageContentToText(entry.message.content)
    .trimStart()
    .startsWith("<system-reminder>");
}

function isCompactPromptTooLongRetryMarker(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  return (
    entry.message.role === "user" &&
    modelMessageContentToText(entry.message.content) === COMPACT_PROMPT_TOO_LONG_RETRY_MARKER
  );
}

function groupRuntimeEntriesByCompactRound(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[][] {
  return groupByAssistantStartedRounds(entries, runtimeEntryRole);
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function getPromptTooLongTokenGap(cause: unknown): number | undefined {
  let current: unknown = cause;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (typeof current === "string") {
      const gap = parsePromptTooLongTokenGap(current);
      if (gap !== undefined) return gap;
      return undefined;
    }
    if (current === undefined || current === null || typeof current !== "object") {
      return undefined;
    }
    if (seen.has(current)) return undefined;
    seen.add(current);

    const record = current as Record<string, unknown>;
    for (const key of ["message", "errorDetails", "details", "body"]) {
      const value = record[key];
      if (typeof value === "string") {
        const gap = parsePromptTooLongTokenGap(value);
        if (gap !== undefined) return gap;
      }
    }
    current = record.cause ?? record.lastError ?? record.error;
  }

  return undefined;
}

function parsePromptTooLongTokenGap(message: string): number | undefined {
  const match = message.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (!match) return undefined;

  const actual = Number(match[1]?.replace(/,/g, ""));
  const limit = Number(match[2]?.replace(/,/g, ""));
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || actual <= limit) {
    return undefined;
  }
  return Math.ceil(actual - limit);
}

function cloneRuntimeEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  return cloneRuntimeMessageEntry(entry);
}

function runtimeEntryRole(entry: RuntimeMessageEntry): "system" | "user" | "assistant" | "tool" {
  if (isRuntimeAttachmentEntry(entry)) return "user";
  return entry.message.role;
}
