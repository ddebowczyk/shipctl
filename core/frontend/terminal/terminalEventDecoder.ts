/**
 * Fail-closed decoder for host terminal events.
 *
 * The Rust model in `core/backend/src/terminal/types.rs` is the authority. This
 * decoder is the only door into client state: an event that does not match the
 * generated contract (`terminalEventContract.json`) is rejected here, before it
 * can reach the attachment controller, the registry, or the renderer.
 *
 * Structure only. Ordering and lifecycle meaning are behavior and are proved by
 * traces, not by this file.
 */

import type {
  TerminalEffect,
  TerminalEvent,
  TerminalRevision,
  TerminalScreenState,
} from "./types.ts";

/** Mirrors `MAX_EXACT_JSON_INTEGER` in core/backend/src/terminal/contract.rs. */
export const MAX_EXACT_JSON_INTEGER = 9_007_199_254_740_991;

export class TerminalEventDecodeError extends Error {
  constructor(message: string) {
    super(`Rejected terminal event: ${message}`);
    this.name = "TerminalEventDecodeError";
  }
}

function reject(message: string): never {
  throw new TerminalEventDecodeError(message);
}

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    reject("payload is not an object");
  }
  return raw as Record<string, unknown>;
}

/**
 * A sequence or revision must be a positive integer the host and the client
 * both represent exactly. Anything else would let the two sides disagree about
 * order while both believed they were consecutive.
 */
function exactCounter(raw: Record<string, unknown>, field: string): number {
  const value = raw[field];
  if (typeof value !== "number") reject(`${field} is not a number`);
  if (!Number.isInteger(value)) reject(`${field} is not an integer`);
  if (value <= 0) reject(`${field} is not positive`);
  if (value > MAX_EXACT_JSON_INTEGER) reject(`${field} is outside the exact integer range`);
  return value;
}

function text(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string") reject(`${field} is not a string`);
  return value;
}

function nested(raw: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = raw[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

function byteArray(raw: Record<string, unknown>, field: string): number[] {
  const value = raw[field];
  if (!Array.isArray(value)) reject(`${field} is not an array`);
  for (const byte of value) {
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      reject(`${field} contains a value that is not a byte`);
    }
  }
  return value as number[];
}

function array(raw: Record<string, unknown>, field: string): readonly unknown[] {
  const value = raw[field];
  if (!Array.isArray(value)) reject(`${field} is not an array`);
  return value;
}

/**
 * The host's state, checked at the depth this decoder is the authority for.
 *
 * Every fact the client reads without descending into rows is checked here. The
 * rows and the cells inside them are checked where the client model reads them,
 * because that is where a missing field would be believed; the generated
 * contract describes this field as one object, so nothing below it is gated by
 * the drift artifact yet.
 *
 * The state is handed on whole rather than rebuilt from the checked fields. A
 * rebuilt object would drop whatever this decoder does not name, and the field
 * it dropped would be missing in the client model with nothing to say why.
 */
function screenState(raw: Record<string, unknown>, field: string): TerminalScreenState {
  const state = nested(raw, field);
  exactCounter(state, "columns");
  exactCounter(state, "rows");
  text(state, "screen");
  count(state, "scrollbackRows");
  nested(state, "cursor");
  nested(state, "modes");
  nested(state, "colors");
  nested(state, "damage");
  array(state, "viewport");
  return state as unknown as TerminalScreenState;
}

/**
 * The occurrences that came with one state frame.
 *
 * Each one is checked for the tag that says what it is, because a client
 * dispatches on that tag. What hangs below the tag belongs to the handler for
 * that kind and is checked there.
 */
function effects(raw: Record<string, unknown>, field: string): readonly TerminalEffect[] {
  return array(raw, field).map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      reject(`${field}[${index}] is not an object`);
    }
    const effect = entry as Record<string, unknown>;
    if (typeof effect.kind !== "string") {
      reject(`${field}[${index}] has no kind`);
    }
    return effect as TerminalEffect;
  });
}

/** Like {@link exactCounter}, for a count that may legitimately be zero. */
function count(raw: Record<string, unknown>, field: string): number {
  const value = raw[field];
  if (typeof value !== "number") reject(`${field} is not a number`);
  if (!Number.isInteger(value)) reject(`${field} is not an integer`);
  if (value < 0) reject(`${field} is negative`);
  if (value > MAX_EXACT_JSON_INTEGER) reject(`${field} is outside the exact integer range`);
  return value;
}

/** Every tag the client accepts. A tag absent from this list is rejected. */
export const TERMINAL_EVENT_TAGS = [
  "output",
  "replay",
  "screen",
  "metadata_changed",
  "agent_activity_changed",
  "exited",
  "resync_required",
  "detached",
] as const;

export type TerminalEventTag = (typeof TERMINAL_EVENT_TAGS)[number];

/**
 * Decode one host event or throw.
 *
 * The switch is exhaustive over `TERMINAL_EVENT_TAGS`; a tag added to the Rust
 * model without a case here lands in the default branch and is rejected rather
 * than silently ignored.
 */
export function decodeTerminalEvent(raw: unknown): TerminalEvent {
  const payload = object(raw);
  const rawTag = payload.event;
  if (typeof rawTag !== "string") reject("event tag is missing or not a string");
  const tag = rawTag as TerminalEventTag;

  switch (tag) {
    case "output":
      return {
        event: "output",
        sequence: exactCounter(payload, "sequence"),
        revision: exactCounter(payload, "revision") as TerminalRevision,
        data: byteArray(payload, "data"),
      };
    case "replay": {
      const replay = nested(payload, "replay");
      return {
        event: "replay",
        sequence: exactCounter(payload, "sequence"),
        replay: {
          revision: exactCounter(replay, "revision") as TerminalRevision,
          columns: exactCounter(replay, "columns"),
          rows: exactCounter(replay, "rows"),
          bytes: byteArray(replay, "bytes"),
        },
      };
    }
    case "screen":
      return {
        event: "screen",
        sequence: exactCounter(payload, "sequence"),
        revision: exactCounter(payload, "revision") as TerminalRevision,
        state: screenState(payload, "state"),
        effects: effects(payload, "effects"),
      };
    case "metadata_changed":
    case "agent_activity_changed":
    case "exited":
      nested(payload, "descriptor");
      return {
        event: tag,
        sequence: exactCounter(payload, "sequence"),
        descriptor: payload.descriptor,
      } as TerminalEvent;
    case "resync_required":
    case "detached":
      return {
        event: tag,
        sequence: exactCounter(payload, "sequence"),
        reason: text(payload, "reason"),
      };
    default:
      return reject(`unsupported event tag "${String(rawTag)}"`);
  }
}
