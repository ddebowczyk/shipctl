import type { KeybindingSettings } from "@shipctl/core/platform";
import type { TerminalInput, TerminalModifiers } from "./terminalSemanticInput.ts";

export interface KeybindingPreset {
  id: keyof KeybindingSettings;
  keys: string[];
  action: string;
  description: string;
  /** Bytes to write to the PTY when the combo fires */
  sequence: string;
  /**
   * The same thing, as the meaning a host encodes.
   *
   * The sequence above is what the host already makes of these keys \u2014 asserted
   * against the pinned encoder in
   * `runtime.rs::the_keybinding_presets_are_bytes_this_host_already_makes` \u2014 so
   * a client on the semantic path names what the person asked for and keeps no
   * bytes of its own. The two stay side by side while both transports ship.
   */
  input: TerminalInput;
  /** Return true if this keyboard event matches the key combo (regardless of keydown/keyup) */
  match: (ev: KeyboardEvent) => boolean;
}

/** Nothing held. A preset names the modifiers its own encoding needs. */
const NO_MODS: TerminalModifiers = {
  shift: false,
  alt: false,
  ctrl: false,
  meta: false,
  capsLock: false,
  numLock: false,
};

export const KEYBINDING_PRESETS: KeybindingPreset[] = [
  {
    id: "shiftEnterNewline",
    keys: ["Shift", "Enter"],
    action: "Newline",
    description: "Send a newline instead of submitting. Useful for multi-line input in Claude Code, Codex, etc.",
    sequence: "\n",
    // A newline, not a key: the point of the preset is that return submits,
    // so what it asks for is the character return would not produce.
    input: { kind: "text", text: "\n" },
    match: (ev) =>
      ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey,
  },
  {
    id: "optionDeleteWord",
    keys: ["\u2325", "Delete"],
    action: "Delete word",
    description: "Delete the previous word, matching macOS text editing conventions.",
    sequence: "\x17", // Ctrl+W
    input: {
      kind: "key",
      action: "press",
      code: "KeyW",
      text: "w",
      mods: { ...NO_MODS, ctrl: true },
      composing: false,
    },
    match: (ev) =>
      ev.key === "Backspace" && ev.altKey && !ev.ctrlKey && !ev.metaKey,
  },
  {
    id: "cmdKClear",
    keys: ["\u2318", "K"],
    action: "Clear terminal",
    description: "Clear the terminal screen, matching iTerm and Terminal.app behavior.",
    sequence: "\x0c", // form feed
    input: {
      kind: "key",
      action: "press",
      code: "KeyL",
      text: "l",
      mods: { ...NO_MODS, ctrl: true },
      composing: false,
    },
    match: (ev) =>
      ev.key === "k" && ev.metaKey && !ev.ctrlKey && !ev.altKey,
  },
];

/** The enabled preset a keyboard event fires, or null when the event is
 *  ordinary terminal input. Resolution is settings plus a match, so it is
 *  decided here; the view owns writing the sequence and telling xterm whether
 *  to handle the event itself.
 *
 *  A disabled preset never matches, so its combo stays available to the
 *  program running in the terminal. */
export function resolveKeybindingPreset(
  settings: KeybindingSettings,
  event: KeyboardEvent,
): KeybindingPreset | null {
  for (const preset of KEYBINDING_PRESETS) {
    if (settings[preset.id] && preset.match(event)) return preset;
  }
  return null;
}
