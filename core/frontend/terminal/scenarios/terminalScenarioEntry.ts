/**
 * The dev-only way in.
 *
 * A scenario harness that ships is a new permanent surface, and area 05
 * completes on deletion plus durable negative proof. Trading a second VT for a
 * second entry point is not a cutover, so this file exists to make the entry
 * conditional and to make that condition checkable.
 *
 * The guard in {@link installTerminalScenarioHarness} is written as a bare
 * `import.meta.env.DEV` test on purpose. Vite replaces that expression with a
 * literal at build time, so a release build sees `if (!false) return false`,
 * and Rollup drops everything after it — including the dynamic import of the
 * module that touches the live terminal. Wrapping the same check in a function
 * call would defeat that: the bundler cannot fold through a call, and the
 * harness would ship. `ops/check/bin/check-release-bundle.mjs` asserts the
 * outcome rather than trusting the reasoning.
 */

/** The global the harness installs under. Named once, for the release check. */
export const TERMINAL_SCENARIO_GLOBAL = "__shipctlTerminalScenarios";

/** What the harness exposes when it is installed. */
export interface TerminalScenarioHarness {
  /** Run the catalog against a terminal and resolve with the NDJSON transcript. */
  run(terminalId: string, runId?: string): Promise<string>;
}

/** Loads the composition root that binds the real surface. */
export type ScenarioHostLoader = () => Promise<{
  runTerminalScenarios(
    terminalId: never,
    runId: string,
  ): Promise<{ ndjson: string }>;
}>;

/** Whether a build may install the harness at all. */
export function scenarioHarnessAllowed(env: { DEV?: boolean } | undefined): boolean {
  return env?.DEV === true;
}

/**
 * Install the harness onto a target object.
 *
 * Separated from the build-time guard so the installation itself — what is
 * exposed, under which name, and that a disallowed build installs nothing — is
 * provable in the `node --test` lane, where `import.meta.env` does not exist.
 */
export function installScenarioHarnessInto(
  target: Record<string, unknown>,
  allowed: boolean,
  load: ScenarioHostLoader,
  clock: () => number = () => Date.now(),
): boolean {
  if (!allowed) return false;

  const harness: TerminalScenarioHarness = {
    run: async (terminalId, runId = `run-${clock()}`) => {
      const { runTerminalScenarios } = await load();
      const result = await runTerminalScenarios(terminalId as never, runId);
      return result.ndjson;
    },
  };

  target[TERMINAL_SCENARIO_GLOBAL] = harness;
  return true;
}

/**
 * Install the harness in a dev build, and do nothing otherwise.
 *
 * Returns whether it installed, so a caller can tell the two apart without
 * reading the global.
 */
export function installTerminalScenarioHarness(): boolean {
  // Bare and direct: this is the expression the bundler folds. See the note at
  // the top of the file before changing its shape.
  if (!import.meta.env.DEV) return false;

  return installScenarioHarnessInto(
    globalThis as unknown as Record<string, unknown>,
    true,
    () => import("../terminalScenarioHost.ts"),
  );
}
