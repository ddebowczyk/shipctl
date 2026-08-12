import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { terminalDriverId, type TerminalPresentationProps } from "@shipctl/module-api";

import { scheduleVisibleTerminalFocus } from "./focusVisibleTerminal.ts";
import { writeRawTerminalOccurrences } from "./rawOccurrences.ts";

const THIN_TERMINAL_DRIVER_ID = terminalDriverId("thin-terminal");

/**
 * Browser-owned terminal interpretation. The host gives this presentation
 * exact bytes; it never turns them into a host replay or semantic frame.
 */
export function ThinTerminalPresentation({
  terminalId,
  host,
  visible,
}: TerminalPresentationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    void import("./xterm.css");
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);

    let disposed = false;
    let attachment: Awaited<ReturnType<typeof host.attachRaw>> | null = null;
    const writeInput = terminal.onData((data) => {
      void host.write(terminalId, new TextEncoder().encode(data));
    });
    const resize = () => {
      fit.fit();
      void host.resize(terminalId, terminal.cols, terminal.rows);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    void host.attachRaw(terminalId, THIN_TERMINAL_DRIVER_ID).then(async (raw) => {
      attachment = raw;
      await writeRawTerminalOccurrences(
        raw.occurrences,
        (bytes) => terminal.write(bytes),
        () => disposed,
      );
    }).catch((error: unknown) => {
      if (!disposed) terminal.writeln(`\\r\\nTerminal stream failed: ${String(error)}`);
    });

    return () => {
      disposed = true;
      terminalRef.current = null;
      observer.disconnect();
      writeInput.dispose();
      void attachment?.detach();
      terminal.dispose();
    };
  }, [host, terminalId]);

  useEffect(
    () => scheduleVisibleTerminalFocus(visible, terminalRef.current),
    [visible],
  );

  return (
    <div className="terminal-view" style={{ display: visible ? "block" : "none" }}>
      <div ref={containerRef} className="terminal-surface" />
    </div>
  );
}
