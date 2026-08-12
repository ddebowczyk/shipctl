import { invoke, isTauri } from "@tauri-apps/api/core";

export interface NoticeDiagnostic {
  readonly id: number;
  readonly occurredAt: string;
  readonly tone: "info" | "success" | "error";
  readonly title: string;
  readonly message?: string;
  readonly occurrences: number;
}

export interface TerminalRuntimeDiagnostic {
  readonly occurredAt: string;
  readonly terminalId: string;
  readonly event: string;
  readonly facts?: Readonly<Record<string, string | number | boolean | null>>;
}

/** A stable, payload-free log entry for one user-facing failure. */
export function noticeDiagnosticLogEntry(diagnostic: NoticeDiagnostic): string {
  return JSON.stringify({ kind: "notice", ...diagnostic });
}

/** A payload-free terminal state transition that is safe for a release log. */
export function terminalDiagnosticLogEntry(diagnostic: TerminalRuntimeDiagnostic): string {
  return JSON.stringify({ kind: "terminal", ...diagnostic });
}

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
 * Persist an error notice in Tauri's release log.
 *
 * The in-memory history is useful during one renderer lifetime. This record
 * survives it, so an agent can inspect the failure after an app run without
 * needing a screenshot or an open developer console. Actions are intentionally
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
