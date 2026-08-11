import { useEffect, useRef } from "react";
import { createBrowserContainerPorts } from "./terminalBrowserSession.ts";
import {
  bindTerminalContainer,
  type TerminalContainerBinding,
} from "./terminalContainerBinding.ts";
import type { TerminalId } from "./types.ts";

interface TerminalViewProps {
  terminalId: TerminalId;
  visible: boolean;
}

/**
 * The React half of a terminal: a container, and when it is on screen.
 *
 * Nothing else is decided here. The observers, the gesture listeners and the
 * session lifetime belong to "./terminalContainerBinding.ts", and the
 * attachment, viewport and fit decisions to "./terminalViewSession.ts", where
 * they can be proved without React or a DOM. What is left below is the wiring
 * that only a component can do: hold a ref, mount, unmount, and re-render.
 */
export default function TerminalView({ terminalId, visible }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bindingRef = useRef<TerminalContainerBinding | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const binding = bindTerminalContainer(container, createBrowserContainerPorts(terminalId));
    bindingRef.current = binding;

    return () => {
      binding.dispose();
      bindingRef.current = null;
    };
  }, [terminalId]);

  useEffect(() => {
    if (visible) bindingRef.current?.reveal();
    else bindingRef.current?.conceal();
  }, [terminalId, visible]);

  return (
    <div className="terminal-view" style={{ display: visible ? "block" : "none" }}>
      <div className="terminal-underlay" />
      <div ref={containerRef} className="terminal-surface" />
    </div>
  );
}
