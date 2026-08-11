import type { TerminalId } from "./types.ts";

export type TerminalClientMetric = "decode" | "modelCommit" | "paint";

export interface TerminalClientPerformanceStats {
  readonly decodeCount: number;
  readonly decodeMilliseconds: number;
  readonly modelCommitCount: number;
  readonly modelCommitMilliseconds: number;
  readonly paintCount: number;
  readonly paintMilliseconds: number;
}

interface MutableMetric {
  count: number;
  milliseconds: number;
}

interface MutableStats {
  decode: MutableMetric;
  modelCommit: MutableMetric;
  paint: MutableMetric;
}

const EMPTY = (): MutableMetric => ({ count: 0, milliseconds: 0 });
const terminalMetrics = new Map<TerminalId, MutableStats>();

function held(terminalId: TerminalId): MutableStats {
  const existing = terminalMetrics.get(terminalId);
  if (existing) return existing;
  const created = { decode: EMPTY(), modelCommit: EMPTY(), paint: EMPTY() };
  terminalMetrics.set(terminalId, created);
  return created;
}

/** Record observed client work. This reports facts and applies no threshold. */
export function recordTerminalClientMetric(
  terminalId: TerminalId,
  metric: TerminalClientMetric,
  milliseconds: number,
): void {
  const sample = held(terminalId)[metric];
  sample.count += 1;
  sample.milliseconds += milliseconds;
}

export function terminalClientPerformanceStats(
  terminalId: TerminalId,
): TerminalClientPerformanceStats {
  const stats = held(terminalId);
  return {
    decodeCount: stats.decode.count,
    decodeMilliseconds: stats.decode.milliseconds,
    modelCommitCount: stats.modelCommit.count,
    modelCommitMilliseconds: stats.modelCommit.milliseconds,
    paintCount: stats.paint.count,
    paintMilliseconds: stats.paint.milliseconds,
  };
}

export function forgetTerminalClientPerformanceStats(terminalId: TerminalId): void {
  terminalMetrics.delete(terminalId);
}
