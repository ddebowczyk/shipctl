/**
 * The client's own model of one terminal.
 *
 * This is the durable recipient of host state. It holds no xterm, no React, no
 * DOM, no canvas and no renderer, so a terminal keeps its screen, its history
 * intent and its lifecycle while nothing is mounted, and a surface that mounts,
 * unmounts or is recreated repaints from what is already here instead of asking
 * the host to send it again.
 *
 * The model reads. It never decides terminal meaning: grapheme width, wrap,
 * reflow, cursor column, selection and modes arrive decided by the host, and
 * nothing in this file recomputes any of them.
 *
 * Every commit is atomic. A frame is decoded completely before any part of it
 * is stored, so a frame the host sent wrong, or one that arrives against the
 * wrong base, leaves the model exactly as it was and is reported instead.
 *
 * The authority for the shapes below is `TerminalProjection` in
 * `core/backend/src/terminal/projection.rs`. `terminalScreenFixture.json` is one
 * frame written by the host's own parser and is what the suite decodes, so a
 * renamed or reshaped field fails here rather than in a browser.
 */

import type {
  TerminalAnchorId,
  TerminalEffect,
  TerminalProjectedPoint,
  TerminalScreenState,
} from "../semanticTypes.ts";

/** How many columns a grapheme occupies. The host owns this. */
export type TerminalCellWidth = "narrow" | "wide" | "spacer_tail" | "spacer_head";

/** OSC 133 marking, as the host reported it. */
export type TerminalPromptMark = "none" | "prompt" | "prompt_continuation";

export type TerminalActiveScreen = "primary" | "alternate";

/** What changed since the host's previous read. */
export type TerminalDamageScope = "clean" | "partial" | "full";

export interface TerminalColorModel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface TerminalCellModel {
  /** One grapheme cluster, combining marks included. Empty for spacer cells. */
  readonly text: string;
  readonly width: TerminalCellWidth;
  readonly bold: boolean;
  readonly foreground: TerminalColorModel | null;
  readonly background: TerminalColorModel | null;
  readonly selected: boolean;
  readonly hyperlink: string | null;
}

export interface TerminalRowModel {
  readonly wrapped: boolean;
  readonly continuation: boolean;
  readonly prompt: TerminalPromptMark;
  readonly cells: readonly TerminalCellModel[];
}

/**
 * How the cursor is drawn.
 *
 * The child's DECSCUSR request resolved against the configured default, which
 * the host does — so this is terminal state like any other, and not a
 * preference the painter reads on its own.
 */
export type TerminalCursorShape = "block" | "block_hollow" | "bar" | "underline";

export interface TerminalCursorModel {
  readonly column: number;
  readonly row: number;
  readonly visible: boolean;
  readonly pendingWrap: boolean;
  readonly shape: TerminalCursorShape;
  /** Whether this cursor blinks. When it is lit is the painter's own phase. */
  readonly blinking: boolean;
}

export interface TerminalModesModel {
  readonly wraparound: boolean;
  readonly bracketedPaste: boolean;
  readonly applicationCursorKeys: boolean;
  readonly applicationKeypad: boolean;
  readonly focusEvents: boolean;
  readonly mouseTracking: boolean;
  readonly insert: boolean;
  readonly reverseVideo: boolean;
  readonly origin: boolean;
}

export interface TerminalColorsModel {
  readonly foreground: TerminalColorModel | null;
  readonly background: TerminalColorModel | null;
  readonly palette: readonly TerminalColorModel[];
}

export interface TerminalDamageModel {
  readonly scope: TerminalDamageScope;
  /** Viewport rows that changed. Meaningful when the scope is partial. */
  readonly rows: readonly number[];
}

export interface TerminalScreenModel {
  readonly columns: number;
  readonly rows: number;
  readonly screen: TerminalActiveScreen;
  readonly scrollbackRows: number;
  readonly cursor: TerminalCursorModel;
  readonly modes: TerminalModesModel;
  readonly colors: TerminalColorsModel;
  readonly damage: TerminalDamageModel;
  readonly viewport: readonly TerminalRowModel[];
}

export class TerminalModelDecodeError extends Error {
  constructor(message: string) {
    super(`Rejected terminal state: ${message}`);
    this.name = "TerminalModelDecodeError";
  }
}

function reject(message: string): never {
  throw new TerminalModelDecodeError(message);
}

function objectAt(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    reject(`${path} is not an object`);
  }
  return raw as Record<string, unknown>;
}

function boolAt(raw: Record<string, unknown>, field: string, path: string): boolean {
  const value = raw[field];
  if (typeof value !== "boolean") reject(`${path}.${field} is not a boolean`);
  return value;
}

function countAt(raw: Record<string, unknown>, field: string, path: string): number {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    reject(`${path}.${field} is not a count`);
  }
  return value;
}

function stringAt(raw: Record<string, unknown>, field: string, path: string): string {
  const value = raw[field];
  if (typeof value !== "string") reject(`${path}.${field} is not a string`);
  return value;
}

function memberAt<T extends string>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  members: readonly T[],
): T {
  const value = stringAt(raw, field, path);
  if (!(members as readonly string[]).includes(value)) {
    reject(`${path}.${field} is not one of ${members.join(", ")}`);
  }
  return value as T;
}

function arrayAt(raw: Record<string, unknown>, field: string, path: string): readonly unknown[] {
  const value = raw[field];
  if (!Array.isArray(value)) reject(`${path}.${field} is not an array`);
  return value;
}

function colorAt(raw: unknown, path: string): TerminalColorModel {
  const color = objectAt(raw, path);
  const channel = (name: "r" | "g" | "b"): number => {
    const value = color[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
      reject(`${path}.${name} is not a colour channel`);
    }
    return value;
  };
  return { r: channel("r"), g: channel("g"), b: channel("b") };
}

/**
 * A colour the host may leave unset. The field must be present either way: an
 * absent field is a shape the host does not write, and reading it as "unset"
 * would turn a protocol change into a silently different colour.
 */
function optionalColorAt(
  raw: Record<string, unknown>,
  field: string,
  path: string,
): TerminalColorModel | null {
  if (!(field in raw)) reject(`${path}.${field} is missing`);
  const value = raw[field];
  return value === null ? null : colorAt(value, `${path}.${field}`);
}

function cellAt(raw: unknown, path: string): TerminalCellModel {
  const cell = objectAt(raw, path);
  return {
    text: stringAt(cell, "text", path),
    width: memberAt(cell, "width", path, ["narrow", "wide", "spacer_tail", "spacer_head"]),
    bold: boolAt(cell, "bold", path),
    foreground: optionalColorAt(cell, "foreground", path),
    background: optionalColorAt(cell, "background", path),
    selected: boolAt(cell, "selected", path),
    // The host omits this field on a cell that carries no link, which is the
    // one place an absent field is the host's own encoding of "none".
    hyperlink: cell.hyperlink === undefined ? null : stringAt(cell, "hyperlink", path),
  };
}

function rowAt(raw: unknown, path: string): TerminalRowModel {
  const row = objectAt(raw, path);
  return {
    wrapped: boolAt(row, "wrapped", path),
    continuation: boolAt(row, "continuation", path),
    prompt: memberAt(row, "prompt", path, ["none", "prompt", "prompt_continuation"]),
    cells: arrayAt(row, "cells", path).map((cell, index) => cellAt(cell, `${path}.cells[${index}]`)),
  };
}

function selectionAt(
  raw: Record<string, unknown>,
  rows: number,
  columns: number,
): readonly ReadonlySet<number>[] {
  const selected = Array.from({ length: rows }, () => new Set<number>());
  let previousRow = -1;
  for (const [rowIndex, rawRow] of arrayAt(raw, "selection", "state").entries()) {
    const selectionRow = objectAt(rawRow, `state.selection[${rowIndex}]`);
    const row = countAt(selectionRow, "row", `state.selection[${rowIndex}]`);
    if (row >= rows || row <= previousRow) {
      reject(`state.selection[${rowIndex}].row is not a new row of this viewport`);
    }
    previousRow = row;
    let previousEnd = 0;
    for (const [spanIndex, rawSpan] of arrayAt(
      selectionRow,
      "spans",
      `state.selection[${rowIndex}]`,
    ).entries()) {
      const path = `state.selection[${rowIndex}].spans[${spanIndex}]`;
      const span = objectAt(rawSpan, path);
      const start = countAt(span, "start", path);
      const end = countAt(span, "end", path);
      if (start < previousEnd || start >= end || end > columns) {
        reject(`${path} is not a bounded, ordered selection span`);
      }
      for (let column = start; column < end; column += 1) selected[row].add(column);
      previousEnd = end;
    }
  }
  return selected;
}

function runRowAt(
  raw: unknown,
  path: string,
  selected: ReadonlySet<number>,
  columns: number,
): TerminalRowModel {
  const row = objectAt(raw, path);
  const cells: TerminalCellModel[] = [];
  for (const [runIndex, rawRun] of arrayAt(row, "runs", path).entries()) {
    const runPath = `${path}.runs[${runIndex}]`;
    const run = objectAt(rawRun, runPath);
    const width = memberAt(run, "width", runPath, [
      "narrow",
      "wide",
      "spacer_tail",
      "spacer_head",
    ]);
    const bold = boolAt(run, "bold", runPath);
    const foreground = optionalColorAt(run, "foreground", runPath);
    const background = optionalColorAt(run, "background", runPath);
    const hyperlink = run.hyperlink === undefined ? null : stringAt(run, "hyperlink", runPath);
    const glyphs = arrayAt(run, "glyphs", runPath);
    if (glyphs.length === 0) reject(`${runPath}.glyphs is empty`);
    for (const [glyphIndex, glyph] of glyphs.entries()) {
      if (typeof glyph !== "string") reject(`${runPath}.glyphs[${glyphIndex}] is not a string`);
      const column = cells.length;
      cells.push({
        text: glyph,
        width,
        bold,
        foreground,
        background,
        selected: selected.has(column),
        hyperlink,
      });
    }
  }
  if (cells.length !== columns) {
    reject(`${path} holds ${cells.length} cells and the host reported ${columns}`);
  }
  return {
    wrapped: boolAt(row, "wrapped", path),
    continuation: boolAt(row, "continuation", path),
    prompt: memberAt(row, "prompt", path, ["none", "prompt", "prompt_continuation"]),
    cells,
  };
}

/**
 * Decode one host screen state, completely, or throw.
 *
 * Nothing is stored here; the caller commits the returned value. That is what
 * makes a rejected frame leave the model untouched.
 */
export function decodeScreenState(raw: TerminalScreenState | unknown): TerminalScreenModel {
  const state = objectAt(raw, "state");
  const cursor = objectAt(state.cursor, "state.cursor");
  const modes = objectAt(state.modes, "state.modes");
  const colors = objectAt(state.colors, "state.colors");
  const damage = objectAt(state.damage, "state.damage");
  const columns = countAt(state, "columns", "state");
  const rows = countAt(state, "rows", "state");
  const selection = selectionAt(state, rows, columns);
  const viewport = arrayAt(state, "viewport", "state").map((row, index) =>
    runRowAt(row, `state.viewport[${index}]`, selection[index], columns),
  );
  if (viewport.length !== rows) {
    reject(`state.viewport holds ${viewport.length} rows and the host reported ${rows}`);
  }
  return {
    columns,
    rows,
    screen: memberAt(state, "screen", "state", ["primary", "alternate"]),
    scrollbackRows: countAt(state, "scrollbackRows", "state"),
    cursor: {
      column: countAt(cursor, "column", "state.cursor"),
      row: countAt(cursor, "row", "state.cursor"),
      visible: boolAt(cursor, "visible", "state.cursor"),
      pendingWrap: boolAt(cursor, "pendingWrap", "state.cursor"),
      shape: memberAt(cursor, "shape", "state.cursor", [
        "block",
        "block_hollow",
        "bar",
        "underline",
      ]),
      blinking: boolAt(cursor, "blinking", "state.cursor"),
    },
    modes: {
      wraparound: boolAt(modes, "wraparound", "state.modes"),
      bracketedPaste: boolAt(modes, "bracketedPaste", "state.modes"),
      applicationCursorKeys: boolAt(modes, "applicationCursorKeys", "state.modes"),
      applicationKeypad: boolAt(modes, "applicationKeypad", "state.modes"),
      focusEvents: boolAt(modes, "focusEvents", "state.modes"),
      mouseTracking: boolAt(modes, "mouseTracking", "state.modes"),
      insert: boolAt(modes, "insert", "state.modes"),
      reverseVideo: boolAt(modes, "reverseVideo", "state.modes"),
      origin: boolAt(modes, "origin", "state.modes"),
    },
    colors: {
      foreground: optionalColorAt(colors, "foreground", "state.colors"),
      background: optionalColorAt(colors, "background", "state.colors"),
      palette: arrayAt(colors, "palette", "state.colors").map((color, index) =>
        colorAt(color, `state.colors.palette[${index}]`),
      ),
    },
    damage: {
      scope: memberAt(damage, "scope", "state.damage", ["clean", "partial", "full"]),
      rows: arrayAt(damage, "rows", "state.damage").map((row, index) => {
        if (typeof row !== "number" || !Number.isInteger(row) || row < 0 || row >= rows) {
          reject(`state.damage.rows[${index}] is not a row of this viewport`);
        }
        return row;
      }),
    },
    viewport,
  };
}

/**
 * The rows behind the viewport, as the host answered one read.
 *
 * A history row number is a position, never an identity: eviction renumbers
 * everything behind it. `historyRows` is what history held when this window was
 * read, so a client can tell that its window moved — it cannot tell which line
 * moved where, and this model never pretends it can.
 */
export interface TerminalHistoryWindowModel {
  /** History row of the first row held. Zero is the oldest row kept. */
  readonly startRow: number;
  /** Rows retained behind the viewport when the window was read. */
  readonly historyRows: number;
  /** The window, oldest row first. */
  readonly rows: readonly TerminalRowModel[];
}

/**
 * Decode one history window, completely, or throw.
 *
 * The rows are decoded by the same reader the viewport uses, because they are
 * the same kind of row; `terminalHistoryFixture.json` is the host's own answer
 * and the suite proves that claim against it.
 */
export function decodeHistoryWindow(raw: unknown): TerminalHistoryWindowModel {
  const window = objectAt(raw, "history");
  const startRow = countAt(window, "startRow", "history");
  const historyRows = countAt(window, "historyRows", "history");
  const rows = arrayAt(window, "rows", "history").map((row, index) =>
    rowAt(row, `history.rows[${index}]`),
  );
  // History is what the window is read out of, so a window cannot reach past
  // it. A client that believed one would be holding rows the host does not.
  if (startRow + rows.length > historyRows) {
    reject(
      `history.rows reaches row ${startRow + rows.length} and the host retains ${historyRows}`,
    );
  }
  return { startRow, historyRows, rows };
}

/**
 * One line the host is holding for this client, and where it is now.
 *
 * A row number says where something was; this says which line it is. The host
 * moves an anchor with its cell through scrolling, eviction and reflow, so a
 * client that must point at one line across reads holds one of these instead of
 * a number. The authority is `TerminalAnchor` in
 * `core/backend/src/terminal/projection.rs`.
 */
export interface TerminalAnchorModel {
  readonly id: TerminalAnchorId;
  /** False once the anchored line is gone. Trustworthy while `lossReported`. */
  readonly retained: boolean;
  /**
   * Whether this terminal can report the loss of an anchored line.
   *
   * False on a terminal that retains no history: a line that leaves the active
   * area is destroyed with no eviction to report, and the anchor keeps naming
   * the row that replaced it. A client that needs a line to stay a line reads
   * this before believing `retained`.
   */
  readonly lossReported: boolean;
  /** Where a history read finds the line, while it is behind the viewport. */
  readonly history: TerminalProjectedPoint | null;
  /** History and the active area counted together, for as long as it exists. */
  readonly screen: TerminalProjectedPoint | null;
  /** Where the line is drawn, while it is visible. */
  readonly viewport: TerminalProjectedPoint | null;
  /** Where the line is in the active area, while the child can write to it. */
  readonly active: TerminalProjectedPoint | null;
}

function optionalPointAt(
  raw: Record<string, unknown>,
  field: string,
  path: string,
): TerminalProjectedPoint | null {
  // Present either way, for the reason a colour is: an absent field is a shape
  // the host does not write, and reading it as "nowhere" would turn a protocol
  // change into a line that silently stopped existing.
  if (!(field in raw)) reject(`${path}.${field} is missing`);
  const value = raw[field];
  if (value === null) return null;
  const point = objectAt(value, `${path}.${field}`);
  return {
    column: countAt(point, "column", `${path}.${field}`),
    row: countAt(point, "row", `${path}.${field}`),
  };
}

/** Decode one anchor, completely, or throw. */
export function decodeAnchor(raw: unknown): TerminalAnchorModel {
  const anchor = objectAt(raw, "anchor");
  return {
    id: countAt(anchor, "id", "anchor"),
    retained: boolAt(anchor, "retained", "anchor"),
    lossReported: boolAt(anchor, "lossReported", "anchor"),
    history: optionalPointAt(anchor, "history", "anchor"),
    screen: optionalPointAt(anchor, "screen", "anchor"),
    viewport: optionalPointAt(anchor, "viewport", "anchor"),
    active: optionalPointAt(anchor, "active", "anchor"),
  };
}

/**
 * Decode an anchor the host may no longer hold.
 *
 * `null` is the host's answer for a handle it never minted or already released.
 * It is a fact about the client's handle, not a malformed frame.
 */
export function decodeResolvedAnchor(raw: unknown): TerminalAnchorModel | null {
  return raw === null || raw === undefined ? null : decodeAnchor(raw);
}

/** One committed state, with the counters that say which one it is. */
export interface TerminalModelState {
  readonly screen: TerminalScreenModel;
  /** The host occurrence this state came from. */
  readonly sequence: number;
  /** The host's revision of the terminal at that occurrence. */
  readonly revision: number;
}

/** What a surface is told when the model changes. */
export type TerminalModelListener = (
  state: TerminalModelState,
  damage: TerminalDamageModel,
) => void;

/** Why a frame did not commit. */
export type TerminalFrameOutcome =
  | { readonly status: "committed" }
  | { readonly status: "rejected"; readonly reason: "stale" | "invalid"; readonly detail: string };

/** The one frame this model applies today: a complete host snapshot. */
export interface TerminalScreenFrame {
  readonly sequence: number;
  readonly revision: number;
  readonly state: TerminalScreenState | unknown;
}

/** Where the client is looking. Renderer-independent: rows, never pixels. */
export interface TerminalViewportIntent {
  /** The user is pinned to the newest output and follows it. */
  readonly followBottom: boolean;
  /**
   * The history row the user is holding in view, or null while following the
   * bottom. It is a host history coordinate, not a scroll offset.
   */
  readonly historyAnchor: number | null;
}

const FULL_REPAINT: TerminalDamageModel = { scope: "full", rows: [] };

/**
 * One terminal's durable client state.
 *
 * Surfaces come and go against it. Disposal is deliberate and explicit, so no
 * React cleanup, visibility change, theme change or renderer swap can end a
 * terminal's continuity by accident.
 */
export class TerminalClientModel {
  #state: TerminalModelState | null = null;
  #history: TerminalHistoryWindowModel | null = null;
  #effects: TerminalEffect[] = [];
  #listeners = new Set<TerminalModelListener>();
  #intent: TerminalViewportIntent = { followBottom: true, historyAnchor: null };
  #exited = false;
  #disposed = false;

  /** The committed state, or null before the first frame. */
  get state(): TerminalModelState | null {
    return this.#state;
  }

  /** The host reported this terminal has ended. Input is closed; state stays. */
  get exited(): boolean {
    return this.#exited;
  }

  /**
   * The history window this model last read, or null before any read.
   *
   * One window, not an accumulation. Rows from two reads cannot be joined by
   * their numbers: eviction renumbers history silently, and `historyRows`
   * stands still once retention is at its limit, so two windows that look
   * adjacent may not be. Holding one line across time is what the host's
   * anchors are for, and `terminalReadingAnchor.ts` holds the reader's own.
   */
  get history(): TerminalHistoryWindowModel | null {
    return this.#history;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get viewportIntent(): TerminalViewportIntent {
    return this.#intent;
  }

  /**
   * Apply one host frame.
   *
   * The frame is decoded in full before anything is stored, and a frame that is
   * not newer than the committed one is refused rather than reordered. Either
   * the whole frame commits or the model is untouched.
   */
  applyScreen(frame: TerminalScreenFrame): TerminalFrameOutcome {
    if (this.#disposed) {
      return { status: "rejected", reason: "invalid", detail: "the model is disposed" };
    }
    if (this.#state && frame.sequence <= this.#state.sequence) {
      return {
        status: "rejected",
        reason: "stale",
        detail: `sequence ${frame.sequence} is not newer than ${this.#state.sequence}`,
      };
    }
    let screen: TerminalScreenModel;
    try {
      screen = decodeScreenState(frame.state);
      if (!Number.isInteger(frame.revision) || frame.revision <= 0) {
        reject("the frame carries no revision");
      }
    } catch (error) {
      return {
        status: "rejected",
        reason: "invalid",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    this.#state = { screen, sequence: frame.sequence, revision: frame.revision };
    // The window was read against the screen this frame replaces. Whatever
    // pushed the screen on may have evicted lines, and eviction renumbers
    // history without saying so, so the rows held no longer answer for the
    // numbers they are filed under. They are read again rather than assumed.
    this.#history = null;
    for (const listener of [...this.#listeners]) listener(this.#state, screen.damage);
    return { status: "committed" };
  }

  /**
   * Start, or restart, from a complete host baseline.
   *
   * A baseline is not a later frame: it is the whole state as of the sequence
   * it names, so it replaces what is here instead of being ordered against it.
   * That is what lets a reattachment that found nothing new still install a
   * state, where an ordinary frame at the same sequence would be stale.
   *
   * Occurrences already waiting are kept. They happened; a new baseline does
   * not unhappen them.
   */
  installBaseline(frame: TerminalScreenFrame): TerminalFrameOutcome {
    if (this.#disposed) {
      return { status: "rejected", reason: "invalid", detail: "the model is disposed" };
    }
    let screen: TerminalScreenModel;
    try {
      screen = decodeScreenState(frame.state);
      if (!Number.isInteger(frame.revision) || frame.revision <= 0) {
        reject("the baseline carries no revision");
      }
    } catch (error) {
      return {
        status: "rejected",
        reason: "invalid",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.#state = { screen, sequence: frame.sequence, revision: frame.revision };
    // The whole state is replaced, and a history window read against the old
    // one is part of what it replaces.
    this.#history = null;
    for (const listener of [...this.#listeners]) listener(this.#state, FULL_REPAINT);
    return { status: "committed" };
  }

  /** Commit ordered occurrences without coupling them to replaceable state. */
  applyEffects(effects: readonly TerminalEffect[]): TerminalFrameOutcome {
    if (this.#disposed) {
      return { status: "rejected", reason: "invalid", detail: "the model is disposed" };
    }
    try {
      for (const [index, effect] of effects.entries()) {
        if (typeof effect?.kind !== "string") reject(`effects[${index}] has no kind`);
      }
    } catch (error) {
      return {
        status: "rejected",
        reason: "invalid",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.#effects.push(...effects);
    if (this.#state) {
      for (const listener of [...this.#listeners]) listener(this.#state, { scope: "clean", rows: [] });
    }
    return { status: "committed" };
  }

  /**
   * Hold one history window the host answered.
   *
   * It is not ordered against the screen: a window is a read of retention at
   * the moment it was taken, and it neither advances nor invalidates the
   * viewport's sequence. Nothing is stored unless the whole window decodes.
   *
   * A reader who is not following the bottom is looking at these rows, so the
   * window arriving is a change to what is displayed and listeners are told.
   * One who is following the bottom is not, and is not woken by a read that
   * changes nothing on their screen.
   */
  applyHistory(raw: unknown): TerminalFrameOutcome {
    if (this.#disposed) {
      return { status: "rejected", reason: "invalid", detail: "the model is disposed" };
    }
    let window: TerminalHistoryWindowModel;
    try {
      window = decodeHistoryWindow(raw);
    } catch (error) {
      return {
        status: "rejected",
        reason: "invalid",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.#history = window;
    if (!this.#intent.followBottom) this.#announce();
    return { status: "committed" };
  }

  /** The host reported the terminal ended. */
  noteExited(): void {
    if (this.#disposed) return;
    this.#exited = true;
  }

  /**
   * Take the occurrences that have not been handled yet.
   *
   * They are delivered once. A caller that takes them owns them, so a bell does
   * not ring twice because a surface remounted, and one that arrives while
   * nothing is mounted still waits here rather than being dropped.
   */
  drainEffects(): readonly TerminalEffect[] {
    const taken = this.#effects;
    this.#effects = [];
    return taken;
  }

  /**
   * Watch committed changes.
   *
   * A new listener is given the current state immediately, and told to repaint
   * all of it: a surface that has just mounted has painted nothing, whatever
   * the last frame's damage said. Removing a listener removes a presentation,
   * not the model.
   */
  subscribe(listener: TerminalModelListener): () => void {
    this.#listeners.add(listener);
    if (this.#state) listener(this.#state, FULL_REPAINT);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Where the client is looking. The surface reports it; the model keeps it.
   *
   * Moving it changes which rows are displayed, so listeners are told and are
   * told to repaint all of them: the rows above and below a scroll are not the
   * rows the last frame's damage described.
   */
  setViewportIntent(intent: TerminalViewportIntent): void {
    if (this.#disposed) return;
    if (
      intent.followBottom === this.#intent.followBottom
      && intent.historyAnchor === this.#intent.historyAnchor
    ) {
      return;
    }
    this.#intent = intent;
    this.#announce();
  }

  /** Tell every listener that all of what they show is owed a frame. */
  #announce(): void {
    if (!this.#state) return;
    const state = this.#state;
    for (const listener of [...this.#listeners]) listener(state, FULL_REPAINT);
  }

  /**
   * End this model deliberately.
   *
   * This is a recovery boundary and the only one this class can reach on its
   * own. It is never a side effect of a surface going away.
   */
  dispose(): void {
    this.#disposed = true;
    this.#state = null;
    this.#history = null;
    this.#effects = [];
    this.#listeners.clear();
  }
}
