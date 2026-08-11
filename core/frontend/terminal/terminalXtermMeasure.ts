/**
 * The xterm half of terminal measurement.
 *
 * This value-imports xterm and therefore stays out of the capability's logic
 * entry point, alongside "./terminalXtermSurface.ts" and
 * "./terminalRendererAddons.ts". The policy applied to what it measures is in
 * "./terminalMeasure.ts".
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { TERMINAL_LINE_HEIGHT } from "@shipctl/core/appearance";
import { resolveTerminalSize, type TerminalSizeProbe } from "./terminalMeasure.ts";
import { TRANSITIONAL_RENDERER_SCROLLBACK_ROWS } from "./terminalRetention.ts";
import { useTerminalSettingsStore } from "./useTerminalSettingsStore.ts";

/**
 * Measure with xterm's own fit logic, against an offscreen container sized to
 * match the real terminal viewport.
 *
 * The container is positioned off screen rather than hidden with `display`,
 * because a `display:none` box has no layout and xterm would measure nothing.
 */
const probeWithOffscreenXterm: TerminalSizeProbe = (containerWidth, containerHeight) => {
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

  try {
    return fitAddon.proposeDimensions() ?? null;
  } finally {
    // The probe builds a renderer on every call; leaving either behind would
    // accumulate a detached terminal per resize.
    term.dispose();
    document.body.removeChild(container);
  }
};

/** Compute terminal cols/rows from a container's pixel dimensions. */
export function computeTerminalSize(
  containerWidth: number,
  containerHeight: number,
): { cols: number; rows: number } {
  return resolveTerminalSize(containerWidth, containerHeight, probeWithOffscreenXterm);
}
