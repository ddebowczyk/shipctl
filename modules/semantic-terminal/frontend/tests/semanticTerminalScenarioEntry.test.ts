import assert from "node:assert/strict";
import { test } from "node:test";

import {
  installScenarioHarnessInto,
  scenarioHarnessAllowed,
  TERMINAL_SCENARIO_GLOBAL,
  type ScenarioHostLoader,
} from "@shipctl/module-semantic-terminal";

function loader(transcript: string): ScenarioHostLoader & { loads: number } {
  const fn = () => {
    fn.loads += 1;
    return Promise.resolve({ runTerminalScenarios: () => Promise.resolve({ ndjson: transcript }) });
  };
  fn.loads = 0;
  return fn as ScenarioHostLoader & { loads: number };
}

test("only a development build may install the harness", () => {
  assert.equal(scenarioHarnessAllowed({ DEV: true }), true);
  assert.equal(scenarioHarnessAllowed({ DEV: false }), false);
  assert.equal(scenarioHarnessAllowed(undefined), false);
});

test("a disallowed build installs and loads nothing", () => {
  const target: Record<string, unknown> = {};
  const load = loader("");
  assert.equal(installScenarioHarnessInto(target, false, load), false);
  assert.deepEqual(Object.keys(target), []);
  assert.equal(load.loads, 0);
});

test("the named harness loads its live host only when run", async () => {
  const target: Record<string, unknown> = {};
  const load = loader('{"kind":"run-end"}');
  assert.equal(installScenarioHarnessInto(target, true, load, () => 7), true);
  assert.deepEqual(Object.keys(target), [TERMINAL_SCENARIO_GLOBAL]);
  assert.equal(load.loads, 0);
  const harness = target[TERMINAL_SCENARIO_GLOBAL] as TerminalScenarioHarness;
  assert.equal(await harness.run("terminal-1"), '{"kind":"run-end"}');
  assert.equal(load.loads, 1);
});

interface TerminalScenarioHarness {
  run(terminalId: string): Promise<string>;
}
