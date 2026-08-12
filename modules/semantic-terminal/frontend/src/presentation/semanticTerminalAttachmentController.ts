/**
 * Attachment sequencing for a semantic terminal.
 *
 * This controller owns no DOM or host bridge. Its only durable state is the
 * client model, which lets a recreated presentation continue from the last
 * host-authorized screen. The raw-byte attachment controller remains in core
 * until the legacy transport is removed.
 */

import type { TerminalClientModel, TerminalFrameOutcome } from "./terminalClientModel.ts";
import type { TerminalInput } from "./terminalSemanticInput.ts";
import type {
  SemanticTerminalWireEvent,
  TerminalInputOutcome,
  TerminalScreenState,
} from "../semanticTypes.ts";

export interface SemanticTerminalAttachmentDescriptor {
  readonly revision: number;
}

export interface SemanticTerminalAttachmentSnapshot {
  readonly descriptor: SemanticTerminalAttachmentDescriptor;
  readonly sequenceBoundary: number;
  readonly state: TerminalScreenState;
}

export interface SemanticTerminalAttachmentLease {
  readonly attachmentId: string;
  readonly live: boolean;
  readonly snapshot: SemanticTerminalAttachmentSnapshot;
  activate(): void;
}

export interface SemanticTerminalAttachmentPorts {
  attach(
    onEvent: (event: SemanticTerminalWireEvent) => void,
  ): Promise<SemanticTerminalAttachmentLease>;
  detach(attachmentId: string): Promise<void>;
  creditScreen(attachmentId: string, committedSequence: number): Promise<void>;
  acceptsInput(): boolean;
  sendInput(input: TerminalInput): Promise<TerminalInputOutcome>;
  readHistory(startRow: number, rows: number): Promise<unknown>;
  publishAttachmentId(attachmentId: string | null): void;
  reportError(error: unknown): void;
  /** Report an event that belongs only to the retired raw transport. */
  reportRawEvent(error: unknown): void;
  reportState?(
    event: string,
    facts?: Readonly<Record<string, string | number | boolean | null>>,
  ): void;
  model: TerminalClientModel;
  recordModelCommit?(milliseconds: number): void;
  schedule?(task: () => void): void;
}

/** Maintains one ordered semantic attachment and requests baselines on faults. */
export class SemanticTerminalAttachmentController {
  readonly #ports: SemanticTerminalAttachmentPorts;
  readonly #schedule: (task: () => void) => void;
  #generation = 0;
  #sequence = 0;
  #screenCredit: number | null = null;
  #screenDemand = true;
  #lease: SemanticTerminalAttachmentLease | null = null;
  #attached = false;
  #attaching = false;
  #recoveryPending = false;
  #inputReady = false;
  #terminalEnded = false;
  #disposed = false;
  #inputTail: Promise<void> = Promise.resolve();

  constructor(ports: SemanticTerminalAttachmentPorts) {
    this.#ports = ports;
    this.#schedule = ports.schedule ?? ((task) => globalThis.queueMicrotask(task));
  }

  get attachmentId(): string | null {
    return this.#lease?.attachmentId ?? null;
  }

  get attached(): boolean {
    return this.#attached;
  }

  acceptsInput(): boolean {
    return this.#lease !== null && this.#inputReady;
  }

  setScreenDemand(demand: boolean): void {
    if (this.#disposed || demand === this.#screenDemand) return;
    this.#screenDemand = demand;
    if (demand) this.#grantScreenCredit();
  }

  async start(): Promise<void> {
    if (this.#disposed || this.#attached) return;
    if (!this.#ports.acceptsInput()) {
      this.#stopForTerminalEnd("attachment_not_started");
      return;
    }
    await this.#openAttachment();
  }

  submitInput(input: TerminalInput): Promise<TerminalInputOutcome> {
    const result = this.#inputTail.then(() => this.#submitInputNow(input));
    this.#inputTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #submitInputNow(input: TerminalInput): Promise<TerminalInputOutcome> {
    if (!this.#lease || !this.#inputReady) {
      const reason = this.#lease ? "not_ready" : "detached";
      this.#ports.reportState?.("input_unavailable", { reason });
      return { status: "unavailable", reason };
    }
    return this.#ports.sendInput(input);
  }

  async readHistory(startRow: number, rows: number): Promise<TerminalFrameOutcome> {
    try {
      return this.#ports.model.applyHistory(await this.#ports.readHistory(startRow, rows));
    } catch (error) {
      return {
        status: "rejected",
        reason: "invalid",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  requestRecovery(): void {
    if (this.#disposed || this.#terminalEnded) return;
    if (!this.#ports.acceptsInput()) {
      this.#stopForTerminalEnd("attachment_recovery_stopped");
      return;
    }
    this.#ports.reportState?.("attachment_recovery_requested", {
      sequence: this.#sequence,
    });
    this.#inputReady = false;
    this.#screenCredit = null;
    this.#recoveryPending = true;
    this.#schedule(() => {
      if (!this.#disposed && !this.#attaching && this.#recoveryPending) {
        void this.#openAttachment();
      }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#attached = false;
    this.#inputReady = false;
    this.#terminalEnded = true;
    const lease = this.#lease;
    this.#lease = null;
    this.#ports.publishAttachmentId(null);
    if (lease) void this.#ports.detach(lease.attachmentId).catch(() => undefined);
  }

  async #openAttachment(): Promise<void> {
    if (this.#disposed || this.#attaching) return;
    if (!this.#ports.acceptsInput()) {
      this.#stopForTerminalEnd("attachment_open_stopped");
      return;
    }
    this.#ports.reportState?.("attachment_opening");
    this.#attaching = true;
    const generation = ++this.#generation;
    const previous = this.#lease;
    this.#lease = null;
    this.#attached = false;
    this.#inputReady = false;
    this.#terminalEnded = false;
    this.#recoveryPending = false;
    this.#ports.publishAttachmentId(null);
    if (previous) await this.#ports.detach(previous.attachmentId).catch(() => undefined);

    try {
      const lease = await this.#ports.attach((event) => this.#observe(generation, event));
      if (this.#disposed || this.#generation !== generation) {
        await this.#ports.detach(lease.attachmentId).catch(() => undefined);
        return;
      }
      this.#lease = lease;
      this.#terminalEnded = !lease.live;
      this.#ports.publishAttachmentId(lease.attachmentId);
      if (!this.#installBaseline(lease.snapshot)) {
        // A malformed baseline cannot become valid by attaching again. Close
        // this lease and leave one inspectable error instead of retrying it.
        this.#lease = null;
        this.#ports.publishAttachmentId(null);
        await this.#ports.detach(lease.attachmentId).catch(() => undefined);
        return;
      }
      this.#attached = true;
      this.#ports.reportState?.("attachment_ready", {
        sequence: lease.snapshot.sequenceBoundary,
        revision: lease.snapshot.descriptor.revision,
        inputReady: this.#inputReady,
      });
      lease.activate();
    } catch (error) {
      if (this.#ports.acceptsInput()) {
        this.#ports.reportError(error);
      } else {
        this.#stopForTerminalEnd("attachment_open_ended");
      }
    } finally {
      this.#attaching = false;
      if (this.#recoveryPending && !this.#disposed) {
        this.#schedule(() => void this.#openAttachment());
      }
    }
  }

  #installBaseline(snapshot: SemanticTerminalAttachmentSnapshot): boolean {
    this.#inputReady = false;
    this.#sequence = snapshot.sequenceBoundary;
    const startedAt = performance.now();
    const outcome = this.#ports.model.installBaseline({
      sequence: snapshot.sequenceBoundary,
      revision: snapshot.descriptor.revision,
      state: snapshot.state,
    });
    this.#ports.recordModelCommit?.(performance.now() - startedAt);
    if (outcome.status !== "committed") {
      this.#ports.reportError(new Error(`The terminal baseline was refused: ${outcome.detail}`));
      return false;
    }
    this.#inputReady = !this.#terminalEnded && this.#ports.acceptsInput();
    this.#screenCredit = snapshot.sequenceBoundary;
    this.#grantScreenCredit();
    return true;
  }

  #observe(generation: number, event: SemanticTerminalWireEvent): void {
    if (this.#disposed || this.#generation !== generation) return;
    if (event.sequence < this.#sequence) {
      this.requestRecovery();
      return;
    }
    this.#sequence = event.sequence;
    switch (event.event) {
      case "screen": {
        const startedAt = performance.now();
        const outcome = this.#ports.model.applyScreen({
          sequence: event.sequence,
          revision: event.revision,
          state: event.state,
        });
        this.#ports.recordModelCommit?.(performance.now() - startedAt);
        if (outcome.status !== "committed") {
          this.#ports.reportState?.("screen_rejected", {
            sequence: event.sequence,
            reason: outcome.reason,
          });
          this.#ports.reportError(new Error(`The terminal frame was refused: ${outcome.detail}`));
          this.requestRecovery();
          return;
        }
        this.#screenCredit = event.sequence;
        this.#grantScreenCredit();
        return;
      }
      case "effects": {
        const startedAt = performance.now();
        const outcome = this.#ports.model.applyEffects(event.effects);
        this.#ports.recordModelCommit?.(performance.now() - startedAt);
        if (outcome.status !== "committed") {
          this.#ports.reportError(new Error(`The terminal effects were refused: ${outcome.detail}`));
          if (outcome.reason === "stale") this.requestRecovery();
        }
        return;
      }
      case "resync_required":
        this.requestRecovery();
        return;
      case "detached":
        if (!this.#ports.acceptsInput()) {
          this.#stopForTerminalEnd("attachment_detached_after_exit");
        } else if (!this.#terminalEnded) {
          this.requestRecovery();
        }
        return;
      case "exited":
        this.#stopForTerminalEnd("terminal_exited");
        return;
      case "metadata_changed":
      case "agent_activity_changed":
        return;
      case "output":
      case "replay":
        this.#ports.reportRawEvent(new Error("This terminal session has no byte path to write child output into"));
        this.requestRecovery();
        return;
      default: {
        const unhandled: never = event;
        void unhandled;
      }
    }
  }

  #grantScreenCredit(): void {
    const committedSequence = this.#screenCredit;
    const lease = this.#lease;
    if (this.#terminalEnded || !this.#screenDemand || committedSequence === null || !lease) return;
    this.#screenCredit = null;
    const generation = this.#generation;
    void this.#ports.creditScreen(lease.attachmentId, committedSequence).catch((error: unknown) => {
      if (this.#disposed || this.#terminalEnded || this.#generation !== generation || this.#lease !== lease) {
        return;
      }
      if (!this.#ports.acceptsInput()) {
        this.#stopForTerminalEnd("screen_credit_ended");
        return;
      }
      this.#ports.reportState?.("screen_credit_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.requestRecovery();
    });
  }

  #stopForTerminalEnd(event: string): void {
    this.#terminalEnded = true;
    this.#inputReady = false;
    this.#screenCredit = null;
    this.#recoveryPending = false;
    this.#ports.reportState?.(event, { sequence: this.#sequence });
  }
}
