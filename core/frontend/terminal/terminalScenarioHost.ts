/**
 * The browser composition root for the packaged-app scenario harness.
 *
 * Everything the scenarios need that is not a plain function is bound here: the
 * clock, the frame source, the host's memory sampler, and the live terminal
 * they drive. `core/frontend/terminal/scenarios/` holds none of it, and
 * `ops/modularity` enforces that — which is the point. The claim the harness
 * makes is that the surface can be driven entirely through the port; a scenario
 * that could reach the renderer, the buffer or an element directly would prove
 * only that it ran.
 *
 * This file is imported from the dev-only entry in "./terminalScenarioEntry.ts"
 * and from nowhere else, so a release bundle carries neither.
 */

import { getMemoryStats } from "@shipctl/core/platform";
import { terminalCache, terminalPresentation } from "./terminalCache.ts";
import { TERMINAL_CLIENT_RUNTIME } from "./terminalClientRuntime.ts";
import {
  formatScenarioRecord,
  type ScenarioRecord,
  type ScenarioRunnerPorts,
} from "./scenarios/scenarioContract.ts";
import { createTerminalScenarios, type TerminalSurfaceProbe } from "./scenarios/scenarioCatalog.ts";
import { runScenarios, type ScenarioRunSummary } from "./scenarios/scenarioRunner.ts";
import type { TerminalId } from "./types.ts";

/**
 * Wait for `count` presented frames and report the gap between each.
 *
 * This is the one measurement the page may take for itself: it is observed from
 * the compositor rather than guessed from the process.
 */
function frameDeltas(count: number): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let previous = performance.now();
    let remaining = count;

    const tick = (): void => {
      const now = performance.now();
      deltas.push(now - previous);
      previous = now;
      remaining -= 1;
      if (remaining <= 0) {
        resolve(deltas);
        return;
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  });
}

/**
 * Resident bytes of the app process, from the host.
 *
 * WebKit exposes no `performance.memory` — that is Chrome's API — so this is
 * the only honest source, and it is the one the host already owns.
 */
async function sampleHostMemory(): Promise<number | null> {
  try {
    const stats = await getMemoryStats();
    return stats.app_rss;
  } catch {
    return null;
  }
}

/** One presented frame, so an answer is given after the compositor drew. */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * Drive a live terminal.
 *
 * The probe answers in the terminal's own terms. Where an answer needs the
 * renderer, it is read here and nowhere a scenario can reach.
 *
 * Both transports answer the same six questions, and the same terminal is on
 * exactly one of them: an engine in the cache is the byte path, a presentation
 * is the semantic one. Two of the answers are not the same measurement on both,
 * and a reader comparing transcripts has to know which:
 *
 * - `writeOutput` on the byte path resolves when this client's own parser
 *   consumed the text. There is no such call on the semantic path — the client
 *   cannot write to a screen the host owns — so the text is sent to the child,
 *   whose tty echoes it back through the host, the protocol and the model. That
 *   resolves when the host took the input, not when the frame carrying it was
 *   painted. What the two share is the frame sampling around the burst, which
 *   is the number that says whether the app stalled.
 * - `resize` on the byte path resizes a local buffer. On the semantic path the
 *   host owns the screen, so it is asked, and the round trip includes it.
 */
function createSurfaceProbe(terminalId: TerminalId): TerminalSurfaceProbe {
  const surface = () => terminalCache.get(terminalId)?.term;
  const presentation = () => terminalPresentation(terminalId);

  return {
    loseGpuContext: () => {
      // A WebGL surface can be told to drop its context. A DOM or canvas
      // renderer cannot, and the scenario reports that as a skip rather than
      // inventing a failure it did not observe.
      const canvas = document
        .querySelector(".terminal-surface canvas")
        ?.closest("canvas");
      const gl =
        canvas?.getContext("webgl2") ?? canvas?.getContext("webgl") ?? null;
      const lose = gl?.getExtension("WEBGL_lose_context");
      if (!lose) return false;
      lose.loseContext();
      return true;
    },

    // A surface still presenting rows has a live terminal with a buffer, or a
    // model with a screen in it. The reader's question — "does it look right" —
    // is not answerable here, and the register marks it manual for that reason.
    surfaceUsable: () => surface() !== undefined || presentation()?.model.state != null,

    secondModelPresent: () => {
      // Criterion 7's negative: exactly one terminal for this id. More than one
      // element bearing an xterm screen — or more than one canvas, which is the
      // semantic surface's whole presentation — means a fallback instantiated
      // its own rather than repainting the existing one.
      return (
        document.querySelectorAll(".terminal-surface .xterm-screen, .terminal-surface canvas")
          .length > 1
      );
    },

    writeOutput: async (text) => {
      const terminal = surface();
      if (terminal) {
        await new Promise<void>((resolve) => {
          terminal.write(text, () => resolve());
        });
        return;
      }
      if (!presentation()) return;
      // See the note above: the child produces the output, because the client
      // has no way to put anything on a screen the host owns — which is the
      // property this whole path exists to have.
      await TERMINAL_CLIENT_RUNTIME.input(terminalId, { kind: "text", text });
    },

    bufferRows: () => {
      const terminal = surface();
      if (terminal) return terminal.buffer.active.length;
      const state = presentation()?.model.state;
      return state ? state.screen.scrollbackRows + state.screen.rows : 0;
    },

    resize: async (columns, rows) => {
      const terminal = surface();
      if (terminal) {
        terminal.resize(columns, rows);
        await nextFrame();
        return;
      }
      const attachmentId = presentation()?.attachmentId() ?? null;
      if (!attachmentId) return;
      await TERMINAL_CLIENT_RUNTIME.resize(terminalId, attachmentId, columns, rows);
      await nextFrame();
    },
  };
}

export interface ScenarioRunResult extends ScenarioRunSummary {
  /** Every emitted record, in order, as NDJSON lines. */
  ndjson: string;
}

/**
 * Run the whole catalog against a live terminal and return the transcript.
 *
 * The records go to the console as they happen so a run that hangs still shows
 * what it reached, and are returned together so a caller can persist them.
 */
export async function runTerminalScenarios(
  terminalId: TerminalId,
  runId: string,
): Promise<ScenarioRunResult> {
  const lines: string[] = [];
  const ports: ScenarioRunnerPorts = {
    now: () => performance.now(),
    emit: (record: ScenarioRecord) => {
      const line = formatScenarioRecord(record);
      lines.push(line);
      console.log(line);
    },
    sampleHostMemory,
    frameDeltas,
  };

  const summary = await runScenarios(
    runId,
    createTerminalScenarios(createSurfaceProbe(terminalId)),
    ports,
  );
  return { ...summary, ndjson: lines.join("\n") };
}
