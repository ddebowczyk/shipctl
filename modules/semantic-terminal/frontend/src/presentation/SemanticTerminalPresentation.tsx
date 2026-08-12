import { useEffect, useRef } from "react";
import type { TerminalPresentationProps } from "@shipctl/module-api";

import "./semanticTerminalPresentation.css";

import { terminalSession } from "./terminalCache.ts";
import {
  createSemanticTerminalContainerPorts,
  type SemanticTerminalBrowserPorts,
} from "./semanticTerminalBrowserSession.ts";
import {
  bindTerminalContainer,
  type TerminalContainerBinding,
} from "./terminalContainerBinding.ts";

/** The selected semantic terminal's module-owned browser presentation. */
export function SemanticTerminalPresentation({
  terminalId,
  descriptor,
  visible,
  services,
}: TerminalPresentationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bindingRef = useRef<TerminalContainerBinding | null>(null);
  const lifecycleRef = useRef(descriptor.lifecycle);
  lifecycleRef.current = descriptor.lifecycle;

  useEffect(() => {
    const container = containerRef.current;
    const presentation = services.terminalPresentation;
    if (!container || !presentation) {
      if (!presentation) {
        services.notices.push({
          tone: "error",
          title: "Terminal presentation unavailable",
          message: "The terminal host did not provide browser presentation services.",
        });
      }
      return;
    }
    const ports: SemanticTerminalBrowserPorts = {
      isRunning: () => lifecycleRef.current === "running",
      notices: services.notices,
      externalLinks: services.externalLinks,
      presentation,
    };
    // Keep the harness behind a literal Vite development branch. It must be
    // installed only when a real semantic presentation exists, and Rollup
    // must remove its dynamic import from a release bundle.
    if (import.meta.env.DEV) {
      void import("../scenarios/semanticTerminalScenarioEntry.ts").then((module) => {
        module.installSemanticTerminalScenarioHarness();
      });
    }
    const binding = bindTerminalContainer(
      container,
      createSemanticTerminalContainerPorts(terminalId, ports),
    );
    bindingRef.current = binding;
    const unsubscribePreferences = presentation.subscribe(() => {
      const session = terminalSession(terminalId);
      session?.applyTheme();
      session?.applySettings();
    });

    return () => {
      unsubscribePreferences();
      binding.dispose();
      bindingRef.current = null;
    };
  }, [services, terminalId]);

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
