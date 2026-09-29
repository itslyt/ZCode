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
// 轮内保留量。依据（实测两个长会话，看 specs §16.0）：
//   一个用户轮的中位步数 = 10，keep=5 时 78~81% 的轮**在轮内就发生清除**；
//   keep=15 把这个比例降到 1%（仅 max=18 的长轮还会清）。
// 为什么不用「轮内完全不清」：microcompact 是 autocompact 前的缓冲区，
//   轮内不清会让本该回收的量直接撞 416K 阈值，把一次便宜的本地清除换成一次
//   完整 LLM 摘要调用（实测最长 115 s）且不可逆。
// 为什么跳轮就收回 5：跨轮后早先的结果对新问题基本无用，实测每轮可压量中位仅 1.6K token。
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS_IN_TURN = 15;
// pin 有效期（方案 4 = 近期性 ∧ 总量上限，见 specs §16.2）。
// 近期性 3 步：意图变了自然失效（窗口顺序即时间顺序，无需新增状态）。
// 总量 20K：实测每轮可压量 p99 = 20 042 / max 27 450，cap=20K 时仅 1.6~1.8% 的轮会回退。
export const DEFAULT_MICROCOMPACT_PIN_RECENCY_STEPS = 3;
export const DEFAULT_MICROCOMPACT_PIN_TOKEN_BUDGET = 20_000;
const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
// 提高至 2000 的依据：对 196 条真实 applied 事件模拟，阈值 256→2000 把清除**操作数**
// 从 332/931 降到 107/304（减约 1/3~1/9），而回收总量基本不变（重尾分布，
// 少数大事件贡献绝大多数回收量）。
//
// 注意适用边界：它只减少「隔多久清一次」，**在未启用重取 pin 时**不减少最终被销毁
// 的结果数（清空不可逆且每次清「除最新 N 条外全部」）——真正保住证据的是可压工具名单
// （见 DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS）。
// 启用 pin（见 resolvePinnedRefetchIndexes）后，被销毁的条数确实会减少（离线重放：少 15~28 条），
// 但**不要把它读成「pin 能省 token」**：反事实重放显示 pin 反而让期末常驻多出 ~14K~24K token
// （区间取自离线重放，随快照时刻漂移，见 specs §14.2）。
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
  /**
   * 同一用户轮内的保留条数。默认取 DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS_IN_TURN。
   *
   * 为什么轮内要比跳轮多留：`keepRecentToolResults` 的单位是 **model step**，
   * 而实测一个用户轮的中位步数是 10、max 18——keep=5 时 **78~81% 的轮在轮内就发生清除**，
   * 这正是「同一文件反复读」的根本来源。见 specs/context-compaction-optimization.md §16。
   */
  keepRecentToolResultsInTurn?: number;
  /** pin 的近期性约束：只在最近这么多 model step 内重取过时，pin 才生效。 */
  pinRecencySteps?: number;
  /** pin 的总量上限（估算 token）：所有生效 pin 合计超过它就不再新增 pin。 */
  pinTokenBudget?: number;
  /**
   * 当前 model step 序号（同一用户轮内从 0 递增）。
   *
   * 它是**轮边界信号**：0 = 轮首（turn-loop 里对应 `CompactPhase.PreRequest`，
   * 即上一轮已结束、用户刚提了新问题），>0 = 轮内（`MidTurn`）。
   *
   * 不用「窗口里有没有真实用户消息」判：交互式会话的窗口里那个消息**永远在**，
   * 该判据恒成立、无法表达「轮已结束」。
   * 缺省时视为不在轮内（即取跳轮保留量），保持旧的保守行为。
   */
  modelStepIndex?: number;
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
  /**
   * 观测字段（specs/context-compaction-optimization.md §16.3）。
   *
   * 放在 decision 而不是 payload：`nothing_to_clear`（含「pin 把全部候选都保住了」
   * 这种最该被观察的情形）不产生 payload，而调参需要的正是这种分布。
   */
  observation?: MicrocompactObservation;
}

/** 本轮 microcompact 的可观测事实：保留量与 pin 的规模、以及 pin 未生效的原因。 */
export interface MicrocompactObservation {
  keepRecentLimit: number;
  withinUserTurn: boolean;
  pinnedTargetCount: number;
  pinnedTokenCount: number;
  pinnedDroppedByRecency: number;
  pinnedDroppedByCap: number;
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
  /** 该结果的估算 token，供 pin 的总量上限核算。 */
  tokenCount: number;
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

  // 保留条数：轮内放大（温和版 B）。单位是 model step，而一个用户轮中位 10 步——
  // keep=5 时 78~81% 的轮在轮内就发生清除，这正是「反复读」的根源。见 specs §16.1。
  // 轮内放大（温和版 B）。轮边界用 modelStepIndex 判定（见该字段注释）：
  //   0 = 轮首（pre_request，上一轮已结束）→ 取旧的 5；>0 = 轮内 → 取 15。
  const stepIndex = config.modelStepIndex;
  const withinUserTurn = stepIndex !== undefined && stepIndex > 0;
  const keepCount = withinUserTurn
    ? (positiveInt(config.keepRecentToolResultsInTurn) ??
        DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS_IN_TURN)
    : (positiveInt(config.keepRecentToolResults) ?? DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS);
  const boundedKeepCount = Math.max(1, keepCount);
  const clearGroupCount = Math.max(0, candidateGroups.length - boundedKeepCount);
  // 观测对象先算出来，：它在「有东西可清」和「pin 全保住了」两条路径上都要上报。
  const observation = (pins: PinResolution): MicrocompactObservation => ({
    keepRecentLimit: boundedKeepCount,
    withinUserTurn,
    pinnedTargetCount: pins.indexes.size,
    pinnedTokenCount: pins.tokenCount,
    pinnedDroppedByRecency: pins.droppedByRecency,
    pinnedDroppedByCap: pins.droppedByCap,
  });
  const emptyPins: PinResolution = {
    indexes: new Set<number>(),
    tokenCount: 0,
    droppedByRecency: 0,
    droppedByCap: 0,
  };
  if (clearGroupCount === 0) {
    return {
      decision: {
        estimatedTokenCount,
        reason: "nothing_to_clear",
        thresholdTokens,
        trigger,
        observation: observation(emptyPins),
      },
      messages,
    };
  }

  // `allCandidates` 是全量候选（含最新 N 条），pin 的判定与排除都要在全量上做；
  // `clearRangeCandidates` 是「按旧规则应当清掉」的那批。
  const allCandidates = candidateGroups.flat();
  const clearRangeCandidates = candidateGroups.slice(0, clearGroupCount).flat();
  const pins = resolvePinnedRefetchIndexes({
    candidateGroups,
    clearedRefetchKeys: collection.clearedRefetchKeys,
    recencySteps: positiveInt(config.pinRecencySteps) ?? DEFAULT_MICROCOMPACT_PIN_RECENCY_STEPS,
    tokenBudget: positiveInt(config.pinTokenBudget) ?? DEFAULT_MICROCOMPACT_PIN_TOKEN_BUDGET,
  });

  const toClear = clearRangeCandidates.filter((candidate) => !pins.indexes.has(candidate.index));
  if (toClear.length === 0) {
    return {
      decision: {
        estimatedTokenCount,
        reason: "nothing_to_clear",
        thresholdTokens,
        trigger,
        observation: observation(pins),
      },
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
    decision: { estimatedTokenCount, reason: "applied", thresholdTokens, trigger, observation: observation(pins) },
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
      // 观测字段（§16.3）：与 decision.observation 同源；payload 侧一并落库，
      // 便于按会话回查 pin 的分布。
      ...observation(pins),
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
 * pin 的判定结果。除了「钉哪些」还要回报为何未钉，供调参（§16.3）。
 */
interface PinResolution {
  indexes: ReadonlySet<number>;
  tokenCount: number;
  droppedByRecency: number;
  droppedByCap: number;
}

/**
 * 决定哪些候选项必须保留（永不清）——「断环」的全部逻辑就在这里。
 *
 * 基础判据是合取，缺一不可：
 *  1. 该重取目标**曾被清过**（`clearedRefetchKeys`）——证明「清掉它」已经造成过一次代价；
 *  2. 该目标在候选里**还有存活副本**——证明它确实还在被用。
 *
 * 为什么必须带上条件 1（实证）：已清除的条目在收集阶段就被跳过（幂等），所以
 * 「一清除 + 一存活」这种循环样本在候选里**只剩 1 条**。单看「候选出现≥2 次」会漏掉它们。
 * 反过来，实测两个会话里有 15 个「同一目标读≥2 次但从未被清」的 key——那只是同一位置
 * 读了两次，没有循环，不该 pin。
 *
 * 在此基础上加**有效期**（方案 4 = 近期性 ∧ 总量上限，见 specs §16.2）：
 *  - 近期性：只在最近 `recencySteps` 个 model step 内出现过才 pin。
 *    窗口顺序就是时间顺序（候选按 step 分组后从新往旧遍历），**不需要新增状态**。
 *    效果是「续租」：模型持续重取就持续被 pin；一旦停了 recencySteps 步没再用，
 *    pin 自然失效——这正是「意图可能已经变了」要的行为。
 *  - 总量上限：所有生效 pin 的合计估算 token 不得超过 `tokenBudget`。
 *    没有它，一轮里重取多个大文件会把常驻推到 autocompact 阀值（实测两个会话常驻
 *    400K–530K、阀值 416K，而 pin 增量 +14K~24K），把一次便宜的本地清除换成
 *    一次完整 LLM 摘要调用。
 *
 * 两者是合取：近期性防不了总量（一轮内可重取多个大文件），总量防不了陈旧。
 * 预算不够时**优先保近期**（所以从新往旧遍历）。
 */
function resolvePinnedRefetchIndexes(input: {
  candidateGroups: readonly (readonly ToolResultCandidate[])[];
  clearedRefetchKeys: ReadonlySet<string>;
  recencySteps: number;
  tokenBudget: number;
}): PinResolution {
  const seenKeys = new Set<string>();
  const indexes = new Set<number>();
  let tokenCount = 0;
  let droppedByRecency = 0;
  let droppedByCap = 0;

  for (let stepFromEnd = 0; stepFromEnd < input.candidateGroups.length; stepFromEnd += 1) {
    const group = input.candidateGroups[input.candidateGroups.length - 1 - stepFromEnd]!;
    for (let index = group.length - 1; index >= 0; index -= 1) {
      const candidate = group[index]!;
      const key = candidate.refetchKey;
      if (!key) continue;
      // 同一 key 只看最新一条：更早的副本照常清（只保留一份即可断环，多留只吃窗口）。
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (!input.clearedRefetchKeys.has(key)) continue;
      if (stepFromEnd >= input.recencySteps) {
        droppedByRecency += 1;
        continue;
      }
      if (tokenCount + candidate.tokenCount > input.tokenBudget) {
        droppedByCap += 1;
        continue;
      }
      tokenCount += candidate.tokenCount;
      indexes.add(candidate.index);
    }
  }

  return { indexes, tokenCount, droppedByRecency, droppedByCap };
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
      // pin 的总量上限按被保留那一份的体积核算；与 estimateMessageTokens 同一估算口径。
      tokenCount: estimateMessageTokens([message]),
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
