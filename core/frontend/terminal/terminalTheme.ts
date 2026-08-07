import type { ITheme } from "@xterm/xterm";
import { hexLuminance } from "@shep/core/appearance";
import type { ShepTheme } from "@shep/core/appearance";
import type { TerminalSettings } from "@shep/core/platform";
import { resizePty } from "@shep/core/platform";
import { terminalCache } from "./terminalCache.ts";
import { buildCSSFontFamily } from "@shep/core/appearance";
import { preserveTerminalViewport } from "./terminalViewport.ts";
import { reconcileTerminalRenderer } from "./terminalRenderer.ts";

// Utility to make hex colors partially transparent
function withAlpha(hex: string, alpha: number): string {
  if (hex.startsWith("#") && (hex.length === 7 || hex.length === 9)) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hex;
}

function isLightTheme(theme: ShepTheme): boolean {
  return hexLuminance(theme.appBg) > 0.3;
}

export function createTerminalTheme(theme: ShepTheme): ITheme {
  const light = isLightTheme(theme);
  return {
    background: "transparent",
    foreground: theme.termForeground,
    cursor: theme.termCursor,
    selectionBackground: theme.termSelection,
    black: light ? theme.termBlack : withAlpha(theme.termBlack, 0.4),
    red: theme.termRed,
    green: theme.termGreen,
    yellow: theme.termYellow,
    blue: theme.termBlue,
    magenta: theme.termMagenta,
    cyan: theme.termCyan,
    white: theme.termWhite,
    brightBlack: light ? theme.termBrightBlack : withAlpha(theme.termBrightBlack, 0.4),
    brightRed: theme.termBrightRed,
    brightGreen: theme.termBrightGreen,
    brightYellow: theme.termBrightYellow,
    brightBlue: theme.termBrightBlue,
    brightMagenta: theme.termBrightMagenta,
    brightCyan: theme.termBrightCyan,
    brightWhite: theme.termBrightWhite,
  };
}

export function applyThemeToTerminals(theme: ShepTheme): void {
  const xtermTheme = createTerminalTheme(theme);
  for (const [, entry] of terminalCache) {
    // Skip hidden terminals entirely — setting options.theme on a
    // terminal with display:none corrupts xterm's internal scroll state.
    // Hidden terminals get the theme applied when they become visible
    // (TerminalView's useEffect re-applies the current store theme).
    const el = entry.term.element;
    if (!el || el.offsetParent === null) continue;

    preserveTerminalViewport(entry.term, () => {
      // Drop a renderer the incoming theme cannot use before that theme is
      // installed, and load the accelerated one only once an opaque theme is
      // already in place. Both transitions land in the same task, so no frame
      // is painted by a renderer that cannot honour the background.
      if (theme.isTransparent) {
        reconcileTerminalRenderer(entry.term, entry, theme);
      }
      entry.term.options.theme = xtermTheme;
      if (!theme.isTransparent) {
        reconcileTerminalRenderer(entry.term, entry, theme);
      }
      entry.term.refresh(0, entry.term.rows - 1);
    });
  }
}

export function applyTerminalSettings(settings: TerminalSettings): void {
  const cssFont = buildCSSFontFamily(settings.fontFamily);

  for (const [ptyId, entry] of terminalCache) {
    const fontMetricsChanged =
      entry.term.options.fontFamily !== cssFont ||
      entry.term.options.fontSize !== settings.fontSize;

    entry.term.options.cursorStyle = settings.cursorStyle;
    entry.term.options.cursorBlink = settings.cursorBlink;
    entry.term.options.scrollback = settings.scrollback;
    entry.term.options.fontFamily = cssFont;
    entry.term.options.fontSize = settings.fontSize;

    const el = entry.term.element;
    if (!fontMetricsChanged || !el || el.offsetParent === null) continue;

    // Clear the renderer's glyph texture atlas so the new font is measured
    // and cached from scratch. Without this, xterm keeps rendering glyphs
    // with the *old* font's metrics, causing clipping and misalignment.
    entry.rendererAddon?.clearTextureAtlas?.();
    preserveTerminalViewport(entry.term, () => {
      entry.fitAddon.fit();
    });
    entry.term.refresh(0, entry.term.rows - 1);
    resizePty(ptyId, entry.term.cols, entry.term.rows).catch((error) => {
      if (import.meta.env.DEV) {
        console.error("Failed to resize PTY after terminal settings change:", error);
      }
    });
  }
}
