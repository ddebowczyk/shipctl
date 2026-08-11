import {
  createTerminalAttachmentBootstrap,
  type TerminalAttachmentBootstrap,
} from "./terminalAttachmentBootstrap.ts";
import {
  anchorTerminal,
  attachTerminal,
  closeTerminal,
  detachTerminal,
  getErrorCode,
  listTerminals,
  historyTerminal,
  inputTerminal,
  releaseTerminalAnchor,
  resizeTerminal,
  resolveTerminalAnchor,
  selectTerminal,
  spawnTerminal,
  subscribeTerminalRegistry,
  updateTerminalMetadata,
  writeTerminal,
  type TerminalAttachmentHandle,
  type TerminalRegistrySubscription,
} from "@shipctl/core/platform";
import type { TerminalInput } from "./terminalSemanticInput.ts";
import { useTerminalStore } from "./useTerminalStore.ts";
import {
  publishTerminalClosed,
  publishTerminalDescriptor,
  type TerminalProjectionEvent,
} from "./terminalSessions.ts";
import { mergeTerminalDescriptorActivity } from "./terminalAgentActivity.ts";
import type {
  TerminalAnchorId,
  TerminalAttachmentId,
  TerminalCloseOutcome,
  TerminalCloseResult,
  TerminalDescriptor,
  TerminalEvent,
  TerminalId,
  TerminalInputOutcome,
  TerminalLaunchRequest,
  TerminalMetadata,
  TerminalProjectedPoint,
  TerminalProjectedSpace,
  TerminalRegistryEvent,
  TerminalSelectionRequest,
  TerminalSelectionState,
  TerminalTransport,
} from "./types.ts";

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
    bootstrap: TerminalAttachmentBootstrap,
    transport: TerminalTransport,
  ): Promise<TerminalAttachmentHandle>;
  detach(attachmentId: TerminalAttachmentId): Promise<void>;
  write(terminalId: TerminalId, data: string | Uint8Array): Promise<void>;
  /** Semantic input. Answers how many bytes the child's modes made of it. */
  input(terminalId: TerminalId, input: TerminalInput): Promise<number>;
  /**
   * The rows behind the viewport. Unchecked here: the client model's decoder
   * is the only door into client state.
   */
  history(terminalId: TerminalId, startRow: number, rows: number): Promise<unknown>;
  /** Pin one cell, so a client can keep naming that line. Unchecked. */
  anchor(
    terminalId: TerminalId,
    space: TerminalProjectedSpace,
    at: TerminalProjectedPoint,
  ): Promise<unknown>;
  /** Where an anchored line is now. Unchecked. */
  resolveAnchor(terminalId: TerminalId, anchor: TerminalAnchorId): Promise<unknown>;
  /** Drop an anchor. Unchecked. */
  releaseAnchor(terminalId: TerminalId, anchor: TerminalAnchorId): Promise<unknown>;
  /** Select by intent. The host decides which cells that covers. */
  select(
    terminalId: TerminalId,
    request: TerminalSelectionRequest,
  ): Promise<TerminalSelectionState>;
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
  attach: attachTerminal,
  detach: detachTerminal,
  write: writeTerminal,
  input: inputTerminal,
  history: historyTerminal,
  anchor: anchorTerminal,
  resolveAnchor: resolveTerminalAnchor,
  releaseAnchor: releaseTerminalAnchor,
  select: selectTerminal,
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

  observeEvent(_terminalId: TerminalId, event: TerminalEvent): void {
    if (
      event.event === "metadata_changed"
      || event.event === "agent_activity_changed"
      || event.event === "exited"
    ) {
      this.#commitUpsert(event.descriptor, "updated");
    }
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

  /**
   * Open an attachment in the encoding the caller names.
   *
   * The encoding has no default here on purpose. It is the one thing that
   * decides whether this client interprets the child's bytes or reads the
   * host's state, and a default is how that choice stayed invisible while the
   * webview sat on the byte path. It dies with area 05, and so does the
   * parameter.
   */
  attach(
    terminalId: TerminalId,
    claimsResize: boolean,
    onEvent: (event: TerminalEvent) => void,
    transport: TerminalTransport,
  ): Promise<TerminalAttachmentHandle> {
    return this.#host.attach(
      terminalId,
      claimsResize,
      createTerminalAttachmentBootstrap((event) => {
        this.observeEvent(terminalId, event);
        onEvent(event);
      }),
      transport,
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
   * Report what a person did and let the host encode it from the child's modes.
   *
   * The host answers with a byte count that this does not carry on: zero is a
   * normal answer — a focus report or a mouse motion the child never asked for
   * — and a caller that acted on it would be deciding, from the client side,
   * what the terminal does with input.
   */
  async input(terminalId: TerminalId, input: TerminalInput): Promise<TerminalInputOutcome> {
    return this.#submit(terminalId, () => this.#host.input(terminalId, input));
  }

  /**
   * Read the rows behind the viewport.
   *
   * A read, so it does not pass through the input admission rule above: state
   * outlives the child, and a terminal that has exited still has scrollback a
   * person may want to read. The answer is passed on unchecked, because the
   * client model decodes it fail-closed.
   */
  history(terminalId: TerminalId, startRow: number, rows: number): Promise<unknown> {
    return this.#host.history(terminalId, startRow, rows);
  }

  /**
   * Pin one cell, and keep the handle the host minted.
   *
   * Reads, like {@link history}: what a client points at outlives the child.
   * The host holds the pin until it is released, so whoever asks for one owns
   * releasing it.
   */
  anchor(
    terminalId: TerminalId,
    space: TerminalProjectedSpace,
    at: TerminalProjectedPoint,
  ): Promise<unknown> {
    return this.#host.anchor(terminalId, space, at);
  }

  resolveAnchor(terminalId: TerminalId, anchor: TerminalAnchorId): Promise<unknown> {
    return this.#host.resolveAnchor(terminalId, anchor);
  }

  releaseAnchor(terminalId: TerminalId, anchor: TerminalAnchorId): Promise<unknown> {
    return this.#host.releaseAnchor(terminalId, anchor);
  }

  /**
   * Ask the host to select, and receive what it holds.
   *
   * A host operation rather than an input, so it does not pass through the
   * admission rule either: selecting is reading, and the answer carries the
   * text because only the host can unwrap a wrapped line or drop the spacer
   * half of a wide grapheme.
   */
  select(
    terminalId: TerminalId,
    request: TerminalSelectionRequest,
  ): Promise<TerminalSelectionState> {
    return this.#host.select(terminalId, request);
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

  /**
   * Close a terminal and report whether the removal was observed.
   *
   * The host publishes `Removed` before the close command resolves, so the
   * normal path is that the reducer has already committed the absence. If the
   * channel event has not arrived, one reconcile settles it. If the terminal is
   * still present after that, the outcome says so instead of a second writer
   * synthesizing a removal the host never published.
   */
  async close(terminalId: TerminalId): Promise<TerminalCloseOutcome> {
    await this.#host.close(terminalId);
    if (!this.#descriptors.has(terminalId)) return { status: "closed" };
    await this.reconcile();
    if (!this.#descriptors.has(terminalId)) return { status: "closed" };
    return { status: "unconfirmed", terminalId };
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
    return true;
  }

  #commitRemoval(terminalId: TerminalId): boolean {
    const descriptor = this.#descriptors.get(terminalId)?.descriptor;
    // The tombstone is written even for a terminal never observed here, so a
    // list request already in flight cannot restore it.
    this.#removals.set(terminalId, ++this.#observation);
    this.#descriptors.delete(terminalId);
    this.#announcedExit.delete(terminalId);
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
    }
    return descriptors;
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
