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

/** External decisions used by the unsafe-paste review policy. */
export interface TerminalPasteReviewPorts {
  confirmationEnabled(): boolean;
  classify(text: string): Promise<boolean>;
  requestConfirmation(accept: () => void, cancel: () => void): void;
  reportFailure(error: unknown): void;
}

/**
 * Submit paste text now, or hold it for the host-backed confirmation flow.
 *
 * The disabled path does not call the host. This keeps the guard optional and
 * preserves the direct-paste behavior unless the user enables it in config.
 */
export function reviewTerminalPaste(
  ports: TerminalPasteReviewPorts,
  text: string,
  submit: () => void,
): void {
  if (!ports.confirmationEnabled()) {
    submit();
    return;
  }

  void ports.classify(text).then(
    (safe) => {
      if (safe) submit();
      else ports.requestConfirmation(submit, () => undefined);
    },
    (error: unknown) => ports.reportFailure(error),
  );
}

export interface TerminalEffectOutcomePorts {
  bell(): void;
  clipboardRefused(): void;
}

/** One semantic-terminal side effect emitted beside a screen frame. */
export interface SemanticTerminalEffect {
  readonly kind: string;
  readonly [field: string]: unknown;
}

/**
 * Report the browser-visible outcome of a terminal side effect.
 *
 * OSC 52 is deliberately not applied. A terminal process must not change the
 * system clipboard without a browser gesture. The visible refusal also keeps
 * the request from disappearing without an outcome.
 */
export function reportTerminalEffectOutcome(
  effect: SemanticTerminalEffect,
  ports: TerminalEffectOutcomePorts,
): void {
  if (effect.kind === "bell") ports.bell();
  if (effect.kind === "clipboard") ports.clipboardRefused();
}
