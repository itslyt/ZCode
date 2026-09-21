import { useEffect, useState } from "react";
import type { V4ConversationUsageResult } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";

const REFRESH_INTERVAL_MS = 1000;

/**
 * 会话级用量/时长统计：DB 聚合权威值，按完成节拍 1s 轮询。
 * 查询失败保留旧值等下一拍重试，统计条不闪零。
 */
export function useSessionStats({
  workspacePath,
  workspaceIdentity,
  sessionId,
  enabled = true,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled?: boolean;
}): V4ConversationUsageResult | null {
  const { zcodeAgentService } = useServices();
  const scopeKey = JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId]);
  const [result, setResult] = useState<{
    key: string;
    service: typeof zcodeAgentService;
    data: V4ConversationUsageResult | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const data = await zcodeAgentService.getTaskTokenUsage({
          workspacePath,
          workspaceIdentity,
          sessionId,
        });
        if (!disposed) setResult({ key: scopeKey, service: zcodeAgentService, data });
      } catch {
        // 保留旧值；切会话后的旧结果由 scopeKey 挡掉，不会覆盖新会话。
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), REFRESH_INTERVAL_MS);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [enabled, scopeKey, sessionId, workspaceIdentity, workspacePath, zcodeAgentService]);

  const current = result?.key === scopeKey && result.service === zcodeAgentService ? result : null;
  return current?.data ?? null;
}
