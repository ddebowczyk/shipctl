import type { Terminal } from "@xterm/xterm";

/** Distance of the viewport from the bottom of the scrollback, in lines.
 *  0 means pinned to the bottom (following output). */
export function terminalBottomOffset(term: Terminal): number {
  const buffer = term.buffer.active;
  return Math.max(0, buffer.baseY - buffer.viewportY);
}

export function preserveTerminalViewport(term: Terminal, update: () => void) {
  const bottomOffset = terminalBottomOffset(term);

  update();

  if (bottomOffset === 0) {
    term.scrollToBottom();
    return;
  }

  const after = term.buffer.active;
  term.scrollToLine(Math.max(0, after.baseY - bottomOffset));
}

export type ViewportDrainAction =
  /** Leave the viewport where it is. */
  | { kind: "none" }
  /** Follow output. */
  | { kind: "bottom" }
  /** Restore a remembered distance from the end of the rebuilt buffer. */
  | { kind: "line"; line: number };

/** What a completed output drain should do to the viewport.
 *
 *  A replay rebuilds the buffer behind a `term.reset()`, which zeroes the
 *  scroll position, so `preserveTerminalViewport` cannot wrap it: the rows do
 *  not exist again until the replayed bytes have been parsed. The distance the
 *  user was reading at is captured before the reset and re-applied here. The
 *  output queue reports a drain only once it has emptied, so this is the first
 *  moment the rebuilt buffer is whole.
 *
 *  Following output wins over a remembered position, because a user at the end
 *  of the buffer asked to stay at the end. */
export function resolveViewportDrainAction(state: {
  pinnedToBottom: boolean;
  /** Lines from the end a pending replay must restore, or null when none is
   *  pending. */
  pendingBottomOffset: number | null;
  /** The rebuilt buffer's last line. */
  baseY: number;
}): ViewportDrainAction {
  if (state.pinnedToBottom) return { kind: "bottom" };
  if (state.pendingBottomOffset === null) return { kind: "none" };
  return {
    kind: "line",
    line: Math.max(0, state.baseY - state.pendingBottomOffset),
  };
}

/** Re-assert a scroll position onto the DOM viewport after the terminal's
 *  container was `display:none`. Browsers zero a hidden element's scrollTop
 *  and never restore it, while xterm's internal position survives — and
 *  xterm ignores scroll requests that already match its internal position,
 *  so a plain scrollToLine would no-op and leave the DOM stuck at the top.
 *  Jumping elsewhere first forces a real scroll; both calls land within one
 *  render frame, so the intermediate position is never painted. */
export function resyncTerminalViewport(term: Terminal, bottomOffset: number): void {
  const buffer = term.buffer.active;
  if (buffer.baseY === 0) return;

  const target = Math.max(0, buffer.baseY - bottomOffset);
  term.scrollToLine(target === 0 ? buffer.baseY : 0);
  if (bottomOffset === 0) {
    term.scrollToBottom();
  } else {
    term.scrollToLine(target);
  }
}
