import {
  type RawTerminalAttachment,
  type RawTerminalOccurrence,
  type TerminalDriverId,
  type TerminalHostDescriptor,
  type TerminalHostLifecycleEvent,
  type TerminalHostLaunchRequest,
  type TerminalHostPort,
} from "@shipctl/module-api";
import {
  attachRawTerminal,
  closeTerminal,
  detachTerminal,
  listTerminals,
  resizeTerminal,
  spawnTerminal,
  subscribeTerminalRegistry,
  writeTerminal,
} from "@shipctl/core/platform";
import { useThemeStore } from "@shipctl/core/appearance";

type PlatformTerminalDescriptor = Awaited<ReturnType<typeof listTerminals>>[number];
type PlatformTerminalId = Parameters<typeof attachRawTerminal>[0];
type PlatformAttachmentId = Parameters<typeof detachTerminal>[0];
type PlatformLaunchRequest = Parameters<typeof spawnTerminal>[0];

interface RawTerminalEvent {
  readonly event: string;
  readonly sequence?: number;
  readonly data?: number[];
}

interface RawAttachmentState {
  readonly attachmentId: string;
  readonly queue: RawOccurrenceQueue;
}

class RawOccurrenceQueue implements AsyncIterable<RawTerminalOccurrence> {
  readonly #queued: RawTerminalOccurrence[] = [];
  #next: ((result: IteratorResult<RawTerminalOccurrence>) => void) | null = null;
  #closed = false;

  push(occurrence: RawTerminalOccurrence): void {
    if (this.#closed) return;
    const next = this.#next;
    this.#next = null;
    if (next) next({ value: occurrence, done: false });
    else this.#queued.push(occurrence);
  }

  close(): void {
    this.#closed = true;
    const next = this.#next;
    this.#next = null;
    next?.({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RawTerminalOccurrence> {
    while (true) {
      const queued = this.#queued.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.#closed) return;
      const result = await new Promise<IteratorResult<RawTerminalOccurrence>>((resolve) => {
        this.#next = resolve;
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

function hostDescriptor(descriptor: PlatformTerminalDescriptor): TerminalHostDescriptor {
  return {
    id: descriptor.id,
    driverId: descriptor.driverId,
    lifecycle: descriptor.lifecycle,
    columns: descriptor.columns,
    rows: descriptor.rows,
    label: descriptor.metadata.label,
    projectPath: descriptor.metadata.projectPath,
  };
}

function terminalColorTheme(): PlatformLaunchRequest["colorTheme"] {
  const theme = useThemeStore.getState().theme;
  return {
    foreground: theme.termForeground,
    background: theme.appBg,
    palette: [
      theme.termBlack,
      theme.termRed,
      theme.termGreen,
      theme.termYellow,
      theme.termBlue,
      theme.termMagenta,
      theme.termCyan,
      theme.termWhite,
      theme.termBrightBlack,
      theme.termBrightRed,
      theme.termBrightGreen,
      theme.termBrightYellow,
      theme.termBrightBlue,
      theme.termBrightMagenta,
      theme.termBrightCyan,
      theme.termBrightWhite,
    ],
  };
}

/** Decode only the facts that the generic raw host stream guarantees. */
function rawEvent(raw: unknown): RawTerminalEvent {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object" || !("event" in value)) {
    throw new Error("Terminal raw stream delivered an invalid event");
  }
  const event = value as RawTerminalEvent;
  if (typeof event.event !== "string") {
    throw new Error("Terminal raw stream event has no name");
  }
  if (event.event === "output") {
    if (!Number.isSafeInteger(event.sequence) || !Array.isArray(event.data)) {
      throw new Error("Terminal raw output event is invalid");
    }
  }
  return event;
}

/**
 * Browser implementation of the generic terminal host port. Its composition
 * caller is AppShell; it translates host IPC DTOs into module API facts.
 */
export class TerminalHostAdapter implements TerminalHostPort {
  readonly #attachments = new Map<string, RawAttachmentState>();

  async list(): Promise<readonly TerminalHostDescriptor[]> {
    return (await listTerminals()).map(hostDescriptor);
  }

  async launch(request: TerminalHostLaunchRequest): Promise<TerminalHostDescriptor> {
    const descriptor = await spawnTerminal({
      driverId: request.driverId,
      target: {
        type: "program",
        program: request.command,
        argv: request.arguments ?? [],
      },
      cwd: request.cwd,
      environment: {},
      columns: request.columns,
      rows: request.rows,
      colorTheme: terminalColorTheme(),
      metadata: {
        label: request.label,
        cwd: request.cwd,
        projectPath: request.projectPath ?? null,
        displayCommand: request.command,
        createdAtMs: Date.now(),
        owner: { type: "core" },
        ownerMetadata: null,
        presentation: null,
      },
    });
    return hostDescriptor(descriptor);
  }

  async observe(
    listener: (event: TerminalHostLifecycleEvent) => void,
  ): Promise<() => void> {
    const subscription = await subscribeTerminalRegistry((event) => {
      if (event.event === "upserted") listener({ type: "upserted", descriptor: hostDescriptor(event.descriptor) });
      else listener({ type: "removed", terminalId: event.terminalId });
    });
    return () => subscription.dispose();
  }

  async attachRaw(terminalId: string, driverId: TerminalDriverId): Promise<RawTerminalAttachment> {
    const descriptor = (await listTerminals())
      .find((candidate) => candidate.id === terminalId);
    if (!descriptor) throw new Error(`Terminal ${terminalId} was not found`);
    if (descriptor.driverId !== driverId) {
      throw new Error(`Terminal ${terminalId} is selected for ${descriptor.driverId}, not ${driverId}`);
    }

    const queue = new RawOccurrenceQueue();
    const bootstrap = {
      activate: () => undefined,
      deliver: (raw: unknown) => {
        const event = rawEvent(raw);
      if (event.event === "output") {
          queue.push({ sequence: event.sequence!, bytes: new Uint8Array(event.data!) });
      } else if (event.event === "exited" || event.event === "detached") {
        queue.close();
      }
      },
    };
    const attachment = await attachRawTerminal(terminalId as PlatformTerminalId, true, bootstrap);
    bootstrap.activate();
    const state = { attachmentId: attachment.attachmentId, queue };
    this.#attachments.set(terminalId, state);

    return {
      id: attachment.attachmentId,
      terminalId,
      driverId,
      occurrences: queue,
      detach: async () => {
        if (this.#attachments.get(terminalId) !== state) return;
        this.#attachments.delete(terminalId);
        queue.close();
        await detachTerminal(attachment.attachmentId as PlatformAttachmentId);
      },
    };
  }

  write(terminalId: string, bytes: Uint8Array): Promise<void> {
    return writeTerminal(terminalId as PlatformTerminalId, bytes);
  }

  async resize(terminalId: string, columns: number, rows: number): Promise<void> {
    const attachment = this.#attachments.get(terminalId);
    if (!attachment) throw new Error(`Terminal ${terminalId} has no raw attachment`);
    await resizeTerminal(
      terminalId as PlatformTerminalId,
      attachment.attachmentId as PlatformAttachmentId,
      columns,
      rows,
    );
  }

  async close(terminalId: string): Promise<void> {
    await closeTerminal(terminalId as PlatformTerminalId);
  }
}

export const terminalHostAdapter = new TerminalHostAdapter();
