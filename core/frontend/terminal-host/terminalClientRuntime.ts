import {
  attachRawTerminal,
  closeTerminal,
  detachTerminal,
  getErrorCode,
  getErrorMessage,
  listTerminals,
  resizeTerminal,
  spawnTerminal,
  subscribeTerminalRegistry,
  updateTerminalMetadata,
  writeTerminal,
  type RawTerminalAttachmentHandle,
  type TerminalRegistrySubscription,
} from "@shipctl/core/platform";
import { reportTerminalDiagnostic } from "@shipctl/core/shared";
import { useTerminalStore } from "./useTerminalStore.ts";
import {
  publishTerminalClosed,
  publishTerminalDescriptor,
  type TerminalProjectionEvent,
} from "./terminalSessions.ts";
import { mergeTerminalDescriptorActivity } from "./terminalAgentActivity.ts";
import type {
  TerminalAttachmentId,
  TerminalCloseOutcome,
  TerminalCloseResult,
  TerminalDescriptor,
  TerminalId,
  TerminalInputOutcome,
  TerminalLaunchRequest,
  TerminalMetadata,
  TerminalRawAttachmentBootstrap,
  TerminalRegistryEvent,
} from "./types.ts";

/** Facts on the host raw stream. No terminal interpretation enters core. */
export interface RawTerminalHostEvent {
  readonly event: "output" | "exited" | "detached" | "resync_required";
  readonly sequence?: number;
  readonly data?: readonly number[];
  readonly descriptor?: TerminalDescriptor;
  readonly reason?: string;
}

interface ObservedDescriptor {
  descriptor: TerminalDescriptor;
  observation: number;
}

/**
 * Every host call the runtime makes. Injecting it lets the ordering rules be
 * proved with controlled promises instead of a live Tauri bridge.
 */
export interface TerminalHostPort {
  list(): Promise<TerminalDescriptor[]>;
  spawn(request: TerminalLaunchRequest): Promise<TerminalDescriptor>;
  updateMetadata(
    terminalId: TerminalId,
    metadata: TerminalMetadata,
  ): Promise<TerminalDescriptor>;
  subscribeRegistry(
    onEvent: (event: TerminalRegistryEvent) => void,
  ): Promise<TerminalRegistrySubscription>;
  attach(
    terminalId: TerminalId,
    claimsResize: boolean,
    bootstrap: TerminalRawAttachmentBootstrap,
  ): Promise<RawTerminalAttachmentHandle>;
  detach(attachmentId: TerminalAttachmentId): Promise<void>;
  write(terminalId: TerminalId, data: string | Uint8Array): Promise<void>;
  resize(
    terminalId: TerminalId,
    attachmentId: TerminalAttachmentId,
    columns: number,
    rows: number,
  ): Promise<void>;
  close(terminalId: TerminalId): Promise<TerminalCloseResult>;
}

const TAURI_TERMINAL_HOST: TerminalHostPort = {
  list: listTerminals,
  spawn: spawnTerminal,
  updateMetadata: updateTerminalMetadata,
  subscribeRegistry: subscribeTerminalRegistry,
  attach: attachRawTerminal,
  detach: detachTerminal,
  write: writeTerminal,
  resize: resizeTerminal,
  close: closeTerminal,
};

/**
 * Host error codes that mean "this terminal is no longer taking input". They
 * are a normal outcome of a keystroke racing an exit or a close, not a failure
 * to report to the user.
 */
const EXPECTED_UNAVAILABILITY = new Set([
  "not_found",
  "exited",
  "closing",
  "shutting_down",
]);

/**
 * Renderer-side projection of the host terminal registry.
 *
 * It owns no process lifecycle: spawn, attach, detach, and close all delegate
 * to the Rust host. It owns exactly one thing — the frontend descriptor
 * registry — and every mutation of it goes through the reducer below. Nothing
 * else may write the descriptor map, the removal tombstones, the Zustand
 * projection, or the module lifecycle stream, so an in-flight `list` can never
 * resurrect a terminal the host has removed.
 */
export class TerminalClientRuntime {
  readonly #host: TerminalHostPort;
  #descriptors = new Map<TerminalId, ObservedDescriptor>();
  #removals = new Map<TerminalId, number>();
  /** Terminals whose exit has been announced to modules exactly once. */
  #announcedExit = new Set<TerminalId>();
  /** Clean core shells whose host removal has already been requested. */
  #retiringCleanExit = new Set<TerminalId>();
  #observation = 0;
  #registrySubscription: TerminalRegistrySubscription | null = null;
  #registryStarting: Promise<void> | null = null;
  #registryDesired = false;

  constructor(host: TerminalHostPort = TAURI_TERMINAL_HOST) {
    this.#host = host;
  }

  descriptors(): readonly TerminalDescriptor[] {
    return [...this.#descriptors.values()]
      .sort((left, right) => left.observation - right.observation)
      .map(({ descriptor }) => descriptor);
  }

  descriptor(terminalId: TerminalId): TerminalDescriptor | undefined {
    return this.#descriptors.get(terminalId)?.descriptor;
  }

  startRegistry(): Promise<void> {
    this.#registryDesired = true;
    if (this.#registrySubscription) return Promise.resolve();
    if (this.#registryStarting) return this.#registryStarting;
    this.#registryStarting = (async () => {
      const subscription = await this.#host.subscribeRegistry((event) => {
        this.observeRegistryEvent(event);
      });
      this.#registrySubscription = subscription;
      if (!this.#registryDesired) return;
      await this.reconcile();
    })().finally(() => {
      this.#registryStarting = null;
    });
    return this.#registryStarting;
  }

  async stopRegistry(): Promise<void> {
    this.#registryDesired = false;
    await this.#registryStarting?.catch(() => undefined);
    if (this.#registryDesired) return;
    const subscription = this.#registrySubscription;
    this.#registrySubscription = null;
    if (subscription) await subscription.dispose();
  }

  observeRegistryEvent(event: TerminalRegistryEvent): void {
    if (event.event === "upserted") {
      this.#commitUpsert(event.descriptor, "updated");
      return;
    }
    this.#commitRemoval(event.terminalId);
  }

  async reconcile(): Promise<readonly TerminalDescriptor[]> {
    const requestBoundary = this.#observation;
    const listed = await this.#host.list();
    return this.#commitSnapshot(listed, requestBoundary);
  }

  observeDescriptor(
    descriptor: TerminalDescriptor,
    event: TerminalProjectionEvent = "updated",
  ): boolean {
    return this.#commitUpsert(descriptor, event);
  }

  async spawn(request: TerminalLaunchRequest): Promise<TerminalDescriptor> {
    const descriptor = await this.#host.spawn(request);
    this.#commitUpsert(descriptor, "launched");
    return descriptor;
  }

  async updateMetadata(
    terminalId: TerminalId,
    metadata: TerminalMetadata,
  ): Promise<TerminalDescriptor> {
    const descriptor = await this.#host.updateMetadata(terminalId, metadata);
    this.#commitUpsert(descriptor, "updated");
    return descriptor;
  }

  /** Open a generic attachment of exact child bytes. */
  attach(
    terminalId: TerminalId,
    claimsResize: boolean,
    onEvent: (event: RawTerminalHostEvent) => void,
  ): Promise<RawTerminalAttachmentHandle> {
    return this.#host.attach(
      terminalId,
      claimsResize,
      {
        deliver: (raw) => onEvent(raw as RawTerminalHostEvent),
        activate: () => undefined,
      },
    );
  }

  detach(attachmentId: TerminalAttachmentId): Promise<void> {
    return this.#host.detach(attachmentId);
  }

  /**
   * Submit exact bytes and report what happened.
   *
   * Legacy: a client that decides its own bytes keeps a second copy of the
   * child's modes, which is what {@link input} exists to end.
   */
  async write(
    terminalId: TerminalId,
    data: string | Uint8Array,
  ): Promise<TerminalInputOutcome> {
    return this.#submit(terminalId, () => this.#host.write(terminalId, data));
  }

  /**
   * The one admission rule, for both input paths.
   *
   * A terminal that has exited, is closing, or is already gone is a normal
   * outcome, not an error: the keystroke simply raced the lifecycle. Only a
   * transport, validation, or host I/O failure is reported as a failure.
   */
  async #submit(
    terminalId: TerminalId,
    send: () => Promise<unknown>,
  ): Promise<TerminalInputOutcome> {
    const descriptor = this.descriptor(terminalId);
    if (!descriptor || descriptor.lifecycle !== "running") {
      return { status: "unavailable", reason: descriptor?.lifecycle ?? "not_found" };
    }
    try {
      await send();
      return { status: "accepted" };
    } catch (error) {
      // The host is the final authority: the lifecycle may have changed since
      // the projection above was read.
      const code = getErrorCode(error);
      if (code && EXPECTED_UNAVAILABILITY.has(code)) {
        return { status: "unavailable", reason: code };
      }
      return { status: "failed", error };
    }
  }

  async resize(
    terminalId: TerminalId,
    attachmentId: TerminalAttachmentId,
    columns: number,
    rows: number,
  ): Promise<void> {
    const descriptor = this.descriptor(terminalId);
    if (!descriptor || descriptor.lifecycle !== "running") return;
    await this.#host.resize(terminalId, attachmentId, columns, rows);
  }

  /** Close a terminal from the authoritative host result.
   *
   * A successful host close returns only after the record has been removed.
   * The registry event uses a separate IPC channel and can arrive later, so it
   * cannot be the acknowledgement for this command. Commit the confirmed
   * absence here; a later `Removed` event is an idempotent duplicate.
   */
  async close(terminalId: TerminalId): Promise<TerminalCloseOutcome> {
    const descriptor = this.descriptor(terminalId);
    reportTerminalDiagnostic({
      occurredAt: new Date().toISOString(),
      terminalId,
      event: "close_requested",
      facts: {
        projectionPresent: Boolean(descriptor),
        lifecycle: descriptor?.lifecycle ?? null,
        revision: descriptor?.revision ?? null,
        ownerType: descriptor?.metadata.owner.type ?? null,
      },
    });

    try {
      const result = await this.#host.close(terminalId);
      const projectionRemoved = this.#commitRemoval(terminalId);
      reportTerminalDiagnostic({
        occurredAt: new Date().toISOString(),
        terminalId,
        event: "close_committed",
        facts: {
          hostExisted: result.existed,
          exitCode: result.exit?.code ?? null,
          exitReason: result.exit?.reason ?? null,
          projectionRemoved,
        },
      });
      return { status: "closed" };
    } catch (error) {
      reportTerminalDiagnostic({
        occurredAt: new Date().toISOString(),
        terminalId,
        event: "close_failed",
        facts: {
          code: getErrorCode(error),
          message: getErrorMessage(error),
        },
      });
      throw error;
    }
  }

  // ── the registry reducer: the only writer of frontend terminal state ──

  #commitUpsert(
    descriptor: TerminalDescriptor,
    event: TerminalProjectionEvent,
  ): boolean {
    const current = this.#descriptors.get(descriptor.id)?.descriptor;
    if (current && current.revision >= descriptor.revision) return false;
    const merged = mergeTerminalDescriptorActivity(current, descriptor);
    this.#descriptors.set(descriptor.id, {
      descriptor: merged,
      observation: ++this.#observation,
    });
    this.#removals.delete(descriptor.id);
    useTerminalStore.getState().upsertTerminalDescriptor(merged);
    this.#publishProjection(merged, event);
    this.#retireCleanCoreExit(merged);
    return true;
  }

  #commitRemoval(terminalId: TerminalId): boolean {
    const descriptor = this.#descriptors.get(terminalId)?.descriptor;
    // The tombstone is written even for a terminal never observed here, so a
    // list request already in flight cannot restore it.
    this.#removals.set(terminalId, ++this.#observation);
    this.#descriptors.delete(terminalId);
    this.#announcedExit.delete(terminalId);
    this.#retiringCleanExit.delete(terminalId);
    useTerminalStore.getState().removeTerminalDescriptor(terminalId);
    if (!descriptor) return false;
    publishTerminalClosed(descriptor);
    return true;
  }

  #commitSnapshot(
    listed: readonly TerminalDescriptor[],
    requestBoundary: number,
  ): readonly TerminalDescriptor[] {
    const previous = this.#descriptors;
    const next = new Map<TerminalId, ObservedDescriptor>();
    for (const descriptor of listed) {
      const merged = mergeTerminalDescriptorActivity(
        previous.get(descriptor.id)?.descriptor,
        descriptor,
      );
      next.set(descriptor.id, {
        descriptor: merged,
        observation: ++this.#observation,
      });
    }
    // Preserve descriptors observed while list was in flight. Their revision
    // wins over an older row from that snapshot, and a newly created terminal
    // cannot disappear because its list request raced creation.
    for (const [terminalId, observed] of previous) {
      const row = next.get(terminalId);
      if (
        observed.observation > requestBoundary ||
        (row && observed.descriptor.revision > row.descriptor.revision)
      ) {
        next.set(terminalId, observed);
      }
    }
    const racedRemovals = new Map<TerminalId, number>();
    for (const [terminalId, observation] of this.#removals) {
      if (observation > requestBoundary) {
        next.delete(terminalId);
        racedRemovals.set(terminalId, observation);
      }
    }
    this.#removals = racedRemovals;
    this.#descriptors = next;
    const descriptors = this.descriptors();
    useTerminalStore.getState().reconcileTerminalDescriptors(descriptors);
    for (const [terminalId, observed] of previous) {
      if (!next.has(terminalId)) {
        this.#announcedExit.delete(terminalId);
        publishTerminalClosed(observed.descriptor);
      }
    }
    for (const descriptor of descriptors) {
      const prior = previous.get(descriptor.id)?.descriptor;
      if (!prior) this.#publishProjection(descriptor, "adopted");
      else if (prior.revision < descriptor.revision) {
        this.#publishProjection(descriptor, "updated");
      }
      this.#retireCleanCoreExit(descriptor);
    }
    return descriptors;
  }

  /**
   * Remove a normal interactive shell after its child exits successfully.
   *
   * The host stays authoritative: this asks its existing idempotent close
   * operation to remove the retained record, and the successful result removes
   * the tab. Module sessions keep their owner lifecycle, and a non-zero exit
   * keeps its final screen for diagnosis.
   */
  #retireCleanCoreExit(descriptor: TerminalDescriptor): void {
    if (
      descriptor.lifecycle !== "exited"
      || descriptor.exit?.reason !== "process_exit"
      || descriptor.exit.code !== 0
      || descriptor.metadata.owner.type !== "core"
      || this.#retiringCleanExit.has(descriptor.id)
    ) return;

    this.#retiringCleanExit.add(descriptor.id);
    void this.close(descriptor.id).catch((error: unknown) => {
      this.#retiringCleanExit.delete(descriptor.id);
      if (import.meta.env?.DEV) {
        console.error("Failed to retire cleanly exited terminal:", error);
      }
    });
  }

  /** Module lifecycle events follow committed transitions, and exit once. */
  #publishProjection(
    descriptor: TerminalDescriptor,
    event: TerminalProjectionEvent,
  ): void {
    if (descriptor.lifecycle === "exited") {
      if (this.#announcedExit.has(descriptor.id)) return;
      this.#announcedExit.add(descriptor.id);
    }
    publishTerminalDescriptor(descriptor, event);
  }
}

export const TERMINAL_CLIENT_RUNTIME = new TerminalClientRuntime();
