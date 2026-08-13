import type { ContributionId, ModuleId } from "./panels";

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

/**
 * A static command contributed by core or a bundled module.
 *
 * Native menu placement is compiled separately in Rust. This contract only
 * describes the frontend dispatch target and its availability.
 */
export interface CommandContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly label: string;
  isEnabled?(context: CommandInvocationContext): boolean;
  run(context: CommandInvocationContext): void | Promise<void>;
}
