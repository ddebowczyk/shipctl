/**
 * Terminal history retention, frontend side.
 *
 * The product setting is a **byte budget** because the host parser measures
 * history in bytes and evicts whole pages. A row count would be a promise the
 * host cannot keep, so no row-named value here is ever presented as the user's
 * setting.
 */

import type { TerminalSettings, TerminalSettingsCommit } from "@shipctl/core/platform";

const MIB = 1024 * 1024;

/** Mirrors `RETENTION_DEFAULT_BYTES` in core/backend/src/terminal/retention.rs. */
export const RETENTION_DEFAULT_BYTES = 16 * MIB;

/** Mirrors `RETENTION_MAX_BYTES`. The backend clamps; this only shapes the UI. */
export const RETENTION_MAX_BYTES = 256 * MIB;

/** Budgets offered in the settings panel. */
export const RETENTION_PRESET_BYTES = [0, 4 * MIB, 16 * MIB, 64 * MIB, 256 * MIB] as const;

export function formatRetentionBudget(bytes: number): string {
  if (bytes === 0) return "None";
  return `${Math.round(bytes / MIB)} MB`;
}

/** Settings the client holds, with the revision they were committed at. */
export interface CommittedTerminalSettings {
  settings: TerminalSettings;
  retentionRevision: number;
}

/**
 * Decide what a settings response does to committed client state.
 *
 * A response carrying a revision below the one already held describes a policy
 * the user has replaced, so it is discarded. Equal revisions are accepted
 * because a reload of the same commit is not a rollback.
 */
export function applyTerminalSettingsCommit(
  held: CommittedTerminalSettings,
  commit: TerminalSettingsCommit,
): CommittedTerminalSettings {
  const { retentionRevision, ...settings } = commit;
  if (retentionRevision < held.retentionRevision) return held;
  return { settings, retentionRevision };
}
