import type {
  SemanticTerminalAnchor,
  SemanticTerminalEffect,
  SemanticTerminalHistoryCell,
  SemanticTerminalHistoryRow,
  SemanticTerminalHistoryWindow,
  SemanticTerminalPublicationStats,
  SemanticTerminalScreenRow,
  SemanticTerminalScreenRun,
  SemanticTerminalScreenState,
  SemanticTerminalSelectionState,
} from "@shipctl/module-api";

export const MAX_EXACT_JSON_INTEGER = 9_007_199_254_740_991;

export class SemanticTerminalWireError extends Error {
  constructor(message: string) {
    super(`Rejected semantic terminal value: ${message}`);
    this.name = "SemanticTerminalWireError";
  }
}

function reject(message: string): never {
  throw new SemanticTerminalWireError(message);
}

function object(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    reject(`${path} is not an object`);
  }
  return raw as Record<string, unknown>;
}

function array(raw: Record<string, unknown>, field: string, path: string): readonly unknown[] {
  const value = raw[field];
  if (!Array.isArray(value)) reject(`${path}.${field} is not an array`);
  return value;
}

function string(raw: Record<string, unknown>, field: string, path: string): string {
  const value = raw[field];
  if (typeof value !== "string") reject(`${path}.${field} is not a string`);
  return value;
}

function boolean(raw: Record<string, unknown>, field: string, path: string): boolean {
  const value = raw[field];
  if (typeof value !== "boolean") reject(`${path}.${field} is not a boolean`);
  return value;
}

function count(raw: Record<string, unknown>, field: string, path: string): number {
  const value = raw[field];
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_EXACT_JSON_INTEGER
  ) {
    reject(`${path}.${field} is not an exact non-negative integer`);
  }
  return value;
}

function positive(raw: Record<string, unknown>, field: string, path: string): number {
  const value = count(raw, field, path);
  if (value < 1) reject(`${path}.${field} is not positive`);
  return value;
}

function member<const Value extends string>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  values: readonly Value[],
): Value {
  const value = string(raw, field, path);
  if (!(values as readonly string[]).includes(value)) {
    reject(`${path}.${field} is not one of ${values.join(", ")}`);
  }
  return value as Value;
}

function color(raw: unknown, path: string) {
  const value = object(raw, path);
  const channel = (field: "r" | "g" | "b") => {
    const result = count(value, field, path);
    if (result > 255) reject(`${path}.${field} is not a color channel`);
    return result;
  };
  return { r: channel("r"), g: channel("g"), b: channel("b") };
}

function optionalColor(raw: Record<string, unknown>, field: string, path: string) {
  if (!(field in raw)) reject(`${path}.${field} is missing`);
  return raw[field] === null ? null : color(raw[field], `${path}.${field}`);
}

function point(raw: unknown, path: string) {
  const value = object(raw, path);
  return { column: count(value, "column", path), row: count(value, "row", path) };
}

function optionalPoint(raw: Record<string, unknown>, field: string, path: string) {
  if (!(field in raw)) reject(`${path}.${field} is missing`);
  return raw[field] === null ? null : point(raw[field], `${path}.${field}`);
}

function screenRun(raw: unknown, path: string): SemanticTerminalScreenRun {
  const value = object(raw, path);
  const glyphs = array(value, "glyphs", path).map((glyph, index) => {
    if (typeof glyph !== "string") reject(`${path}.glyphs[${index}] is not a string`);
    return glyph;
  });
  if (glyphs.length === 0) reject(`${path}.glyphs is empty`);
  const hyperlink = value.hyperlink;
  if (hyperlink !== undefined && typeof hyperlink !== "string") {
    reject(`${path}.hyperlink is not a string`);
  }
  return {
    glyphs,
    width: member(value, "width", path, ["narrow", "wide", "spacer_tail", "spacer_head"]),
    bold: boolean(value, "bold", path),
    foreground: optionalColor(value, "foreground", path),
    background: optionalColor(value, "background", path),
    ...(hyperlink === undefined ? {} : { hyperlink }),
  };
}

function screenRow(raw: unknown, path: string): SemanticTerminalScreenRow {
  const value = object(raw, path);
  return {
    wrapped: boolean(value, "wrapped", path),
    continuation: boolean(value, "continuation", path),
    prompt: member(value, "prompt", path, ["none", "prompt", "prompt_continuation"]),
    runs: array(value, "runs", path).map((run, index) => screenRun(run, `${path}.runs[${index}]`)),
  };
}

function historyCell(raw: unknown, path: string): SemanticTerminalHistoryCell {
  const value = object(raw, path);
  const hyperlink = value.hyperlink;
  if (hyperlink !== undefined && typeof hyperlink !== "string") {
    reject(`${path}.hyperlink is not a string`);
  }
  return {
    text: string(value, "text", path),
    width: member(value, "width", path, ["narrow", "wide", "spacer_tail", "spacer_head"]),
    bold: boolean(value, "bold", path),
    foreground: optionalColor(value, "foreground", path),
    background: optionalColor(value, "background", path),
    selected: boolean(value, "selected", path),
    ...(hyperlink === undefined ? {} : { hyperlink }),
  };
}

function historyRow(raw: unknown, path: string): SemanticTerminalHistoryRow {
  const value = object(raw, path);
  return {
    wrapped: boolean(value, "wrapped", path),
    continuation: boolean(value, "continuation", path),
    prompt: member(value, "prompt", path, ["none", "prompt", "prompt_continuation"]),
    cells: array(value, "cells", path).map((cell, index) =>
      historyCell(cell, `${path}.cells[${index}]`)),
  };
}

export function decodeSemanticTerminalScreenState(raw: unknown): SemanticTerminalScreenState {
  const state = object(raw, "state");
  const columns = positive(state, "columns", "state");
  const rows = positive(state, "rows", "state");
  const cursor = object(state.cursor, "state.cursor");
  const modes = object(state.modes, "state.modes");
  const colors = object(state.colors, "state.colors");
  const damage = object(state.damage, "state.damage");
  const viewport = array(state, "viewport", "state").map((row, index) =>
    screenRow(row, `state.viewport[${index}]`));
  if (viewport.length !== rows) reject("state.viewport does not match state.rows");
  return {
    columns,
    rows,
    screen: member(state, "screen", "state", ["primary", "alternate"]),
    scrollbackRows: count(state, "scrollbackRows", "state"),
    cursor: {
      column: count(cursor, "column", "state.cursor"),
      row: count(cursor, "row", "state.cursor"),
      visible: boolean(cursor, "visible", "state.cursor"),
      pendingWrap: boolean(cursor, "pendingWrap", "state.cursor"),
      shape: member(cursor, "shape", "state.cursor", ["block", "block_hollow", "bar", "underline"]),
      blinking: boolean(cursor, "blinking", "state.cursor"),
    },
    modes: {
      wraparound: boolean(modes, "wraparound", "state.modes"),
      bracketedPaste: boolean(modes, "bracketedPaste", "state.modes"),
      applicationCursorKeys: boolean(modes, "applicationCursorKeys", "state.modes"),
      applicationKeypad: boolean(modes, "applicationKeypad", "state.modes"),
      focusEvents: boolean(modes, "focusEvents", "state.modes"),
      mouseTracking: boolean(modes, "mouseTracking", "state.modes"),
      insert: boolean(modes, "insert", "state.modes"),
      reverseVideo: boolean(modes, "reverseVideo", "state.modes"),
      origin: boolean(modes, "origin", "state.modes"),
    },
    colors: {
      foreground: optionalColor(colors, "foreground", "state.colors"),
      background: optionalColor(colors, "background", "state.colors"),
      palette: array(colors, "palette", "state.colors").map((entry, index) =>
        color(entry, `state.colors.palette[${index}]`)),
    },
    damage: {
      scope: member(damage, "scope", "state.damage", ["clean", "partial", "full"]),
      rows: array(damage, "rows", "state.damage").map((row, index) => {
        if (typeof row !== "number" || !Number.isSafeInteger(row) || row < 0 || row >= rows) {
          reject(`state.damage.rows[${index}] is not a viewport row`);
        }
        return row;
      }),
    },
    viewport,
    selection: array(state, "selection", "state").map((entry, index) => {
      const selection = object(entry, `state.selection[${index}]`);
      const row = count(selection, "row", `state.selection[${index}]`);
      if (row >= rows) reject(`state.selection[${index}].row is not a viewport row`);
      return {
        row,
        spans: array(selection, "spans", `state.selection[${index}]`).map((entrySpan, spanIndex) => {
          const path = `state.selection[${index}].spans[${spanIndex}]`;
          const span = object(entrySpan, path);
          const start = count(span, "start", path);
          const end = count(span, "end", path);
          if (start >= end || end > columns) reject(`${path} is not a bounded span`);
          return { start, end };
        }),
      };
    }),
  };
}

export function decodeSemanticTerminalHistory(raw: unknown): SemanticTerminalHistoryWindow {
  const value = object(raw, "history");
  const startRow = count(value, "startRow", "history");
  const historyRows = count(value, "historyRows", "history");
  const rows = array(value, "rows", "history").map((row, index) =>
    historyRow(row, `history.rows[${index}]`));
  if (startRow + rows.length > historyRows) reject("history window exceeds retained history");
  return { startRow, historyRows, rows };
}

export function decodeSemanticTerminalAnchor(raw: unknown): SemanticTerminalAnchor {
  const value = object(raw, "anchor");
  return {
    id: count(value, "id", "anchor"),
    retained: boolean(value, "retained", "anchor"),
    lossReported: boolean(value, "lossReported", "anchor"),
    history: optionalPoint(value, "history", "anchor"),
    screen: optionalPoint(value, "screen", "anchor"),
    viewport: optionalPoint(value, "viewport", "anchor"),
    active: optionalPoint(value, "active", "anchor"),
  };
}

export function decodeResolvedSemanticTerminalAnchor(raw: unknown): SemanticTerminalAnchor | null {
  return raw === null ? null : decodeSemanticTerminalAnchor(raw);
}

export function decodeSemanticTerminalSelection(raw: unknown): SemanticTerminalSelectionState {
  const value = object(raw, "selection");
  const textValue = value.text;
  if (textValue !== null && typeof textValue !== "string") {
    reject("selection.text is not a string or null");
  }
  return {
    active: boolean(value, "active", "selection"),
    text: textValue,
  };
}

export function decodeSemanticTerminalEffects(raw: unknown): readonly SemanticTerminalEffect[] {
  if (!Array.isArray(raw)) reject("effects is not an array");
  return raw.map((entry, index) => {
    const path = `effects[${index}]`;
    const effect = object(entry, path);
    const kind = string(effect, "kind", path);
    switch (kind) {
      case "title":
        return { kind, title: string(effect, "title", path) };
      case "workingDirectory":
        return { kind, uri: string(effect, "uri", path) };
      case "bell":
        return { kind };
      case "clipboard":
        return {
          kind,
          location: member(effect, "location", path, ["standard", "selection", "primary"]),
          contents: array(effect, "contents", path).map((entryContent, contentIndex) => {
            const contentPath = `${path}.contents[${contentIndex}]`;
            const content = object(entryContent, contentPath);
            return {
              mime: string(content, "mime", contentPath),
              data: string(content, "data", contentPath),
            };
          }),
        };
      default:
        return reject(`${path}.kind is unsupported`);
    }
  });
}

export function decodeSemanticTerminalPublicationStats(
  raw: unknown,
): SemanticTerminalPublicationStats {
  const value = object(raw, "publicationStats");
  return {
    ptyReads: count(value, "ptyReads", "publicationStats"),
    screenChanges: count(value, "screenChanges", "publicationStats"),
    screenProjections: count(value, "screenProjections", "publicationStats"),
    screenEncodes: count(value, "screenEncodes", "publicationStats"),
    screenEncodedBytes: count(value, "screenEncodedBytes", "publicationStats"),
    screenRecipientDeliveries: count(value, "screenRecipientDeliveries", "publicationStats"),
    effectEvents: count(value, "effectEvents", "publicationStats"),
    effectEncodedBytes: count(value, "effectEncodedBytes", "publicationStats"),
    currentScreenTransactions: count(value, "currentScreenTransactions", "publicationStats"),
    currentScreenBytesQueued: count(value, "currentScreenBytesQueued", "publicationStats"),
    peakScreenBytesQueued: count(value, "peakScreenBytesQueued", "publicationStats"),
    currentEffectEventsQueued: count(value, "currentEffectEventsQueued", "publicationStats"),
    currentEffectBytesQueued: count(value, "currentEffectBytesQueued", "publicationStats"),
    peakEffectEventsQueued: count(value, "peakEffectEventsQueued", "publicationStats"),
    peakEffectBytesQueued: count(value, "peakEffectBytesQueued", "publicationStats"),
  };
}

export type NativeSemanticTerminalEvent =
  | {
      readonly event: "screen";
      readonly sequence: number;
      readonly revision: number;
      readonly state: SemanticTerminalScreenState;
    }
  | {
      readonly event: "effects";
      readonly sequence: number;
      readonly effects: readonly SemanticTerminalEffect[];
    }
  | {
      readonly event: "metadata_changed" | "agent_activity_changed" | "exited";
      readonly sequence: number;
    }
  | {
      readonly event: "resync_required" | "detached";
      readonly sequence: number;
      readonly reason: string;
    }
  | { readonly event: "unsupported"; readonly sequence: number; readonly source: "output" | "replay" };

export function decodeNativeSemanticTerminalEvent(raw: unknown): NativeSemanticTerminalEvent {
  const value = object(raw, "event");
  const event = string(value, "event", "event");
  const sequence = positive(value, "sequence", "event");
  switch (event) {
    case "screen":
      return {
        event,
        sequence,
        revision: positive(value, "revision", "event"),
        state: decodeSemanticTerminalScreenState(value.state),
      };
    case "effects":
      return { event, sequence, effects: decodeSemanticTerminalEffects(value.effects) };
    case "metadata_changed":
    case "agent_activity_changed":
    case "exited":
      object(value.descriptor, "event.descriptor");
      return { event, sequence };
    case "resync_required":
    case "detached":
      return { event, sequence, reason: string(value, "reason", "event") };
    case "output":
    case "replay":
      return { event: "unsupported", sequence, source: event };
    default:
      return reject(`event.event ${JSON.stringify(event)} is unsupported`);
  }
}

export interface NativeSemanticTerminalAttachment {
  readonly attachmentId: string;
  readonly live: boolean;
  readonly revision: number;
  readonly sequenceBoundary: number;
  readonly snapshot: SemanticTerminalScreenState;
}

export function decodeNativeSemanticTerminalAttachment(
  raw: unknown,
): NativeSemanticTerminalAttachment {
  const value = object(raw, "attachment");
  const descriptor = object(value.descriptor, "attachment.descriptor");
  return {
    attachmentId: string(value, "attachmentId", "attachment"),
    live: boolean(value, "live", "attachment"),
    revision: count(descriptor, "revision", "attachment.descriptor"),
    sequenceBoundary: count(value, "sequenceBoundary", "attachment"),
    snapshot: decodeSemanticTerminalScreenState(value.snapshot),
  };
}

export function decodeEncodedByteCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return reject("encoded byte count is not an exact non-negative integer");
  }
  return raw;
}

export function decodeBoolean(raw: unknown, path: string): boolean {
  if (typeof raw !== "boolean") return reject(`${path} is not a boolean`);
  return raw;
}

export function decodeAppMemory(raw: unknown): { readonly appRss: number } {
  const value = object(raw, "appMemory");
  return { appRss: count(value, "appRss", "appMemory") };
}
