import assert from "node:assert/strict";
import { test } from "node:test";

import { COLUMN_REFLOW_SETTLE_MS, type TerminalGeometry } from "../terminalFitPlan.ts";
import {
  TerminalFitScheduler,
  type TerminalFitMeasurement,
} from "../terminalFitScheduler.ts";

/** A buffer long enough that a width change is deferred rather than reflowed. */
const LONG_BUFFER = 400;
const SHORT_BUFFER = 10;

class Harness {
  /** Sizes handed to the surface, in order. */
  readonly applied: TerminalGeometry[] = [];
  readonly scheduler: TerminalFitScheduler;

  measurement: TerminalFitMeasurement | null = {
    current: { columns: 80, rows: 24 },
    proposed: { columns: 80, rows: 24 },
    bufferRows: SHORT_BUFFER,
  };

  #deferred: { task: () => void; delayMs: number } | null = null;

  constructor() {
    this.scheduler = new TerminalFitScheduler({
      measure: () => this.measurement,
      applySize: async (size) => {
        this.applied.push(size);
      },
      defer: (task, delayMs) => {
        this.#deferred = { task, delayMs };
        return () => {
          if (this.#deferred?.task === task) this.#deferred = null;
        };
      },
    });
  }

  /** What the container currently proposes. */
  propose(proposed: TerminalGeometry, bufferRows = SHORT_BUFFER): void {
    this.measurement = {
      current: this.measurement?.current ?? { columns: 80, rows: 24 },
      proposed,
      bufferRows,
    };
  }

  /** Pretend the surface accepted a size, as a real resize would. */
  settleAt(current: TerminalGeometry): void {
    this.measurement = {
      current,
      proposed: this.measurement?.proposed ?? current,
      bufferRows: this.measurement?.bufferRows ?? SHORT_BUFFER,
    };
  }

  get pendingDelay(): number | null {
    return this.#deferred?.delayMs ?? null;
  }

  /** Let the quiet period elapse. */
  fireDeferred(): void {
    const deferred = this.#deferred;
    assert.ok(deferred, "no deferred fit was scheduled");
    this.#deferred = null;
    deferred.task();
  }
}

test("an unmeasurable container is not resized", async () => {
  const h = new Harness();
  h.measurement = null;

  await h.scheduler.request();

  assert.deepEqual(h.applied, []);
});

test("a container that has not changed is not resized", async () => {
  const h = new Harness();

  await h.scheduler.request();

  assert.deepEqual(h.applied, []);
});

test("a short buffer takes the whole change at once", async () => {
  const h = new Harness();
  h.propose({ columns: 120, rows: 30 });

  await h.scheduler.request();

  assert.deepEqual(h.applied, [{ columns: 120, rows: 30 }]);
  assert.equal(h.pendingDelay, null, "nothing to wait for");
});

test("a long buffer takes the rows now and the width once the gesture settles", async () => {
  const h = new Harness();
  h.propose({ columns: 120, rows: 30 }, LONG_BUFFER);

  await h.scheduler.request();

  assert.deepEqual(
    h.applied,
    [{ columns: 80, rows: 30 }],
    "rows are cheap, so they land at the current width",
  );
  assert.equal(h.pendingDelay, COLUMN_REFLOW_SETTLE_MS);

  h.fireDeferred();
  assert.deepEqual(h.applied.at(-1), { columns: 120, rows: 30 });
});

test("a width-only change against a long buffer waits without an interim resize", async () => {
  const h = new Harness();
  h.propose({ columns: 120, rows: 24 }, LONG_BUFFER);

  await h.scheduler.request();
  assert.deepEqual(h.applied, []);

  h.fireDeferred();
  assert.deepEqual(h.applied, [{ columns: 120, rows: 24 }]);
});

test("an observation at the settled size leaves the pending width alone", async () => {
  const h = new Harness();
  h.propose({ columns: 120, rows: 24 }, LONG_BUFFER);
  await h.scheduler.request();

  // The gesture paused at a width the surface already has: this observation
  // says nothing about the width still waiting to be applied.
  h.settleAt({ columns: 120, rows: 24 });
  h.propose({ columns: 120, rows: 24 }, LONG_BUFFER);
  await h.scheduler.request();

  assert.equal(h.pendingDelay, COLUMN_REFLOW_SETTLE_MS);
});

test("a later gesture supersedes the width that was waiting", async () => {
  const h = new Harness();
  h.propose({ columns: 120, rows: 24 }, LONG_BUFFER);
  await h.scheduler.request();

  h.propose({ columns: 200, rows: 24 }, LONG_BUFFER);
  await h.scheduler.request();

  h.fireDeferred();
  assert.deepEqual(h.applied, [{ columns: 200, rows: 24 }], "the stale width never lands");
});

test("a resize that can be applied at once drops the width that was waiting", async () => {
  const h = new Harness();
  h.propose({ columns: 120, rows: 24 }, LONG_BUFFER);
  await h.scheduler.request();

  // The buffer has since been reset to a short one, so nothing needs deferring.
  h.propose({ columns: 90, rows: 24 }, SHORT_BUFFER);
  await h.scheduler.request();

  assert.deepEqual(h.applied, [{ columns: 90, rows: 24 }]);
  assert.equal(h.pendingDelay, null);
});

test("a disposed scheduler applies nothing, then or later", async () => {
  const h = new Harness();
  h.propose({ columns: 120, rows: 24 }, LONG_BUFFER);
  await h.scheduler.request();

  h.scheduler.dispose();
  assert.equal(h.pendingDelay, null, "the pending width was dropped, not applied late");

  h.propose({ columns: 200, rows: 40 });
  await h.scheduler.request();
  assert.deepEqual(h.applied, []);
});
