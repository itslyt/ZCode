import {
  MicrocompactStrategy,
  MicrocompactTrigger,
  modelMessageContentToText,
  type MicrocompactBoundaryPayload,
  type ModelMessageContent,
  type ToolCallId,
} from "@zcode/contracts";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens } from "./manual.js";

export const MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX = "[Old tool result content cleared]";
export const MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE = "[Old tool result content cleared]";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;
const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
// 提高至 2000 的依据：对 196 条真实 applied 事件模拟，阈值 256→2000 把清除**操作数**
// 从 332/931 降到 107/304（减约 1/3~1/9），而回收总量基本不变（重尾分布，
// 少数大事件贡献绝大多数回收量）。
//
// 注意适用边界：它只减少「隔多久清一次」，**在未启用重取 pin 时**不减少最终被销毁
// 的结果数（清空不可逆且每次清「除最新 N 条外全部」）——真正保住证据的是可压工具名单
// （见 DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS）。
// 启用 pin（见 resolvePinnedRefetchIndexes）后，被销毁的条数确实会减少（实测两个会话各少 27/28 条），
// 但**不要把它读成「pin 能省 token」**：反事实重放显示 pin 反而让期末常驻多出 ~14K–16K token。
// 它换掉的是循环里那条目标上的重复工具往返，不是上下文占用。见 specs §14.2。
export const DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS = 2_000;
export const DEFAULT_MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;
// 只压「清除后能精确重取」的工具。按真实工具入参实测（3 个长会话）：
//   Read / Grep / Glob 的重取指针生成率 100%（file_path / pattern 可从入参完全还原）
//   Bash 为 0%，且其输出 97.5% 未落盘（无 <persisted-output>）→ 清掉就是真丢，无法回读
// 排除 Bash 后：被销毁的结果数从 ~92% 降到 ~15%，回收量仍保留约 40%。
// 这正是本 fork 早期“清掉后反复重跑命令”的根因——不是清得太早，是清了一个不可重取的类别。
// Edit / Write / ApplyPatch 同样无指针（且体积小），一并移出。
export const DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS = ["Read", "Grep", "Glob"] as const;

export interface LocalMicrocompactPolicyConfig {
  enabled?: boolean;
  thresholdTokens?: number;
  idleThresholdMinutes?: number;
  keepRecentToolResults?: number;
  compactableToolNames?: readonly string[];
  clearErrorResults?: boolean;
  minTokenSavings?: number;
}

export interface LocalMicrocompactMessage extends CompactModelMessage {
  isError?: boolean;
  toolCalls?: Array<{ id: string; input: unknown; name: string }>;
  toolCallId?: string;
  toolName?: string;
}

export type LocalMicrocompactBoundaryPayload = Omit<
  MicrocompactBoundaryPayload,
  "traceId" | "turnId"
>;

export interface LocalMicrocompactDecision {
  estimatedTokenCount: number;
  reason:
    | "disabled"
    | "not_triggered"
    | "no_candidates"
    | "nothing_to_clear"
    | "below_min_savings"
    | "applied";
  thresholdTokens?: number;
  trigger?: MicrocompactTrigger;
}

export interface LocalMicrocompactResult<T extends LocalMicrocompactMessage> {
  decision: LocalMicrocompactDecision;
  messages: T[];
  payload?: LocalMicrocompactBoundaryPayload;
}

interface ToolResultCandidate {
  index: number;
  toolCallId: string;
  /** 清除后留下的结构化重取指针，让模型能按 file:line 精确重读而非盲目再读一遍。 */
  pointer?: string;
  /** `pointer` 的目标身份（规范化），用于识别「同一目标被反复重取」。 */
  refetchKey?: string;
}

export function buildDefaultMicrocompactThreshold(autoCompactThreshold: number): number {
  const ratioThreshold = Math.floor(autoCompactThreshold * DEFAULT_MICROCOMPACT_THRESHOLD_RATIO);
  const bufferThreshold = autoCompactThreshold - DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS;
  return Math.max(0, Math.min(ratioThreshold, bufferThreshold));
}

export function maybeLocalMicrocompactMessages<T extends LocalMicrocompactMessage>(input: {
  config?: LocalMicrocompactPolicyConfig;
  lastAssistantCompletedAtMs?: number;
  messages: readonly T[];
  nowMs?: number;
}): LocalMicrocompactResult<T> {
  const config = input.config ?? {};
  const messages = input.messages.map(cloneLocalMicrocompactMessage);
  const estimatedTokenCount = estimateMessageTokens(messages);
  const thresholdTokens = positiveInt(config.thresholdTokens);

  if (config.enabled === false) {
    return {
      decision: { estimatedTokenCount, reason: "disabled", thresholdTokens },
      messages,
    };
  }

  const trigger = resolveMicrocompactTrigger({
    config,
    estimatedTokenCount,
    lastAssistantCompletedAtMs: input.lastAssistantCompletedAtMs,
    nowMs: input.nowMs,
    thresholdTokens,
  });
  if (!trigger) {
    return {
      decision: { estimatedTokenCount, reason: "not_triggered", thresholdTokens },
      messages,
    };
  }

  const collection = collectCompactableToolResultGroups(messages, config);
  const candidateGroups = collection.groups;
  if (candidateGroups.length === 0) {
    return {
      decision: { estimatedTokenCount, reason: "no_candidates", thresholdTokens, trigger },
      messages,
    };
  }

  const keepCount =
    positiveInt(config.keepRecentToolResults) ?? DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS;
  const boundedKeepCount = Math.max(1, keepCount);
  const clearGroupCount = Math.max(0, candidateGroups.length - boundedKeepCount);
  if (clearGroupCount === 0) {
    return {
      decision: { estimatedTokenCount, reason: "nothing_to_clear", thresholdTokens, trigger },
      messages,
    };
  }

  // `allCandidates` 是全量候选（含最新 N 条），pin 的判定与排除都要在全量上做；
  // `clearRangeCandidates` 是「按旧规则应当清掉」的那批。
  const allCandidates = candidateGroups.flat();
  const clearRangeCandidates = candidateGroups.slice(0, clearGroupCount).flat();
  const pinnedIndexes = resolvePinnedRefetchIndexes(allCandidates, collection.clearedRefetchKeys);

  const toClear = clearRangeCandidates.filter((candidate) => !pinnedIndexes.has(candidate.index));
  if (toClear.length === 0) {
    return {
      decision: { estimatedTokenCount, reason: "nothing_to_clear", thresholdTokens, trigger },
      messages,
    };
  }
  const clearedIndexes = new Set(toClear.map((candidate) => candidate.index));
  const toKeep = allCandidates.filter((candidate) => !clearedIndexes.has(candidate.index));
  for (const candidate of toClear) {
    const message = messages[candidate.index];
    if (!message) continue;
    messages[candidate.index] = {
      ...message,
      content: buildClearedToolResultContent(candidate.pointer),
    };
  }

  const postTokenCount = estimateMessageTokens(messages);
  const tokensSaved = Math.max(0, estimatedTokenCount - postTokenCount);
  const minSavings = positiveInt(config.minTokenSavings) ?? DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS;
  if (tokensSaved < minSavings) {
    return {
      decision: { estimatedTokenCount, reason: "below_min_savings", thresholdTokens, trigger },
      messages: input.messages.map(cloneLocalMicrocompactMessage),
    };
  }

  return {
    decision: { estimatedTokenCount, reason: "applied", thresholdTokens, trigger },
    messages,
    payload: {
      clearedMessageCount: toClear.length,
      clearedToolCallIds: toClear.map((candidate) => candidate.toolCallId as ToolCallId),
      keptToolCallIds: toKeep.map((candidate) => candidate.toolCallId as ToolCallId),
      postMicrocompactTokenCount: postTokenCount,
      preMicrocompactTokenCount: estimatedTokenCount,
      strategy: MicrocompactStrategy.LocalToolResultClear,
      tokensSaved,
      trigger,
    },
  };
}

function resolveMicrocompactTrigger(input: {
  config: LocalMicrocompactPolicyConfig;
  estimatedTokenCount: number;
  lastAssistantCompletedAtMs?: number;
  nowMs?: number;
  thresholdTokens?: number;
}): MicrocompactTrigger | undefined {
  const idleThresholdMinutes =
    positiveInt(input.config.idleThresholdMinutes) ?? DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES;
  if (
    input.lastAssistantCompletedAtMs !== undefined &&
    Number.isFinite(input.lastAssistantCompletedAtMs)
  ) {
    const elapsedMs = (input.nowMs ?? Date.now()) - input.lastAssistantCompletedAtMs;
    if (elapsedMs > idleThresholdMinutes * 60_000) {
      return MicrocompactTrigger.TimeBased;
    }
  }

  if (input.thresholdTokens !== undefined && input.estimatedTokenCount >= input.thresholdTokens) {
    return MicrocompactTrigger.TokenPressure;
  }

  return undefined;
}

interface CompactableToolResultCollection {
  groups: ToolResultCandidate[][];
  clearedRefetchKeys: ReadonlySet<string>;
}

/**
 * 决定哪些候选项必须保留（永不清）——「断环」的全部逻辑就在这里。
 *
 * 判据是合取，缺一不可：
 *  1. 该重取目标**曾被清过**（`clearedRefetchKeys`）——证明「清掉它」已经造成过一次代价；
 *  2. 该目标在候选里**还有存活副本**——证明它确实还在被用（否则没有可清的东西，也无所谓 pin）。
 *
 * 只 pin 该 key 的**最新**一条。更早的副本照常清：与会话里「保留最新 N 条」方向一致，
 * 只保留一份即可断环，多留只吃窗口。
 *
 * 为什么必须带上条件 1（实证）：已清除的条目在收集阶段就被跳过（幂等），所以
 * 「一清除 + 一存活」这种循环样本在候选里**只剩 1 条**。单看「候选出现≥2 次」会漏掉它们。
 * 反过来，实测两个会话里有 15 个「同一目标读≥2 次但从未被清」的 key——那只是同一位置
 * 读了两次，没有循环，不该 pin（这一条正是 14.4 验收表里的第 2 行）。
 *
 * 成本：被 pin 的那一份会长期留在窗口里。反事实重放（两个长会话）显示被 pin 的目标仅
 * 15 个（4.2%/5.1%），但期末常驻多出 ~14K–16K token——**这不是省 token 的优化**，
 * 换掉的是循环中的重复工具往返。见 specs §14.2。
 */
function resolvePinnedRefetchIndexes(
  allCandidates: readonly ToolResultCandidate[],
  clearedRefetchKeys: ReadonlySet<string>,
): ReadonlySet<number> {
  const newestIndexByRefetchKey = new Map<string, number>();
  for (const candidate of allCandidates) {
    if (!candidate.refetchKey) continue;
    newestIndexByRefetchKey.set(candidate.refetchKey, candidate.index);
  }

  const pinned = new Set<number>();
  for (const [refetchKey, index] of newestIndexByRefetchKey) {
    if (clearedRefetchKeys.has(refetchKey)) pinned.add(index);
  }
  return pinned;
}

function collectCompactableToolResultGroups<T extends LocalMicrocompactMessage>(
  messages: readonly T[],
  config: LocalMicrocompactPolicyConfig,
): CompactableToolResultCollection {
  const compactableTools = new Set(
    config.compactableToolNames ?? DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS,
  );
  const clearErrorResults = config.clearErrorResults === true;
  const groups: ToolResultCandidate[][] = [];
  // 出现过「已被清除」标记的重取目标集合。与「候选里还有存活副本」合取构成 pin 判据。
  const clearedRefetchKeys = new Set<string>();
  // assistant 消息上的 toolCalls.input 是结构化参数，清除时据此生成重取指针。
  const inputsByToolCallId = new Map<string, unknown>();
  let currentGroup: ToolResultCandidate[] | undefined;

  const flushCurrentGroup = (): void => {
    if (currentGroup && currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    currentGroup = undefined;
  };

  messages.forEach((message, index) => {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        inputsByToolCallId.set(call.id, call.input);
      }
      flushCurrentGroup();
      currentGroup = [];
      return;
    }

    if (message.role !== "tool") return;
    if (!message.toolCallId || !message.toolName) return;
    if (!compactableTools.has(message.toolName)) return;
    if (message.isError && !clearErrorResults) return;
    const descriptor = buildRefetchDescriptor(
      message.toolName,
      inputsByToolCallId.get(message.toolCallId),
    );
    // 已清除的条目不再作为候选（幂等），但它的 key 要记下来：
    // 「这个目标已经被清过一次」是识别循环的必要条件（见 resolvePinnedRefetchIndexes）。
    if (isMicrocompactClearedToolResultContent(message.content)) {
      if (descriptor.refetchKey) clearedRefetchKeys.add(descriptor.refetchKey);
      return;
    }
    if (hasMediaToolResultContent(message.content)) return;
    const candidate: ToolResultCandidate = {
      index,
      toolCallId: message.toolCallId,
      ...descriptor,
    };

    if (!currentGroup) {
      groups.push([candidate]);
      return;
    }

    currentGroup.push(candidate);
  });

  flushCurrentGroup();
  return { groups, clearedRefetchKeys };
}

function buildClearedToolResultContent(pointer?: string): ModelMessageContent {
  if (!pointer) return MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE;
  return `${MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE}\n${pointer}`;
}

function isMicrocompactClearedToolResultContent(content: ModelMessageContent): boolean {
  // 清除后的内容现在可能带重取指针，用前缀判断保证幂等（不会二次清除）。
  return modelMessageContentToText(content).startsWith(MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX);
}

/**
 * 只读工具的结构化参数可以还原成一条精确的重取指令；Bash 等无结构化参数则不给指针。
 *
 * 同时给出 `refetchKey`：与指针同源、但规范化为「目标身份」（不因缺省 offset 而变化），
 * 供识别「同一目标被反复重取」。两者从一个地方产出，不会出现「能生成指针却算不出 key」的分叉。
 */
function buildRefetchDescriptor(
  toolName: string,
  input: unknown,
): { pointer?: string; refetchKey?: string } {
  if (!input || typeof input !== "object") return {};
  const args = input as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  if (toolName === "Read") {
    const filePath = str(args.file_path);
    if (!filePath) return {};
    const offset = num(args.offset);
    const limit = num(args.limit);
    const range =
      offset !== undefined || limit !== undefined
        ? ` offset=${offset ?? 1} limit=${limit ?? "-"}`
        : "";
    return {
      pointer: `Re-fetch with: Read(file_path="${filePath}"${range})`,
      // Read 省略 offset/limit 等价于「从第 1 行读默认长度」，与显式 offset=1 是同一目标：
      // 不归一化的话，「整文件读」与「offset=1 读」会被当成两个 key，pin 判不出来。
      refetchKey: `Read|${filePath}|${offset ?? 1}|${limit ?? "-"}`,
    };
  }
  if (toolName === "Grep") {
    const pattern = str(args.pattern);
    if (!pattern) return {};
    const path = str(args.path);
    return {
      pointer: `Re-fetch with: Grep(pattern="${pattern}"${path ? `, path="${path}"` : ""})`,
      refetchKey: `Grep|${pattern}|${path ?? "-"}`,
    };
  }
  if (toolName === "Glob") {
    const pattern = str(args.pattern);
    if (!pattern) return {};
    const path = str(args.path);
    return {
      pointer: `Re-fetch with: Glob(pattern="${pattern}"${path ? `, path="${path}"` : ""})`,
      refetchKey: `Glob|${pattern}|${path ?? "-"}`,
    };
  }
  return {};
}

function hasMediaToolResultContent(content: ModelMessageContent): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return false;
    // video 与 image/file 同为受保护媒体：Read 视频结果漏判会被 microcompact 清掉。
    return block.type === "image" || block.type === "video" || block.type === "file";
  });
}

function cloneLocalMicrocompactMessage<T extends LocalMicrocompactMessage>(message: T): T {
  return {
    ...message,
    content: cloneContent(message.content),
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
  };
}

function cloneContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if ("source" in block && block.source) {
      return { ...block, source: { ...block.source } };
    }
    if ("providerOptions" in block && block.providerOptions) {
      return { ...block, providerOptions: { ...block.providerOptions } };
    }
    return { ...block };
  }) as ModelMessageContent;
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
