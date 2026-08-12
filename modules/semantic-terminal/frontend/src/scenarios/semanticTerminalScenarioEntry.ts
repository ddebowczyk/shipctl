/** Development-only entry for the packaged semantic scenario harness. */

/** The global the harness installs under. Named once for the release check. */
export const TERMINAL_SCENARIO_GLOBAL = "__shipctlTerminalScenarios";

export interface TerminalScenarioHarness {
  run(terminalId: string, runId?: string): Promise<string>;
}

export type ScenarioHostLoader = () => Promise<{
  runTerminalScenarios(terminalId: string, runId: string): Promise<{ ndjson: string }>;
}>;

export function scenarioHarnessAllowed(env: { DEV?: boolean } | undefined): boolean {
  return env?.DEV === true;
}

export function installScenarioHarnessInto(
  target: Record<string, unknown>,
  allowed: boolean,
  load: ScenarioHostLoader,
  clock: () => number = () => Date.now(),
): boolean {
  if (!allowed) return false;
  target[TERMINAL_SCENARIO_GLOBAL] = {
    run: async (terminalId: string, runId = `run-${clock()}`) => {
      const { runTerminalScenarios } = await load();
      return (await runTerminalScenarios(terminalId, runId)).ndjson;
    },
  } satisfies TerminalScenarioHarness;
  return true;
}

/**
 * Install only in a development build.
 *
 * Keep this bare `import.meta.env.DEV` test. Vite folds it for a release
 * build and removes the dynamic import with the harness. The release bundle
 * check proves that result.
 */
export function installSemanticTerminalScenarioHarness(): boolean {
  if (!import.meta.env.DEV) return false;
  return installScenarioHarnessInto(
    globalThis as unknown as Record<string, unknown>,
    true,
    () => import("./semanticTerminalScenarioHost.ts"),
  );
}
