import type { ContributionId } from "../protocol/panels";

/**
 * The small host context available to a static command handler.
 *
 * Commands describe intent. They do not receive a Tauri API, a canvas adapter,
 * or a mutable module registry.
 */
export interface CommandInvocationContext {
  readonly activeProjectId: string | null;
  openPanel(panelId: ContributionId): void;
}
