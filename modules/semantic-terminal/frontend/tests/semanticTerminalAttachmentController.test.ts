import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SemanticTerminalAttachmentController,
  type SemanticTerminalAttachmentLease,
  type SemanticTerminalWireEvent,
  type TerminalClientModel,
  type TerminalInput,
  type TerminalInputOutcome,
} from "@shipctl/module-semantic-terminal";

const state = {
  columns: 80,
  rows: 24,
  screen: "primary",
  scrollbackRows: 0,
  cursor: {},
  modes: {},
  colors: {},
  damage: {},
  viewport: [],
  selection: [],
} as const;

function model(trace: string[]): TerminalClientModel {
  return {
    installBaseline: ({ sequence }) => {
      trace.push(`baseline:${sequence}`);
      return { status: "committed" };
    },
    applyScreen: ({ sequence }) => {
      trace.push(`screen:${sequence}`);
      return { status: "committed" };
    },
    applyEffects: (effects) => {
      trace.push(`effects:${effects.length}`);
      return { status: "committed" };
    },
    applyHistory: () => ({ status: "committed" }),
  } as unknown as TerminalClientModel;
}

class Harness {
  readonly trace: string[] = [];
  readonly scheduled: (() => void)[] = [];
  sink: ((event: SemanticTerminalWireEvent) => void) | null = null;
  attachment = 0;
  running = true;
  creditResult: Promise<void> | null = null;

  readonly controller: SemanticTerminalAttachmentController;

  constructor(overrides: {
    model?: TerminalClientModel;
    sendInput?: (input: TerminalInput) => Promise<TerminalInputOutcome>;
  } = {}) {
    this.controller = new SemanticTerminalAttachmentController({
      attach: async (sink) => {
      this.sink = sink;
      const attachmentId = `attachment-${++this.attachment}`;
      this.trace.push(`attach:${attachmentId}`);
      return {
        attachmentId,
        live: true,
        snapshot: {
          descriptor: { revision: 1 },
          sequenceBoundary: 0,
          state,
        },
        activate: () => this.trace.push(`activate:${attachmentId}`),
      } satisfies SemanticTerminalAttachmentLease;
      },
      detach: async (attachmentId) => this.trace.push(`detach:${attachmentId}`),
      creditScreen: async (_attachmentId, sequence) => {
        this.trace.push(`credit:${sequence}`);
        if (this.creditResult) await this.creditResult;
      },
      acceptsInput: () => this.running,
      sendInput: overrides.sendInput ?? (async (input) => {
        this.trace.push(`input:${input.kind}`);
        return { status: "accepted", encodedBytes: 1 };
      }),
      readHistory: async () => ({ startRow: 0, historyRows: 0, rows: [] }),
      publishAttachmentId: (id) => this.trace.push(`published:${id ?? "none"}`),
      reportError: (error) => this.trace.push(`error:${String(error)}`),
      reportRawEvent: (error) => this.trace.push(`raw:${String(error)}`),
      model: overrides.model ?? model(this.trace),
      schedule: (task) => this.scheduled.push(task),
    });
  }

  async start(): Promise<void> {
    await this.controller.start();
  }

  async recover(): Promise<void> {
    this.controller.requestRecovery();
    await this.runScheduled();
  }

  async runScheduled(): Promise<void> {
    for (const task of this.scheduled.splice(0)) task();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const input: TerminalInput = {
  kind: "key",
  action: "press",
  code: "KeyA",
  text: "a",
  mods: { shift: false, alt: false, ctrl: false, meta: false, capsLock: false, numLock: false },
  composing: false,
};

test("the module controller installs semantic state and grants one screen credit", async () => {
  const harness = new Harness();
  await harness.start();

  assert.deepEqual(harness.trace, [
    "published:none",
    "attach:attachment-1",
    "published:attachment-1",
    "baseline:0",
    "credit:0",
    "activate:attachment-1",
  ]);
  assert.equal(harness.controller.acceptsInput(), true);
  assert.deepEqual(await harness.controller.submitInput(input), {
    status: "accepted",
    encodedBytes: 1,
  });
});

test("the module controller commits semantic frames and rejects raw events", async () => {
  const harness = new Harness();
  await harness.start();

  harness.sink?.({ event: "screen", sequence: 1, revision: 1, state });
  harness.sink?.({ event: "effects", sequence: 1, effects: [{ kind: "bell" }] });
  harness.sink?.({ event: "output", sequence: 2, revision: 1, data: [7] });

  assert.ok(harness.trace.includes("screen:1"));
  assert.ok(harness.trace.includes("effects:1"));
  assert.ok(harness.trace.some((entry) => entry.startsWith("raw:")));
});

test("a semantic frame fault recovers with a fresh module attachment", async () => {
  const harness = new Harness();
  await harness.start();

  harness.sink?.({ event: "resync_required", sequence: 1, reason: "host requested" });
  await harness.recover();

  assert.deepEqual(
    harness.trace.filter((entry) => entry.startsWith("attach:")),
    ["attach:attachment-1", "attach:attachment-2"],
  );
});

test("semantic input reaches the native actor in observed order", async () => {
  let releaseFirst: (() => void) | null = null;
  const started: string[] = [];
  const harness = new Harness({
    sendInput: (next) => {
      started.push(next.kind);
      if (started.length > 1) {
        return Promise.resolve({ status: "accepted", encodedBytes: 0 });
      }
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "accepted", encodedBytes: 1 });
      });
    },
  });
  await harness.start();

  const first = harness.controller.submitInput(input);
  const second = harness.controller.submitInput({ ...input, action: "release" });
  await Promise.resolve();
  assert.deepEqual(started, ["key"]);

  assert.ok(releaseFirst);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["key", "key"]);
});

test("a refused live frame recovers instead of stopping screen delivery", async () => {
  const trace: string[] = [];
  const refusing = model(trace);
  refusing.applyScreen = ({ sequence }) => {
    trace.push(`screen:${sequence}`);
    return { status: "rejected", reason: "invalid", detail: "bad live frame" };
  };
  const harness = new Harness({ model: refusing });
  await harness.start();

  harness.sink?.({ event: "screen", sequence: 1, revision: 1, state });
  await harness.runScheduled();

  assert.deepEqual(
    harness.trace.filter((entry) => entry.startsWith("attach:")),
    ["attach:attachment-1", "attach:attachment-2"],
  );
});

test("a malformed baseline is reported once and is not retried", async () => {
  const trace: string[] = [];
  const scheduled: (() => void)[] = [];
  const controller = new SemanticTerminalAttachmentController({
    attach: async () => {
      trace.push("attach");
      return {
        attachmentId: "broken-attachment",
        live: true,
        snapshot: {
          descriptor: { revision: 1 },
          sequenceBoundary: 0,
          state,
        },
        activate: () => trace.push("activate"),
      } satisfies SemanticTerminalAttachmentLease;
    },
    detach: async (attachmentId) => trace.push(`detach:${attachmentId}`),
    creditScreen: async () => trace.push("credit"),
    acceptsInput: () => true,
    sendInput: async () => ({ status: "accepted", encodedBytes: 1 }),
    readHistory: async () => ({ startRow: 0, historyRows: 0, rows: [] }),
    publishAttachmentId: (id) => trace.push(`published:${id ?? "none"}`),
    reportError: (error) => trace.push(`error:${String(error)}`),
    reportRawEvent: () => undefined,
    model: {
      installBaseline: () => ({
        status: "rejected",
        reason: "invalid",
        detail: "state.selection is not an array",
      }),
    } as unknown as TerminalClientModel,
    schedule: (task) => scheduled.push(task),
  });

  await controller.start();
  for (const task of scheduled) task();

  assert.deepEqual(trace, [
    "published:none",
    "attach",
    "published:broken-attachment",
    "error:Error: The terminal baseline was refused: state.selection is not an array",
    "published:none",
    "detach:broken-attachment",
  ]);
  assert.equal(controller.attached, false);
});

test("a terminal that already exited is not attached or reported as an error", async () => {
  const harness = new Harness();
  harness.running = false;

  await harness.start();

  assert.deepEqual(harness.trace, []);
  assert.equal(harness.controller.acceptsInput(), false);
});

test("screen credit failure after terminal exit stops without attach recovery", async () => {
  const harness = new Harness();
  let rejectCredit: ((error: unknown) => void) | null = null;
  harness.creditResult = new Promise<void>((_resolve, reject) => {
    rejectCredit = reject;
  });

  await harness.start();
  harness.running = false;
  assert.ok(rejectCredit);
  rejectCredit(new Error("Terminal driver attachment is not live"));
  await new Promise((resolve) => setImmediate(resolve));
  await harness.runScheduled();

  assert.deepEqual(
    harness.trace.filter((entry) => entry.startsWith("attach:")),
    ["attach:attachment-1"],
  );
  assert.equal(harness.trace.some((entry) => entry.startsWith("error:")), false);
  assert.equal(harness.controller.acceptsInput(), false);
});
