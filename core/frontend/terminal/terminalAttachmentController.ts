/**
 * Attachment protocol for one terminal.
 *
 * This owns everything the client must get right about *sequencing* an
 * attachment: which generation a callback belongs to, which sequence number is
 * expected next, when a replay baseline is installed, when buffered bootstrap
 * events may be released, when recovery is scheduled, and what survives
 * disposal.
 *
 * It holds no renderer. React, xterm, the terminal cache, the output queue, and
 * the Tauri bridge all sit behind {@link TerminalAttachmentPorts}, so every
 * protocol trace — gap recovery, overlapping recovery requests, stale callbacks
 * from a superseded generation, disposal mid-attach — is provable without a DOM.
 *
 * Invariants:
 *
 * - Exactly one attach cycle runs at a time. Concurrent recovery requests
 *   collapse into one following cycle, never into parallel attachment loops.
 * - A callback from a superseded generation cannot mutate state.
 * - The expected sequence advances only through a consecutive event or a new
 *   replay baseline. A gap requests recovery instead of guessing.
 * - Input is closed on every transition that invalidates the baseline and is
 *   reopened only once the surface holds the replay the host sent.
 */

import type { TerminalClientModel, TerminalFrameOutcome } from "./terminalClientModel.ts";
import type { TerminalInput } from "./terminalSemanticInput.ts";
import type {
  TerminalAttachmentId,
  TerminalDescriptor,
  TerminalEvent,
  TerminalInputOutcome,
  TerminalReplay,
  TerminalScreenState,
} from "./types.ts";

/** The host snapshot that opens an attachment. */
export interface TerminalAttachmentSnapshot {
  readonly descriptor: TerminalDescriptor;
  readonly sequenceBoundary: number;
  /** The byte path's baseline. Legacy; area 05 deletes it. */
  readonly replay: TerminalReplay;
  /** The semantic path's baseline, and null on the byte path. */
  readonly state: TerminalScreenState | null;
}

/** One open attachment. `activate` releases events buffered during the attach. */
export interface TerminalAttachmentLease {
  readonly attachmentId: TerminalAttachmentId;
  readonly snapshot: TerminalAttachmentSnapshot;
  activate(): void;
}

export interface TerminalAttachmentPorts {
  /** Open an attachment. The controller supplies the only event sink. */
  attach(onEvent: (event: TerminalEvent) => void): Promise<TerminalAttachmentLease>;
  /** Close an attachment. Failure is not recoverable and is ignored. */
  detach(attachmentId: TerminalAttachmentId): Promise<void>;
  /** Publish a descriptor carried by an attachment snapshot. */
  observeDescriptor(descriptor: TerminalDescriptor): void;
  /** Reset the surface to this replay baseline and accept output again. */
  installReplay(replay: TerminalReplay): void;
  /** Stop delivering output to the surface; the baseline is no longer valid. */
  stopOutput(): void;
  /** Hand exact bytes to the surface, in order. */
  releaseOutput(bytes: readonly number[]): void;
  /** Whether the host terminal currently accepts input. */
  acceptsInput(): boolean;
  /** Submit exact bytes. Legacy; area 05 deletes it with the byte path. */
  write(data: string): Promise<TerminalInputOutcome>;
  /**
   * Submit what a person did and let the host encode it.
   *
   * Optional only while the byte path still ships: a caller that has no
   * semantic transport is refused rather than quietly written as bytes, since
   * bytes chosen by a client are the second copy of the child's modes this
   * path exists to end.
   */
  sendInput?(input: TerminalInput): Promise<TerminalInputOutcome>;
  /**
   * Read the rows behind the viewport, unchecked.
   *
   * Optional for the same reason {@link sendInput} is: the byte path has no
   * such transport, and a client without one is refused rather than given a
   * reconstruction of what scrolled away.
   */
  readHistory?(startRow: number, rows: number): Promise<unknown>;
  /** Record the live attachment id, or null while none is held. */
  publishAttachmentId(attachmentId: TerminalAttachmentId | null): void;
  /** Report an attach failure to the user. */
  reportError(error: unknown): void;
  /**
   * Defer one recovery decision. Defaults to `queueMicrotask`; tests inject a
   * scheduler they drain explicitly so no trace depends on timing.
   */
  schedule?(task: () => void): void;
  /**
   * The client model this attachment writes, on the semantic path.
   *
   * Supplying one selects that path: baselines and frames become state applied
   * to this model, and no bytes are installed or released. The model outlives
   * the controller — a reattachment writes the same model — so it is given
   * here rather than created here, and disposing the controller does not
   * dispose it.
   */
  model?: TerminalClientModel;
}

export class TerminalAttachmentController {
  readonly #ports: TerminalAttachmentPorts;
  readonly #schedule: (task: () => void) => void;

  /** Rises on every attach cycle and on disposal; older callbacks are ignored. */
  #generation = 0;
  #expectedSequence = 0;
  #lease: TerminalAttachmentLease | null = null;
  #attached = false;
  #attaching = false;
  #recoveryPending = false;
  #inputReady = false;
  #disposed = false;

  constructor(ports: TerminalAttachmentPorts) {
    this.#ports = ports;
    this.#schedule = ports.schedule ?? queueMicrotask;
  }

  /** The live attachment id, or null while none is held. */
  get attachmentId(): TerminalAttachmentId | null {
    return this.#lease?.attachmentId ?? null;
  }

  /** True once a snapshot has been installed and the event stream is live. */
  get attached(): boolean {
    return this.#attached;
  }

  /** Whether input may be sent: an attachment is held and its baseline is current. */
  acceptsInput(): boolean {
    return this.#lease !== null && this.#inputReady;
  }

  /**
   * The one input path for the view.
   *
   * Readiness is decided here, at submission time, from the current attachment
   * state; the host decides the rest. The caller receives a typed outcome and
   * never has to choose between dropping a keystroke and raising an error.
   */
  async submitInput(data: string): Promise<TerminalInputOutcome> {
    const refusal = this.#refusal();
    if (refusal) return refusal;
    return this.#ports.write(data);
  }

  /**
   * The same path, for input that names meaning instead of bytes.
   *
   * Readiness is decided the same way and for the same reason: a baseline that
   * is not current is a screen the person is not looking at. What the input
   * becomes is the host's, so nothing here inspects it.
   */
  async submitSemanticInput(input: TerminalInput): Promise<TerminalInputOutcome> {
    const send = this.#ports.sendInput;
    if (!send) {
      // A wiring fault, not a lifecycle one. Reporting it as unavailable would
      // read as "the terminal is busy" and hide a client with no semantic
      // transport for as long as nobody looked at a keystroke.
      return {
        status: "failed",
        error: new Error("This attachment has no semantic input transport"),
      };
    }
    const refusal = this.#refusal();
    if (refusal) return refusal;
    return send(input);
  }

  /**
   * Read a window of history into the model.
   *
   * Not an input path, so it is not refused for a baseline that is not current:
   * a read of the host's retention is true whatever the attachment is doing,
   * and it is exactly while recovering — or after the child exited — that a
   * person still wants to see what scrolled away. The window is committed
   * through the model's decoder, so a shape the host did not write leaves the
   * model as it was.
   */
  async readHistory(startRow: number, rows: number): Promise<TerminalFrameOutcome> {
    const read = this.#ports.readHistory;
    if (!read) {
      return {
        status: "rejected",
        reason: "invalid",
        detail: "This attachment has no history transport",
      };
    }
    const model = this.#ports.model;
    if (!model) {
      return {
        status: "rejected",
        reason: "invalid",
        detail: "This attachment has no client model to hold history",
      };
    }
    try {
      return model.applyHistory(await read(startRow, rows));
    } catch (error) {
      return {
        status: "rejected",
        reason: "invalid",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Why input may not be submitted now, or null when it may. */
  #refusal(): TerminalInputOutcome | null {
    if (this.acceptsInput()) return null;
    // Either no attachment is held, or one is held whose baseline is not
    // current: mid-replay, recovering, or past the host's exit.
    return { status: "unavailable", reason: this.#lease ? "not_ready" : "detached" };
  }

  /** Open the attachment. Does nothing once attached or disposed. */
  async start(): Promise<void> {
    if (this.#disposed || this.#attached) return;
    await this.#openAttachment();
  }

  /**
   * Ask for a fresh baseline.
   *
   * Every untrusted-baseline signal arrives here: a sequence gap, a host
   * `resync_required` or `detached`, and local output-queue overflow. Requests
   * raised while a cycle is running collapse into one following cycle.
   */
  requestRecovery(): void {
    if (this.#disposed) return;
    this.#inputReady = false;
    this.#recoveryPending = true;
    this.#schedule(() => {
      if (this.#disposed || this.#attaching || !this.#recoveryPending) return;
      void this.#openAttachment();
    });
  }

  /**
   * The surface has written everything queued for the current baseline.
   *
   * Input readiness is decided here rather than at replay time: until the
   * replay bytes have been parsed, the surface does not yet show the state the
   * user would be typing into.
   */
  noteOutputDrained(): void {
    if (this.#disposed || !this.#lease) return;
    this.#inputReady = this.#ports.acceptsInput();
  }

  /** Abandon the attachment. Terminal: no later callback may take effect. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#attaching = false;
    this.#recoveryPending = false;
    this.#attached = false;
    this.#inputReady = false;
    const lease = this.#lease;
    this.#lease = null;
    this.#ports.publishAttachmentId(null);
    this.#ports.stopOutput();
    if (lease) void this.#ports.detach(lease.attachmentId).catch(() => undefined);
  }

  async #openAttachment(): Promise<void> {
    if (this.#disposed || this.#attaching) return;
    this.#attaching = true;
    const generation = ++this.#generation;
    const previous = this.#lease;
    this.#lease = null;
    this.#attached = false;
    this.#inputReady = false;
    this.#recoveryPending = false;
    this.#ports.publishAttachmentId(null);
    this.#ports.stopOutput();
    if (previous) {
      await this.#ports.detach(previous.attachmentId).catch(() => undefined);
    }

    try {
      const lease = await this.#ports.attach((event) => {
        this.#observe(generation, event);
      });
      // The attach may have been superseded or disposed while in flight. The
      // lease is real and must be released; it may not become current.
      if (this.#disposed || this.#generation !== generation) {
        await this.#ports.detach(lease.attachmentId).catch(() => undefined);
        return;
      }

      this.#lease = lease;
      this.#ports.publishAttachmentId(lease.attachmentId);
      this.#ports.observeDescriptor(lease.snapshot.descriptor);
      // The baseline must be installed before buffered events are released, so
      // the first live event lands on the state it was sequenced against.
      if (!this.#installBaseline(lease.snapshot)) return;
      this.#attached = true;
      lease.activate();
    } catch (error) {
      this.#ports.reportError(error);
    } finally {
      this.#attaching = false;
      if (this.#recoveryPending && !this.#disposed) {
        this.#schedule(() => {
          void this.#openAttachment();
        });
      }
    }
  }

  /**
   * Install the baseline this attachment asked for.
   *
   * Returns false when the host answered with the encoding this attachment did
   * not ask for. That is not a frame to drop: the attachment cannot be started
   * on a baseline it cannot read, so it is reported and recovered instead.
   */
  #installBaseline(snapshot: TerminalAttachmentSnapshot): boolean {
    const model = this.#ports.model;
    if (!model) {
      this.#installReplay(snapshot.replay, snapshot.sequenceBoundary);
      return true;
    }
    if (snapshot.state === null) {
      this.#ports.reportError(
        new Error("The terminal attachment was given no state to start from"),
      );
      this.requestRecovery();
      return false;
    }
    this.#inputReady = false;
    this.#expectedSequence = snapshot.sequenceBoundary;
    const outcome = model.installBaseline({
      sequence: snapshot.sequenceBoundary,
      revision: snapshot.descriptor.revision,
      state: snapshot.state,
      effects: [],
    });
    if (outcome.status !== "committed") {
      this.#ports.reportError(new Error(`The terminal baseline was refused: ${outcome.detail}`));
      this.requestRecovery();
      return false;
    }
    // Nothing is re-parsed on this path, so the state the user would type into
    // is on screen as soon as it is committed.
    this.#inputReady = this.#ports.acceptsInput();
    return true;
  }

  #installReplay(replay: TerminalReplay, sequenceBoundary: number): void {
    this.#inputReady = false;
    this.#expectedSequence = sequenceBoundary;
    this.#ports.installReplay(replay);
    if (replay.bytes.length === 0) {
      // Nothing to drain, so no drain callback will decide readiness.
      this.#inputReady = this.#ports.acceptsInput();
    } else {
      this.#ports.releaseOutput(replay.bytes);
    }
  }

  #observe(generation: number, event: TerminalEvent): void {
    if (this.#disposed || this.#generation !== generation) return;
    if (event.sequence !== this.#expectedSequence + 1) {
      this.requestRecovery();
      return;
    }
    this.#expectedSequence = event.sequence;

    switch (event.event) {
      case "output":
        this.#ports.releaseOutput(event.data);
        return;
      case "replay":
        this.#installReplay(event.replay, event.sequence);
        return;
      case "resync_required":
      case "detached":
        this.requestRecovery();
        return;
      case "exited":
        this.#inputReady = false;
        return;
      case "metadata_changed":
      case "agent_activity_changed":
        // Descriptor projection is the runtime's concern, not the protocol's.
        return;
      case "screen": {
        const model = this.#ports.model;
        if (!model) {
          // This attachment asked the host for the byte encoding, so semantic
          // state arriving here means the host sent an encoding this client did
          // not ask for. Refuse the frame instead of dropping it in silence.
          this.#ports.reportError(
            new Error("The terminal attachment received semantic state on the byte stream"),
          );
          return;
        }
        const outcome = model.applyScreen({
          sequence: event.sequence,
          revision: event.revision,
          state: event.state,
          effects: event.effects,
        });
        if (outcome.status !== "committed") {
          // The model is untouched, so the client's state is the last frame it
          // could believe. It needs a baseline, not the next frame.
          this.#ports.reportError(new Error(`The terminal frame was refused: ${outcome.detail}`));
          this.requestRecovery();
        }
        return;
      }
      default: {
        // A variant added to the host model without a decision here fails to
        // compile rather than being silently dropped.
        const unhandled: never = event;
        void unhandled;
        return;
      }
    }
  }
}
