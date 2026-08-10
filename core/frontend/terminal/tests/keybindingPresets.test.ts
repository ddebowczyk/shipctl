import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeybindingSettings } from "@shipctl/core/platform";

import {
  KEYBINDING_PRESETS,
  resolveKeybindingPreset,
} from "../keybindingPresets.ts";

const ALL_ENABLED = Object.fromEntries(
  KEYBINDING_PRESETS.map((preset) => [preset.id, true]),
) as KeybindingSettings;

const ALL_DISABLED = Object.fromEntries(
  KEYBINDING_PRESETS.map((preset) => [preset.id, false]),
) as KeybindingSettings;

/** The subset of a keyboard event the preset matchers read. */
function keyEvent(init: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}) {
  return {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  } as KeyboardEvent;
}

test("shift+enter resolves to the newline preset", () => {
  const preset = resolveKeybindingPreset(
    ALL_ENABLED,
    keyEvent({ key: "Enter", shiftKey: true }),
  );
  assert.equal(preset?.id, "shiftEnterNewline");
  assert.equal(preset?.sequence, "\n");
});

test("option+backspace resolves to a delete-word control byte", () => {
  const preset = resolveKeybindingPreset(
    ALL_ENABLED,
    keyEvent({ key: "Backspace", altKey: true }),
  );
  assert.equal(preset?.id, "optionDeleteWord");
  assert.equal(preset?.sequence, "\x17");
});

test("cmd+k resolves to a form feed", () => {
  const preset = resolveKeybindingPreset(
    ALL_ENABLED,
    keyEvent({ key: "k", metaKey: true }),
  );
  assert.equal(preset?.id, "cmdKClear");
  assert.equal(preset?.sequence, "\x0c");
});

test("a plain keystroke is ordinary terminal input", () => {
  assert.equal(resolveKeybindingPreset(ALL_ENABLED, keyEvent({ key: "Enter" })), null);
  assert.equal(resolveKeybindingPreset(ALL_ENABLED, keyEvent({ key: "k" })), null);
  assert.equal(
    resolveKeybindingPreset(ALL_ENABLED, keyEvent({ key: "Backspace" })),
    null,
  );
});

test("a disabled preset leaves its combo to the running program", () => {
  // This is the whole point of the setting: with the preset off, cmd+k must
  // reach the child rather than clear the screen.
  assert.equal(
    resolveKeybindingPreset(ALL_DISABLED, keyEvent({ key: "k", metaKey: true })),
    null,
  );
  assert.equal(
    resolveKeybindingPreset(ALL_DISABLED, keyEvent({ key: "Enter", shiftKey: true })),
    null,
  );
});

test("presets are settable independently", () => {
  const onlyNewline = { ...ALL_DISABLED, shiftEnterNewline: true };
  assert.equal(
    resolveKeybindingPreset(onlyNewline, keyEvent({ key: "Enter", shiftKey: true }))?.id,
    "shiftEnterNewline",
  );
  assert.equal(
    resolveKeybindingPreset(onlyNewline, keyEvent({ key: "k", metaKey: true })),
    null,
  );
});

test("an extra modifier stops a preset from firing", () => {
  // A combo the user meant for the program must not be swallowed.
  assert.equal(
    resolveKeybindingPreset(
      ALL_ENABLED,
      keyEvent({ key: "Enter", shiftKey: true, ctrlKey: true }),
    ),
    null,
  );
  assert.equal(
    resolveKeybindingPreset(
      ALL_ENABLED,
      keyEvent({ key: "k", metaKey: true, altKey: true }),
    ),
    null,
  );
});

test("every preset carries a sequence to write", () => {
  // A preset with no sequence would swallow its combo and send nothing.
  for (const preset of KEYBINDING_PRESETS) {
    assert.ok(preset.sequence.length > 0, preset.id);
  }
});
