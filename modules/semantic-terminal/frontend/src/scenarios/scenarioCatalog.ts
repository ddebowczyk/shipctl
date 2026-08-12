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
 * "../../tests/terminalCapabilityRegister.test.ts" rejects it.
 */

import type { ScenarioContext, ScenarioOutcome, TerminalScenario } from "./scenarioContract.ts";

/** Structural host observations exposed through the scenario port. */
interface TerminalPublicationObservation {
  readonly ptyReads: number;
  readonly screenChanges: number;
  readonly screenProjections: number;
  readonly screenEncodes: number;
  readonly screenEncodedBytes: number;
  readonly screenRecipientDeliveries: number;
  readonly effectEvents: number;
  readonly effectEncodedBytes: number;
  readonly currentScreenTransactions: number;
  readonly currentScreenBytesQueued: number;
  readonly peakScreenBytesQueued: number;
  readonly currentEffectEventsQueued: number;
  readonly currentEffectBytesQueued: number;
  readonly peakEffectEventsQueued: number;
  readonly peakEffectBytesQueued: number;
}

/** Structural client observations exposed through the scenario port. */
interface TerminalClientPerformanceObservation {
  readonly decodeCount: number;
  readonly decodeMilliseconds: number;
  readonly modelCommitCount: number;
  readonly modelCommitMilliseconds: number;
  readonly paintCount: number;
  readonly paintMilliseconds: number;
}

export interface HiddenCatchupObservation {
  readonly screenChangesWhileHidden: number;
  readonly projectionsWhileHidden: number;
  readonly encodesWhileHidden: number;
  readonly modelCommitsWhileHidden: number;
  readonly paintsWhileHidden: number;
  readonly projectionsOnReveal: number;
  readonly encodesOnReveal: number;
  readonly modelCommitsOnReveal: number;
  readonly paintsOnReveal: number;
  readonly sequenceAdvance: number;
}

export interface AttachmentFanoutObservation {
  readonly screenChanges: number;
  readonly projections: number;
  readonly encodes: number;
  readonly encodedBytes: number;
  readonly recipientDeliveries: number;
  readonly currentScreenTransactions: number;
  readonly currentScreenBytesQueued: number;
}

export interface SlowClientRecoveryObservation {
  readonly screenChanges: number;
  readonly projectionsBeforeRecovery: number;
  readonly encodesBeforeRecovery: number;
  readonly deliveriesBeforeRecovery: number;
  readonly transactionsBeforeReplacement: number;
  readonly transactionsAfterReplacement: number;
  readonly bytesBeforeReplacement: number;
  readonly bytesAfterReplacement: number;
  readonly recoveredSequenceAdvance: number;
  readonly effectEvents: number;
  readonly effectEncodedBytes: number;
}

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
   * Fail the primary painter once and report whether automatic recreation ran.
   */
  failPrimaryRenderer(): Promise<boolean>;
  /** Whether the surface still presents rows to a reader. */
  surfaceUsable(): boolean;
  /**
   * Whether a second terminal model exists — an xterm instance standing in for
   * the painter after a failure. Criterion 7 fails if this is ever true.
   */
  secondModelPresent(): boolean;
  /** Make the child produce the sustained-output workload. */
  writeSustainedOutput(lines: number): Promise<void>;
  /** Rows the surface currently holds, including scrollback. */
  bufferRows(): number;
  /** Resize the surface. */
  resize(columns: number, rows: number): Promise<void>;
  /** Cumulative host publication observations. */
  publicationStats(): Promise<TerminalPublicationObservation>;
  /** Cumulative decoder, model, and painter observations. */
  clientPerformanceStats(): TerminalClientPerformanceObservation;
  /** Stop credit while hidden, then observe one catch-up on reveal. */
  measureHiddenCatchup(): Promise<HiddenCatchupObservation>;
  /** Add one validated semantic reader and observe shared publication. */
  measureAttachmentFanout(): Promise<AttachmentFanoutObservation>;
  /** Hold one committed screen, replace later state, then grant credit. */
  measureSlowClientRecovery(): Promise<SlowClientRecoveryObservation>;
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
      "renderer.primary-failure",
      "The terminal survives a primary-painter failure, without a second model.",
      ["renderer.primary-failure-recovery"],
      async (context) => {
        const rowsBefore = probe.bufferRows();
        if (!await probe.failPrimaryRenderer()) {
          return {
            status: "failed",
            detail: "automatic Canvas2D renderer recreation failed",
          };
        }

        // Recreation schedules one full repaint. Observe that compositor frame
        // before asking whether the new renderer generation presented it.
        await context.frameDeltas(1);

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
        const hostBefore = await probe.publicationStats();
        const clientBefore = probe.clientPerformanceStats();
        const startedAt = context.now();
        const framesPromise = context.frameDeltas(SAMPLED_FRAMES);

        await probe.writeSustainedOutput(SUSTAINED_OUTPUT_LINES);
        const writeMs = context.now() - startedAt;
        context.measure("output.write", writeMs, "ms");
        context.measure("output.lines", SUSTAINED_OUTPUT_LINES, "count");

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

        const hostAfter = await probe.publicationStats();
        const clientAfter = probe.clientPerformanceStats();
        const hostDeltas = {
          "host.pty-reads": hostAfter.ptyReads - hostBefore.ptyReads,
          "host.screen-changes": hostAfter.screenChanges - hostBefore.screenChanges,
          "host.screen-projections": hostAfter.screenProjections - hostBefore.screenProjections,
          "host.screen-encodes": hostAfter.screenEncodes - hostBefore.screenEncodes,
          "host.screen-encoded-bytes": hostAfter.screenEncodedBytes - hostBefore.screenEncodedBytes,
          "host.screen-recipient-deliveries":
            hostAfter.screenRecipientDeliveries - hostBefore.screenRecipientDeliveries,
          "host.effect-events": hostAfter.effectEvents - hostBefore.effectEvents,
          "host.effect-encoded-bytes":
            hostAfter.effectEncodedBytes - hostBefore.effectEncodedBytes,
        };
        for (const [name, value] of Object.entries(hostDeltas)) {
          context.measure(name, value, name.endsWith("bytes") ? "bytes" : "count");
        }
        context.measure(
          "host.current-screen-transactions",
          hostAfter.currentScreenTransactions,
          "count",
        );
        context.measure(
          "host.current-screen-bytes-queued",
          hostAfter.currentScreenBytesQueued,
          "bytes",
        );
        context.measure(
          "host.peak-screen-bytes-queued",
          hostAfter.peakScreenBytesQueued,
          "bytes",
        );
        context.measure(
          "host.current-effect-events-queued",
          hostAfter.currentEffectEventsQueued,
          "count",
        );
        context.measure(
          "host.current-effect-bytes-queued",
          hostAfter.currentEffectBytesQueued,
          "bytes",
        );
        context.measure("host.peak-effect-events-queued", hostAfter.peakEffectEventsQueued, "count");
        context.measure("host.peak-effect-bytes-queued", hostAfter.peakEffectBytesQueued, "bytes");

        context.measure(
          "client.decode-calls",
          clientAfter.decodeCount - clientBefore.decodeCount,
          "count",
        );
        context.measure(
          "client.decode-work",
          clientAfter.decodeMilliseconds - clientBefore.decodeMilliseconds,
          "ms",
        );
        context.measure(
          "client.model-commits",
          clientAfter.modelCommitCount - clientBefore.modelCommitCount,
          "count",
        );
        context.measure(
          "client.model-commit-work",
          clientAfter.modelCommitMilliseconds - clientBefore.modelCommitMilliseconds,
          "ms",
        );
        context.measure(
          "client.paints",
          clientAfter.paintCount - clientBefore.paintCount,
          "count",
        );
        context.measure(
          "client.paint-work",
          clientAfter.paintMilliseconds - clientBefore.paintMilliseconds,
          "ms",
        );

        // No threshold is applied. Area 04 requires measurements to cite an
        // authority, and no recorded product requirement or technical contract
        // sets a frame or throughput budget for this app. The numbers are
        // reported; turning one into a gate is an owner's decision.
        return { status: "passed" };
      },
    ),

    scenario(
      "measure.hidden-catchup",
      "A hidden semantic surface stops screen work and resumes from current state on reveal.",
      ["measure.hidden-catchup"],
      async (context) => {
        const observed = await probe.measureHiddenCatchup();
        context.measure("hidden.screen-changes", observed.screenChangesWhileHidden, "count");
        context.measure("hidden.screen-projections", observed.projectionsWhileHidden, "count");
        context.measure("hidden.screen-encodes", observed.encodesWhileHidden, "count");
        context.measure("hidden.model-commits", observed.modelCommitsWhileHidden, "count");
        context.measure("hidden.paints", observed.paintsWhileHidden, "count");
        context.measure("reveal.screen-projections", observed.projectionsOnReveal, "count");
        context.measure("reveal.screen-encodes", observed.encodesOnReveal, "count");
        context.measure("reveal.model-commits", observed.modelCommitsOnReveal, "count");
        context.measure("reveal.paints", observed.paintsOnReveal, "count");
        context.measure("reveal.sequence-advance", observed.sequenceAdvance, "count");

        const hiddenDidNoScreenWork = observed.projectionsWhileHidden === 0
          && observed.encodesWhileHidden === 0
          && observed.modelCommitsWhileHidden === 0
          && observed.paintsWhileHidden === 0;
        const revealCaughtUp = observed.screenChangesWhileHidden > 0
          && observed.projectionsOnReveal > 0
          && observed.encodesOnReveal > 0
          && observed.modelCommitsOnReveal > 0
          && observed.paintsOnReveal > 0
          && observed.sequenceAdvance > 0;
        return hiddenDidNoScreenWork && revealCaughtUp
          ? { status: "passed" }
          : { status: "failed", detail: "hidden work or reveal catch-up violated demand pacing" };
      },
    ),

    scenario(
      "measure.attachment-fanout",
      "Two semantic readers share one projection and one encoded event.",
      ["measure.attachment-fanout"],
      async (context) => {
        const observed = await probe.measureAttachmentFanout();
        context.measure("fanout.screen-changes", observed.screenChanges, "count");
        context.measure("fanout.screen-projections", observed.projections, "count");
        context.measure("fanout.screen-encodes", observed.encodes, "count");
        context.measure("fanout.screen-encoded-bytes", observed.encodedBytes, "bytes");
        context.measure("fanout.recipient-deliveries", observed.recipientDeliveries, "count");
        context.measure("fanout.current-screen-transactions", observed.currentScreenTransactions, "count");
        context.measure("fanout.current-screen-bytes-queued", observed.currentScreenBytesQueued, "bytes");

        return observed.screenChanges > 0
          && observed.projections === 1
          && observed.encodes === 1
          && observed.recipientDeliveries === 2
          ? { status: "passed" }
          : { status: "failed", detail: "two readers did not share one canonical encoding" };
      },
    ),

    scenario(
      "measure.slow-client-recovery",
      "A stalled semantic reader holds one frame and resumes at newest state.",
      ["measure.slow-client-recovery"],
      async (context) => {
        const observed = await probe.measureSlowClientRecovery();
        context.measure("slow.screen-changes", observed.screenChanges, "count");
        context.measure("slow.projections-before-recovery", observed.projectionsBeforeRecovery, "count");
        context.measure("slow.encodes-before-recovery", observed.encodesBeforeRecovery, "count");
        context.measure("slow.deliveries-before-recovery", observed.deliveriesBeforeRecovery, "count");
        context.measure("slow.transactions-before-replacement", observed.transactionsBeforeReplacement, "count");
        context.measure("slow.transactions-after-replacement", observed.transactionsAfterReplacement, "count");
        context.measure("slow.bytes-before-replacement", observed.bytesBeforeReplacement, "bytes");
        context.measure("slow.bytes-after-replacement", observed.bytesAfterReplacement, "bytes");
        context.measure("slow.recovered-sequence-advance", observed.recoveredSequenceAdvance, "count");
        context.measure("slow.effect-events", observed.effectEvents, "count");
        context.measure("slow.effect-encoded-bytes", observed.effectEncodedBytes, "bytes");

        // Replacement needs two later screen changes: one can only be a next
        // state. This workload creates two so the recovered sequence can prove
        // an intermediate state was not queued and replayed.
        return observed.screenChanges >= 3
          && observed.projectionsBeforeRecovery === 1
          && observed.encodesBeforeRecovery === 1
          && observed.deliveriesBeforeRecovery === 1
          && observed.transactionsBeforeReplacement === 1
          && observed.transactionsAfterReplacement === 1
          && observed.bytesBeforeReplacement === observed.bytesAfterReplacement
          && observed.recoveredSequenceAdvance > 1
          ? { status: "passed" }
          : { status: "failed", detail: "the stalled reader accumulated state or missed newest-state recovery" };
      },
    ),
  ];
}
