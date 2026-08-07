import type { PtyColorTheme } from "@shep/core/platform";
import type { ShepTheme } from "@shep/core/appearance";

export function toPtyColorTheme(theme: ShepTheme): PtyColorTheme {
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
