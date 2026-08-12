export interface TerminalFocusTarget {
  focus(): void;
}

type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

/** Focus a visible terminal after the browser has applied its layout. */
export function scheduleVisibleTerminalFocus(
  visible: boolean,
  terminal: TerminalFocusTarget | null,
  requestFrame: RequestFrame = window.requestAnimationFrame.bind(window),
  cancelFrame: CancelFrame = window.cancelAnimationFrame.bind(window),
): (() => void) | undefined {
  if (!visible || !terminal) return undefined;

  const frame = requestFrame(() => terminal.focus());
  return () => cancelFrame(frame);
}
