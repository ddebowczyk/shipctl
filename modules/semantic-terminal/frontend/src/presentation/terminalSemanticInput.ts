/**
 * What a person did, as this client observed it.
 *
 * The host owns what bytes an action becomes. Which bytes depend on the modes
 * the child selected — application cursor keys, the Kitty keyboard protocol,
 * bracketed paste, mouse tracking and format, focus reporting — and all of
 * those live in the host's parser. So this module maps a browser event to the
 * host's `TerminalInput` and stops there. It builds no escape sequence, holds
 * no mode, and keeps no copy of the host's rules.
 *
 * Three rules follow from that, and each is asserted in the suite:
 *
 * - **Text is what the layout produced, unmodified by Ctrl or Meta.** Ctrl+C
 *   reports `c` with `ctrl` held. The control byte is the host's conclusion.
 * - **A key is named by where it is, not by what it makes.** `code` is the W3C
 *   physical-key name. The host refuses a name it cannot place; this module
 *   keeps no second table of key names to refuse it earlier.
 * - **A pointer position is a pixel until the host says otherwise.** The
 *   geometry travels with the event, because only the client knows how large
 *   it drew a cell.
 *
 * The shapes below mirror `core/backend/src/terminal/input.rs`. They are not
 * checked against it by a compiler, so `terminalInputFixture.json` — written by
 * the host from those Rust types — is the gate, and
 * `tests/terminalSemanticInput.test.ts` builds a browser event for every sample
 * in it.
 */

// A pointer position is one concept, shared with the paint plan that resolves
// it to a cell. It is imported rather than restated so the two cannot drift.
import type { TerminalSurfacePoint } from "./terminalCellPaint.ts";

/** Modifier keys held when something happened. */
export interface TerminalModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  /** The command key on macOS, the Windows key elsewhere. */
  readonly meta: boolean;
  readonly capsLock: boolean;
  readonly numLock: boolean;
}

export type TerminalKeyAction = "press" | "release" | "repeat";

export interface TerminalKeyInput {
  readonly kind: "key";
  readonly action: TerminalKeyAction;
  /** A W3C key code name, such as `KeyC`, `ArrowUp` or `F5`. */
  readonly code: string;
  /** What the key produces under the current layout, or null. */
  readonly text: string | null;
  readonly mods: TerminalModifiers;
  /** A composing key produces no bytes; the commit arrives as text. */
  readonly composing: boolean;
}

/** Text an input method committed. It carries no key: a composition has none. */
export interface TerminalTextInput {
  readonly kind: "text";
  readonly text: string;
}

/** A paste. Bracketed or not is the child's mode, not this client's choice. */
export interface TerminalPasteInput {
  readonly kind: "paste";
  readonly text: string;
}

export type TerminalMouseAction = "press" | "release" | "motion";

export type TerminalMouseButton =
  | "left"
  | "middle"
  | "right"
  | "four"
  | "five"
  | "six"
  | "seven"
  | "eight"
  | "nine"
  | "ten"
  | "eleven";

/** How the client drew the terminal, in pixels. */
export interface TerminalSurfaceGeometry {
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
}

export interface TerminalMouseInput {
  readonly kind: "mouse";
  readonly action: TerminalMouseAction;
  /** Null for a motion with no button held. */
  readonly button: TerminalMouseButton | null;
  readonly mods: TerminalModifiers;
  /** Surface pixels, with the surface's top-left corner at the origin. */
  readonly x: number;
  readonly y: number;
  readonly surface: TerminalSurfaceGeometry;
  /** The formats that report drags need this and cannot derive it. */
  readonly anyButtonPressed: boolean;
}

export interface TerminalFocusInput {
  readonly kind: "focus";
  readonly gained: boolean;
}

/** One thing a person did. */
export type TerminalInput =
  | TerminalKeyInput
  | TerminalTextInput
  | TerminalPasteInput
  | TerminalMouseInput
  | TerminalFocusInput;

/**
 * The modifier state every browser event carries.
 *
 * Named on its own because an event with no button and no key — a wheel — still
 * has to report what was held while it happened.
 */
export interface TerminalModifierFacts {
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  getModifierState(key: string): boolean;
}

/**
 * The part of a `KeyboardEvent` this module reads.
 *
 * Structural, so the suite constructs one and a browser's own event satisfies
 * it without a DOM.
 */
export interface TerminalKeyEventFacts extends TerminalModifierFacts {
  readonly type: string;
  readonly code: string;
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

/** The part of a `PointerEvent` or `MouseEvent` this module reads. */
export interface TerminalPointerEventFacts extends TerminalModifierFacts {
  readonly type: string;
  /** W3C `button`: the button whose state changed, and -1 for none. */
  readonly button: number;
  /** W3C `buttons`: the bitmask of buttons currently held. */
  readonly buttons: number;
}

function modifiers(event: TerminalModifierFacts): TerminalModifiers {
  return {
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    // Lock state is held rather than pressed, and only the platform knows it.
    capsLock: event.getModifierState("CapsLock"),
    numLock: event.getModifierState("NumLock"),
  };
}

/**
 * What a key produced, or null for a key that produces no text.
 *
 * `key` is either one code point of text or the name of a key — `ArrowUp`,
 * `Enter`, `Dead`. One code point is the whole test, and nothing longer is
 * lost by it: text longer than one code point comes from an input method, and
 * an input method commits through {@link semanticTextInput} instead.
 *
 * Whether that code point is printable is the host's question. It drops text
 * its encoder cannot carry, and this module keeps no second copy of that rule.
 */
function keyText(key: string): string | null {
  return Array.from(key).length === 1 ? key : null;
}

/**
 * One key event, or null for an event that is neither a press nor a release.
 *
 * The code is passed through. A key this host cannot name is refused by the
 * host, which is where the table of names lives.
 */
export function semanticKeyInput(event: TerminalKeyEventFacts): TerminalKeyInput | null {
  const action: TerminalKeyAction | null =
    event.type === "keydown" ? (event.repeat ? "repeat" : "press")
    : event.type === "keyup" ? "release"
    : null;
  if (action === null) return null;
  return {
    kind: "key",
    action,
    code: event.code,
    text: keyText(event.key),
    mods: modifiers(event),
    composing: event.isComposing,
  };
}

/**
 * Text an input method committed.
 *
 * Empty text is passed on rather than dropped: what an empty commit means is
 * the terminal's question, and the host answers it by encoding nothing.
 */
export function semanticTextInput(text: string): TerminalTextInput {
  return { kind: "text", text };
}

/**
 * A paste.
 *
 * Whether a payload is safe to paste unguarded is the host's answer, not this
 * module's, so nothing is inspected here.
 */
export function semanticPasteInput(text: string): TerminalPasteInput {
  return { kind: "paste", text };
}

/**
 * The button whose state changed, by W3C index.
 *
 * The browser numbers buttons and the host names them, so this mapping has to
 * live on the client side of the boundary. Null for an event that changed no
 * button, which is what a motion reports.
 */
const BUTTONS_BY_INDEX: readonly TerminalMouseButton[] = [
  "left",
  "middle",
  "right",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
];

/**
 * The button a held-button bitmask reports first.
 *
 * W3C `buttons` orders its bits by primary, secondary, auxiliary — not by the
 * `button` index — so the first three entries are not in index order.
 */
const BUTTONS_BY_BIT: readonly TerminalMouseButton[] = [
  "left",
  "right",
  "middle",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
];

function heldButton(buttons: number): TerminalMouseButton | null {
  for (const [bit, button] of BUTTONS_BY_BIT.entries()) {
    if ((buttons & (1 << bit)) !== 0) return button;
  }
  return null;
}

/**
 * One pointer event in surface pixels.
 *
 * A motion names the button being dragged, because the formats that report
 * drags need it and cannot derive it from one event. A motion with nothing
 * held names none.
 */
export function semanticMouseInput(
  event: TerminalPointerEventFacts,
  point: TerminalSurfacePoint,
  surface: TerminalSurfaceGeometry,
): TerminalMouseInput | null {
  const action: TerminalMouseAction | null =
    event.type === "pointerdown" || event.type === "mousedown" ? "press"
    : event.type === "pointerup" || event.type === "mouseup" ? "release"
    : event.type === "pointermove" || event.type === "mousemove" ? "motion"
    : null;
  if (action === null) return null;
  const button =
    action === "motion" ? heldButton(event.buttons) : (BUTTONS_BY_INDEX[event.button] ?? null);
  return {
    kind: "mouse",
    action,
    button,
    mods: modifiers(event),
    x: point.x,
    y: point.y,
    surface,
    anyButtonPressed: event.buttons !== 0,
  };
}

/** Which way the wheel turned, in the direction the surface moved. */
export type TerminalWheelDirection = "up" | "down" | "left" | "right";

/**
 * The button each wheel direction is.
 *
 * A terminal has no scroll message. X11 numbered the wheel as buttons four to
 * seven and every mouse format since has carried it that way, so the host
 * encodes a wheel from a button press like any other. The numbers are asserted
 * against the pinned parser in
 * `compat.rs::the_wheel_encodes_as_the_buttons_the_scroll_flag_names`, and the
 * `mouse-wheel-*` samples of the input fixture are the same four values.
 */
const WHEEL_BUTTONS: Readonly<Record<TerminalWheelDirection, TerminalMouseButton>> = {
  up: "four",
  down: "five",
  left: "six",
  right: "seven",
};

/**
 * One wheel report, for a child that asked for the mouse.
 *
 * One report is one step of the wheel. How many steps an event is worth is the
 * client's measurement — it depends on the cell it drew — so the caller counts
 * them and this says what one of them is.
 *
 * The press has no release. A wheel is never held, and a client that sent one
 * would be telling the child a button was let go.
 */
export function semanticWheelInput(
  direction: TerminalWheelDirection,
  event: TerminalModifierFacts,
  point: TerminalSurfacePoint,
  surface: TerminalSurfaceGeometry,
): TerminalMouseInput {
  return {
    kind: "mouse",
    action: "press",
    button: WHEEL_BUTTONS[direction],
    mods: modifiers(event),
    x: point.x,
    y: point.y,
    surface,
    // Nothing is held: the formats that report drags must not read a wheel as
    // one.
    anyButtonPressed: false,
  };
}

/** The window gained or lost focus. */
export function semanticFocusInput(gained: boolean): TerminalFocusInput {
  return { kind: "focus", gained };
}
