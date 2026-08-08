import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShipctlTheme } from "@shipctl/core/appearance";
import { blendOpaque, createTerminalTheme } from "../terminalTheme.ts";

// Only the fields createTerminalTheme reads; the rest of ShipctlTheme drives
// surfaces this module never touches.
function theme(overrides: Partial<ShipctlTheme> = {}): ShipctlTheme {
  return {
    isTransparent: false,
    appBg: "#1a1b26",
    termForeground: "#c0caf5",
    termCursor: "#c0caf5",
    termSelection: "#33467c",
    termBlack: "#414868",
    termRed: "#f7768e",
    termGreen: "#9ece6a",
    termYellow: "#e0af68",
    termBlue: "#7aa2f7",
    termMagenta: "#bb9af7",
    termCyan: "#7dcfff",
    termWhite: "#a9b1d6",
    termBrightBlack: "#414868",
    termBrightRed: "#f7768e",
    termBrightGreen: "#9ece6a",
    termBrightYellow: "#e0af68",
    termBrightBlue: "#7aa2f7",
    termBrightMagenta: "#bb9af7",
    termBrightCyan: "#7dcfff",
    termBrightWhite: "#c0caf5",
    ...overrides,
  } as ShipctlTheme;
}

test("glass themes keep a transparent background", () => {
  assert.equal(createTerminalTheme(theme({ isTransparent: true })).background, "transparent");
});

test("opaque themes hand the renderer a real RGB background", () => {
  // WebGL turns "transparent"'s zero RGB value into an opaque black viewport,
  // so opaque themes must supply their own background colour.
  const built = createTerminalTheme(theme({ appBg: "#1a1b26" }));
  assert.equal(built.background, "#1a1b26");
});

test("dark palettes pre-blend the dimmed ANSI entries instead of carrying alpha", () => {
  const built = createTerminalTheme(theme());

  assert.equal(built.black, blendOpaque("#1a1b26", "#414868", 0.4));
  assert.equal(built.brightBlack, blendOpaque("#1a1b26", "#414868", 0.4));
  for (const color of [built.black, built.brightBlack]) {
    assert.match(String(color), /^#[\da-f]{6}$/i, "WebGL needs opaque ANSI colours");
  }
});

test("light palettes keep their ANSI entries untouched", () => {
  const light = theme({ appBg: "#fdf6e3", termBlack: "#073642", termBrightBlack: "#586e75" });
  const built = createTerminalTheme(light);

  assert.equal(built.black, "#073642");
  assert.equal(built.brightBlack, "#586e75");
});

test("scrollbar colours come from the theme now that xterm draws the scrollbar", () => {
  const built = createTerminalTheme(theme({ termForeground: "#c0caf5" }));

  assert.equal(built.scrollbarSliderBackground, "rgba(192, 202, 245, 0.24)");
  assert.equal(built.scrollbarSliderHoverBackground, "rgba(192, 202, 245, 0.4)");
  assert.equal(built.scrollbarSliderActiveBackground, "rgba(192, 202, 245, 0.5)");
});

/* ── blendOpaque ───────────────────────────────────────── */

test("blendOpaque mixes the foreground toward the background", () => {
  assert.equal(blendOpaque("#000000", "#ffffff", 0.4), "#666666");
  assert.equal(blendOpaque("#000000", "#ffffff", 0), "#000000");
  assert.equal(blendOpaque("#000000", "#ffffff", 1), "#ffffff");
});

test("blendOpaque passes non-hex colours through unchanged", () => {
  assert.equal(blendOpaque("rgba(0, 0, 0, 0.5)", "#ffffff", 0.4), "#ffffff");
  assert.equal(blendOpaque("#000000", "transparent", 0.4), "transparent");
});
