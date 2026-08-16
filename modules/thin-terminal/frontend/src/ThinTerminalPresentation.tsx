import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import {
  terminalDriverId,
  terminalSessionsService,
  type SemanticRequestOutcome,
  type SemanticStreamAttachment,
  type TerminalPresentationProps,
} from "@shipctl/module-api";

import { scheduleVisibleTerminalFocus } from "./focusVisibleTerminal.ts";

const THIN_TERMINAL_DRIVER_ID = terminalDriverId("thin-terminal");

/**
 * Browser-owned terminal interpretation. The host gives this presentation
 * exact bytes; it never turns them into a host replay or semantic frame.
 */
export function ThinTerminalPresentation({
  activation,
  terminalId,
  services,
  visible,
}: TerminalPresentationProps) {
  const terminalSessions = activation.services.require(terminalSessionsService);
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
    let attachment: SemanticStreamAttachment | null = null;
    const pendingInput: Array<{
      readonly source: "key" | "paste";
      readonly bytes: Uint8Array;
    }> = [];
    let inputSource: "key" | "paste" = "key";
    const reportedFailures = new Set<string>();
    const reportFailure = (title: string, outcome: SemanticRequestOutcome<unknown>) => {
      if (outcome.result.ok) return;
      const key = `${outcome.result.error.code}:${outcome.result.error.message}`;
      if (reportedFailures.has(key)) return;
      reportedFailures.add(key);
      services.notices.push({
        tone: "error",
        title,
        message: outcome.result.error.message,
      });
    };
    const sendInput = async (source: "key" | "paste", bytes: Uint8Array) => {
      const current = attachment;
      if (!current) {
        pendingInput.push({ source, bytes });
        return;
      }
      const outcome = await terminalSessions.writeInput.execute({
        terminalId,
        attachmentId: current.id,
        source,
        bytes,
      });
      reportFailure("Could not write to terminal", outcome);
    };
    const writeInput = terminal.onData((data) => {
      void sendInput(inputSource, new TextEncoder().encode(data));
    });
    const markPaste = () => {
      inputSource = "paste";
      queueMicrotask(() => { inputSource = "key"; });
    };
    terminal.element?.addEventListener("paste", markPaste, true);

    let resizeQueue = Promise.resolve();
    const resize = () => {
      fit.fit();
      const current = attachment;
      if (!current) return;
      resizeQueue = resizeQueue.then(async () => {
        const outcome = await terminalSessions.resize.execute({
          terminalId,
          attachmentId: current.id,
          columns: terminal.cols,
          rows: terminal.rows,
        });
        reportFailure("Could not resize terminal", outcome);
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    void terminalSessions.bytes.attach({
      terminalId,
      driverId: THIN_TERMINAL_DRIVER_ID,
      claimsResize: true,
      afterSequence: null,
      initialCredit: 0,
    }, async (delivery) => {
      if (disposed) return;
      if (delivery.type === "gap") {
        terminal.writeln("\r\nTerminal output before this attachment is unavailable.");
        return;
      }
      if (delivery.type === "disconnected") {
        terminal.writeln(`\r\nTerminal stream disconnected: ${delivery.reason}`);
        return;
      }
      await new Promise<void>((resolve) => terminal.write(delivery.value.bytes, resolve));
      if (disposed) return;
      attachment?.acknowledge(delivery.sequence);
      attachment?.grant(1);
    }).then((attached) => {
      if (disposed) {
        void attached.dispose();
        return;
      }
      attachment = attached;
      resize();
      attached.grant(1);
      for (const input of pendingInput.splice(0)) {
        void sendInput(input.source, input.bytes);
      }
    }).catch((error: unknown) => {
      if (!disposed) terminal.writeln(`\r\nTerminal stream failed: ${String(error)}`);
    });

    return () => {
      disposed = true;
      terminalRef.current = null;
      observer.disconnect();
      writeInput.dispose();
      terminal.element?.removeEventListener("paste", markPaste, true);
      void attachment?.dispose();
      terminal.dispose();
    };
  }, [services, terminalId, terminalSessions]);

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
