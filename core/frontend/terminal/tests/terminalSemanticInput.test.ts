/**
 * Browser events, against the values the host reads.
 *
 * `terminalInputFixture.json` is written by `terminal/contract.rs` from the
 * Rust `TerminalInput` types, so every field name, every tag and every
 * defaulted value below is the host's, not a reading of it. Each sample is one
 * thing a person does; this file builds the browser event for it and compares
 * the whole value.
 *
 * The comparison is whole on purpose. A missing modifier, an absent `text`
 * written as undefined rather than null, or a tag spelled the client's way
 * would each pass a field-by-field check written from the same misreading.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  semanticFocusInput,
  semanticKeyInput,
  semanticMouseInput,
  semanticPasteInput,
  semanticTextInput,
  semanticWheelInput,
  type TerminalKeyEventFacts,
  type TerminalModifierFacts,
  type TerminalPointerEventFacts,
  type TerminalSurfaceGeometry,
} from "../terminalSemanticInput.ts";
import { KEYBINDING_PRESETS } from "../keybindingPresets.ts";

const samples = JSON.parse(
  readFileSync(new URL("../terminalInputFixture.json", import.meta.url), "utf8"),
) as ReadonlyArray<{ name: string; input: unknown }>;

/** The host's value for one sample. An unknown name is the gate failing. */
function hostInput(name: string): unknown {
  const sample = samples.find((entry) => entry.name === name);
  assert.ok(sample, `${name} is not a sample of the host's input fixture`);
  return sample.input;
}

/** The host's surface geometry, so the pointer samples compare whole. */
const SURFACE = hostInput("mouse-press-left") as { surface: TerminalSurfaceGeometry };

function keyEvent(facts: {
  type: string;
  code: string;
  key: string;
  repeat?: boolean;
  isComposing?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  locks?: readonly string[];
}): TerminalKeyEventFacts {
  return {
    type: facts.type,
    code: facts.code,
    key: facts.key,
    repeat: facts.repeat ?? false,
    isComposing: facts.isComposing ?? false,
    shiftKey: facts.shiftKey ?? false,
    altKey: facts.altKey ?? false,
    ctrlKey: facts.ctrlKey ?? false,
    metaKey: facts.metaKey ?? false,
    getModifierState: (name) => (facts.locks ?? []).includes(name),
  };
}

function pointerEvent(facts: {
  type: string;
  button: number;
  buttons: number;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  locks?: readonly string[];
}): TerminalPointerEventFacts {
  return {
    type: facts.type,
    button: facts.button,
    buttons: facts.buttons,
    shiftKey: facts.shiftKey ?? false,
    altKey: facts.altKey ?? false,
    ctrlKey: facts.ctrlKey ?? false,
    metaKey: facts.metaKey ?? false,
    getModifierState: (name) => (facts.locks ?? []).includes(name),
  };
}

/** A wheel carries modifiers and nothing else this module reads. */
function wheelEvent(facts: {
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  locks?: readonly string[];
}): TerminalModifierFacts {
  return {
    shiftKey: facts.shiftKey ?? false,
    altKey: facts.altKey ?? false,
    ctrlKey: facts.ctrlKey ?? false,
    metaKey: facts.metaKey ?? false,
    getModifierState: (name) => (facts.locks ?? []).includes(name),
  };
}

/** The host's pointer position, shared by every pointer sample. */
const POINT = { x: 123.5, y: 47 };

test("a printable key reports what the layout produced", () => {
  assert.deepStrictEqual(
    semanticKeyInput(keyEvent({ type: "keydown", code: "KeyC", key: "c" })),
    hostInput("key-press-plain"),
  );
});

test("a key held with Ctrl still reports the unmodified text", () => {
  // The falsification that matters: a client that encoded here would send
  // 0x03 and the host would never see which key made it.
  assert.deepStrictEqual(
    semanticKeyInput(keyEvent({ type: "keydown", code: "KeyC", key: "c", ctrlKey: true })),
    hostInput("key-press-ctrl"),
  );
});

test("a key that produces no text names only the physical key", () => {
  assert.deepStrictEqual(
    semanticKeyInput(keyEvent({ type: "keydown", code: "ArrowUp", key: "ArrowUp" })),
    hostInput("key-press-named"),
  );
});

test("a held key repeats rather than pressing again", () => {
  assert.deepStrictEqual(
    semanticKeyInput(keyEvent({ type: "keydown", code: "KeyA", key: "a", repeat: true })),
    hostInput("key-repeat"),
  );
});

test("a release is reported, and the host decides whether it is wanted", () => {
  assert.deepStrictEqual(
    semanticKeyInput(keyEvent({ type: "keyup", code: "KeyC", key: "c" })),
    hostInput("key-release"),
  );
});

test("a key inside a composition says so", () => {
  assert.deepStrictEqual(
    semanticKeyInput(keyEvent({ type: "keydown", code: "KeyA", key: "a", isComposing: true })),
    hostInput("key-composing"),
  );
});

test("lock state is read from the platform, not from the key that changed", () => {
  assert.deepStrictEqual(
    semanticKeyInput(
      keyEvent({
        type: "keydown",
        code: "Digit1",
        key: "!",
        shiftKey: true,
        locks: ["CapsLock", "NumLock"],
      }),
    ),
    hostInput("key-locks"),
  );
});

test("text longer than one code point comes from an input method, not a key", () => {
  // Both halves of the rule. A key event never carries composed text...
  const composed = semanticKeyInput(
    keyEvent({ type: "keydown", code: "KeyA", key: "漢字", isComposing: true }),
  );
  assert.equal(composed?.text, null);
  // ...and the commit that follows carries it with no key at all.
  assert.deepStrictEqual(semanticTextInput("漢字"), hostInput("text-commit"));
});

test("one code point outside the basic plane is still one key's text", () => {
  const emoji = semanticKeyInput(keyEvent({ type: "keydown", code: "KeyE", key: "\u{1f600}" }));
  // Two UTF-16 units, one code point. A length test on the string would drop it.
  assert.equal(emoji?.text, "\u{1f600}");
});

test("an event that is neither a press nor a release produces nothing", () => {
  assert.equal(semanticKeyInput(keyEvent({ type: "keypress", code: "KeyC", key: "c" })), null);
});

test("a paste is passed on whole, and the host judges it", () => {
  assert.deepStrictEqual(semanticPasteInput("echo hi"), hostInput("paste"));
});

test("a button press names the button and carries the surface it happened on", () => {
  assert.deepStrictEqual(
    semanticMouseInput(
      pointerEvent({ type: "pointerdown", button: 0, buttons: 1 }),
      POINT,
      SURFACE.surface,
    ),
    hostInput("mouse-press-left"),
  );
});

test("a drag names the held button, which the changed-button index does not", () => {
  // A pointermove reports button -1. Reading it would name no button and the
  // host's drag formats would report a release instead.
  assert.deepStrictEqual(
    semanticMouseInput(
      pointerEvent({ type: "pointermove", button: -1, buttons: 1 }),
      POINT,
      SURFACE.surface,
    ),
    hostInput("mouse-motion-drag"),
  );
});

test("a hover names no button", () => {
  assert.deepStrictEqual(
    semanticMouseInput(
      pointerEvent({ type: "pointermove", button: -1, buttons: 0 }),
      POINT,
      SURFACE.surface,
    ),
    hostInput("mouse-motion-idle"),
  );
});

test("the secondary button is named by its index, not by its bit", () => {
  // W3C numbers the secondary button 2 and gives it bit 2 in `buttons`, where
  // bit 2 is the auxiliary button. One table for each is why.
  assert.deepStrictEqual(
    semanticMouseInput(
      pointerEvent({ type: "pointerup", button: 2, buttons: 0, altKey: true, shiftKey: true }),
      POINT,
      SURFACE.surface,
    ),
    hostInput("mouse-release-right"),
  );
});

test("a drag with the secondary button held names the secondary button", () => {
  const held = semanticMouseInput(
    pointerEvent({ type: "pointermove", button: -1, buttons: 2 }),
    POINT,
    SURFACE.surface,
  );
  assert.equal(held?.button, "right");
  const auxiliary = semanticMouseInput(
    pointerEvent({ type: "pointermove", button: -1, buttons: 4 }),
    POINT,
    SURFACE.surface,
  );
  assert.equal(auxiliary?.button, "middle");
});

test("a pointer event of no interest produces nothing", () => {
  assert.equal(
    semanticMouseInput(
      pointerEvent({ type: "pointerenter", button: -1, buttons: 0 }),
      POINT,
      SURFACE.surface,
    ),
    null,
  );
});

test("the wheel is the four buttons the host names, pressed and not held", () => {
  // The falsification this rules out: a client that invented a scroll message,
  // or numbered the directions itself. Each direction is compared whole against
  // the host's own sample, and `anyButtonPressed` false is part of the value —
  // a wheel read as a held button would report every later motion as a drag.
  for (const [direction, name] of [
    ["up", "mouse-wheel-up"],
    ["down", "mouse-wheel-down"],
    ["left", "mouse-wheel-left"],
    ["right", "mouse-wheel-right"],
  ] as const) {
    assert.deepStrictEqual(
      semanticWheelInput(direction, wheelEvent({}), POINT, SURFACE.surface),
      hostInput(name),
      direction,
    );
  }
});

test("a wheel turned with a modifier held carries it", () => {
  const ctrl = semanticWheelInput("up", wheelEvent({ ctrlKey: true }), POINT, SURFACE.surface);
  // Ctrl+wheel is how a person zooms in a great many programs, and which of
  // them is listening is the child's business once it asked for the mouse.
  assert.deepStrictEqual(ctrl.mods, {
    shift: false,
    alt: false,
    ctrl: true,
    meta: false,
    capsLock: false,
    numLock: false,
  });
});

test("focus is reported in both directions", () => {
  assert.deepStrictEqual(semanticFocusInput(true), hostInput("focus-gained"));
  assert.deepStrictEqual(semanticFocusInput(false), hostInput("focus-lost"));
});

test("the keybinding presets carry the host's own value for what they send", () => {
  // Each preset ships a byte sequence for the legacy path. The semantic form
  // beside it is the host's, taken from the fixture, and
  // runtime.rs::the_keybinding_presets_are_bytes_this_host_already_makes
  // asserts those same samples encode to those same bytes. So the preset
  // cannot drift into a client deciding its own bytes.
  const preset = (id: string) => {
    const found = KEYBINDING_PRESETS.find((candidate) => candidate.id === id);
    assert.ok(found, `no ${id} preset`);
    return found;
  };

  assert.deepStrictEqual(preset("optionDeleteWord").input, hostInput("preset-delete-word"));
  assert.deepStrictEqual(preset("cmdKClear").input, hostInput("preset-clear-screen"));
  assert.deepStrictEqual(preset("shiftEnterNewline").input, hostInput("preset-newline"));

  // And the bytes the legacy path writes are the ones the Rust test pinned.
  assert.equal(preset("optionDeleteWord").sequence, "\x17");
  assert.equal(preset("cmdKClear").sequence, "\x0c");
  assert.equal(preset("shiftEnterNewline").sequence, "\n");
});

test("every sample of the host's fixture is claimed by a test in this file", () => {
  // The fixture is the gate, so an added sample must fail here until a browser
  // event is written for it rather than pass by being ignored.
  const claimed = new Set([
    "key-press-plain",
    "key-press-ctrl",
    "key-press-named",
    "key-repeat",
    "key-release",
    "key-composing",
    "key-locks",
    "text-commit",
    "paste",
    "mouse-press-left",
    "mouse-motion-drag",
    "mouse-motion-idle",
    "mouse-release-right",
    "mouse-wheel-up",
    "mouse-wheel-down",
    "mouse-wheel-left",
    "mouse-wheel-right",
    "preset-delete-word",
    "preset-clear-screen",
    "preset-newline",
    "focus-gained",
    "focus-lost",
  ]);
  assert.deepStrictEqual(
    samples.map((sample) => sample.name).filter((name) => !claimed.has(name)),
    [],
  );
});
