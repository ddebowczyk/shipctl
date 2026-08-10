import assert from "node:assert/strict";
import { test } from "node:test";

import type { TerminalAttachmentLease } from "../terminalAttachmentController.ts";
import type { TerminalGeometry } from "../terminalFitPlan.ts";
import type { TerminalSurface } from "../terminalSurface.ts";
import { TerminalViewportPin } from "../terminalViewportPin.ts";
import {
  startTerminalViewSession,
  type TerminalSessionOutput,
  type TerminalSessionRuntime,
  type TerminalSessionTiming,
  type TerminalViewSessionPorts,
} from "../terminalViewSession.ts";
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

function size(geometry: TerminalGeometry): string {
  return `${geometry.columns}x${geometry.rows}`;
}

class Harness {
  /** Every observable port effect, in order. The trace under assertion. */
  readonly trace: string[] = [];
  readonly ports: TerminalViewSessionPorts;
  readonly notices: string[] = [];

  /** The geometry the container proposes, or null while unmeasurable. */
  proposed: TerminalGeometry | null = null;
  /** What the host makes of the next keystroke. */
  inputOutcome: TerminalInputOutcome = { status: "accepted" };
  hostAcceptsInput = true;
  /** Bytes the attachment's replay carries. */
  replayBytes: readonly number[] = [7];

  #current: TerminalGeometry = { columns: 80, rows: 24 };
  #bottomOffset = 0;
  #inputSink: ((data: string) => void) | null = null;
  #frames: (() => void)[] = [];
  #deferred: { task: () => void; cancelled: boolean }[] = [];
  #afterDrain: (() => void) | null = null;
  #onOverflow: (() => void) | null = null;
  #nextAttachment = 0;
  #attachmentId: TerminalAttachmentId | null = null;

  constructor() {
    const pin = new TerminalViewportPin(
      {
        bottomOffset: () => {
          this.trace.push("pin:read");
          return this.#bottomOffset;
        },
        baseY: () => 0,
        scrollToBottom: () => this.trace.push("pin:bottom"),
        scrollToLine: (line) => this.trace.push(`pin:line:${line}`),
      },
      (task) => task(),
    );

    const surface: TerminalSurface = {
      pin,
      open: () => this.trace.push("open"),
      setInputSink: (sink) => {
        this.#inputSink = sink;
        this.trace.push(sink ? "sink:on" : "sink:off");
      },
      applyCurrentTheme: () => this.trace.push("theme"),
      applyCurrentSettings: () => this.trace.push("settings"),
      refresh: () => this.trace.push("refresh"),
      focus: () => this.trace.push("focus"),
      reset: () => this.trace.push("reset"),
      resize: (next) => {
        this.#current = next;
        this.trace.push(`resize:${size(next)}`);
      },
      resizePreservingViewport: (next) => {
        this.#current = next;
        this.trace.push(`fit:${size(next)}`);
      },
      geometry: () => this.#current,
      proposeGeometry: () => this.proposed,
      bufferRows: () => 10,
      resyncViewport: () => this.trace.push("resync"),
      publishAttachmentId: (attachmentId) => {
        this.#attachmentId = attachmentId;
        this.trace.push(`publish:${attachmentId ?? "none"}`);
      },
      logActiveFont: () => this.trace.push("font"),
    };

    const output: TerminalSessionOutput = {
      register: (afterDrain, onOverflow) => {
        this.#afterDrain = afterDrain;
        this.#onOverflow = onOverflow;
        this.trace.push("register");
      },
      unregister: () => {
        this.#afterDrain = null;
        this.#onOverflow = null;
        this.trace.push("unregister");
      },
      release: (bytes) => this.trace.push(`release:${bytes.length}`),
    };

    const runtime: TerminalSessionRuntime = {
      attach: (onEvent) => this.#attach(onEvent),
      detach: async (attachmentId) => {
        this.trace.push(`detach:${attachmentId}`);
      },
      observeDescriptor: () => this.trace.push("descriptor"),
      write: async (data) => {
        this.trace.push(`write:${data}`);
        return this.inputOutcome;
      },
      acceptsInput: () => this.hostAcceptsInput,
      resize: async (attachmentId, next) => {
        this.trace.push(`host-resize:${attachmentId}:${size(next)}`);
      },
    };

    const timing: TerminalSessionTiming = {
      nextFrame: () =>
        new Promise<void>((resolve) => {
          this.#frames.push(() => resolve());
        }),
      defer: (task) => {
        const entry = { task, cancelled: false };
        this.#deferred.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
      fontsReady: () => null,
    };

    this.ports = {
      surface,
      output,
      runtime,
      timing,
      notifyError: (title, error) => {
        this.notices.push(`${title}: ${String(error)}`);
      },
    };
  }

  get attachmentId(): TerminalAttachmentId | null {
    return this.#attachmentId;
  }

  /** Where the user is reading, as the surface would report it. */
  set bottomOffset(offset: number) {
    this.#bottomOffset = offset;
  }

  /** Let the reveal's animation frame arrive and run everything it unblocks. */
  async frame(): Promise<void> {
    for (const resolve of this.#frames.splice(0)) resolve();
    await settle();
  }

  /** Type into the terminal, the way the surface's own handlers do. */
  async type(data: string): Promise<void> {
    this.#inputSink?.(data);
    await settle();
  }

  /** Report that the output queue has emptied. */
  drain(): void {
    assert.ok(this.#afterDrain, "no output registration to drain");
    this.#afterDrain();
  }

  /** Report that the local parser budget was exceeded. */
  overflow(): void {
    assert.ok(this.#onOverflow, "no output registration to overflow");
    this.#onOverflow();
  }

  /** Let the reveal's settle period elapse. */
  fireDeferred(): void {
    for (const entry of this.#deferred.splice(0)) {
      if (!entry.cancelled) entry.task();
    }
  }

  get deferredCancelled(): boolean {
    return this.#deferred.every((entry) => entry.cancelled);
  }

  async #attach(onEvent: (event: TerminalEvent) => void): Promise<TerminalAttachmentLease> {
    void onEvent;
    const attachmentId = `attachment-${++this.#nextAttachment}` as TerminalAttachmentId;
    this.trace.push(`attach:${attachmentId}`);
    return {
      attachmentId,
      snapshot: {
        descriptor: { id: "terminal-1", lifecycle: "running" } as unknown as TerminalDescriptor,
        sequenceBoundary: 0,
        replay: {
          revision: 1,
          columns: 90,
          rows: 30,
          bytes: this.replayBytes,
        } as unknown as TerminalReplay,
      },
      activate: () => this.trace.push("activate"),
    };
  }
}

/* ── reveal ────────────────────────────────────────────── */

test("a revealed terminal catches up before anything measures it", async () => {
  const h = new Harness();
  h.proposed = { columns: 100, rows: 40 };

  const session = startTerminalViewSession(h.ports);
  assert.deepEqual(h.trace, ["open", "sink:on"], "nothing runs before the frame");

  await h.frame();

  assert.deepEqual(h.trace, [
    "open",
    "sink:on",
    // Theme and settings are collected before the surface is measured: both can
    // change the cell metrics the fit is about to compute from.
    "theme",
    "settings",
    "refresh",
    "fit:100x40",
    // The reading position is re-asserted after the work that could move it.
    "resync",
    // The attach cycle opens by dropping whatever baseline was held.
    "publish:none",
    "unregister",
    "attach:attachment-1",
    "publish:attachment-1",
    "descriptor",
    // The replay baseline: the queue is stopped, the position remembered, and
    // the buffer rebuilt before a single byte may be written into it.
    "unregister",
    "pin:read",
    "reset",
    "resize:90x30",
    "register",
    "release:1",
    "activate",
    // The surface now holds the host's geometry, so it is fitted again — and
    // this time there is an attachment to tell.
    "fit:100x40",
    "host-resize:attachment-1:100x40",
  ]);

  session.dispose();
});

test("a terminal shown again catches up without a new attachment", async () => {
  const h = new Harness();
  h.proposed = { columns: 100, rows: 40 };
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  h.drain();
  h.trace.length = 0;

  // The tab was hidden and is being shown again. The attachment never left, so
  // the surface only has to be caught up on what changed while it was away.
  session.reveal();
  await h.frame();

  assert.deepEqual(h.trace, ["theme", "settings", "refresh", "resync"]);

  session.dispose();
});

test("a terminal hidden and shown keeps writing input to the same attachment", async () => {
  const h = new Harness();
  h.proposed = { columns: 100, rows: 40 };
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  h.drain();
  const attachmentId = h.attachmentId;

  session.reveal();
  await h.frame();
  h.trace.length = 0;
  await h.type("ls\r");

  assert.deepEqual(h.trace, ["write:ls\r", "pin:bottom"], "input was never closed");
  assert.equal(h.attachmentId, attachmentId, "the same attachment is still held");

  session.dispose();
});

test("a reveal supersedes the settle the one before it deferred", async () => {
  const h = new Harness();
  h.proposed = { columns: 100, rows: 40 };
  const session = startTerminalViewSession(h.ports);
  await h.frame();

  session.reveal();
  await h.frame();
  h.fireDeferred();

  assert.deepEqual(
    h.trace.filter((entry) => entry === "focus"),
    ["focus"],
    "a stale settle does not take focus a second time",
  );

  session.dispose();
});

test("a session disposed before its frame arrives touches nothing", async () => {
  const h = new Harness();
  h.proposed = { columns: 100, rows: 40 };

  const session = startTerminalViewSession(h.ports);
  session.dispose();
  await h.frame();

  assert.deepEqual(h.trace, ["open", "sink:on", "sink:off", "publish:none", "unregister"]);
});

test("the reveal takes focus only once the surface has settled", async () => {
  const h = new Harness();
  h.proposed = { columns: 100, rows: 40 };
  const session = startTerminalViewSession(h.ports);
  await h.frame();

  assert.ok(!h.trace.includes("focus"), "focus waits for the quiet period");
  h.fireDeferred();
  assert.ok(h.trace.includes("focus"));

  session.dispose();
});

test("disposal cancels the work the reveal deferred", async () => {
  const h = new Harness();
  h.proposed = { columns: 100, rows: 40 };
  const session = startTerminalViewSession(h.ports);
  await h.frame();

  session.dispose();
  h.fireDeferred();

  assert.ok(h.deferredCancelled);
  assert.ok(!h.trace.includes("focus"), "a disposed session does not steal focus");
});

/* ── input ─────────────────────────────────────────────── */

test("input reaches the host only once the surface holds the replay", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();

  await h.type("a");
  assert.ok(!h.trace.includes("write:a"), "the replay has not drained yet");

  h.drain();
  await h.type("a");
  assert.ok(h.trace.includes("write:a"));

  session.dispose();
});

test("accepted input follows output", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  h.drain();
  h.trace.length = 0;

  await h.type("ls\r");

  assert.deepEqual(h.trace, ["write:ls\r", "pin:bottom"]);
  assert.deepEqual(h.notices, []);

  session.dispose();
});

test("a keystroke that raced the terminal's exit is not the user's problem", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  h.drain();
  h.inputOutcome = { status: "unavailable", reason: "exited" };
  h.trace.length = 0;

  await h.type("a");

  assert.deepEqual(h.trace, ["write:a"], "nothing follows a raced keystroke");
  assert.deepEqual(h.notices, []);

  session.dispose();
});

test("input the host could not take is reported", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  h.drain();
  h.inputOutcome = { status: "failed", error: new Error("pipe closed") };

  await h.type("a");

  assert.deepEqual(h.notices, ["Couldn’t write to terminal: Error: pipe closed"]);

  session.dispose();
});

test("a disposed session drops an outcome that was still in flight", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  h.drain();
  h.trace.length = 0;

  h.ports.surface.pin.applyIntent("unpin");
  const typed = h.type("a");
  session.dispose();
  await typed;

  assert.ok(!h.trace.includes("pin:bottom"), "a disposed session leaves the buffer alone");
});

/* ── replay and recovery ───────────────────────────────── */

test("a drained replay restores the position the user was reading at", async () => {
  const h = new Harness();
  h.bottomOffset = 12;
  const session = startTerminalViewSession(h.ports);
  h.ports.surface.pin.applyIntent("unpin");
  await h.frame();

  // The reset above remembered 12 lines from the end; the drain puts them back.
  h.trace.length = 0;
  h.bottomOffset = 0;
  h.drain();

  assert.deepEqual(h.trace, ["pin:line:0"]);

  session.dispose();
});

test("a local overflow asks for a fresh baseline instead of guessing", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  h.trace.length = 0;

  h.overflow();
  await settle();

  assert.ok(
    h.trace.includes("attach:attachment-2"),
    "the session reattaches rather than writing onto a truncated buffer",
  );

  session.dispose();
});

/* ── fit ───────────────────────────────────────────────── */

test("a container change reaches the host only while an attachment is held", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);

  h.proposed = { columns: 120, rows: 50 };
  await session.requestFit();
  assert.deepEqual(h.trace, ["open", "sink:on", "fit:120x50"], "no attachment to tell");

  await h.frame();
  h.trace.length = 0;
  h.proposed = { columns: 130, rows: 50 };
  await session.requestFit();

  assert.deepEqual(h.trace, ["fit:130x50", `host-resize:${h.attachmentId}:130x50`]);

  session.dispose();
});

test("a disposed session stops fitting", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  session.dispose();
  h.trace.length = 0;

  h.proposed = { columns: 140, rows: 60 };
  await session.requestFit();

  assert.deepEqual(h.trace, []);
});

test("disposal closes the input path and releases the attachment", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  h.trace.length = 0;

  session.dispose();
  await settle();

  assert.deepEqual(h.trace, ["sink:off", "publish:none", "unregister", "detach:attachment-1"]);
});
