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
