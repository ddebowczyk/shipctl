// Fitting a terminal to its container is arithmetic over two geometries and a
// buffer length. Only the result needs xterm, so the decision lives here and
// the view keeps the xterm resize, the PTY resize and the debounce timer.
//
// This module holds no timer and calls nothing. It says what should happen.

export interface TerminalGeometry {
  columns: number;
  rows: number;
}

/** Buffer length above which a column change is deferred instead of applied at
 *  once, because reflowing a long scrollback on every width observation is
 *  costly. Adopted from upstream 59e8fc7 rather than chosen here. */
export const COLUMN_REFLOW_DEFER_BUFFER_ROWS = 200;

/** Quiet period a deferred column change waits for, in milliseconds. Adopted
 *  from upstream 59e8fc7 rather than chosen here. */
export const COLUMN_REFLOW_SETTLE_MS = 100;

/** xterm and the PTY both reject a dimension below this, so every size the view
 *  sends is clamped first. This is the floor the view has always applied. */
export const MINIMUM_TERMINAL_DIMENSION = 2;

export type TerminalFitPlan =
  /** The proposed geometry matches the current one. Do nothing, and leave any
   *  deferred column change pending: it was scheduled against a width that has
   *  not been reached yet. */
  | { kind: "unchanged" }
  /** Apply this geometry now and drop any deferred column change. */
  | { kind: "resize"; size: TerminalGeometry }
  /** A column change against a long buffer. Apply `immediate` now when it is
   *  present, then apply `deferred` once the gesture has been quiet. */
  | {
      kind: "settle-columns";
      immediate: TerminalGeometry | null;
      deferred: TerminalGeometry;
    };

export function clampTerminalGeometry(geometry: TerminalGeometry): TerminalGeometry {
  return {
    columns: Math.max(MINIMUM_TERMINAL_DIMENSION, geometry.columns),
    rows: Math.max(MINIMUM_TERMINAL_DIMENSION, geometry.rows),
  };
}

export function planTerminalFit(inputs: {
  current: TerminalGeometry;
  proposed: TerminalGeometry;
  /** Lines held in the active buffer, including scrollback. */
  bufferRows: number;
}): TerminalFitPlan {
  const { current, proposed, bufferRows } = inputs;
  const columnsChanged = current.columns !== proposed.columns;
  const rowsChanged = current.rows !== proposed.rows;

  if (!columnsChanged && !rowsChanged) return { kind: "unchanged" };

  const deferColumns =
    columnsChanged && bufferRows > COLUMN_REFLOW_DEFER_BUFFER_ROWS;
  if (!deferColumns) return { kind: "resize", size: proposed };

  // Rows are cheap to apply, so they land at the current width straight away
  // and only the width waits for the gesture to settle.
  return {
    kind: "settle-columns",
    immediate: rowsChanged ? { columns: current.columns, rows: proposed.rows } : null,
    deferred: proposed,
  };
}
