/**
 * What a packaged-app scenario is.
 *
 * Area 04 has facts that no unit lane can reach: whether a glyph fits the span
 * the host gave it, whether the surface survives a primary-renderer failure, and
 * what the app actually costs while output streams. They need real font
 * rasterization, a real graphics stack, and the packaged binary — so they run
 * inside the shipped webview and report from there, rather than being driven
 * from outside by a WebDriver the platform does not have.
 *
 * A scenario is therefore an ordinary async function with a narrow context. It
 * reaches the terminal only through the area-03 ports; `ops/modularity` enforces
 * that, which is what makes the harness evidence for the port's narrowness
 * rather than merely a convenient place to run code.
 *
 * ## What a scenario cannot prove
 *
 * A self-driven scenario proves that something ran, did not throw, and produced
 * the numbers recorded beside it. It does not prove the result looked right.
 * No scenario here can settle whether a combining mark landed on the correct
 * base glyph, whether a fallback font is legible, or whether a cursor is where
 * a reader would expect it. Those need a person, and the register marks them
 * `manual` for that reason.
 */

/** A scenario's stable name. Correlates page records with host samples. */
export type ScenarioId = string;

export type MeasurementUnit = "ms" | "bytes" | "count" | "hz";

export interface ScenarioMeasurement {
  name: string;
  value: number;
  unit: MeasurementUnit;
}

export type ScenarioStatus = "passed" | "failed" | "skipped";

export interface ScenarioOutcome {
  status: ScenarioStatus;
  /** Why, when the status is not `passed`. */
  detail?: string;
}

/** What a scenario may do while it runs. */
export interface ScenarioContext {
  /** Milliseconds since the run began. Monotonic. */
  now(): number;
  /** Record a number as it is taken. Emitted whether the scenario passes. */
  measure(name: string, value: number, unit: MeasurementUnit): void;
  /**
   * Deltas between the next `count` presented frames, in milliseconds.
   *
   * Frame timing is the one measurement the page can take for itself: it is
   * observed from the compositor rather than from the process. Memory is not
   * here on purpose — see {@link ScenarioRunnerPorts.sampleHostMemory}.
   */
  frameDeltas(count: number): Promise<number[]>;
}

export interface TerminalScenario {
  readonly id: ScenarioId;
  /**
   * The capability register entries this scenario stands as proof for.
   *
   * A scenario that proves nothing in the register is a demo, and the register
   * test rejects it.
   */
  readonly proves: readonly string[];
  readonly description: string;
  run(context: ScenarioContext): Promise<ScenarioOutcome>;
}

/**
 * One line of the run's NDJSON output.
 *
 * Host memory appears on the scenario boundaries rather than in a measurement,
 * because it is not the page's to report: WebKit exposes no `performance.memory`
 * — that API is Chrome's — and a number invented in the webview would be worse
 * than none. The host owns the process and samples it; the scenario id on these
 * records is what the two sides correlate on.
 */
export type ScenarioRecord =
  | { kind: "run-begin"; runId: string; scenarios: number }
  | { kind: "scenario-begin"; id: ScenarioId; atMs: number; hostMemoryBytes: number | null }
  | { kind: "measurement"; id: ScenarioId; name: string; value: number; unit: MeasurementUnit }
  | {
      kind: "scenario-end";
      id: ScenarioId;
      status: ScenarioStatus;
      detail?: string;
      durationMs: number;
      hostMemoryBytes: number | null;
    }
  | {
      kind: "run-end";
      runId: string;
      passed: number;
      failed: number;
      skipped: number;
      durationMs: number;
    };

export interface ScenarioRunnerPorts {
  /** Monotonic milliseconds. */
  now(): number;
  /** Take one NDJSON record. */
  emit(record: ScenarioRecord): void;
  /**
   * Resident bytes of the app process, from the host, or `null` where the host
   * cannot say. Never read from the webview.
   */
  sampleHostMemory(): Promise<number | null>;
  /** Deltas between the next `count` presented frames. */
  frameDeltas(count: number): Promise<number[]>;
}

/** Render one record as a line of NDJSON. */
export function formatScenarioRecord(record: ScenarioRecord): string {
  return JSON.stringify(record);
}
