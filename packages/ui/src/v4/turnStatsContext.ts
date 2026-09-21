import { createContext, useContext } from "react";
import type { V4ConversationTurnUsageRow } from "@zcode/shared/zcode-protocol-v4";

/** 每个 timeline 一份逐轮统计 map；行级胶囊按 turnId 取数，避免每行各自轮询。 */
export const TurnStatsContext = createContext<Record<string, V4ConversationTurnUsageRow>>({});

export function useTurnStatsMap(): Record<string, V4ConversationTurnUsageRow> {
  return useContext(TurnStatsContext);
}
