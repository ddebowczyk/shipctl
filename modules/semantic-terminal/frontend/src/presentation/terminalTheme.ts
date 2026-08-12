import type { TerminalSurfacePalette } from "./terminalCellSurface.ts";

/** The application colour facts the semantic canvas needs. */
export interface TerminalSurfaceTheme {
  readonly termForeground: string;
  readonly appBg: string;
  readonly termCursor: string;
  readonly termSelection: string;
}

/** Creates the palette used by semantic terminal canvas surfaces. */
export function createTerminalSurfacePalette(
  theme: TerminalSurfaceTheme,
): TerminalSurfacePalette {
  return {
    foreground: theme.termForeground,
    background: theme.appBg,
    cursor: theme.termCursor,
    selection: theme.termSelection,
  };
}
