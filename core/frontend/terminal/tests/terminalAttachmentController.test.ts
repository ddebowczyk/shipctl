import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TerminalAttachmentController,
  type TerminalAttachmentLease,
  type TerminalAttachmentPorts,
} from "../terminalAttachmentController.ts";
import type {
  TerminalAttachmentId,
  TerminalDescriptor,
  TerminalEvent,
  TerminalInputOutcome,
  TerminalReplay,
} from "../types.ts";

/** Flush every pending microtask without waiting on wall-clock time. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function descriptor(id: string): TerminalDescriptor {
  return { id, lifecycle: "running" } as unknown as TerminalDescriptor;
}

function replay(bytes: readonly number[]): TerminalReplay {
  return { revision: 1, columns: 80, rows: 24, bytes } as unknown as TerminalReplay;
}

function output(sequence: number, byte: number): TerminalEvent {
  return { event: "output", sequence, revision: 1, data: [byte] } as unknown as TerminalEvent;
}

/** One attach call the test completes explicitly. */
interface PendingAttach {
  readonly sink: (event: TerminalEvent) => void;
  /** Events the host emitted before `activate()`, held like the real bootstrap. */
  readonly buffered: TerminalEvent[];
  deliver(event: TerminalEvent): void;
  resolve(options?: { attachmentId?: string; boundary?: number; bytes?: readonly number[] }): void;
  reject(error: unknown): void;
}

class Harness {
  /** Every observable port effect, in order. The trace under assertion. */
  readonly trace: string[] = [];
  readonly attaches: PendingAttach[] = [];
  readonly scheduled: (() => void)[] = [];
  readonly errors: unknown[] = [];
  hostAcceptsInput = true;
  hostInputOutcome: TerminalInputOutcome = { status: "accepted" };

  readonly ports: TerminalAttachmentPorts;
  #nextAttachment = 0;

  constructor() {
    this.ports = {
      attach: (sink) => this.#attach(sink),
      detach: async (attachmentId) => {
        this.trace.push(`detach:${attachmentId}`);
      },
      observeDescriptor: (value) => {
        this.trace.push(`descriptor:${value.id}`);
      },
      installReplay: (value) => {
        this.trace.push(`installReplay:${value.bytes.length}`);
      },
      stopOutput: () => {
        this.trace.push("stopOutput");
      },
      releaseOutput: (bytes) => {
        this.trace.push(`output:${[...bytes].join(",")}`);
      },
      acceptsInput: () => this.hostAcceptsInput,
      write: async (data) => {
        this.trace.push(`write:${data}`);
        return this.hostInputOutcome;
      },
      publishAttachmentId: (attachmentId) => {
        this.trace.push(`publish:${attachmentId ?? "none"}`);
      },
      reportError: (error) => {
        this.errors.push(error);
        this.trace.push("error");
      },
      schedule: (task) => {
        this.scheduled.push(task);
      },
    };
  }

  #attach(sink: (event: TerminalEvent) => void): Promise<TerminalAttachmentLease> {
    const id = `attachment-${++this.#nextAttachment}`;
    this.trace.push(`attach:${id}`);
    let resolveLease!: (lease: TerminalAttachmentLease) => void;
    let rejectLease!: (error: unknown) => void;
    const promise = new Promise<TerminalAttachmentLease>((resolve, reject) => {
      resolveLease = resolve;
      rejectLease = reject;
    });
    const pending: PendingAttach = {
      sink,
      buffered: [],
      deliver: (event) => pending.buffered.push(event),
      resolve: (options = {}) => {
        const attachmentId = (options.attachmentId ?? id) as TerminalAttachmentId;
        resolveLease({
          attachmentId,
          snapshot: {
            descriptor: descriptor(attachmentId),
            sequenceBoundary: options.boundary ?? 10,
            replay: replay(options.bytes ?? [27]),
          },
          activate: () => {
            this.trace.push(`activate:${attachmentId}`);
            for (const event of pending.buffered.splice(0)) sink(event);
          },
        });
      },
      reject: rejectLease,
    };
    this.attaches.push(pending);
    return promise;
  }

  /** Run the recovery decisions queued so far; new ones queue behind them. */
  runScheduled(): void {
    for (const task of this.scheduled.splice(0)) task();
  }

  /** Settle in-flight promises, then run any recovery they queued, repeatedly. */
  async drain(): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
      await settle();
      if (this.scheduled.length === 0) return;
      this.runScheduled();
    }
    throw new Error("recovery did not converge");
  }

  latestAttach(): PendingAttach {
    const pending = this.attaches[this.attaches.length - 1];
    assert.ok(pending, "no attach is in flight");
    return pending;
  }
}

async function attached(): Promise<{ harness: Harness; controller: TerminalAttachmentController }> {
  const harness = new Harness();
  const controller = new TerminalAttachmentController(harness.ports);
  void controller.start();
  await settle();
  harness.latestAttach().resolve({ boundary: 10, bytes: [] });
  await settle();
  return { harness, controller };
}

test("the snapshot baseline is installed before buffered events are released", async () => {
  const harness = new Harness();
  const controller = new TerminalAttachmentController(harness.ports);

  void controller.start();
  await settle();

  const pending = harness.latestAttach();
  pending.deliver(output(11, 65));
  pending.resolve({ boundary: 10, bytes: [27] });
  await settle();

  assert.deepEqual(harness.trace, [
    "publish:none",
    "stopOutput",
    "attach:attachment-1",
    "publish:attachment-1",
    "descriptor:attachment-1",
    "installReplay:1",
    "output:27",
    "activate:attachment-1",
    "output:65",
  ]);
  assert.equal(controller.attached, true);
  assert.equal(controller.attachmentId, "attachment-1");
});

test("consecutive events after the snapshot boundary are delivered in order", async () => {
  const { harness, controller } = await attached();
  const sink = harness.latestAttach().sink;

  sink(output(11, 1));
  sink(output(12, 2));
  sink(output(13, 3));

  assert.deepEqual(
    harness.trace.filter((entry) => entry.startsWith("output:")),
    ["output:1", "output:2", "output:3"],
  );
  assert.equal(controller.attached, true);
});

test("a replay event reinstalls the baseline and rebases the expected sequence", async () => {
  const { harness, controller } = await attached();
  const sink = harness.latestAttach().sink;

  sink({ event: "replay", sequence: 11, replay: replay([9]) } as TerminalEvent);
  sink(output(12, 4));

  assert.deepEqual(harness.trace.slice(-3), ["installReplay:1", "output:9", "output:4"]);
  assert.equal(controller.attachmentId, "attachment-1", "a replay does not reattach");
});

test("a sequence gap requests one fresh attachment instead of guessing", async () => {
  const { harness, controller } = await attached();
  harness.latestAttach().sink(output(12, 7));

  assert.equal(controller.acceptsInput(), false, "a gap closes input immediately");
  await harness.drain();
  harness.latestAttach().resolve({ bytes: [] });
  await settle();

  assert.deepEqual(harness.trace, [
    "publish:none",
    "stopOutput",
    "attach:attachment-1",
    "publish:attachment-1",
    "descriptor:attachment-1",
    "installReplay:0",
    "activate:attachment-1",
    "publish:none",
    "stopOutput",
    "detach:attachment-1",
    "attach:attachment-2",
    "publish:attachment-2",
    "descriptor:attachment-2",
    "installReplay:0",
    "activate:attachment-2",
  ]);
  assert.equal(harness.attaches.length, 2);
});

for (const kind of ["resync_required", "detached"] as const) {
  test(`a host ${kind} event recovers the baseline`, async () => {
    const { harness } = await attached();
    harness.latestAttach().sink({ event: kind, sequence: 11, reason: "test" } as TerminalEvent);
    await harness.drain();

    assert.equal(harness.attaches.length, 2);
    assert.ok(harness.trace.includes("detach:attachment-1"));
  });
}

test("local output-queue overflow recovers through the same path", async () => {
  const { harness, controller } = await attached();

  controller.requestRecovery();
  assert.equal(controller.acceptsInput(), false);
  await harness.drain();
  harness.latestAttach().resolve({ bytes: [] });
  await settle();

  assert.equal(harness.attaches.length, 2);
  assert.equal(controller.attachmentId, "attachment-2");
});

test("recovery requests raised while a cycle runs collapse into one cycle", async () => {
  const { harness, controller } = await attached();
  const sink = harness.latestAttach().sink;

  // Three untrusted-baseline signals in the same tick.
  sink(output(20, 1));
  sink(output(21, 2));
  controller.requestRecovery();
  await harness.drain();

  assert.equal(harness.attaches.length, 2, "one recovery attachment, not three");
});

test("a recovery raised during an attach schedules exactly one following cycle", async () => {
  const harness = new Harness();
  const controller = new TerminalAttachmentController(harness.ports);
  void controller.start();
  await settle();

  // The first attach is still in flight; recovery cannot start a parallel loop.
  controller.requestRecovery();
  controller.requestRecovery();
  harness.runScheduled();
  await settle();
  assert.equal(harness.attaches.length, 1, "no attachment loop runs in parallel");

  harness.latestAttach().resolve({ boundary: 10, bytes: [] });
  await harness.drain();
  assert.equal(harness.attaches.length, 2);

  harness.latestAttach().resolve({ bytes: [] });
  await settle();
  assert.equal(controller.attachmentId, "attachment-2");
});

test("a callback from a superseded generation cannot mutate state", async () => {
  const { harness, controller } = await attached();
  const staleSink = harness.latestAttach().sink;

  controller.requestRecovery();
  await harness.drain();
  const traceLength = harness.trace.length;

  staleSink(output(11, 99));
  staleSink({ event: "detached", sequence: 12, reason: "stale" } as TerminalEvent);
  await harness.drain();

  assert.deepEqual(harness.trace.slice(traceLength), [], "a stale callback changed state");
  assert.equal(harness.attaches.length, 2);
});

test("an attachment opened after disposal is released, never adopted", async () => {
  const harness = new Harness();
  const controller = new TerminalAttachmentController(harness.ports);
  void controller.start();
  await settle();

  controller.dispose();
  harness.latestAttach().resolve({ bytes: [] });
  await settle();

  assert.deepEqual(harness.trace, [
    "publish:none",
    "stopOutput",
    "attach:attachment-1",
    "publish:none",
    "stopOutput",
    "detach:attachment-1",
  ]);
  assert.equal(controller.attachmentId, null);
  assert.equal(controller.attached, false);
});

test("disposal with a live attachment detaches it and closes every surface", async () => {
  const { harness, controller } = await attached();
  const sink = harness.latestAttach().sink;

  controller.dispose();
  assert.deepEqual(harness.trace.slice(-3), ["publish:none", "stopOutput", "detach:attachment-1"]);

  sink(output(11, 1));
  controller.requestRecovery();
  await harness.drain();
  assert.equal(harness.attaches.length, 1, "nothing reattaches after disposal");
  assert.equal(controller.acceptsInput(), false);
});

test("an attach failure is reported and leaves the controller recoverable", async () => {
  const harness = new Harness();
  const controller = new TerminalAttachmentController(harness.ports);
  void controller.start();
  await settle();

  harness.latestAttach().reject(new Error("host refused"));
  await settle();

  assert.equal(harness.errors.length, 1);
  assert.equal(controller.attached, false);
  assert.equal(controller.attachmentId, null);
  assert.equal(controller.acceptsInput(), false);

  controller.requestRecovery();
  await harness.drain();
  harness.latestAttach().resolve({ bytes: [] });
  await settle();
  assert.equal(controller.attachmentId, "attachment-2");
});

test("input opens only once the surface holds the baseline the host sent", async () => {
  const harness = new Harness();
  const controller = new TerminalAttachmentController(harness.ports);
  void controller.start();
  await settle();

  harness.latestAttach().resolve({ boundary: 10, bytes: [27] });
  await settle();
  assert.equal(controller.acceptsInput(), false, "input stays closed until the replay drains");

  controller.noteOutputDrained();
  assert.equal(controller.acceptsInput(), true);
});

test("an empty replay opens input without waiting for a drain that never comes", async () => {
  const { controller } = await attached();
  assert.equal(controller.acceptsInput(), true);
});

test("input follows the host lifecycle, not the attachment alone", async () => {
  const harness = new Harness();
  const controller = new TerminalAttachmentController(harness.ports);
  harness.hostAcceptsInput = false;
  void controller.start();
  await settle();
  harness.latestAttach().resolve({ bytes: [] });
  await settle();

  assert.equal(controller.acceptsInput(), false, "a terminal that is not running takes no input");
});

test("an exit closes input while the attachment stays open", async () => {
  const { harness, controller } = await attached();
  assert.equal(controller.acceptsInput(), true);

  harness.latestAttach().sink({
    event: "exited",
    sequence: 11,
    descriptor: descriptor("attachment-1"),
  } as TerminalEvent);

  assert.equal(controller.acceptsInput(), false);
  assert.equal(controller.attachmentId, "attachment-1", "an exit does not reattach");
});

test("input submitted with no attachment never reaches the host", async () => {
  const harness = new Harness();
  const controller = new TerminalAttachmentController(harness.ports);

  assert.deepEqual(await controller.submitInput("ls"), {
    status: "unavailable",
    reason: "detached",
  });
  assert.ok(!harness.trace.some((entry) => entry.startsWith("write:")));
});

test("input submitted during recovery never reaches the host", async () => {
  const { harness, controller } = await attached();
  controller.requestRecovery();

  assert.deepEqual(await controller.submitInput("ls"), {
    status: "unavailable",
    reason: "not_ready",
  });
  assert.ok(!harness.trace.some((entry) => entry.startsWith("write:")));
});

test("admitted input is submitted once and its host outcome is returned", async () => {
  const { harness, controller } = await attached();

  assert.deepEqual(await controller.submitInput("ls\r"), { status: "accepted" });
  assert.deepEqual(
    harness.trace.filter((entry) => entry.startsWith("write:")),
    ["write:ls\r"],
  );

  harness.hostInputOutcome = { status: "failed", error: new Error("bridge gone") };
  const outcome = await controller.submitInput("ls\r");
  assert.equal(outcome.status, "failed", "a host failure must not be hidden");
});

test("input after an exit is unavailable without reaching the host", async () => {
  const { harness, controller } = await attached();
  harness.latestAttach().sink({
    event: "exited",
    sequence: 11,
    descriptor: descriptor("attachment-1"),
  } as TerminalEvent);

  assert.deepEqual(await controller.submitInput("ls"), {
    status: "unavailable",
    reason: "not_ready",
  });
  assert.ok(!harness.trace.some((entry) => entry.startsWith("write:")));
});

test("starting an attached controller does not open a second attachment", async () => {
  const { harness, controller } = await attached();
  await controller.start();
  assert.equal(harness.attaches.length, 1);
});
