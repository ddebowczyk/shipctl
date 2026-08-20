import { invoke } from "@tauri-apps/api/core";

/** Native terminal-resource acknowledgement, not a user-settings document. */
export interface TerminalRetentionCommit {
  readonly retentionBytes: number;
  readonly retentionRevision: number;
}

/** Applies the configured byte budget to the already-running terminal resource. */
export function setTerminalRetention(retentionBytes: number): Promise<TerminalRetentionCommit> {
  return invoke("set_terminal_retention", { retentionBytes });
}
