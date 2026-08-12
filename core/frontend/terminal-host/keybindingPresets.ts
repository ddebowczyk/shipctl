/** Host-owned labels for the terminal keybinding settings UI. */
export const KEYBINDING_PRESETS = [
  {
    id: "shiftEnterNewline",
    keys: ["Shift", "Enter"],
    action: "Newline",
    description: "Send a newline instead of submitting.",
  },
  {
    id: "optionDeleteWord",
    keys: ["⌥", "Delete"],
    action: "Delete word",
    description: "Delete the previous word.",
  },
  {
    id: "cmdKClear",
    keys: ["⌘", "K"],
    action: "Clear terminal",
    description: "Clear the terminal screen.",
  },
] as const;
