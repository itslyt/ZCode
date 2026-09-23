import type {
  MessageId,
  MessagePart,
  MessageWithParts,
  ToolPart,
} from "@zcode/contracts";
import {
  parseReadFileStateMetadata,
  type PersistedReadFileStateTool,
} from "../tool/read-file-state-metadata.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../tool/read-file-state.js";
import type { ReadFileStateMap } from "../tool/types.js";
import { activeSessionMessages } from "./session-history-hydrator.js";

export interface ReadFileStateHydrationResult {
  restoredCount: number;
  skippedRangeReadCount: number;
  skippedUnreadableEditCount: number;
}

type CompletedToolPart = ToolPart & {
  state: ToolPart["state"] & {
    output: unknown;
    status: "completed";
  };
};

/**
 * 失败但已经写过读状态的部件。
 *
 * `EditAnchored` 的 stale / ambiguous 拒绝会回传当前锚点（reject-and-serve）并把它们并进
 * served，这次调用的「模型看过哪些行」因此变了。不带上的话，resume 后模型照抄错误信息里
 * 的锚点重发会撞 unserved——跨会话的 reject-and-serve 就断了。
 *
 * 恢复的判据是「部件带没带合法读状态」，**不是**工具名：`Write` / `Edit` 的 error 部件只要
 * 带了合法 metadata 也会恢复。这是有意保留的统一行为（读状态与调用成功与否无关，写不写由
 * handler 决定），不是「其它工具的失败件天然被跳过」。
 */
type FailedToolPart = ToolPart & {
  state: ToolPart["state"] & {
    error: string;
    status: "error";
  };
};

type ReadStateBearingToolPart = CompletedToolPart | FailedToolPart;

export async function hydrateReadFileStateFromSession(input: {
  branchCutAfterMessageId?: MessageId;
  messages: MessageWithParts[];
  readFileState: ReadFileStateMap;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<ReadFileStateHydrationResult> {
  input.readFileState.clear();
  const activeMessages = activeSessionMessages(input.messages, {
    branchCutAfterMessageId: input.branchCutAfterMessageId,
    includeCompactPreservedSegment: false,
    rewindCreatedMessageId: input.rewindCreatedMessageId,
    rewindKeptMessageIds: input.rewindKeptMessageIds,
    rewindTargetMessageId: input.rewindTargetMessageId,
  });

  const result: ReadFileStateHydrationResult = {
    restoredCount: 0,
    skippedRangeReadCount: 0,
    skippedUnreadableEditCount: 0,
  };

  for (const message of activeMessages) {
    if (message.info.role !== "assistant") continue;

    for (const part of dedupeParts(message.parts)) {
      if (!isReadStateBearingToolPart(part)) continue;

      if (part.tool === "Read") {
        const restored = restoreReadToolState(input, part, result);
        if (restored) result.restoredCount++;
        continue;
      }

      if (part.tool === "Write") {
        const restored = restoreMetadataToolState(input.readFileState, part, "Write");
        if (restored) result.restoredCount++;
        continue;
      }

      // EditAnchored 也写读状态（含 served 集合），resume 时必须一并恢复：它的部件名是
      // `EditAnchored`，只匹配 `Edit` 会让锚点编辑过的文件在 resume 后丢掉「已读」状态，
      // 之前建立的 served 集合归零，之后第一次锚点编辑大概率撞 unserved。
      const metadataTool = part.tool === "Edit" || part.tool === "EditAnchored" ? part.tool : null;
      if (metadataTool) {
        const restored = restoreMetadataToolState(input.readFileState, part, metadataTool);
        if (restored) result.restoredCount++;
      }
    }
  }

  return result;
}

function restoreReadToolState(
  input: {
    readFileState: ReadFileStateMap;
  },
  part: ReadStateBearingToolPart,
  result: ReadFileStateHydrationResult,
): boolean {
  const toolInput = asRecord(part.state.input);
  if (!toolInput) return false;
  if (!isHistoricalFullReadWindow(toolInput as HistoricalReadWindow)) {

    // 真正的 range Read 只在同一 runtime 内作为最新水位，跨 resume 不恢复。
    result.skippedRangeReadCount++;
    return false;
  }

  const metadata = parseReadFileStateMetadata(part.state.metadata);
  if (!metadata) return false;
  if (metadata.tool !== "Read") return false;
  if (!isHistoricalFullReadWindow(metadata)) {
    return false;
  }
  setFullReadState(input.readFileState, metadata.path, metadata.content, {
    // resume 不再从 provider-visible cat-n 文本恢复 Read 状态；只有带
    // mtimeMs/revisionId/sizeBytes 的结构化 metadata 才能支撑后续 stale guard。
    isPartialView: metadata.isPartialView,
    mtimeMs: normalizeReadFileStateMtimeMs(metadata.mtimeMs),
    readAt: new Date(metadata.readAtMs),
    revisionId: metadata.revisionId,
    sizeBytes: metadata.sizeBytes,
    servedAnchors: metadata.servedAnchors,
    sourceTool: metadata.tool,
  });
  return true;
}

function restoreMetadataToolState(
  readFileState: ReadFileStateMap,
  part: ReadStateBearingToolPart,
  expectedTool: PersistedReadFileStateTool,
): boolean {
  const metadata = parseReadFileStateMetadata(part.state.metadata);
  if (!metadata || metadata.tool !== expectedTool) return false;
  if (!isHistoricalFullReadWindow(metadata)) return false;

  // Write/Edit 的历史 tool part 不能在 resume 时读取当前磁盘来“补全”状态；
  // 外部手动保存会被误认证为 agent 已读。这里只恢复成功时持久化的完整快照。
  setFullReadState(readFileState, metadata.path, metadata.content, {
    isPartialView: metadata.isPartialView,
    mtimeMs: normalizeReadFileStateMtimeMs(metadata.mtimeMs),
    readAt: new Date(metadata.readAtMs),
    revisionId: metadata.revisionId,
    sizeBytes: metadata.sizeBytes,
    servedAnchors: metadata.servedAnchors,
    sourceTool: metadata.tool,
  });
  return true;
}

function setFullReadState(
  readFileState: ReadFileStateMap,
  filePath: string,
  content: string,
  metadata: {
    isPartialView?: boolean;
    mtimeMs?: number;
    readAt: Date;
    revisionId?: string;
    sizeBytes?: number;
    servedAnchors?: string[];
    sourceTool?: PersistedReadFileStateTool;
  },
): void {
  readFileState.set(createReadFileStateKey(filePath, 1, undefined), {
    path: filePath,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: metadata.isPartialView ?? false,
    readAt: metadata.readAt,
    sourceTool: metadata.sourceTool,
    revisionId: metadata.revisionId,
    mtimeMs: metadata.mtimeMs,
    sizeBytes: metadata.sizeBytes ?? Buffer.byteLength(content, "utf8"),
    servedAnchors: metadata.servedAnchors,
  });
}

interface HistoricalReadWindow {
  limit?: number;
  offset?: number;
}

function isHistoricalFullReadWindow({ offset, limit }: HistoricalReadWindow): boolean {
  return (offset ?? 1) <= 1 && limit === undefined;
}

function dedupeParts(parts: MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) {
    byId.set(part.id, part);
  }
  return [...byId.values()];
}

function isReadStateBearingToolPart(part: MessagePart): part is ReadStateBearingToolPart {
  if (part.type !== "tool") return false;
  if (part.state.status === "completed") return "output" in part.state;
  return part.state.status === "error" && "error" in part.state;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
