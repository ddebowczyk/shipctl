/**
 * The harness installs in a dev build and nowhere else.
 *
 * The build-time half of that — that the bundler folds the guard away and drops
 * the harness from a release bundle — is not assertable here, because it is a
 * property of the bundle rather than of the source. It is checked for real by
 * `ops/check/bin/check-release-bundle.mjs`, which builds and scans. What is
 * assertable here is everything either side of that fold.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  installScenarioHarnessInto,
  scenarioHarnessAllowed,
  TERMINAL_SCENARIO_GLOBAL,
  type ScenarioHostLoader,
} from "../scenarios/terminalScenarioEntry.ts";

/** A loader that reports being asked and returns a fixed transcript. */
function loader(transcript: string): ScenarioHostLoader & { loads: number } {
  const fn = () => {
    fn.loads += 1;
    return Promise.resolve({
      runTerminalScenarios: () => Promise.resolve({ ndjson: transcript }),
    });
  };
  fn.loads = 0;
  return fn as ScenarioHostLoader & { loads: number };
}

test("only a dev build may install", () => {
  assert.equal(scenarioHarnessAllowed({ DEV: true }), true);
  assert.equal(scenarioHarnessAllowed({ DEV: false }), false);
  assert.equal(scenarioHarnessAllowed({}), false);
  assert.equal(
    scenarioHarnessAllowed(undefined),
    false,
    "a build with no env is not a dev build; absence is not permission",
  );
});

test("a disallowed build installs nothing and loads nothing", async () => {
  const target: Record<string, unknown> = {};
  const load = loader("");

  const installed = installScenarioHarnessInto(target, false, load);

  assert.equal(installed, false);
  assert.deepEqual(Object.keys(target), [], "the global stays clean");
  assert.equal(
    load.loads,
    0,
    "the module that drives a live terminal is never even loaded",
  );
});

test("a dev build exposes one named entry", async () => {
  const target: Record<string, unknown> = {};
  const load = loader('{"kind":"run-end"}');

  const installed = installScenarioHarnessInto(target, true, load, () => 7);

  assert.equal(installed, true);
  assert.deepEqual(
    Object.keys(target),
    [TERMINAL_SCENARIO_GLOBAL],
    "exactly one global, under the name the release check scans for",
  );
});

test("the live-terminal module is loaded on use, not on install", async () => {
  const target: Record<string, unknown> = {};
  const load = loader('{"kind":"run-end"}');

  installScenarioHarnessInto(target, true, load, () => 7);
  assert.equal(load.loads, 0, "installing costs nothing");

  const harness = target[TERMINAL_SCENARIO_GLOBAL] as {
    run(id: string): Promise<string>;
  };
  const ndjson = await harness.run("terminal-1");

  assert.equal(load.loads, 1);
  assert.equal(ndjson, '{"kind":"run-end"}', "the caller gets the transcript back");
});
