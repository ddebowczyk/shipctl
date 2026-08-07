import { hexLuminance } from "./themes.ts";
import type { ShepTheme } from "./themes.ts";

interface ParsedTerminalTheme {
  background: string;
  foreground: string;
  selectionBackground?: string;
  cursorColor?: string;
  palette: string[];
}

const REQUIRED_KEYS = new Set(["background", "foreground"]);

function normalizeHex(value: string): string | null {
  const match = value.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!match) return null;
  const hex = match[1];
  if (hex.length === 3) {
    return `#${hex.split("").map((char) => char + char).join("").toLowerCase()}`;
  }
  return `#${hex.toLowerCase()}`;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function mixHex(base: string, overlay: string, amount: number): string {
  const [br, bg, bb] = hexToRgb(base);
  const [or, og, ob] = hexToRgb(overlay);
  const mix = (from: number, to: number) => Math.round(from + (to - from) * amount);
  return `#${[mix(br, or), mix(bg, og), mix(bb, ob)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function alpha(hex: string, opacity: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)})`;
}

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
  const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
  if (!match) return null;
  return [match[1].trim().toLowerCase(), match[2].trim()];
}

export function parseTerminalThemeDefinition(source: string): ParsedTerminalTheme {
  const values = new Map<string, string>();
  const palette = Array<string>(16);

  for (const rawLine of source.split(/\r?\n/)) {
    const entry = parseLine(rawLine);
    if (!entry) continue;
    const [key, value] = entry;

    if (key === "palette") {
      const paletteMatch = value.match(/^(\d{1,2})\s*=\s*(#[0-9a-fA-F]{3,6})$/);
      if (!paletteMatch) {
        throw new Error(`Invalid palette entry: ${rawLine.trim()}`);
      }
      const index = Number.parseInt(paletteMatch[1], 10);
      if (index < 0 || index > 15) {
        throw new Error(`Palette index out of range: ${index}`);
      }
      const color = normalizeHex(paletteMatch[2]);
      if (!color) {
        throw new Error(`Invalid palette color: ${paletteMatch[2]}`);
      }
      palette[index] = color;
      continue;
    }

    values.set(key, value);
  }

  for (const key of REQUIRED_KEYS) {
    const value = values.get(key);
    if (!value) {
      throw new Error(`Missing required theme field: ${key}`);
    }
  }

  const background = normalizeHex(values.get("background") ?? "");
  const foreground = normalizeHex(values.get("foreground") ?? "");
  const selectionBackground = normalizeHex(values.get("selection-background") ?? "");
  const cursorColor = normalizeHex(values.get("cursor-color") ?? "");

  if (!background) throw new Error("Invalid background color");
  if (!foreground) throw new Error("Invalid foreground color");
  if (values.has("selection-background") && !selectionBackground) {
    throw new Error("Invalid selection-background color");
  }
  if (values.has("cursor-color") && !cursorColor) {
    throw new Error("Invalid cursor-color color");
  }

  if (palette.some((value) => !value)) {
    throw new Error("Theme must define palette entries 0 through 15");
  }

  return {
    background,
    foreground,
    selectionBackground: selectionBackground || undefined,
    cursorColor: cursorColor || undefined,
    palette: palette as string[],
  };
}

export function buildCustomTheme(source: string): ShepTheme {
  const parsed = parseTerminalThemeDefinition(source);
  const isLight = hexLuminance(parsed.background) > 0.3;
  const accentBlue = parsed.palette[4];
  const accentPurple = parsed.palette[5];
  const accentCyan = parsed.palette[6];
  const panelBase = isLight ? mixHex(parsed.background, "#ffffff", 0.25) : mixHex(parsed.background, "#000000", 0.12);
  const gradientEdge = isLight ? mixHex(parsed.background, "#d8dce5", 0.16) : mixHex(parsed.background, "#0f1016", 0.30);

  return {
    id: "custom-theme",
    name: "Custom",
    isTransparent: false,

    bgRadial1: alpha(accentBlue, isLight ? 0.08 : 0.10),
    bgRadial2: alpha(accentPurple, isLight ? 0.05 : 0.06),
    bgRadial3: alpha(accentCyan, isLight ? 0.05 : 0.06),
    bgLinearFrom: gradientEdge,
    bgLinearMid: parsed.background,
    bgLinearTo: gradientEdge,

    frameTint: parsed.background,
    panelTint: alpha(panelBase, 0.60),
    glassBorder: alpha(parsed.foreground, isLight ? 0.25 : 0.12),
    glassPanelStrong: alpha(panelBase, 0.78),
    glassBorderStrong: alpha(parsed.foreground, isLight ? 0.35 : 0.18),

    statusRunning: parsed.palette[12],
    statusStopped: parsed.palette[8],
    statusCrashed: parsed.palette[9],
    statusAttention: parsed.palette[11],

    appBg: parsed.background,
    appFg: parsed.foreground,

    termForeground: parsed.foreground,
    termCursor: parsed.cursorColor ?? parsed.foreground,
    termSelection: parsed.selectionBackground ?? alpha(accentBlue, isLight ? 0.22 : 0.30),
    termBlack: parsed.palette[0],
    termRed: parsed.palette[1],
    termGreen: parsed.palette[2],
    termYellow: parsed.palette[3],
    termBlue: parsed.palette[4],
    termMagenta: parsed.palette[5],
    termCyan: parsed.palette[6],
    termWhite: parsed.palette[7],
    termBrightBlack: parsed.palette[8],
    termBrightRed: parsed.palette[9],
    termBrightGreen: parsed.palette[10],
    termBrightYellow: parsed.palette[11],
    termBrightBlue: parsed.palette[12],
    termBrightMagenta: parsed.palette[13],
    termBrightCyan: parsed.palette[14],
    termBrightWhite: parsed.palette[15],
  };
}
