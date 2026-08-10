import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_LINE_HEIGHT } from "@shipctl/core/appearance";
import { useTerminalSettingsStore } from "./useTerminalSettingsStore.ts";
import { TRANSITIONAL_RENDERER_SCROLLBACK_ROWS } from "./terminalRetention.ts";

/**
 * Compute terminal cols/rows from a container's pixel dimensions.
 * Uses xterm's own fit logic against an offscreen container sized to match
 * the real terminal viewport.
 */
export function computeTerminalSize(
  containerWidth: number,
  containerHeight: number,
): { cols: number; rows: number } {
  if (containerWidth <= 0 || containerHeight <= 0) {
    return { cols: 80, rows: 24 };
  }

  const { fontFamily, fontSize } = useTerminalSettingsStore.getState().settings;

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-9999px";
  container.style.top = "-9999px";
  container.style.width = `${containerWidth}px`;
  container.style.height = `${containerHeight}px`;
  container.style.visibility = "hidden";
  document.body.appendChild(container);

  const term = new Terminal({
    fontSize,
    fontFamily,
    lineHeight: TERMINAL_LINE_HEIGHT,
    scrollback: TRANSITIONAL_RENDERER_SCROLLBACK_ROWS,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const dims = fitAddon.proposeDimensions();

  term.dispose();
  document.body.removeChild(container);

  if (!dims) {
    return { cols: 80, rows: 24 };
  }

  return {
    cols: Math.max(2, dims.cols),
    rows: Math.max(2, dims.rows),
  };
}
