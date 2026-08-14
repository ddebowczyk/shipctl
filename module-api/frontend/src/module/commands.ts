import type { CommandInvocationContext } from "../host/commands";
import type { ContributionId, ModuleId } from "../protocol/panels";

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
