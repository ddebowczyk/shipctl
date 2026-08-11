/** Temporary browser state for one input-method composition. */
export interface TerminalImeState {
  readonly active: boolean;
  readonly preedit: string;
}

export interface TerminalImeLifecycle {
  readonly active: boolean;
  start(): void;
  update(preedit: string): void;
  finish(committed: string): void;
  ownsKey(platformIsComposing: boolean): boolean;
}

/**
 * Keep pre-edit presentation separate from committed terminal input.
 *
 * The browser owns the temporary text. The terminal receives only the final
 * composition-end value, once. An empty end value is cancellation.
 */
export function createTerminalImeLifecycle(ports: {
  present(state: TerminalImeState): void;
  commit(text: string): void;
}): TerminalImeLifecycle {
  let active = false;

  return {
    get active() {
      return active;
    },
    start() {
      active = true;
      ports.present({ active: true, preedit: "" });
    },
    update(preedit) {
      if (!active) return;
      ports.present({ active: true, preedit });
    },
    finish(committed) {
      if (!active) return;
      active = false;
      ports.present({ active: false, preedit: "" });
      if (committed) ports.commit(committed);
    },
    ownsKey(platformIsComposing) {
      return active || platformIsComposing;
    },
  };
}

export interface TerminalImeFrame {
  readonly width: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

export interface TerminalImePlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Place the browser editing host at the cursor already planned for painting. */
export function placeTerminalIme(frame: TerminalImeFrame): TerminalImePlacement | null {
  if (!frame.cursor) return null;
  return {
    left: frame.cursor.x,
    top: frame.cursor.y,
    width: Math.max(frame.cellWidth, frame.width - frame.cursor.x),
    height: frame.cellHeight,
  };
}
