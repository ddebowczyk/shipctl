/**
 * Browser composition for the packaged-app semantic scenario harness.
 *
 * This is the sole scenario file that joins live module commands to the
 * semantic model and canvas binding. The catalog itself sees only its probe.
 */

import type {
  SemanticServiceError,
  SemanticTerminalAttachmentId,
  SemanticTerminalPublicationStats,
  SemanticTerminalsErrorCode,
  SemanticTerminalsService,
} from "@shipctl/module-api";
import { terminalPresentation, terminalSession } from "../presentation/terminalCache.ts";
import { TerminalClientModel } from "../presentation/terminalClientModel.ts";
import { terminalClientPerformanceStats } from "../terminalPerformanceMetrics.ts";
import {
  formatScenarioRecord,
  type ScenarioRecord,
  type ScenarioRunnerPorts,
} from "./scenarioContract.ts";
import { createTerminalScenarios, type TerminalSurfaceProbe } from "./scenarioCatalog.ts";
import { runScenarios, type ScenarioRunSummary } from "./scenarioRunner.ts";

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

class ScenarioServiceError extends Error {
  readonly code: SemanticTerminalsErrorCode;

  constructor(error: SemanticServiceError<SemanticTerminalsErrorCode>) {
    super(error.message);
    this.name = "ScenarioServiceError";
    this.code = error.code;
  }
}

async function semanticResult<Value>(
  operation: Promise<{
    readonly result:
      | { readonly ok: true; readonly value: Value }
      | { readonly ok: false; readonly error: SemanticServiceError<SemanticTerminalsErrorCode> };
  }>,
): Promise<Value> {
  const outcome = await operation;
  if (outcome.result.ok) return outcome.result.value;
  throw new ScenarioServiceError(outcome.result.error);
}

async function sampleHostMemory(
  semanticTerminals: SemanticTerminalsService,
): Promise<number | null> {
  try {
    return (await semanticResult(semanticTerminals.appMemory.execute({}))).appRss;
  } catch {
    return null;
  }
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForPublication(
  semanticTerminals: SemanticTerminalsService,
  terminalId: string,
  accepts: (stats: SemanticTerminalPublicationStats) => boolean,
): Promise<SemanticTerminalPublicationStats> {
  for (;;) {
    const stats = await semanticResult(
      semanticTerminals.publicationStats.execute({ terminalId }),
    );
    if (accepts(stats)) return stats;
    await nextFrame();
  }
}

async function sendScenarioText(
  semanticTerminals: SemanticTerminalsService,
  terminalId: string,
  text: string,
): Promise<void> {
  await semanticResult(semanticTerminals.input.execute({
    terminalId,
    input: { kind: "text", text },
  }));
}

async function parkPrimaryScreenCredit(
  semanticTerminals: SemanticTerminalsService,
  terminalId: string,
): Promise<SemanticTerminalPublicationStats> {
  const before = await waitForPublication(
    semanticTerminals,
    terminalId,
    (stats) => stats.currentScreenTransactions === 0,
  );
  await sendScenarioText(semanticTerminals, terminalId, ".");
  return waitForPublication(
    semanticTerminals,
    terminalId,
    (stats) => stats.currentScreenTransactions > before.currentScreenTransactions,
  );
}

interface SemanticObserver {
  nextScreen(): Promise<number>;
  credit(sequence: number): Promise<void>;
  dispose(): Promise<void>;
}

/** Add a real semantic reader without adding another presentation surface. */
async function openSemanticObserver(
  semanticTerminals: SemanticTerminalsService,
  terminalId: string,
): Promise<SemanticObserver> {
  const model = new TerminalClientModel();
  const waiting: Array<{ resolve(sequence: number): void; reject(error: Error): void }> = [];
  const screens: number[] = [];
  let failure: Error | null = null;
  const fail = (detail: string): void => {
    failure = new Error(detail);
    for (const waiter of waiting.splice(0)) waiter.reject(failure);
  };
  const lease = await semanticTerminals.screens.attach({
    terminalId,
    claimsResize: false,
    afterSequence: null,
    initialCredit: 0,
  }, (delivery): void => {
    if (failure) return;
    if (delivery.type === "frame") {
      const effects = model.applyEffects(delivery.value.effects);
      if (effects.status !== "committed") {
        fail(`The observer refused effects: ${effects.detail}`);
        return;
      }
      const outcome = model.applyScreen({
        sequence: delivery.sequence,
        revision: delivery.value.revision,
        state: delivery.value.state,
      });
      if (outcome.status !== "committed") {
        fail(`The observer refused a screen: ${outcome.detail}`);
        return;
      }
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(delivery.sequence);
      else screens.push(delivery.sequence);
      return;
    }
    if (delivery.type === "gap") {
      fail("The semantic observer could not resume its screen history");
      return;
    }
    fail(`The semantic observer disconnected: ${delivery.reason}`);
  });
  const state = lease.snapshot.state;
  const baseline = model.installBaseline({
    sequence: lease.snapshot.revision,
    revision: lease.snapshot.revision,
    state,
  });
  if (baseline.status !== "committed") {
    await lease.dispose();
    model.dispose();
    throw new Error(`The observer refused its baseline: ${baseline.detail}`);
  }
  lease.activate();
  lease.grant(1);

  return {
    nextScreen: () => {
      if (failure) return Promise.reject(failure);
      const sequence = screens.shift();
      if (sequence !== undefined) return Promise.resolve(sequence);
      return new Promise<number>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    credit: async (sequence) => {
      lease.acknowledge(sequence);
      lease.grant(1);
    },
    dispose: async () => {
      for (const waiter of waiting.splice(0)) waiter.reject(new Error("The semantic observer was disposed"));
      model.dispose();
      await lease.dispose();
    },
  };
}

/** Bind scenario questions to the one selected semantic terminal. */
function createSurfaceProbe(
  semanticTerminals: SemanticTerminalsService,
  terminalId: string,
): TerminalSurfaceProbe {
  const presentation = () => terminalPresentation(terminalId);
  return {
    failPrimaryRenderer: () => presentation()?.failPrimaryRenderer() ?? Promise.resolve(false),
    surfaceUsable: () =>
      presentation()?.model.state != null && presentation()?.rendererHealthy() === true,
    secondModelPresent: () => document.querySelectorAll(".terminal-surface canvas").length > 1,
    writeSustainedOutput: async (lines) => {
      if (!Number.isSafeInteger(lines) || lines < 0) {
        throw new Error(`Invalid sustained-output line count: ${lines}`);
      }
      await sendScenarioText(
        semanticTerminals,
        terminalId,
        `i=0; while [ "$i" -lt ${lines} ]; do printf 'sustained output line %s\\r\\n' "$i"; i=$((i+1)); done\r`,
      );
    },
    bufferRows: () => {
      const state = presentation()?.model.state;
      return state ? state.screen.scrollbackRows + state.screen.rows : 0;
    },
    resize: async (columns, rows) => {
      const attachmentId = presentation()?.attachmentId() ?? null;
      if (!attachmentId) return;
      await semanticResult(semanticTerminals.resize.execute({
        terminalId,
        attachmentId: attachmentId as SemanticTerminalAttachmentId,
        columns,
        rows,
      }));
      await nextFrame();
    },
    publicationStats: () => semanticResult(
      semanticTerminals.publicationStats.execute({ terminalId }),
    ),
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
        await parkPrimaryScreenCredit(semanticTerminals, terminalId);
        while ((model.state?.sequence ?? visibleSequence) <= visibleSequence) await nextFrame();
        await nextFrame();
        const hiddenBaselineSequence = model.state?.sequence ?? visibleSequence;
        const hostBefore = await semanticResult(
          semanticTerminals.publicationStats.execute({ terminalId }),
        );
        const clientBefore = terminalClientPerformanceStats(terminalId);
        await sendScenarioText(semanticTerminals, terminalId, "\u0015# shipctl-hidden-catchup\r");
        const hidden = await waitForPublication(
          semanticTerminals,
          terminalId,
          (stats) => stats.screenChanges > hostBefore.screenChanges,
        );
        const clientHidden = terminalClientPerformanceStats(terminalId);
        session.reveal();
        while ((model.state?.sequence ?? hiddenBaselineSequence) <= hiddenBaselineSequence) {
          await nextFrame();
        }
        await nextFrame();
        const revealed = await semanticResult(
          semanticTerminals.publicationStats.execute({ terminalId }),
        );
        const clientRevealed = terminalClientPerformanceStats(terminalId);
        return {
          screenChangesWhileHidden: hidden.screenChanges - hostBefore.screenChanges,
          projectionsWhileHidden: hidden.screenProjections - hostBefore.screenProjections,
          encodesWhileHidden: hidden.screenEncodes - hostBefore.screenEncodes,
          modelCommitsWhileHidden: clientHidden.modelCommitCount - clientBefore.modelCommitCount,
          paintsWhileHidden: clientHidden.paintCount - clientBefore.paintCount,
          projectionsOnReveal: revealed.screenProjections - hidden.screenProjections,
          encodesOnReveal: revealed.screenEncodes - hidden.screenEncodes,
          modelCommitsOnReveal: clientRevealed.modelCommitCount - clientHidden.modelCommitCount,
          paintsOnReveal: clientRevealed.paintCount - clientHidden.paintCount,
          sequenceAdvance: (model.state?.sequence ?? hiddenBaselineSequence) - hiddenBaselineSequence,
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
        const parked = await parkPrimaryScreenCredit(semanticTerminals, terminalId);
        observers.push(await openSemanticObserver(semanticTerminals, terminalId));
        observers.push(await openSemanticObserver(semanticTerminals, terminalId));
        const before = await semanticResult(
          semanticTerminals.publicationStats.execute({ terminalId }),
        );
        const screens = observers.map((observer) => observer.nextScreen());
        await sendScenarioText(semanticTerminals, terminalId, "\u0015f");
        await Promise.all(screens);
        const after = await waitForPublication(
          semanticTerminals,
          terminalId,
          (stats) => stats.screenRecipientDeliveries - before.screenRecipientDeliveries >= observers.length
            && stats.currentScreenTransactions >= parked.currentScreenTransactions + observers.length,
        );
        return {
          screenChanges: after.screenChanges - before.screenChanges,
          projections: after.screenProjections - before.screenProjections,
          encodes: after.screenEncodes - before.screenEncodes,
          encodedBytes: after.screenEncodedBytes - before.screenEncodedBytes,
          recipientDeliveries: after.screenRecipientDeliveries - before.screenRecipientDeliveries,
          currentScreenTransactions: after.currentScreenTransactions - before.currentScreenTransactions,
          currentScreenBytesQueued: after.currentScreenBytesQueued - before.currentScreenBytesQueued,
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
        await parkPrimaryScreenCredit(semanticTerminals, terminalId);
        observer = await openSemanticObserver(semanticTerminals, terminalId);
        const before = await semanticResult(
          semanticTerminals.publicationStats.execute({ terminalId }),
        );
        const firstScreen = observer.nextScreen();
        await sendScenarioText(semanticTerminals, terminalId, "\u0015s");
        const firstSequence = await firstScreen;
        const afterFirst = await waitForPublication(
          semanticTerminals,
          terminalId,
          (stats) => stats.currentScreenTransactions === before.currentScreenTransactions + 1,
        );
        let observedChanges = afterFirst.screenChanges;
        for (const text of ["1", "2"]) {
          await sendScenarioText(semanticTerminals, terminalId, text);
          const changed = await waitForPublication(
            semanticTerminals,
            terminalId,
            (stats) => stats.screenChanges > observedChanges,
          );
          observedChanges = changed.screenChanges;
        }
        const blocked = await waitForPublication(
          semanticTerminals,
          terminalId,
          (stats) => stats.currentScreenTransactions === before.currentScreenTransactions + 1,
        );
        const recoveredScreen = observer.nextScreen();
        await observer.credit(firstSequence);
        const recoveredSequence = await recoveredScreen;
        const observation = {
          screenChanges: blocked.screenChanges - before.screenChanges,
          projectionsBeforeRecovery: blocked.screenProjections - before.screenProjections,
          encodesBeforeRecovery: blocked.screenEncodes - before.screenEncodes,
          deliveriesBeforeRecovery: blocked.screenRecipientDeliveries - before.screenRecipientDeliveries,
          transactionsBeforeReplacement: afterFirst.currentScreenTransactions - before.currentScreenTransactions,
          transactionsAfterReplacement: blocked.currentScreenTransactions - before.currentScreenTransactions,
          bytesBeforeReplacement: afterFirst.currentScreenBytesQueued - before.currentScreenBytesQueued,
          bytesAfterReplacement: blocked.currentScreenBytesQueued - before.currentScreenBytesQueued,
          recoveredSequenceAdvance: recoveredSequence - firstSequence,
          effectEvents: blocked.effectEvents - before.effectEvents,
          effectEncodedBytes: blocked.effectEncodedBytes - before.effectEncodedBytes,
        };
        await sendScenarioText(semanticTerminals, terminalId, "\u0015");
        await waitForPublication(
          semanticTerminals,
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
  readonly ndjson: string;
}

/** Run the complete catalog against the selected semantic terminal. */
export async function runTerminalScenarios(
  semanticTerminals: SemanticTerminalsService,
  terminalId: string,
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
    sampleHostMemory: () => sampleHostMemory(semanticTerminals),
    frameDeltas,
  };
  const summary = await runScenarios(
    runId,
    createTerminalScenarios(createSurfaceProbe(semanticTerminals, terminalId)),
    ports,
  );
  return { ...summary, ndjson: lines.join("\n") };
}
