import {
  attachTerminal,
  closeTerminal,
  detachTerminal,
  listTerminals,
  resizeTerminal,
  spawnTerminal,
  subscribeTerminalRegistry,
  updateTerminalMetadata,
  writeTerminal,
  type TerminalAttachmentHandle,
  type TerminalRegistrySubscription,
} from "@shipctl/core/platform";
import { useTerminalStore } from "./useTerminalStore.ts";
import {
  publishTerminalClosed,
  publishTerminalDescriptor,
} from "./terminalSessions.ts";
import { mergeTerminalDescriptorActivity } from "./terminalAgentActivity.ts";
import type {
  TerminalAttachmentId,
  TerminalDescriptor,
  TerminalEvent,
  TerminalId,
  TerminalLaunchRequest,
  TerminalMetadata,
  TerminalRegistryEvent,
} from "./types.ts";

interface ObservedDescriptor {
  descriptor: TerminalDescriptor;
  observation: number;
}

/**
 * Renderer-side projection of the host terminal registry. It owns no process
 * lifecycle: initialize/list, attach, detach, and close all delegate to the
 * Rust host, while Zustand receives only serializable descriptor projections.
 */
export class TerminalClientRuntime {
  #descriptors = new Map<TerminalId, ObservedDescriptor>();
  #removals = new Map<TerminalId, number>();
  #observation = 0;
  #registrySubscription: TerminalRegistrySubscription | null = null;
  #registryStarting: Promise<void> | null = null;
  #registryDesired = false;

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
      const subscription = await subscribeTerminalRegistry((event) => {
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
      this.observeDescriptor(event.descriptor);
      return;
    }
    const descriptor = this.#descriptors.get(event.terminalId)?.descriptor;
    this.#removals.set(event.terminalId, ++this.#observation);
    this.#descriptors.delete(event.terminalId);
    useTerminalStore.getState().removeTerminalDescriptor(event.terminalId);
    if (descriptor) publishTerminalClosed(descriptor);
  }

  async reconcile(): Promise<readonly TerminalDescriptor[]> {
    const requestBoundary = this.#observation;
    const previous = this.#descriptors;
    const listed = await listTerminals();
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
    for (const [terminalId, observed] of this.#descriptors) {
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
      if (!next.has(terminalId)) publishTerminalClosed(observed.descriptor);
    }
    for (const descriptor of descriptors) {
      const prior = previous.get(descriptor.id)?.descriptor;
      if (!prior) publishTerminalDescriptor(descriptor, "adopted");
      else if (prior.revision < descriptor.revision) {
        publishTerminalDescriptor(descriptor, "updated");
      }
    }
    return descriptors;
  }

  observeDescriptor(
    descriptor: TerminalDescriptor,
    event: "launched" | "adopted" | "updated" = "updated",
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
    publishTerminalDescriptor(merged, event);
    return true;
  }

  observeEvent(_terminalId: TerminalId, event: TerminalEvent): void {
    if (
      event.event === "metadata_changed"
      || event.event === "agent_activity_changed"
      || event.event === "exited"
    ) {
      this.observeDescriptor(event.descriptor);
    }
  }

  async spawn(request: TerminalLaunchRequest): Promise<TerminalDescriptor> {
    const descriptor = await spawnTerminal(request);
    this.observeDescriptor(descriptor, "launched");
    return descriptor;
  }

  async updateMetadata(
    terminalId: TerminalId,
    metadata: TerminalMetadata,
  ): Promise<TerminalDescriptor> {
    const descriptor = await updateTerminalMetadata(terminalId, metadata);
    this.observeDescriptor(descriptor);
    return descriptor;
  }

  attach(
    terminalId: TerminalId,
    claimsResize: boolean,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalAttachmentHandle> {
    return attachTerminal(terminalId, claimsResize, (event) => {
      this.observeEvent(terminalId, event);
      onEvent(event);
    });
  }

  detach(attachmentId: TerminalAttachmentId): Promise<void> {
    return detachTerminal(attachmentId);
  }

  async write(terminalId: TerminalId, data: string | Uint8Array): Promise<void> {
    const descriptor = this.descriptor(terminalId);
    if (!descriptor || descriptor.lifecycle !== "running") {
      throw new Error("Terminal input is unavailable unless the host terminal is running");
    }
    await writeTerminal(terminalId, data);
  }

  async resize(
    terminalId: TerminalId,
    attachmentId: TerminalAttachmentId,
    columns: number,
    rows: number,
  ): Promise<void> {
    const descriptor = this.descriptor(terminalId);
    if (!descriptor || descriptor.lifecycle !== "running") return;
    await resizeTerminal(terminalId, attachmentId, columns, rows);
  }

  async close(terminalId: TerminalId): Promise<void> {
    await closeTerminal(terminalId);
    const descriptor = this.#descriptors.get(terminalId)?.descriptor;
    this.#descriptors.delete(terminalId);
    useTerminalStore.getState().removeTerminalDescriptor(terminalId);
    if (descriptor) publishTerminalClosed(descriptor);
  }
}

export const TERMINAL_CLIENT_RUNTIME = new TerminalClientRuntime();
