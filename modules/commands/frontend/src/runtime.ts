import type {
  ModuleHostServices,
  ModuleTerminalSessionLifecycleEvent,
} from "@shipctl/module-api";

import { useCommandsStore } from "./store";
import { readCommandConfigs, toCommandConfig } from "./types";
import type { CommandConfig, CommandState } from "./types";

export const COMMANDS_CAPABILITY_ID = "commands";

interface CommandOwner {
  readonly projectPath: string;
  readonly commandName: string;
}

const subscribedPorts = new WeakSet<object>();
const pendingLoads = new Map<string, Promise<void>>();

export function resolveCommandCwd(projectPath: string, commandCwd: string | null) {
  const trimmed = commandCwd?.trim();
  if (!trimmed) return projectPath;
  const relativePath = trimmed.replace(/^\.?\//, "").replace(/^\/+/, "");
  return `${projectPath}/${relativePath}`;
}

function applyLifecycle(event: ModuleTerminalSessionLifecycleEvent) {
  if (event.session.moduleId !== "commands") return;
  const metadata = event.session.ownerMetadata;
  const owner: CommandOwner | null = metadata
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && typeof metadata.projectPath === "string"
    && typeof metadata.commandName === "string"
      ? { projectPath: metadata.projectPath, commandName: metadata.commandName }
      : null;
  if (!owner) return;
  const store = useCommandsStore.getState();
  if (["launched", "adopted", "updated"].includes(event.type)) {
    store.setRuntime(owner.projectPath, owner.commandName, "running", event.session.id);
    return;
  }
  if (event.type === "closed") {
    store.setRuntime(owner.projectPath, owner.commandName, "stopped", null);
    return;
  }
  if (event.type !== "exited") return;

  store.setRuntime(
    owner.projectPath,
    owner.commandName,
    event.reason === "nonzero-exit" ? "crashed" : "stopped",
    event.session.id,
  );
}

function ensureRuntime(services: ModuleHostServices) {
  if (subscribedPorts.has(services.terminalSessions)) return;
  subscribedPorts.add(services.terminalSessions);
  services.terminalSessions.subscribe(applyLifecycle);
}

function commandsFor(projectPath: string): readonly CommandState[] {
  return useCommandsStore.getState().projectCommands[projectPath] ?? [];
}

async function persist(
  projectPath: string,
  commands: readonly CommandConfig[],
  services: ModuleHostServices,
) {
  await services.projectData.replace(projectPath, COMMANDS_CAPABILITY_ID, commands);
}

export async function stopCommand(
  projectPath: string,
  name: string,
  services: ModuleHostServices,
) {
  ensureRuntime(services);
  const command = commandsFor(projectPath).find((entry) => entry.name === name);
  if (command?.sessionId) await services.terminalSessions.stop(command.sessionId);
  useCommandsStore.getState().setRuntime(projectPath, name, "stopped", null);
}

export async function startCommand(
  projectPath: string,
  name: string,
  services: ModuleHostServices,
) {
  ensureRuntime(services);
  let command = commandsFor(projectPath).find((entry) => entry.name === name);
  if (!command) return false;

  try {
    if (command.sessionId) {
      await stopCommand(projectPath, name, services);
      command = commandsFor(projectPath).find((entry) => entry.name === name);
      if (!command) return false;
    }
    const invocationId = crypto.randomUUID();
    const ownerKey = `commands:${invocationId}`;
    const dimensions = services.terminalSessions.getDimensions();
    const session = await services.terminalSessions.launch({
      projectPath,
      moduleSessionId: `commands:${invocationId}`,
      ownerKey,
      command: command.command,
      environment: command.env,
      cwd: resolveCommandCwd(projectPath, command.cwd),
      label: command.name,
      ownerMetadata: { projectPath, commandName: name, invocationId },
      columns: dimensions.columns,
      rows: dimensions.rows,
    });
    const current = commandsFor(projectPath).find((entry) => entry.name === name);
    if (current?.sessionId !== session.id) {
      useCommandsStore.getState().setRuntime(projectPath, name, "running", session.id);
    }
    return true;
  } catch (error) {
    services.notices.push({
      tone: "error",
      title: `Couldn’t start ${name}`,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function createCommand(
  projectPath: string,
  command: CommandConfig,
  services: ModuleHostServices,
) {
  const next = [...commandsFor(projectPath).map(toCommandConfig), command];
  try {
    await persist(projectPath, next, services);
    useCommandsStore.getState().add(projectPath, command);
    return true;
  } catch (error) {
    services.notices.push({
      tone: "error",
      title: "Couldn’t save workspace",
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function updateCommand(
  projectPath: string,
  previousName: string,
  command: CommandConfig,
  services: ModuleHostServices,
) {
  const next = commandsFor(projectPath).map((existing) => (
    existing.name === previousName ? command : toCommandConfig(existing)
  ));
  try {
    await persist(projectPath, next, services);
    await stopCommand(projectPath, previousName, services);
    useCommandsStore.getState().update(projectPath, previousName, command);
    return true;
  } catch (error) {
    services.notices.push({
      tone: "error",
      title: "Couldn’t save workspace",
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function deleteCommand(
  projectPath: string,
  name: string,
  services: ModuleHostServices,
) {
  const next = commandsFor(projectPath)
    .filter((command) => command.name !== name)
    .map(toCommandConfig);
  try {
    await persist(projectPath, next, services);
    await stopCommand(projectPath, name, services);
    useCommandsStore.getState().remove(projectPath, name);
    return true;
  } catch (error) {
    services.notices.push({
      tone: "error",
      title: "Couldn’t save workspace",
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function startAllCommands(
  projectPath: string,
  services: ModuleHostServices,
) {
  for (const command of commandsFor(projectPath)) {
    if (command.status !== "running") await startCommand(projectPath, command.name, services);
  }
}

export async function stopAllCommands(
  projectPath: string,
  services: ModuleHostServices,
) {
  for (const command of commandsFor(projectPath)) {
    if (command.status === "running") await stopCommand(projectPath, command.name, services);
  }
}

export function loadProjectCommands(
  projectPath: string,
  services: ModuleHostServices,
): Promise<void> {
  if (useCommandsStore.getState().hasProject(projectPath)) return Promise.resolve();
  const pending = pendingLoads.get(projectPath);
  if (pending) return pending;

  const load = (async () => {
    try {
      const value = await services.projectData.read(projectPath, COMMANDS_CAPABILITY_ID);
      const commands = readCommandConfigs(value);
      useCommandsStore.getState().load(projectPath, commands);
      ensureRuntime(services);
      for (const session of services.terminalSessions.list()) {
        applyLifecycle({ type: "adopted", session });
      }
      for (const command of commands) {
        const current = commandsFor(projectPath).find((entry) => entry.name === command.name);
        if (command.autostart && current?.status !== "running") {
          await startCommand(projectPath, command.name, services);
        }
      }
    } catch (error) {
      services.notices.push({
        tone: "error",
        title: "Couldn’t load project commands",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      pendingLoads.delete(projectPath);
    }
  })();
  pendingLoads.set(projectPath, load);
  return load;
}
