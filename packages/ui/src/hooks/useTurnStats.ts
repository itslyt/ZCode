import { useEffect, useState } from "react";
import type { V4ConversationTurnUsageRow } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";

const REFRESH_INTERVAL_MS = 1000;

/**
 * 逐轮用量/时长统计（turnId → 聚合行）：DB 权威值，1s 轮询。
 * 查询失败保留旧值；切会话由 scopeKey 挡旧结果。
 */
export function useTurnStats({
  workspacePath,
  workspaceIdentity,
  sessionId,
  enabled = true,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled?: boolean;
}): Record<string, V4ConversationTurnUsageRow> {
  const { zcodeAgentService } = useServices();
  const scopeKey = JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId]);
  const [result, setResult] = useState<{
    key: string;
    service: typeof zcodeAgentService;
    data: Record<string, V4ConversationTurnUsageRow>;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const data = await zcodeAgentService.getConversationTurnUsage({
          workspacePath,
          workspaceIdentity,
          sessionId,
        });
        const map: Record<string, V4ConversationTurnUsageRow> = {};
        for (const turn of data.turns) map[turn.turnId] = turn;
        if (!disposed) setResult({ key: scopeKey, service: zcodeAgentService, data: map });
      } catch {
        // 保留旧值等下一拍重试。
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
  return current?.data ?? {};
}
