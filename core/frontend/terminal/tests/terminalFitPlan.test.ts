import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLUMN_REFLOW_DEFER_BUFFER_ROWS,
  MINIMUM_TERMINAL_DIMENSION,
  clampTerminalGeometry,
  planTerminalFit,
} from "../terminalFitPlan.ts";

const SHORT_BUFFER = COLUMN_REFLOW_DEFER_BUFFER_ROWS;
const LONG_BUFFER = COLUMN_REFLOW_DEFER_BUFFER_ROWS + 1;

test("a geometry that already matches produces no work", () => {
  const plan = planTerminalFit({
    current: { columns: 80, rows: 24 },
    proposed: { columns: 80, rows: 24 },
    bufferRows: LONG_BUFFER,
  });
  assert.deepEqual(plan, { kind: "unchanged" });
});

test("a short buffer applies columns and rows together", () => {
  const plan = planTerminalFit({
    current: { columns: 80, rows: 24 },
    proposed: { columns: 120, rows: 40 },
    bufferRows: SHORT_BUFFER,
  });
  assert.deepEqual(plan, {
    kind: "resize",
    size: { columns: 120, rows: 40 },
  });
});

test("the defer threshold is exclusive, so a buffer at the boundary still resizes at once", () => {
  // Guards the boundary itself: the upstream condition is `> 200`, not `>= 200`.
  const atBoundary = planTerminalFit({
    current: { columns: 80, rows: 24 },
    proposed: { columns: 120, rows: 24 },
    bufferRows: SHORT_BUFFER,
  });
  assert.equal(atBoundary.kind, "resize");

  const pastBoundary = planTerminalFit({
    current: { columns: 80, rows: 24 },
    proposed: { columns: 120, rows: 24 },
    bufferRows: LONG_BUFFER,
  });
  assert.equal(pastBoundary.kind, "settle-columns");
});

test("a row-only change is never deferred, however long the buffer is", () => {
  // Rows do not reflow the scrollback, so the cost the threshold exists to
  // avoid is not incurred.
  const plan = planTerminalFit({
    current: { columns: 80, rows: 24 },
    proposed: { columns: 80, rows: 40 },
    bufferRows: LONG_BUFFER,
  });
  assert.deepEqual(plan, {
    kind: "resize",
    size: { columns: 80, rows: 40 },
  });
});

test("a long buffer applies the new rows at the current width and defers the width", () => {
  const plan = planTerminalFit({
    current: { columns: 80, rows: 24 },
    proposed: { columns: 120, rows: 40 },
    bufferRows: LONG_BUFFER,
  });
  assert.deepEqual(plan, {
    kind: "settle-columns",
    // The width stays at 80 so the rows can land without a reflow.
    immediate: { columns: 80, rows: 40 },
    deferred: { columns: 120, rows: 40 },
  });
});

test("a long buffer with a column-only change defers everything", () => {
  const plan = planTerminalFit({
    current: { columns: 80, rows: 24 },
    proposed: { columns: 120, rows: 24 },
    bufferRows: LONG_BUFFER,
  });
  assert.deepEqual(plan, {
    kind: "settle-columns",
    immediate: null,
    deferred: { columns: 120, rows: 24 },
  });
});

test("clamping raises a dimension to the floor and leaves larger ones alone", () => {
  assert.deepEqual(clampTerminalGeometry({ columns: 0, rows: 0 }), {
    columns: MINIMUM_TERMINAL_DIMENSION,
    rows: MINIMUM_TERMINAL_DIMENSION,
  });
  assert.deepEqual(clampTerminalGeometry({ columns: -5, rows: 1 }), {
    columns: MINIMUM_TERMINAL_DIMENSION,
    rows: MINIMUM_TERMINAL_DIMENSION,
  });
  assert.deepEqual(clampTerminalGeometry({ columns: 80, rows: 24 }), {
    columns: 80,
    rows: 24,
  });
});
