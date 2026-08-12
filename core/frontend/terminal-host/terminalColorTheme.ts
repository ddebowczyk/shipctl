import type { TerminalColorTheme } from "./types.ts";
import type { ShipctlTheme } from "@shipctl/core/appearance";

export function toTerminalColorTheme(theme: ShipctlTheme): TerminalColorTheme {
  return {
    foreground: theme.termForeground,
    background: theme.appBg,
    palette: [
      theme.termBlack,
      theme.termRed,
      theme.termGreen,
      theme.termYellow,
      theme.termBlue,
      theme.termMagenta,
      theme.termCyan,
      theme.termWhite,
      theme.termBrightBlack,
      theme.termBrightRed,
      theme.termBrightGreen,
      theme.termBrightYellow,
      theme.termBrightBlue,
      theme.termBrightMagenta,
      theme.termBrightCyan,
      theme.termBrightWhite,
    ],
  };
}
