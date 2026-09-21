import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AssistantTextRow,
  ConversationSnapshot,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";

const STREAM_WINDOW_MS = 4000;
const STREAM_TICK_MS = 1000;
const MAX_WINDOW_SAMPLES = 64;

export interface ComposerTurnStatsView {
  turnId: string;
  startedAt: number;
  streaming: boolean;
  firstTokenMs: number | null;
  outTokens: number | null;
  tokensPerSecond: number | null;
}

interface TurnFact {
  turnId: string;
  startedAt: number;
  endedAt: number | null;
  running: boolean;
  firstTextAt: number | null;
  estimatedTextTokens: number;
}

interface WindowSample {
  at: number;
  tokens: number;
}

/** 回答文本的 token 估算：CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token（与历史补丁口径一致）。 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x20000 && code <= 0x3ffff)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

/** 4s 滑动窗口即时速度；窗口内无增长返回 null（由调用方保持最近值）。 */
export function resolveWindowTokensPerSecond(
  samples: readonly WindowSample[],
  now: number,
): number | null {
  const from = now - STREAM_WINDOW_MS;
  const inWindow = samples.filter((sample) => sample.at >= from);
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  if (!first || !last || last.at <= first.at) return null;
  const growth = last.tokens - first.tokens;
  if (growth <= 0) return null;
  return (growth * 1000) / (last.at - first.at);
}

/**
 * 展示模型选择：精确用量基线缺失（历史轮）只给时间/首 token；
 * 流式中 out 取精确差值与文本估算的较大者、速度取窗口值或保持值；
 * 结束后 out 用精确差值、速度用首文本到轮结束的解码窗口。
 */
export function resolveTurnStatsDisplay(params: {
  streaming: boolean;
  exactOutTokens: number | null;
  estimatedOutTokens: number;
  windowTokensPerSecond: number | null;
  heldTokensPerSecond: number | null;
  endedAt: number | null;
  firstTextAt: number | null;
}): { outTokens: number | null; tokensPerSecond: number | null } {
  if (params.exactOutTokens === null) {
    return { outTokens: null, tokensPerSecond: null };
  }
  if (params.streaming) {
    return {
      outTokens: Math.max(params.exactOutTokens, params.estimatedOutTokens),
      tokensPerSecond: params.windowTokensPerSecond ?? params.heldTokensPerSecond,
    };
  }
  const { exactOutTokens, endedAt, firstTextAt } = params;
  const tokensPerSecond =
    firstTextAt !== null && endedAt !== null && endedAt > firstTextAt && exactOutTokens > 0
      ? (exactOutTokens * 1000) / (endedAt - firstTextAt)
      : null;
  return { outTokens: exactOutTokens, tokensPerSecond };
}

function selectLatestTurnFact(snapshot: ConversationSnapshot | null): TurnFact | null {
  const rows = snapshot?.rows.window ?? [];
  let header: TurnHeaderRow | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "turnHeader") {
      header = row;
      break;
    }
  }
  if (!header) return null;
  const textRows: AssistantTextRow[] = [];
  for (const row of rows) {
    if (row.kind === "assistantText" && row.turnId === header.turnId) textRows.push(row);
  }
  let firstTextAt: number | null = null;
  let estimatedTextTokens = 0;
  for (const row of textRows) {
    if (row.text.length > 0 && (firstTextAt === null || row.createdAt < firstTextAt)) {
      firstTextAt = row.createdAt;
    }
    estimatedTextTokens += estimateTextTokens(row.text);
  }
  return {
    turnId: header.turnId,
    startedAt: header.startedAt,
    endedAt: header.endedAt ?? null,
    running: header.state === "running",
    firstTextAt,
    estimatedTextTokens,
  };
}

/**
 * 从会话投影 snapshot 派生最新一轮的生成指标。精确 out 取 cumulative.outputTokens
 * 在轮次边界的差值（轮开始于挂载之后才记基线；挂载前已开始的轮视为历史轮，无基线）。
 */
export function useComposerTurnStats(
  snapshot: ConversationSnapshot | null,
): ComposerTurnStatsView | null {
  const turn = useMemo(() => selectLatestTurnFact(snapshot), [snapshot]);
  const [mountedAt] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  const running = turn?.running ?? false;

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), STREAM_TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  const cumulativeOutput = snapshot?.usage.cumulative.outputTokens ?? 0;
  // render-phase 派生：轮次变化时冻结基线，同轮重复渲染不再改写（幂等）。
  const [baseline, setBaseline] = useState<{ turnId: string; outputTokens: number | null } | null>(
    null,
  );
  if (turn && baseline?.turnId !== turn.turnId) {
    setBaseline({
      turnId: turn.turnId,
      outputTokens: turn.startedAt >= mountedAt ? cumulativeOutput : null,
    });
  }
  const exactOut =
    turn && baseline?.turnId === turn.turnId && baseline.outputTokens !== null
      ? Math.max(0, cumulativeOutput - baseline.outputTokens)
      : null;

  const estimatedOut = turn?.estimatedTextTokens ?? 0;
  const samplesRef = useRef<WindowSample[]>([]);
  const heldSpeedRef = useRef<number | null>(null);
  useEffect(() => {
    samplesRef.current = [];
    heldSpeedRef.current = null;
  }, [turn?.turnId]);
  useEffect(() => {
    if (!running) return;
    const at = Date.now();
    const samples = samplesRef.current;
    samples.push({ at, tokens: estimatedOut });
    if (samples.length > MAX_WINDOW_SAMPLES) samples.splice(0, samples.length - MAX_WINDOW_SAMPLES);
    const speed = resolveWindowTokensPerSecond(samples, at);
    if (speed !== null) heldSpeedRef.current = speed;
  }, [estimatedOut, running, tick, turn?.turnId]);

  if (!turn) return null;
  const windowSpeed = running ? resolveWindowTokensPerSecond(samplesRef.current, Date.now()) : null;
  const display = resolveTurnStatsDisplay({
    streaming: turn.running,
    exactOutTokens: exactOut,
    estimatedOutTokens: estimatedOut,
    windowTokensPerSecond: windowSpeed,
    heldTokensPerSecond: heldSpeedRef.current,
    endedAt: turn.endedAt,
    firstTextAt: turn.firstTextAt,
  });
  return {
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    streaming: turn.running,
    firstTokenMs: turn.firstTextAt !== null ? Math.max(0, turn.firstTextAt - turn.startedAt) : null,
    outTokens: display.outTokens,
    tokensPerSecond: display.tokensPerSecond,
  };
}
