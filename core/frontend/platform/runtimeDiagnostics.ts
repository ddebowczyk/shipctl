import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  noticeDiagnosticLogEntry,
  terminalDiagnosticLogEntry,
  type NoticeDiagnostic,
  type TerminalRuntimeDiagnostic,
} from "../shared/runtimeDiagnostics.ts";

/** Persist a terminal state transition so an agent can inspect a failed run. */
export function reportTerminalDiagnostic(diagnostic: TerminalRuntimeDiagnostic): void {
  if (!isTauri()) return;
  void invoke("plugin:log|log", {
    level: 3,
    message: terminalDiagnosticLogEntry(diagnostic),
    location: "shipctl.terminal",
  }).catch(() => undefined);
}

/**
 * Persist an error notice in Tauri's release log. Actions are intentionally
 * absent because they contain executable browser callbacks, not diagnostics.
 */
export function reportNoticeDiagnostic(diagnostic: NoticeDiagnostic): void {
  if (diagnostic.tone !== "error" || !isTauri()) return;
  void invoke("plugin:log|log", {
    level: 5,
    message: noticeDiagnosticLogEntry(diagnostic),
    location: "shipctl.notice",
  }).catch(() => undefined);
}
