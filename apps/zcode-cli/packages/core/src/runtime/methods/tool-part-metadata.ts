import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  type CompletedToolPartMetadata,
  type ToolExecutionResult,
} from "../deps.js";
import { createMcpToolDisplay } from "../../tool/executor/result-display.js";

export function mcpToolPartMetadata(
  presentation:
    | { serverName: string; toolName: string; description?: string }
    | undefined,
): CompletedToolPartMetadata | undefined {
  const display = createMcpToolDisplay(presentation);
  return display
    ? { schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION, display }
    : undefined;
}

export function completedToolPartMetadata(
  result: ToolExecutionResult,
): CompletedToolPartMetadata {
  const serialization = result.serialization
    ? {
        truncated: result.serialization.truncated,
        originalBytes: result.serialization.originalBytes,
        returnedBytes: result.serialization.returnedBytes,
        budgetStrategy: result.serialization.budgetStrategy,
        ...(result.serialization.artifactPath
          ? { artifactPath: result.serialization.artifactPath }
          : {}),
      }
    : undefined;
  return {
    schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
    ...(result.display ? { display: result.display } : {}),
    ...(serialization ? { serialization } : {}),
    ...readFileStateMetadataField(result),
  };
}

/**
 * 读状态与调用成功与否无关：失败路径同样要落盘。
 *
 * 单独抽出来是因为两个分支共用它——completed 部件与 error 部件都可能是读状态的
 * 产生者（`EditAnchored` 的 stale 拒绝会并 served，见 reject-and-serve）。
 *
 * resume 需要恢复模型当时真实读到的文件快照；只依赖 tool_result 文本会把主路径
 * 绑死在 provider 展示格式上，所以新 session 结构化持久化 read-state。
 */
export function readFileStateMetadataField(
  result: ToolExecutionResult,
): Pick<CompletedToolPartMetadata, "readFileState"> | Record<string, never> {
  return result.readFileStateMetadata ? { readFileState: result.readFileStateMetadata } : {};
}
