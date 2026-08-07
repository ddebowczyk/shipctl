import type { KeybindingSettings } from "@shep/core/platform";

export interface KeybindingPreset {
  id: keyof KeybindingSettings;
  keys: string[];
  action: string;
  description: string;
  /** Bytes to write to the PTY when the combo fires */
  sequence: string;
  /** Return true if this keyboard event matches the key combo (regardless of keydown/keyup) */
  match: (ev: KeyboardEvent) => boolean;
}

export const KEYBINDING_PRESETS: KeybindingPreset[] = [
  {
    id: "shiftEnterNewline",
    keys: ["Shift", "Enter"],
    action: "Newline",
    description: "Send a newline instead of submitting. Useful for multi-line input in Claude Code, Codex, etc.",
    sequence: "\n",
    match: (ev) =>
      ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey,
  },
  {
    id: "optionDeleteWord",
    keys: ["\u2325", "Delete"],
    action: "Delete word",
    description: "Delete the previous word, matching macOS text editing conventions.",
    sequence: "\x17", // Ctrl+W
    match: (ev) =>
      ev.key === "Backspace" && ev.altKey && !ev.ctrlKey && !ev.metaKey,
  },
  {
    id: "cmdKClear",
    keys: ["\u2318", "K"],
    action: "Clear terminal",
    description: "Clear the terminal screen, matching iTerm and Terminal.app behavior.",
    sequence: "\x0c", // form feed
    match: (ev) =>
      ev.key === "k" && ev.metaKey && !ev.ctrlKey && !ev.altKey,
  },
];
