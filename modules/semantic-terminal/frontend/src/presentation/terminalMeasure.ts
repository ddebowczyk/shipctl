/**
 * How a container's pixels become a terminal's columns and rows.
 *
 * The measurement itself needs a font and a layout engine, and lives in the
 * selected presentation module. What is decided about the answer —
 * when not to ask, what to do when the measurement is unavailable, and the
 * floor every answer is held to — is here, where it can be proved without a
 * browser.
 *
 * The split is not cosmetic. This module is exported from the capability's
 * logic entry point, so it must remain independent from browser bindings.
 */

/**
 * Ask the presentation layer how many cells fit in a box, or `null` when it
 * cannot say — an unmeasurable container, or a renderer with no metrics yet.
 */
export type TerminalSizeProbe = (
  containerWidth: number,
  containerHeight: number,
) => { cols: number; rows: number } | null;

/**
 * The size used when the container cannot be measured. A terminal is shown at
 * a conventional size rather than at nothing.
 */
export const TERMINAL_FALLBACK_SIZE: Readonly<{ cols: number; rows: number }> = {
  cols: 80,
  rows: 24,
};

/** No terminal is narrower or shorter than this, whatever the box reports. */
export const MIN_TERMINAL_DIMENSION = 2;

/**
 * Resolve a terminal size for a container of the given pixel dimensions.
 *
 * A container with no area is not measured at all: it is hidden or not yet
 * laid out, and probing it would build and tear down a renderer to learn
 * nothing.
 */
export function resolveTerminalSize(
  containerWidth: number,
  containerHeight: number,
  probe: TerminalSizeProbe,
): { cols: number; rows: number } {
  if (containerWidth <= 0 || containerHeight <= 0) {
    return { ...TERMINAL_FALLBACK_SIZE };
  }

  const measured = probe(containerWidth, containerHeight);
  if (!measured) {
    return { ...TERMINAL_FALLBACK_SIZE };
  }

  return {
    cols: Math.max(MIN_TERMINAL_DIMENSION, measured.cols),
    rows: Math.max(MIN_TERMINAL_DIMENSION, measured.rows),
  };
}
