export interface CommandConfig {
  readonly name: string;
  readonly command: string;
  readonly autostart: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | null;
}

export type CommandStatus = "stopped" | "running" | "crashed";

export interface CommandState extends CommandConfig {
  readonly status: CommandStatus;
  readonly sessionId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnvironment(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string"
    )),
  );
}

export function readCommandConfigs(value: unknown): CommandConfig[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (typeof entry.name !== "string" || !entry.name.trim()) return [];
    if (typeof entry.command !== "string" || !entry.command.trim()) return [];
    return [{
      name: entry.name,
      command: entry.command,
      autostart: entry.autostart === true,
      env: readEnvironment(entry.env),
      cwd: typeof entry.cwd === "string" ? entry.cwd : null,
    }];
  });
}

export function toCommandConfig(command: CommandState): CommandConfig {
  return {
    name: command.name,
    command: command.command,
    autostart: command.autostart,
    env: command.env,
    cwd: command.cwd,
  };
}
