/**
 * Runs scenarios and reports what happened, as NDJSON.
 *
 * No browser appears below. The runner's own contract — every scenario is
 * reported exactly once, a throwing scenario is a failure rather than the end
 * of the run, and host memory brackets each scenario — is provable in the
 * `node --test` lane against fakes, and is.
 */

import type {
  ScenarioRecord,
  ScenarioRunnerPorts,
  ScenarioStatus,
  TerminalScenario,
} from "./scenarioContract.ts";

export interface ScenarioRunSummary {
  runId: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/**
 * Run every scenario in order, in one process, reporting as it goes.
 *
 * Sequential on purpose: these scenarios measure frames and memory, and two of
 * them running at once would measure each other.
 */
export async function runScenarios(
  runId: string,
  scenarios: readonly TerminalScenario[],
  ports: ScenarioRunnerPorts,
): Promise<ScenarioRunSummary> {
  const startedAt = ports.now();
  ports.emit({ kind: "run-begin", runId, scenarios: scenarios.length });

  const totals: Record<ScenarioStatus, number> = { passed: 0, failed: 0, skipped: 0 };

  for (const scenario of scenarios) {
    const outcome = await runOne(scenario, ports);
    totals[outcome] += 1;
  }

  const summary: ScenarioRunSummary = {
    runId,
    passed: totals.passed,
    failed: totals.failed,
    skipped: totals.skipped,
    durationMs: ports.now() - startedAt,
  };
  ports.emit({ kind: "run-end", ...summary });
  return summary;
}

async function runOne(
  scenario: TerminalScenario,
  ports: ScenarioRunnerPorts,
): Promise<ScenarioStatus> {
  const openedAt = ports.now();
  ports.emit({
    kind: "scenario-begin",
    id: scenario.id,
    atMs: openedAt,
    hostMemoryBytes: await sampleQuietly(ports),
  });

  const emitEnd = async (status: ScenarioStatus, detail?: string): Promise<ScenarioStatus> => {
    const record: ScenarioRecord = {
      kind: "scenario-end",
      id: scenario.id,
      status,
      durationMs: ports.now() - openedAt,
      hostMemoryBytes: await sampleQuietly(ports),
    };
    ports.emit(detail === undefined ? record : { ...record, detail });
    return status;
  };

  try {
    const outcome = await scenario.run({
      now: () => ports.now(),
      measure: (name, value, unit) => {
        ports.emit({ kind: "measurement", id: scenario.id, name, value, unit });
      },
      frameDeltas: (count) => ports.frameDeltas(count),
    });
    return await emitEnd(outcome.status, outcome.detail);
  } catch (error) {
    // A scenario that throws is one result, not the end of the run: the
    // scenarios after it carry facts of their own, and a packaged run that
    // stops at the first failure reports the least when it matters most.
    return await emitEnd("failed", describe(error));
  }
}

/**
 * A memory sample is context, not a result. If the host cannot answer, the
 * scenario still reports; a failed sample must not fail the scenario.
 */
async function sampleQuietly(ports: ScenarioRunnerPorts): Promise<number | null> {
  try {
    return await ports.sampleHostMemory();
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
