/**
 * The reading position, held as a line.
 *
 * The anchor every trace decodes is `terminalAnchorFixture.json`, written by
 * the host's own parser in `core/backend/src/terminal/contract.rs`. That is
 * what makes these assertions about the host's shape rather than about a
 * reading of it.
 *
 * The rule under test is the one a row number cannot keep: a reader scrolled
 * back must stay on the line they are reading while eviction renumbers history
 * under them. Everything below is that rule, plus what happens when the line
 * they were reading stops existing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  decodeAnchor,
  decodeResolvedAnchor,
  type TerminalViewportIntent,
} from "../terminalClientModel.ts";
import { TerminalReadingAnchor } from "../terminalReadingAnchor.ts";
import type { TerminalAnchorId, TerminalProjectedPoint } from "../types.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../terminalAnchorFixture.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The host's own anchor, at the handle and history row the caller names. */
function hostAnchor(
  id: number,
  at: TerminalProjectedPoint | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...structuredClone(fixture), id, history: at, ...overrides };
}

class Harness {
  readonly trace: string[] = [];
  readonly notices: string[] = [];
  intent: TerminalViewportIntent = { followBottom: true, historyAnchor: null };
  /** What the host answers the next anchor or resolve with. */
  next: unknown = hostAnchor(1, { column: 0, row: 0 });
  /** Set to reject every host call, as a host that will not hold a line does. */
  refuse = false;

  readonly reading: TerminalReadingAnchor;

  #pending: (() => void)[] = [];
  /** Hold host answers until the trace releases them. */
  hold = false;

  constructor() {
    this.reading = new TerminalReadingAnchor({
      anchor: (space, at) => {
        this.trace.push(`anchor:${space}:${at.row}:${at.column}`);
        return this.#answer();
      },
      resolveAnchor: (anchor) => {
        this.trace.push(`resolve:${anchor}`);
        return this.#answer();
      },
      releaseAnchor: (anchor: TerminalAnchorId) => {
        this.trace.push(`release:${anchor}`);
        return Promise.resolve(true);
      },
      intent: () => this.intent,
      setIntent: (intent) => {
        this.intent = intent;
        this.trace.push(
          `intent:${intent.followBottom ? "bottom" : String(intent.historyAnchor)}`,
        );
      },
      notifyError: (title, error) => {
        this.notices.push(`${title}: ${String(error)}`);
      },
    });
  }

  /** Move the reader, the way a wheel or a pin does. */
  read(intent: TerminalViewportIntent): void {
    this.intent = intent;
  }

  /** One announced change, and the host answers before it returns. */
  async observe(): Promise<void> {
    this.reading.observe();
    await settle();
  }

  /** Release the host answers a held trace is waiting on. */
  async release(): Promise<void> {
    for (const resolve of this.#pending.splice(0)) resolve();
    await settle();
  }

  #answer(): Promise<unknown> {
    if (this.refuse) return Promise.reject(new Error("the host refused"));
    const value = this.next;
    if (!this.hold) return Promise.resolve(value);
    return new Promise((resolve) => {
      this.#pending.push(() => resolve(value));
    });
  }
}

test("the host's own anchor decodes whole", () => {
  const anchor = decodeAnchor(structuredClone(fixture));

  assert.ok(Number.isInteger(anchor.id));
  assert.equal(anchor.retained, true);
  assert.equal(anchor.lossReported, true, "this terminal can report a lost line");
  assert.deepEqual(anchor.history, { column: 0, row: 0 }, "the line is behind the viewport");
  assert.ok(anchor.screen, "and is somewhere on the screen");
  assert.equal(anchor.viewport, null, "and is not drawn");
  assert.equal(anchor.active, null, "and the child cannot write to it");
});

test("a handle the host no longer holds is an answer, not a malformed frame", () => {
  assert.equal(decodeResolvedAnchor(null), null);
  assert.throws(
    () => decodeAnchor({ id: 1, retained: true, lossReported: true, history: null }),
    /screen is missing/,
    "a field the host stopped writing is refused rather than read as nowhere",
  );
});

test("a reader at the bottom asks the host to hold nothing", async () => {
  const h = new Harness();
  await h.observe();

  assert.deepEqual(h.trace, [], "the newest output is what a screen frame already carries");
});

test("leaving the bottom pins the row the reader displays", async () => {
  const h = new Harness();
  h.read({ followBottom: false, historyAnchor: 6 });
  h.next = hostAnchor(1, { column: 0, row: 6 });
  await h.observe();

  assert.deepEqual(h.trace, ["anchor:history:6:0"]);
  assert.equal(h.reading.held?.id, 1);
});

test("eviction moves the reader with their line", async () => {
  const h = new Harness();
  h.read({ followBottom: false, historyAnchor: 6 });
  h.next = hostAnchor(1, { column: 0, row: 6 });
  await h.observe();
  h.trace.length = 0;

  // Four lines were evicted, so the line the reader is on is row 2 now. A
  // client holding the number would be four lines further down the terminal.
  h.next = hostAnchor(1, { column: 0, row: 2 });
  await h.observe();

  assert.deepEqual(h.trace, ["resolve:1", "intent:2"]);
  assert.deepEqual(h.intent, { followBottom: false, historyAnchor: 2 });

  // The correction is not a move by the reader, so the line is not re-pinned.
  h.trace.length = 0;
  await h.observe();
  assert.deepEqual(h.trace, ["resolve:1"], "the same line is still the reader's");
});

test("a line the terminal dropped puts the reader on the oldest row it kept", async () => {
  const h = new Harness();
  h.read({ followBottom: false, historyAnchor: 6 });
  h.next = hostAnchor(1, { column: 0, row: 6 });
  await h.observe();
  h.trace.length = 0;

  h.next = hostAnchor(1, null, { retained: false, screen: null });
  await h.observe();

  assert.deepEqual(h.trace, ["resolve:1", "release:1", "intent:0"]);
  assert.deepEqual(
    h.intent,
    { followBottom: false, historyAnchor: 0 },
    "the nearest position that still exists is the oldest row history holds",
  );
  assert.equal(h.reading.held, null);
});

test("a line back on the active area returns the reader to the bottom", async () => {
  const h = new Harness();
  h.read({ followBottom: false, historyAnchor: 6 });
  h.next = hostAnchor(1, { column: 0, row: 6 });
  await h.observe();
  h.trace.length = 0;

  h.next = hostAnchor(1, null, { active: { column: 0, row: 3 } });
  await h.observe();

  assert.deepEqual(h.trace, ["resolve:1", "release:1", "intent:bottom"]);
  assert.deepEqual(h.intent, { followBottom: true, historyAnchor: null });
});

test("a reader who scrolls is not pulled back to the line they left", async () => {
  const h = new Harness();
  h.read({ followBottom: false, historyAnchor: 6 });
  h.next = hostAnchor(1, { column: 0, row: 6 });
  await h.observe();
  h.trace.length = 0;

  h.read({ followBottom: false, historyAnchor: 3 });
  h.next = hostAnchor(2, { column: 0, row: 3 });
  await h.observe();

  assert.deepEqual(h.trace, ["release:1", "anchor:history:3:0"]);
  assert.equal(h.reading.held?.id, 2);
  assert.deepEqual(
    h.intent,
    { followBottom: false, historyAnchor: 3 },
    "where the reader went is where they are",
  );
});

test("returning to the bottom stops the host holding the line", async () => {
  const h = new Harness();
  h.read({ followBottom: false, historyAnchor: 6 });
  h.next = hostAnchor(1, { column: 0, row: 6 });
  await h.observe();
  h.trace.length = 0;

  h.read({ followBottom: true, historyAnchor: null });
  await h.observe();

  assert.deepEqual(h.trace, ["release:1"]);
  assert.equal(h.reading.held, null);
});

test("one host call at a time, whatever a frame asks for", async () => {
  const h = new Harness();
  h.hold = true;
  h.read({ followBottom: false, historyAnchor: 6 });
  h.next = hostAnchor(1, { column: 0, row: 6 });

  h.reading.observe();
  h.reading.observe();
  h.reading.observe();
  await settle();

  assert.deepEqual(h.trace, ["anchor:history:6:0"], "a frame cannot queue a second round trip");
  await h.release();
  assert.equal(h.reading.held?.id, 1);
});

test("a host that will not hold a line is reported once, and reading goes on", async () => {
  const h = new Harness();
  h.refuse = true;
  h.read({ followBottom: false, historyAnchor: 6 });
  await h.observe();
  await h.observe();
  await h.observe();

  assert.deepEqual(h.trace, ["anchor:history:6:0"], "a refusal is not retried every frame");
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /Couldn’t hold the terminal reading position/);
  assert.deepEqual(
    h.intent,
    { followBottom: false, historyAnchor: 6 },
    "the reader keeps the position they had, on a row number, as before anchors",
  );
});

test("disposal stops the host holding the line, and no later answer moves the reader", async () => {
  const h = new Harness();
  h.read({ followBottom: false, historyAnchor: 6 });
  h.next = hostAnchor(1, { column: 0, row: 6 });
  await h.observe();
  h.trace.length = 0;

  h.reading.dispose();
  assert.deepEqual(h.trace, ["release:1"]);

  h.next = hostAnchor(1, { column: 0, row: 2 });
  await h.observe();
  assert.deepEqual(h.trace, ["release:1"], "a disposed reading position asks the host nothing");
  assert.deepEqual(h.intent, { followBottom: false, historyAnchor: 6 });
});

test("a line pinned while disposal was in flight is not left with the host", async () => {
  const h = new Harness();
  h.hold = true;
  h.read({ followBottom: false, historyAnchor: 6 });
  h.next = hostAnchor(1, { column: 0, row: 6 });

  h.reading.observe();
  await settle();
  h.reading.dispose();
  await h.release();

  assert.deepEqual(h.trace, ["anchor:history:6:0", "release:1"]);
  assert.equal(h.reading.held, null);
});
