import { useEffect, useRef } from "react";
import { startBrowserTerminalSession } from "./terminalBrowserSession.ts";
import type { TerminalViewSession } from "./terminalViewSession.ts";
import { disposeXtermTerminal } from "./terminalXtermSurface.ts";
import type { TerminalId } from "./types.ts";

interface TerminalViewProps {
  terminalId: TerminalId;
  visible: boolean;
}

/**
 * The DOM half of a terminal.
 *
 * This owns the container and the observers and listeners bound to it, and it
 * decides when the terminal is on screen — nothing else. Attachment, viewport,
 * fit and engine decisions live in "./terminalViewSession.ts" and the modules
 * it composes, where they can be proved without React or a DOM.
 *
 * The two lifetimes below are deliberately separate. The session, and with it
 * the host attachment, belongs to the terminal and ends when this view stops
 * representing it. `visible` only reveals the surface. Hiding a tab must not
 * detach: the attachment would have to be rebuilt from a full replay on the way
 * back, and everything the child printed meanwhile would never reach the buffer.
 */
export default function TerminalView({ terminalId, visible }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TerminalViewSession | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // The container's size and the user's scroll gestures are DOM facts; what
    // they mean is decided inside the session, which need not exist yet.
    const observer = new ResizeObserver(() => {
      void sessionRef.current?.requestFit();
    });
    observer.observe(container);

    // Gestures are read in the capture phase, before xterm consumes them.
    const onWheel = (event: WheelEvent) => sessionRef.current?.pin.noteWheel(event.deltaY);
    const onKeyDown = (event: KeyboardEvent) => sessionRef.current?.pin.noteKey(event);
    container.addEventListener("wheel", onWheel, { capture: true });
    container.addEventListener("keydown", onKeyDown, { capture: true });

    return () => {
      observer.disconnect();
      container.removeEventListener("wheel", onWheel, { capture: true });
      container.removeEventListener("keydown", onKeyDown, { capture: true });
      sessionRef.current?.dispose();
      sessionRef.current = null;
      disposeXtermTerminal(terminalId);
    };
  }, [terminalId]);

  // Being on screen is the only moment the surface may be opened or measured:
  // xterm reads its geometry and its scroll position from the DOM, and a
  // `display:none` container reports neither.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !visible) return;

    const session = sessionRef.current;
    if (session) {
      session.reveal();
      return;
    }
    sessionRef.current = startBrowserTerminalSession(terminalId, container);
  }, [terminalId, visible]);

  return (
    <div className="terminal-view" style={{ display: visible ? "block" : "none" }}>
      <div className="terminal-underlay" />
      <div ref={containerRef} className="terminal-surface" />
    </div>
  );
}
