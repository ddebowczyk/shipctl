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

import {
  getMemoryStats,
  getTerminalPublicationStats,
  type TerminalPublicationStats,
} from "@shipctl/core/platform";
import { TerminalClientModel } from "./terminalClientModel.ts";
import { terminalCache, terminalPresentation, terminalSession } from "./terminalCache.ts";
import { TERMINAL_CLIENT_RUNTIME } from "./terminalClientRuntime.ts";
import {
  formatScenarioRecord,
  type ScenarioRecord,
  type ScenarioRunnerPorts,
} from "./scenarios/scenarioContract.ts";
import { createTerminalScenarios, type TerminalSurfaceProbe } from "./scenarios/scenarioCatalog.ts";
import { runScenarios, type ScenarioRunSummary } from "./scenarios/scenarioRunner.ts";
import type {
  TerminalAttachmentId,
  TerminalEvent,
  TerminalId,
} from "./types.ts";
import { terminalClientPerformanceStats } from "./terminalPerformanceMetrics.ts";

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

/** Wait for an actor observation without imposing a product timeout. */
async function waitForPublication(
  terminalId: TerminalId,
  accepts: (stats: TerminalPublicationStats) => boolean,
): Promise<TerminalPublicationStats> {
  for (;;) {
    const stats = await getTerminalPublicationStats(terminalId);
    if (accepts(stats)) return stats;
    await nextFrame();
  }
}

/** Send text through the semantic input contract and require live admission. */
async function sendScenarioText(terminalId: TerminalId, text: string): Promise<void> {
  const outcome = await TERMINAL_CLIENT_RUNTIME.input(terminalId, { kind: "text", text });
  if (outcome.status !== "accepted") {
    throw new Error(`The scenario terminal refused input: ${outcome.status}`);
  }
}

/**
 * Consume the primary view's one already-granted screen credit after conceal.
 *
 * The protocol permits one outstanding transaction per attachment. Conceal
 * stops the next credit; it cannot recall the credit the visible view already
 * granted. A single echoed glyph consumes that allowance and leaves one stable
 * transaction in flight. Measurements taken after this point can distinguish
 * bounded prior demand from new work done while hidden.
 */
async function parkPrimaryScreenCredit(
  terminalId: TerminalId,
): Promise<TerminalPublicationStats> {
  const before = await waitForPublication(
    terminalId,
    (stats) => stats.currentScreenTransactions === 0,
  );
  await sendScenarioText(terminalId, ".");
  return waitForPublication(
    terminalId,
    (stats) => stats.currentScreenTransactions > before.currentScreenTransactions,
  );
}

interface SemanticObserver {
  readonly attachmentId: TerminalAttachmentId;
  readonly baselineSequence: number;
  nextScreen(): Promise<number>;
  credit(sequence: number): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Add one real Tauri semantic reader that validates and commits every event.
 *
 * It does not auto-credit a screen. The scenario decides when a committed
 * frame permits the next one, which makes fanout and stalled-reader traces
 * observable without adding a second product surface.
 */
async function openSemanticObserver(terminalId: TerminalId): Promise<SemanticObserver> {
  const model = new TerminalClientModel();
  const waiting: Array<{ resolve(sequence: number): void; reject(error: Error): void }> = [];
  const screens: number[] = [];
  let failure: Error | null = null;

  const fail = (detail: string): void => {
    failure = new Error(detail);
    for (const waiter of waiting.splice(0)) waiter.reject(failure);
  };
  const onEvent = (event: TerminalEvent): void => {
    if (failure) return;
    if (event.event === "screen") {
      const outcome = model.applyScreen({
        sequence: event.sequence,
        revision: event.revision,
        state: event.state,
      });
      if (outcome.status !== "committed") {
        fail(`The observer refused a screen: ${outcome.detail}`);
        return;
      }
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(event.sequence);
      else screens.push(event.sequence);
      return;
    }
    if (event.event === "effects") {
      const outcome = model.applyEffects(event.effects);
      if (outcome.status !== "committed") fail(`The observer refused effects: ${outcome.detail}`);
    }
  };

  const lease = await TERMINAL_CLIENT_RUNTIME.attach(
    terminalId,
    false,
    onEvent,
    "semantic",
  );
  const state = lease.snapshot.state;
  if (state === null) {
    await TERMINAL_CLIENT_RUNTIME.detach(lease.attachmentId);
    model.dispose();
    throw new Error("The semantic observer received no baseline state");
  }
  const baseline = model.installBaseline({
    sequence: lease.snapshot.sequenceBoundary,
    revision: lease.snapshot.descriptor.revision,
    state,
  });
  if (baseline.status !== "committed") {
    await TERMINAL_CLIENT_RUNTIME.detach(lease.attachmentId);
    model.dispose();
    throw new Error(`The observer refused its baseline: ${baseline.detail}`);
  }
  lease.activate();
  await TERMINAL_CLIENT_RUNTIME.creditScreen(
    lease.attachmentId,
    lease.snapshot.sequenceBoundary,
  );

  return {
    attachmentId: lease.attachmentId,
    baselineSequence: lease.snapshot.sequenceBoundary,
    nextScreen: () => {
      if (failure) return Promise.reject(failure);
      const sequence = screens.shift();
      if (sequence !== undefined) return Promise.resolve(sequence);
      return new Promise<number>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    credit: (sequence) => TERMINAL_CLIENT_RUNTIME.creditScreen(lease.attachmentId, sequence),
    dispose: async () => {
      for (const waiter of waiting.splice(0)) {
        waiter.reject(new Error("The semantic observer was disposed"));
      }
      model.dispose();
      await TERMINAL_CLIENT_RUNTIME.detach(lease.attachmentId);
    },
  };
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
 * - `writeSustainedOutput` on the byte path resolves when this client's own
 *   parser consumed the generated lines. On the semantic path one short shell
 *   loop makes the child produce the same lines. One input request avoids
 *   measuring thousands of Tauri command round trips instead of the PTY output
 *   and publication path. It resolves when the host takes the command, not
 *   when the last frame is painted. What the two share is the frame sampling
 *   around the burst, which is the number that says whether the app stalled.
 * - `resize` on the byte path resizes a local buffer. On the semantic path the
 *   host owns the screen, so it is asked, and the round trip includes it.
 */
function createSurfaceProbe(terminalId: TerminalId): TerminalSurfaceProbe {
  const surface = () => terminalCache.get(terminalId)?.term;
  const presentation = () => terminalPresentation(terminalId);

  return {
    failPrimaryRenderer: () => presentation()?.failPrimaryRenderer() ?? Promise.resolve(false),

    // A surface still presenting rows has a live terminal with a buffer, or a
    // model with a screen in it. The reader's question — "does it look right" —
    // is not answerable here, and the register marks it manual for that reason.
    surfaceUsable: () =>
      surface() !== undefined
      || (presentation()?.model.state != null && presentation()?.rendererHealthy() === true),

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

    writeSustainedOutput: async (lines) => {
      const output = Array.from(
        { length: lines },
        (_, line) => `sustained output line ${line}\r\n`,
      ).join("");
      const terminal = surface();
      if (terminal) {
        await new Promise<void>((resolve) => {
          terminal.write(output, () => resolve());
        });
        return;
      }
      if (!presentation()) return;
      // See the note above: the child produces the output, because the client
      // has no way to put anything on a screen the host owns. The count is an
      // integer owned by the scenario, but validate it before placing it in a
      // shell command so this seam cannot become an injection surface later.
      if (!Number.isSafeInteger(lines) || lines < 0) {
        throw new Error(`Invalid sustained-output line count: ${lines}`);
      }
      await sendScenarioText(
        terminalId,
        `i=0; while [ "$i" -lt ${lines} ]; do printf 'sustained output line %s\\r\\n' "$i"; i=$((i+1)); done\r`,
      );
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

    publicationStats: () => getTerminalPublicationStats(terminalId),
    clientPerformanceStats: () => terminalClientPerformanceStats(terminalId),

    measureHiddenCatchup: async () => {
      const session = terminalSession(terminalId);
      const model = presentation()?.model;
      if (!session || !model?.state) {
        throw new Error("The hidden-catchup scenario needs a mounted semantic terminal");
      }
      const visibleSequence = model.state.sequence;

      session.conceal();
      try {
        await parkPrimaryScreenCredit(terminalId);
        while ((model.state?.sequence ?? visibleSequence) <= visibleSequence) await nextFrame();
        await nextFrame();
        const hiddenBaselineSequence = model.state?.sequence ?? visibleSequence;
        const hostBefore = await getTerminalPublicationStats(terminalId);
        const clientBefore = terminalClientPerformanceStats(terminalId);

        await sendScenarioText(terminalId, "\u0015# shipctl-hidden-catchup\r");
        const hidden = await waitForPublication(
          terminalId,
          (stats) => stats.screenChanges > hostBefore.screenChanges,
        );
        const clientHidden = terminalClientPerformanceStats(terminalId);

        session.reveal();
        while ((model.state?.sequence ?? hiddenBaselineSequence) <= hiddenBaselineSequence) {
          await nextFrame();
        }
        await nextFrame();
        const revealed = await getTerminalPublicationStats(terminalId);
        const clientRevealed = terminalClientPerformanceStats(terminalId);

        return {
          screenChangesWhileHidden: hidden.screenChanges - hostBefore.screenChanges,
          projectionsWhileHidden: hidden.screenProjections - hostBefore.screenProjections,
          encodesWhileHidden: hidden.screenEncodes - hostBefore.screenEncodes,
          modelCommitsWhileHidden: clientHidden.modelCommitCount - clientBefore.modelCommitCount,
          paintsWhileHidden: clientHidden.paintCount - clientBefore.paintCount,
          projectionsOnReveal: revealed.screenProjections - hidden.screenProjections,
          encodesOnReveal: revealed.screenEncodes - hidden.screenEncodes,
          modelCommitsOnReveal:
            clientRevealed.modelCommitCount - clientHidden.modelCommitCount,
          paintsOnReveal: clientRevealed.paintCount - clientHidden.paintCount,
          sequenceAdvance:
            (model.state?.sequence ?? hiddenBaselineSequence) - hiddenBaselineSequence,
        };
      } finally {
        session.reveal();
      }
    },

    measureAttachmentFanout: async () => {
      const session = terminalSession(terminalId);
      if (!session) throw new Error("The fanout scenario needs a mounted semantic terminal");
      const observers: SemanticObserver[] = [];
      session.conceal();
      try {
        const parked = await parkPrimaryScreenCredit(terminalId);
        observers.push(await openSemanticObserver(terminalId));
        observers.push(await openSemanticObserver(terminalId));
        const before = await getTerminalPublicationStats(terminalId);
        const screens = observers.map((observer) => observer.nextScreen());

        await sendScenarioText(terminalId, "\u0015f");
        await Promise.all(screens);
        const after = await waitForPublication(
          terminalId,
          (stats) =>
            stats.screenRecipientDeliveries - before.screenRecipientDeliveries
              >= observers.length
            && stats.currentScreenTransactions
              >= parked.currentScreenTransactions + observers.length,
        );

        return {
          screenChanges: after.screenChanges - before.screenChanges,
          projections: after.screenProjections - before.screenProjections,
          encodes: after.screenEncodes - before.screenEncodes,
          encodedBytes: after.screenEncodedBytes - before.screenEncodedBytes,
          recipientDeliveries:
            after.screenRecipientDeliveries - before.screenRecipientDeliveries,
          currentScreenTransactions:
            after.currentScreenTransactions - before.currentScreenTransactions,
          currentScreenBytesQueued:
            after.currentScreenBytesQueued - before.currentScreenBytesQueued,
        };
      } finally {
        await Promise.all(observers.map((observer) => observer.dispose()));
        session.reveal();
      }
    },

    measureSlowClientRecovery: async () => {
      const session = terminalSession(terminalId);
      const model = presentation()?.model;
      if (!session || !model?.state) {
        throw new Error("The slow-client scenario needs a mounted semantic terminal");
      }
      let observer: SemanticObserver | null = null;
      session.conceal();
      try {
        await parkPrimaryScreenCredit(terminalId);
        observer = await openSemanticObserver(terminalId);
        const before = await getTerminalPublicationStats(terminalId);

        const firstScreen = observer.nextScreen();
        await sendScenarioText(terminalId, "\u0015s");
        const firstSequence = await firstScreen;
        const afterFirst = await waitForPublication(
          terminalId,
          (stats) =>
            stats.currentScreenTransactions === before.currentScreenTransactions + 1,
        );

        let observedChanges = afterFirst.screenChanges;
        for (const text of ["1", "2"]) {
          await sendScenarioText(terminalId, text);
          const changed = await waitForPublication(
            terminalId,
            (stats) => stats.screenChanges > observedChanges,
          );
          observedChanges = changed.screenChanges;
        }
        const blocked = await waitForPublication(
          terminalId,
          (stats) =>
            stats.currentScreenTransactions === before.currentScreenTransactions + 1,
        );

        const recoveredScreen = observer.nextScreen();
        await observer.credit(firstSequence);
        const recoveredSequence = await recoveredScreen;

        const observation = {
          screenChanges: blocked.screenChanges - before.screenChanges,
          projectionsBeforeRecovery: blocked.screenProjections - before.screenProjections,
          encodesBeforeRecovery: blocked.screenEncodes - before.screenEncodes,
          deliveriesBeforeRecovery:
            blocked.screenRecipientDeliveries - before.screenRecipientDeliveries,
          transactionsBeforeReplacement:
            afterFirst.currentScreenTransactions - before.currentScreenTransactions,
          transactionsAfterReplacement:
            blocked.currentScreenTransactions - before.currentScreenTransactions,
          bytesBeforeReplacement:
            afterFirst.currentScreenBytesQueued - before.currentScreenBytesQueued,
          bytesAfterReplacement:
            blocked.currentScreenBytesQueued - before.currentScreenBytesQueued,
          recoveredSequenceAdvance: recoveredSequence - firstSequence,
          effectEvents: blocked.effectEvents - before.effectEvents,
          effectEncodedBytes: blocked.effectEncodedBytes - before.effectEncodedBytes,
        };

        // Leave the person's command line clean. This state is after the
        // measured recovery and is only the baseline the primary view resumes.
        await sendScenarioText(terminalId, "\u0015");
        await waitForPublication(
          terminalId,
          (stats) => stats.screenChanges > blocked.screenChanges,
        );
        return observation;
      } finally {
        await observer?.dispose();
        session.reveal();
      }
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
