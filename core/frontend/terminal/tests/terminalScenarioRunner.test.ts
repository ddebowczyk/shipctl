/**
 * The runner reports every scenario exactly once, whatever they do.
 *
 * The packaged run is the only place some area-04 facts can be observed, so a
 * harness that loses a result, stops at the first failure, or lets a memory
 * sample take the run down destroys the evidence it exists to collect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatScenarioRecord,
  type ScenarioRecord,
  type ScenarioRunnerPorts,
  type TerminalScenario,
} from "../scenarios/scenarioContract.ts";
import { runScenarios } from "../scenarios/scenarioRunner.ts";

class Harness {
  readonly records: ScenarioRecord[] = [];
  readonly ports: ScenarioRunnerPorts;

  /** What the host answers when asked for memory. */
  memory: number | null | "throw" = 1_000;

  #clock = 0;

  constructor() {
    this.ports = {
      // Every read advances the clock by a millisecond, so durations are
      // deterministic and non-zero without any wall-clock waiting.
      now: () => (this.#clock += 1),
      emit: (record) => this.records.push(record),
      sampleHostMemory: () => {
        if (this.memory === "throw") return Promise.reject(new Error("host unreachable"));
        return Promise.resolve(this.memory);
      },
      frameDeltas: (count) => Promise.resolve(Array.from({ length: count }, () => 16)),
    };
  }

  kinds(): string[] {
    return this.records.map((record) => record.kind);
  }

  find<K extends ScenarioRecord["kind"]>(
    kind: K,
    id?: string,
  ): Extract<ScenarioRecord, { kind: K }>[] {
    return this.records.filter(
      (record): record is Extract<ScenarioRecord, { kind: K }> =>
        record.kind === kind && (id === undefined || (record as { id?: string }).id === id),
    );
  }
}

function scenario(
  id: string,
  run: TerminalScenario["run"],
  proves: readonly string[] = ["x"],
): TerminalScenario {
  return { id, description: id, proves, run };
}

test("a run brackets every scenario and summarises once", async () => {
  const harness = new Harness();

  const summary = await runScenarios(
    "run-1",
    [
      scenario("a", () => Promise.resolve({ status: "passed" })),
      scenario("b", () => Promise.resolve({ status: "skipped", detail: "no GPU" })),
    ],
    harness.ports,
  );

  assert.deepEqual(harness.kinds(), [
    "run-begin",
    "scenario-begin",
    "scenario-end",
    "scenario-begin",
    "scenario-end",
    "run-end",
  ]);
  assert.deepEqual(
    { passed: summary.passed, failed: summary.failed, skipped: summary.skipped },
    { passed: 1, failed: 0, skipped: 1 },
  );
  assert.equal(harness.find("scenario-end", "b")[0]?.detail, "no GPU");
});

test("a throwing scenario is one failure, not the end of the run", async () => {
  const harness = new Harness();

  const summary = await runScenarios(
    "run-2",
    [
      scenario("boom", () => Promise.reject(new Error("context lost"))),
      scenario("after", () => Promise.resolve({ status: "passed" })),
    ],
    harness.ports,
  );

  const failure = harness.find("scenario-end", "boom")[0];
  assert.equal(failure?.status, "failed");
  assert.match(failure?.detail ?? "", /context lost/);
  assert.equal(
    summary.passed,
    1,
    "the scenarios after a failure still run: a packaged run that stops at the " +
      "first failure reports least when it matters most",
  );
});

test("host memory brackets each scenario and never comes from the page", async () => {
  const harness = new Harness();
  harness.memory = 4_096;

  await runScenarios(
    "run-3",
    [scenario("a", () => Promise.resolve({ status: "passed" }))],
    harness.ports,
  );

  assert.equal(harness.find("scenario-begin", "a")[0]?.hostMemoryBytes, 4_096);
  assert.equal(harness.find("scenario-end", "a")[0]?.hostMemoryBytes, 4_096);

  // The page has no business reporting process memory: WebKit exposes no
  // performance.memory, so a number invented here would be worse than none.
  const measurements = harness.find("measurement");
  assert.deepEqual(
    measurements.filter((record) => record.unit === "bytes"),
    [],
    "no scenario reports bytes from the webview",
  );
});

test("an unavailable host memory sample does not fail the scenario", async () => {
  const harness = new Harness();
  harness.memory = "throw";

  const summary = await runScenarios(
    "run-4",
    [scenario("a", () => Promise.resolve({ status: "passed" }))],
    harness.ports,
  );

  assert.equal(summary.passed, 1, "memory is context, not a result");
  assert.equal(harness.find("scenario-begin", "a")[0]?.hostMemoryBytes, null);
  assert.equal(harness.find("scenario-end", "a")[0]?.hostMemoryBytes, null);
});

test("measurements are attributed to the scenario that took them", async () => {
  const harness = new Harness();

  await runScenarios(
    "run-5",
    [
      scenario("a", async (context) => {
        context.measure("frames.mean", 16.7, "ms");
        const deltas = await context.frameDeltas(3);
        context.measure("frames.sampled", deltas.length, "count");
        return { status: "passed" };
      }),
    ],
    harness.ports,
  );

  assert.deepEqual(
    harness.find("measurement").map((record) => `${record.id}:${record.name}=${record.value}`),
    ["a:frames.mean=16.7", "a:frames.sampled=3"],
  );
});

test("records are one line of NDJSON each", async () => {
  const harness = new Harness();
  await runScenarios(
    "run-6",
    [scenario("a", () => Promise.resolve({ status: "passed" }))],
    harness.ports,
  );

  for (const record of harness.records) {
    const line = formatScenarioRecord(record);
    assert.ok(!line.includes("\n"), "a record never spans lines");
    assert.deepEqual(JSON.parse(line), record, "and round-trips");
  }
});
