import type {
  CommandContribution,
  CommandInvocationContext,
  ModuleActivationContext,
  ModuleId,
  ShipctlModule,
} from "@shipctl/module-api";
import {
  activeWorkspaceContributionEntries,
  type ActivatedWorkspaceContribution,
} from "@shipctl/core/host";

export type CommandRegistryErrorCode =
  | "command.invalid_id"
  | "command.duplicate_id"
  | "command.owner_mismatch";

export class CommandRegistryError extends Error {
  readonly code: CommandRegistryErrorCode;

  constructor(code: CommandRegistryErrorCode, message: string) {
    super(message);
    this.name = "CommandRegistryError";
    this.code = code;
  }
}

export type CommandDispatchResult =
  | {
    readonly status: "handled";
    readonly command: CommandContribution;
  }
  | {
    readonly status: "unknown";
    readonly commandId: string;
  }
  | {
    readonly status: "disabled";
    readonly command: CommandContribution;
  }
  | {
    readonly status: "failed";
    readonly command: CommandContribution;
    readonly error: unknown;
  };

export interface CommandRegistry {
  commands(): readonly CommandContribution[];
  dispatch(
    commandId: string,
    context: CommandInvocationContext,
  ): Promise<CommandDispatchResult>;
}

export interface CommandRegistryInput {
  readonly coreCommands?: readonly CommandContribution[];
  /**
   * Commands from the accepted workspace contribution catalog. This is the
   * live path; owner identity prevents a removed or replaced activation from
   * retaining a native command route.
   */
  readonly acceptedModuleCommands?: readonly ActivatedWorkspaceContribution<CommandContribution>[];
  readonly moduleActivations?: ReadonlyMap<ModuleId, ModuleActivationContext>;
  /** Legacy static compiler input. The live shell does not use this path. */
  readonly modules?: readonly ShipctlModule[];
}

interface OwnedCommand {
  readonly ownerId: string;
  readonly command: CommandContribution;
}

function isStableCommandId(value: string): boolean {
  const segments = value.split(".");
  return segments.length >= 2
    && segments.every((segment) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment));
}

function register(
  commandsById: Map<string, CommandContribution>,
  { ownerId, command }: OwnedCommand,
): void {
  if (command.moduleId !== ownerId) {
    throw new CommandRegistryError(
      "command.owner_mismatch",
      `Command ${command.id} belongs to ${command.moduleId}, not ${ownerId}`,
    );
  }
  if (!isStableCommandId(command.id)) {
    throw new CommandRegistryError(
      "command.invalid_id",
      `Command ${command.id} must use a stable dotted identifier`,
    );
  }
  if (commandsById.has(command.id)) {
    throw new CommandRegistryError(
      "command.duplicate_id",
      `Command ${command.id} is registered more than once`,
    );
  }
  commandsById.set(command.id, command);
}

/** Compile commands from the core and the modules that activated at startup. */
export function createCommandRegistry({
  coreCommands = [],
  acceptedModuleCommands,
  moduleActivations,
  modules = [],
}: CommandRegistryInput = {}): CommandRegistry {
  const commandsById = new Map<string, CommandContribution>();
  for (const command of coreCommands) {
    register(commandsById, { ownerId: "core", command });
  }
  if (acceptedModuleCommands !== undefined) {
    for (const { contribution: command, owner } of activeWorkspaceContributionEntries(
      acceptedModuleCommands,
      moduleActivations ?? new Map(),
    )) {
      register(commandsById, { ownerId: owner.moduleId, command });
    }
  } else {
    for (const module of modules) {
      for (const command of module.commands ?? []) {
        register(commandsById, { ownerId: module.id, command });
      }
    }
  }
  const commands = Object.freeze([...commandsById.values()]);

  return {
    commands: () => commands,
    dispatch: async (commandId, context) => {
      const command = commandsById.get(commandId);
      if (!command) return { status: "unknown", commandId };
      try {
        if (command.isEnabled?.(context) === false) {
          return { status: "disabled", command };
        }
        await command.run(context);
        return { status: "handled", command };
      } catch (error) {
        return { status: "failed", command, error };
      }
    },
  };
}
