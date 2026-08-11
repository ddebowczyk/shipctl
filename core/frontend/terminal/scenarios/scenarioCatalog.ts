/**
 * The scenarios themselves.
 *
 * Each is a plain async function over {@link TerminalSurfaceProbe}. Nothing
 * here imports xterm, a DOM, or a renderer: the probe is the seam, and the
 * browser binding in "./browserScenarioPorts.ts" is the only place that knows
 * what really answers it. That is what lets these run in the `node --test` lane
 * against fakes while the same code runs in the packaged webview against the
 * real surface.
 *
 * Every scenario id here must be claimed by an entry in
 * "./capabilityRegister.ts". A scenario nothing claims is a demo, and
 * "../tests/terminalCapabilityRegister.test.ts" rejects it.
 */

import type { ScenarioContext, ScenarioOutcome, TerminalScenario } from "./scenarioContract.ts";

/**
 * What a scenario may ask of the live terminal.
 *
 * Deliberately small and deliberately semantic. A probe that exposed the
 * renderer, the buffer, or an element would let a scenario answer a
 * presentation question directly, which is the authority leak the harness
 * exists to disprove.
 */
export interface TerminalSurfaceProbe {
  /**
   * Force the primary renderer to lose its GPU context.
   *
   * Returns false where the platform offers no way to do it, which is a skip
   * rather than a failure: the scenario cannot run, and pretending it passed
   * would be worse than saying so.
   */
  loseGpuContext(): boolean;
  /** Whether the surface still presents rows to a reader. */
  surfaceUsable(): boolean;
  /**
   * Whether a second terminal model exists — an xterm instance standing in for
   * the painter after a failure. Criterion 7 fails if this is ever true.
   */
  secondModelPresent(): boolean;
  /** Deliver output to the terminal, as the child would. */
  writeOutput(text: string): Promise<void>;
  /** Rows the surface currently holds, including scrollback. */
  bufferRows(): number;
  /** Resize the surface. */
  resize(columns: number, rows: number): Promise<void>;
}

/** Lines written by the sustained-output scenario. */
const SUSTAINED_OUTPUT_LINES = 2_000;

/** Frames sampled while measuring. Enough to see a stall, short enough to end. */
const SAMPLED_FRAMES = 120;

function scenario(
  id: string,
  description: string,
  proves: readonly string[],
  run: (context: ScenarioContext) => Promise<ScenarioOutcome>,
): TerminalScenario {
  return { id, description, proves, run };
}

export function createTerminalScenarios(
  probe: TerminalSurfaceProbe,
): readonly TerminalScenario[] {
  return [
    scenario(
      "renderer.gpu-loss",
      "The terminal survives losing its GPU context, without a second model.",
      ["renderer.gpu-loss-fallback"],
      async (context) => {
        const rowsBefore = probe.bufferRows();
        if (!probe.loseGpuContext()) {
          return {
            status: "skipped",
            detail: "the platform exposes no way to drop the GPU context",
          };
        }

        // Give the compositor frames to present the fallback in. A surface that
        // recovers on the next frame and one that never recovers are only
        // distinguishable after waiting.
        const deltas = await context.frameDeltas(SAMPLED_FRAMES);
        context.measure("frames.after-loss", deltas.length, "count");
        context.measure("frames.slowest", Math.max(0, ...deltas), "ms");

        if (probe.secondModelPresent()) {
          return {
            status: "failed",
            detail: "a second terminal model appeared after renderer failure",
          };
        }
        if (!probe.surfaceUsable()) {
          return { status: "failed", detail: "the surface is blank after renderer failure" };
        }

        const rowsAfter = probe.bufferRows();
        context.measure("buffer.rows-delta", rowsAfter - rowsBefore, "count");
        return rowsAfter >= rowsBefore
          ? { status: "passed" }
          : { status: "failed", detail: `buffer shrank from ${rowsBefore} to ${rowsAfter} rows` };
      },
    ),

    scenario(
      "measure.sustained-output",
      "Sustained output, measured in the packaged app rather than estimated.",
      ["measure.sustained-output"],
      async (context) => {
        const startedAt = context.now();
        const framesPromise = context.frameDeltas(SAMPLED_FRAMES);

        for (let line = 0; line < SUSTAINED_OUTPUT_LINES; line += 1) {
          await probe.writeOutput(`sustained output line ${line}\r\n`);
        }
        const writeMs = context.now() - startedAt;
        context.measure("output.write", writeMs, "ms");
        context.measure("output.lines", SUSTAINED_OUTPUT_LINES, "count");
        if (writeMs > 0) {
          context.measure("output.rate", (SUSTAINED_OUTPUT_LINES / writeMs) * 1_000, "hz");
        }

        const deltas = await framesPromise;
        if (deltas.length > 0) {
          const total = deltas.reduce((sum, delta) => sum + delta, 0);
          context.measure("frames.mean", total / deltas.length, "ms");
          context.measure("frames.slowest", Math.max(...deltas), "ms");
        }

        const resizeStartedAt = context.now();
        await probe.resize(100, 30);
        await probe.resize(80, 24);
        context.measure("resize.round-trip", context.now() - resizeStartedAt, "ms");

        // No threshold is applied. Area 04 requires measurements to cite an
        // authority, and no recorded product requirement or technical contract
        // sets a frame or throughput budget for this app. The numbers are
        // reported; turning one into a gate is an owner's decision.
        return { status: "passed" };
      },
    ),
  ];
}
