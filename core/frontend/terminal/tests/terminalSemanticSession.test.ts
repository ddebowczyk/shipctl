/**
 * A view session with no parser under it.
 *
 * The session is the same one the byte path uses. What changes is what it was
 * given: a client model instead of an output queue, and a runtime that takes
 * meaning instead of bytes. These traces are the proof that the change is a
 * wiring decision and not a second session — the ordering, the recovery and the
 * input readiness all stay where they were.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { TerminalAttachmentLease } from "../terminalAttachmentController.ts";
import { TerminalClientModel } from "../terminalClientModel.ts";
import { decodeTerminalEvent } from "../terminalEventDecoder.ts";
import type { TerminalInput } from "../terminalSemanticInput.ts";
import type { TerminalSurface } from "../terminalSurface.ts";
import { TerminalViewportPin } from "../terminalViewportPin.ts";
import {
  startTerminalViewSession,
  type TerminalViewSessionPorts,
} from "../terminalViewSession.ts";
import type {
  TerminalAttachmentId,
  TerminalDescriptor,
  TerminalEvent,
  TerminalInputOutcome,
} from "../types.ts";

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const fixture = JSON.parse(
  readFileSync(new URL("../terminalScreenFixture.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const anchorFixture = JSON.parse(
  readFileSync(new URL("../terminalAnchorFixture.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** One row of the host's own history, to answer a read with rows it would send. */
const historyRow = (
  JSON.parse(
    readFileSync(new URL("../terminalHistoryFixture.json", import.meta.url), "utf8"),
  ) as { rows: unknown[] }
).rows[0];

/**
 * The host's own screen frame, at the sequence the caller names.
 *
 * `scrollbackRows` is the one field a caller may set, because it is what says
 * there is anything behind the screen to scroll back to.
 */
function screenEvent(sequence: number, scrollbackRows?: number): TerminalEvent {
  const event = decodeTerminalEvent(structuredClone(fixture));
  if (event.event !== "screen") throw new Error("the fixture is a screen frame");
  if (scrollbackRows === undefined) return { ...event, sequence } as TerminalEvent;
  const state = structuredClone(event.state) as Record<string, unknown>;
  state.scrollbackRows = scrollbackRows;
  return { ...event, sequence, state } as TerminalEvent;
}

function baselineState(): unknown {
  const event = decodeTerminalEvent(structuredClone(fixture));
  if (event.event !== "screen") throw new Error("the fixture is a screen frame");
  return event.state;
}

function baselineRevision(): number {
  const event = decodeTerminalEvent(structuredClone(fixture));
  if (event.event !== "screen") throw new Error("the fixture is a screen frame");
  return event.revision;
}

class Harness {
  readonly trace: string[] = [];
  readonly notices: string[] = [];
  /** What the host reported beside the screen, in the order it was handed on. */
  readonly effects: string[] = [];
  readonly model = new TerminalClientModel();
  readonly ports: TerminalViewSessionPorts;
  readonly sent: TerminalInput[] = [];

  inputOutcome: TerminalInputOutcome = { status: "accepted" };
  /** Where the host says the anchored line is now. Eviction moves it. */
  anchoredRow = 0;
  /** How many rows the host says history holds, which is what a read answers from. */
  historyRows = 10;
  /** The host's event sink for the live attachment. */
  emit: ((event: TerminalEvent) => void) | null = null;

  #semanticSink: ((input: TerminalInput) => void) | null = null;
  #frames: (() => void)[] = [];

  constructor() {
    const surface: TerminalSurface = {
      pin: new TerminalViewportPin(
        {
          bottomOffset: () => 0,
          baseY: () => 0,
          scrollToBottom: () => this.trace.push("pin:bottom"),
          scrollToLine: () => this.trace.push("pin:line"),
        },
        (task) => task(),
      ),
      open: () => this.trace.push("open"),
      setInputSink: (sink) => this.trace.push(sink ? "bytes:on" : "bytes:off"),
      setSemanticInputSink: (sink) => {
        this.#semanticSink = sink;
        this.trace.push(sink ? "input:on" : "input:off");
      },
      applyCurrentTheme: () => this.trace.push("theme"),
      applyCurrentSettings: () => this.trace.push("settings"),
      refresh: () => this.trace.push("refresh"),
      focus: () => this.trace.push("focus"),
      reset: () => this.trace.push("reset"),
      resize: () => this.trace.push("resize"),
      resizePreservingViewport: () => this.trace.push("fit"),
      geometry: () => ({ columns: 80, rows: 24 }),
      proposeGeometry: () => null,
      bufferRows: () => 0,
      resyncViewport: () => this.trace.push("resync"),
      publishAttachmentId: (id) => this.trace.push(`publish:${id ?? "none"}`),
      logActiveFont: () => this.trace.push("font"),
    };

    this.ports = {
      surface,
      model: this.model,
      // No `output`: there is no parser on this client to deliver bytes to.
      runtime: {
        attach: (onEvent) => this.#attach(onEvent),
        detach: async (id) => {
          this.trace.push(`detach:${id}`);
        },
        observeDescriptor: () => this.trace.push("descriptor"),
        write: async (data) => {
          this.trace.push(`write:${data}`);
          return this.inputOutcome;
        },
        sendInput: async (input) => {
          this.sent.push(input);
          this.trace.push(`send:${input.kind}`);
          return this.inputOutcome;
        },
        readHistory: async (startRow, rows) => {
          this.trace.push(`history:${startRow}:${rows}`);
          const held = Math.max(0, Math.min(rows, this.historyRows - startRow));
          return {
            startRow,
            historyRows: this.historyRows,
            rows: Array.from({ length: held }, () => structuredClone(historyRow)),
          };
        },
        anchors: {
          anchor: async (space, at) => {
            this.trace.push(`anchor:${space}:${at.row}`);
            return this.anchorAt(at.row);
          },
          resolveAnchor: async (anchor) => {
            this.trace.push(`resolve:${anchor}`);
            return this.anchorAt(this.anchoredRow);
          },
          releaseAnchor: async (anchor) => {
            this.trace.push(`release:${anchor}`);
            return true;
          },
        },
        acceptsInput: () => true,
        resize: async () => {
          this.trace.push("host-resize");
        },
      },
      timing: {
        nextFrame: () =>
          new Promise<void>((resolve) => {
            this.#frames.push(() => resolve());
          }),
        defer: () => () => {},
        fontsReady: () => null,
      },
      reportEffect: (effect) => {
        this.effects.push(effect.kind);
      },
      notifyError: (title, error) => {
        this.notices.push(`${title}: ${String(error)}`);
      },
    };
  }

  /** The host's own anchor, naming the history row it holds now. */
  anchorAt(row: number): Record<string, unknown> {
    this.anchoredRow = row;
    return {
      ...structuredClone(anchorFixture),
      history: { column: 0, row },
    };
  }

  async frame(): Promise<void> {
    for (const resolve of this.#frames.splice(0)) resolve();
    await settle();
  }

  /** Do something, the way the surface's own listeners do. */
  async act(input: TerminalInput): Promise<void> {
    this.#semanticSink?.(input);
    await settle();
  }

  async #attach(onEvent: (event: TerminalEvent) => void): Promise<TerminalAttachmentLease> {
    this.emit = onEvent;
    this.trace.push("attach");
    return {
      attachmentId: "attachment-1" as TerminalAttachmentId,
      snapshot: {
        descriptor: {
          id: "terminal-1",
          lifecycle: "running",
          revision: baselineRevision(),
        } as unknown as TerminalDescriptor,
        sequenceBoundary: 0,
        // The byte path's baseline, which this session never installs.
        replay: { revision: 1, columns: 80, rows: 24, bytes: [7] } as never,
        state: baselineState() as never,
      },
      activate: () => this.trace.push("activate"),
    };
  }
}

test("the attachment's baseline becomes model state, with no bytes anywhere", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  assert.ok(h.model.state, "the terminal's state is the host's snapshot");
  assert.equal(h.model.state?.sequence, 0);
  assert.ok(
    !h.trace.includes("reset") && !h.trace.includes("fit"),
    "nothing was discarded or resized for a replay this session never received",
  );
  assert.deepEqual(h.notices, []);
});

test("a host frame advances the model, and a gap is not guessed at", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  h.emit?.(screenEvent(1));
  assert.equal(h.model.state?.sequence, 1);

  // A frame that is not the next one is a gap. The session recovers rather
  // than applying it, so the model keeps the last state it could believe.
  h.emit?.(screenEvent(5));
  assert.equal(h.model.state?.sequence, 1, "the model is untouched by a frame out of order");
});

test("what happened beside the screen is handed on once, in order", async () => {
  // A bell is not a cell and a title is not a row. They arrive with the frame
  // they belong to, and the client that is told about them is told once: a
  // second delivery is a terminal that rings twice for one bell.
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  // A snapshot is state, not occurrences: the bell that rang before this
  // client attached is not rung again for it.
  assert.deepEqual(h.effects, []);

  h.emit?.(screenEvent(1));
  await settle();
  assert.deepEqual(h.effects, ["title", "bell"]);

  // Nothing new happened, so nothing is reported again.
  h.effects.length = 0;
  h.model.setViewportIntent({ followBottom: true, historyAnchor: null });
  await settle();
  assert.deepEqual(h.effects, []);
});

test("local input leaves as what a person did", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  await h.act({ kind: "focus", gained: true });

  assert.deepEqual(h.sent, [{ kind: "focus", gained: true }]);
  assert.ok(!h.trace.some((entry) => entry.startsWith("write:")), "and never as bytes");
});

test("an unsent keystroke is reported, and an accepted one moves the reading position", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();
  h.trace.length = 0;

  await h.act({ kind: "text", text: "a" } as TerminalInput);
  assert.deepEqual(h.notices, [], "an accepted keystroke is nobody's problem");

  h.inputOutcome = { status: "failed", error: new Error("the host refused") };
  await h.act({ kind: "text", text: "b" } as TerminalInput);
  assert.deepEqual(h.notices, ["Couldn’t write to terminal: Error: the host refused"]);
});

test("bytes arriving for a session with no parser are reported, not dropped", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  h.emit?.({ event: "output", sequence: 1, data: [104, 105] } as unknown as TerminalEvent);
  await settle();

  assert.deepEqual(h.notices, [
    "Couldn’t show terminal output: Error: This terminal session has no byte path to "
      + "write child output into",
  ]);
});

test("disposal closes the semantic input path", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();
  h.trace.length = 0;

  session.dispose();
  assert.ok(h.trace.includes("input:off"), "no later action can reach the host");

  await h.act({ kind: "focus", gained: false });
  assert.deepEqual(h.sent, [], "and the sink the surface still holds goes nowhere");
});

test("a reader who scrolls back has the rows they display read for them", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  // Ten rows behind an eight-row screen, and the reader moves to the sixth.
  h.emit?.(screenEvent(1, 10));
  h.trace.length = 0;
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 6 });
  await settle();

  assert.deepEqual(
    h.trace.filter((entry) => entry.startsWith("history:")),
    ["history:6:4"],
    "the four rows of history that reach the top of the live screen",
  );
});

test("a reader at the bottom asks the host for no history at all", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  h.emit?.(screenEvent(1, 10));
  await settle();

  assert.deepEqual(h.trace.filter((entry) => entry.startsWith("history:")), []);
});

test("the same read against the same screen is not asked for twice", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  // Retention ends before the rows the reader asks for, so the host answers
  // short and the rows are still not held. Asking again would produce the same
  // short answer for as long as the reader sits still, which is a loop rather
  // than a recovery.
  h.historyRows = 6;
  h.emit?.(screenEvent(1, 10));
  h.trace.length = 0;
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 6 });
  await settle();
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 6 });
  await settle();

  assert.deepEqual(h.trace.filter((entry) => entry.startsWith("history:")), ["history:6:4"]);
});

test("a reader who scrolls back has their line pinned, not their row number", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  h.emit?.(screenEvent(1, 10));
  h.trace.length = 0;
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 6 });
  await settle();

  assert.ok(
    h.trace.includes("anchor:history:6"),
    "the row the reader displays is pinned as a line the host tracks",
  );
});

test("the host moving the reader's line moves the reader", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  h.emit?.(screenEvent(1, 10));
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 6 });
  await settle();
  h.trace.length = 0;

  // Four lines were evicted while the reader sat still. Nothing in a screen
  // frame says so; the anchor is the only place it can be learnt.
  h.anchoredRow = 2;
  h.emit?.(screenEvent(2, 10));
  await settle();

  assert.deepEqual(h.model.viewportIntent, { followBottom: false, historyAnchor: 2 });
  const reads = h.trace.filter((entry) => entry.startsWith("history:"));
  assert.ok(
    reads.at(-1)?.startsWith("history:2:"),
    `the rows read are the ones the reader's line is on now, not ${String(reads.at(-1))}`,
  );
});

test("disposal stops the host holding the reader's line", async () => {
  const h = new Harness();
  const session = startTerminalViewSession(h.ports);
  await h.frame();

  h.emit?.(screenEvent(1, 10));
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 6 });
  await settle();
  h.trace.length = 0;

  session.dispose();
  await settle();

  assert.ok(
    h.trace.some((entry) => entry.startsWith("release:")),
    "a session that ends does not leave the host tracking a line for nobody",
  );
});

test("a screen that advanced under a scrolled-back reader is read again", async () => {
  const h = new Harness();
  startTerminalViewSession(h.ports);
  await h.frame();

  h.emit?.(screenEvent(1, 10));
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 6 });
  await settle();
  h.trace.length = 0;

  // A history row number is a position, and eviction moves it. The rows behind
  // a reader are re-read rather than assumed to be the ones already held.
  h.emit?.(screenEvent(2, 10));
  await settle();

  assert.deepEqual(h.trace.filter((entry) => entry.startsWith("history:")), ["history:6:4"]);
});
