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

import type {
  TerminalAttachmentId,
  TerminalDescriptor,
  TerminalEvent,
  TerminalInputOutcome,
  TerminalReplay,
} from "./types.ts";

/** The host snapshot that opens an attachment. */
export interface TerminalAttachmentSnapshot {
  readonly descriptor: TerminalDescriptor;
  readonly sequenceBoundary: number;
  readonly replay: TerminalReplay;
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
  /** Submit input to the host, which is the final admission authority. */
  write(data: string): Promise<TerminalInputOutcome>;
  /** Record the live attachment id, or null while none is held. */
  publishAttachmentId(attachmentId: TerminalAttachmentId | null): void;
  /** Report an attach failure to the user. */
  reportError(error: unknown): void;
  /**
   * Defer one recovery decision. Defaults to `queueMicrotask`; tests inject a
   * scheduler they drain explicitly so no trace depends on timing.
   */
  schedule?(task: () => void): void;
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
    if (!this.acceptsInput()) {
      // Either no attachment is held, or one is held whose baseline is not
      // current: mid-replay, recovering, or past the host's exit.
      return { status: "unavailable", reason: this.#lease ? "not_ready" : "detached" };
    }
    return this.#ports.write(data);
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
      this.#installReplay(lease.snapshot.replay, lease.snapshot.sequenceBoundary);
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
