import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ModuleHostServices,
  ModuleTerminalSession,
  ModuleTerminalSessionLifecycleEvent,
} from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

import type { CommandConfig, CommandState } from "../src/types.ts";

type CommandsModule = typeof import("../src/index.ts");
type CommandsDataModule = typeof import("../src/commandsDataClient.ts");

let vite: ViteDevServer;
let commands: CommandsModule;
let commandsData: CommandsDataModule;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  commands = await vite.ssrLoadModule(
    "/modules/commands/frontend/src/index.ts",
  ) as CommandsModule;
  commandsData = await vite.ssrLoadModule(
    "/modules/commands/frontend/src/commandsDataClient.ts",
  ) as CommandsDataModule;
});

after(async () => {
  await vite.close();
});

beforeEach(() => {
  commands.useCommandsStore.setState({ projectCommands: {} });
  commandsData.configureCommandsDataClient(null);
});

const command = (overrides: Partial<CommandConfig> = {}): CommandConfig => ({
  name: "dev",
  command: "pnpm dev",
  autostart: false,
  env: {},
  cwd: null,
  ...overrides,
});

function fixtureServices(options: {
  readonly data?: unknown;
  readonly calls?: Array<unknown[]>;
  readonly sessions?: readonly ModuleTerminalSession[];
} = {}) {
  const calls = options.calls ?? [];
  let listener: ((event: ModuleTerminalSessionLifecycleEvent) => void) | null = null;
  const services = {
    panels: {
      open: () => "fixture-panel",
      reveal: () => undefined,
      close: () => undefined,
    },
    appearance: {
      getSnapshot: () => ({ themeId: "fixture", background: "#000" }),
      subscribe: () => () => undefined,
    },
    terminalSessions: {
      list: () => options.sessions ?? [],
      getDimensions: () => ({ columns: 132, rows: 42 }),
      launch: async (request) => {
        const session = {
          id: request.moduleSessionId,
          terminalId: "00000000-0000-4000-8000-000000000001" as never,
          moduleId: "commands",
          projectPath: request.projectPath,
          ownerKey: request.ownerKey,
          label: request.label,
          ownerMetadata: request.ownerMetadata,
        };
        calls.push(["launch", request]);
        listener?.({ type: "launched", session });
        return session;
      },
      launchManaged: async () => { throw new Error("not used"); },
      update: async (sessionId, patch) => ({
        id: sessionId,
        terminalId: "00000000-0000-4000-8000-000000000001" as never,
        moduleId: "commands",
        projectPath: "/repo",
        ownerKey: "commands:fixture",
        label: patch.label ?? "fixture",
      }),
      stop: async (sessionId) => {
        calls.push(["stop", sessionId]);
      },
      focus: async (sessionId) => {
        calls.push(["focus", sessionId]);
      },
      subscribe: (next) => {
        listener = next;
        return () => {
          if (listener === next) listener = null;
        };
      },
    },
    settings: {
      getSnapshot: () => ({ values: {}, isSaving: false, error: null }),
      subscribe: () => () => undefined,
      update: async () => undefined,
    },
    skills: {
      getSnapshot: () => ({ byProject: {} }),
      subscribe: () => () => undefined,
      install: async () => undefined,
    },
    notices: {
      push: (notice) => calls.push(["notice", notice]),
    },
    externalLinks: { open: async () => undefined },
  } satisfies ModuleHostServices;
  commandsData.configureCommandsDataClient({
    read: async (projectPath) => {
      calls.push(["read", projectPath]);
      return (options.data ?? null) as never;
    },
    replace: async (projectPath, value) => {
      calls.push(["replace", projectPath, value]);
    },
    forget: () => undefined,
  });
  return {
    calls,
    services,
    publish: (event: ModuleTerminalSessionLifecycleEvent) => listener?.(event),
  };
}

test("module identity, panel identity, navigation, and migration metadata are stable", () => {
  assert.equal(commands.commandsModule.id, "shipctl.commands");
  assert.equal(commands.commandsModule.panels[0].id, "core.commands");
  assert.equal(commands.commandsModule.panels[0].shortcut, "⇧⌘C");
  assert.equal(commands.commandsModule.panels[0].migrationAlias.kind, "commands");
  assert.equal(commands.commandsModule.projectNavigation[0].panelId, "core.commands");
});

test("catalogue parsing and generated names preserve existing behavior", () => {
  const existing = [
    { ...command({ name: "pnpm_dev" }), status: "stopped", sessionId: null },
    { ...command({ name: "pnpm_dev_2" }), status: "stopped", sessionId: null },
  ] satisfies CommandState[];
  assert.equal(commands.generateCommandName("  PNPM   dev!!!  ", existing), "pnpm_dev_3");
  assert.equal(commands.generateCommandName("$$$", existing), "command");
});

test("project load is isolated, first-visit-only, and autostarts sequentially", async () => {
  const fixture = fixtureServices({
    data: [command({ autostart: true, env: { PORT: "3000" }, cwd: "apps/web" })],
  });
  await commands.loadProjectCommands("/alpha", fixture.services);
  await commands.loadProjectCommands("/alpha", fixture.services);

  const state = commands.useCommandsStore.getState().projectCommands["/alpha"];
  assert.equal(state[0].status, "running");
  assert.match(state[0].sessionId ?? "", /^commands:/);
  assert.equal(fixture.calls.filter(([kind]) => kind === "read").length, 1);
  const launch = fixture.calls.find(([kind]) => kind === "launch")?.[1] as Record<string, unknown>;
  assert.deepEqual(launch, {
    projectPath: "/alpha",
    moduleSessionId: launch.moduleSessionId,
    ownerKey: launch.ownerKey,
    command: "pnpm dev",
    environment: { PORT: "3000" },
    cwd: "/alpha/apps/web",
    label: "dev",
    ownerMetadata: launch.ownerMetadata,
    columns: 132,
    rows: 42,
  });
});

test("project load adopts a host-owned autostart terminal without launching a duplicate", async () => {
  const existingSession = {
    id: "commands:existing",
    terminalId: "00000000-0000-4000-8000-000000000099" as never,
    moduleId: "commands",
    projectPath: "/alpha",
    ownerKey: "commands:/alpha:dev",
    label: "dev",
    ownerMetadata: {
      projectPath: "/alpha",
      commandName: "dev",
      invocationId: "existing-invocation",
    },
  } satisfies ModuleTerminalSession;
  const fixture = fixtureServices({
    data: [command({ autostart: true })],
    sessions: [existingSession],
  });

  await commands.loadProjectCommands("/alpha", fixture.services);

  const state = commands.useCommandsStore.getState().projectCommands["/alpha"][0];
  assert.equal(state.status, "running");
  assert.equal(state.sessionId, existingSession.id);
  assert.equal(fixture.calls.some(([kind]) => kind === "launch"), false);

  fixture.publish({ type: "adopted", session: existingSession });
  assert.equal(commands.useCommandsStore.getState().projectCommands["/alpha"][0].sessionId, existingSession.id);
  assert.equal(fixture.calls.some(([kind]) => kind === "launch"), false);
});

test("create, update, and delete persist before mutating runtime state", async () => {
  const fixture = fixtureServices();
  commands.useCommandsStore.getState().load("/alpha", [command()]);

  assert.equal(await commands.createCommand(
    "/alpha",
    command({ name: "test", command: "pnpm test" }),
    fixture.services,
  ), true);
  assert.equal(await commands.startCommand("/alpha", "dev", fixture.services), true);
  assert.equal(await commands.updateCommand(
    "/alpha",
    "dev",
    command({ command: "pnpm dev --host" }),
    fixture.services,
  ), true);
  assert.equal(await commands.deleteCommand("/alpha", "test", fixture.services), true);

  assert.deepEqual(
    commands.useCommandsStore.getState().projectCommands["/alpha"].map(({ name, command }) => ({ name, command })),
    [{ name: "dev", command: "pnpm dev --host" }],
  );
  assert.deepEqual(
    fixture.calls.map(([kind]) => kind),
    ["replace", "launch", "replace", "stop", "replace"],
  );
});

test("terminal lifecycle maps zero, nonzero, and manual exits without PTY knowledge", async () => {
  const fixture = fixtureServices();
  commands.useCommandsStore.getState().load("/alpha", [command()]);
  await commands.startCommand("/alpha", "dev", fixture.services);
  const request = fixture.calls.find(([kind]) => kind === "launch")?.[1] as {
    moduleSessionId: string;
    ownerKey: string;
    ownerMetadata: Record<string, string>;
  };
  const session = {
    id: request.moduleSessionId,
    terminalId: "00000000-0000-4000-8000-000000000001" as never,
    moduleId: "commands",
    projectPath: "/alpha",
    ownerKey: request.ownerKey,
    label: "dev",
    ownerMetadata: request.ownerMetadata,
  };

  fixture.publish({ type: "exited", session, reason: "nonzero-exit", exitCode: 2 });
  assert.equal(commands.useCommandsStore.getState().projectCommands["/alpha"][0].status, "crashed");
  assert.equal(
    commands.useCommandsStore.getState().projectCommands["/alpha"][0].sessionId,
    request.moduleSessionId,
  );
  await commands.stopCommand("/alpha", "dev", fixture.services);
  assert.equal(commands.useCommandsStore.getState().projectCommands["/alpha"][0].status, "stopped");
  assert.equal(commands.useCommandsStore.getState().projectCommands["/alpha"][0].sessionId, null);
});

test("cwd resolution preserves the existing relative and permissive behavior", () => {
  assert.equal(commands.resolveCommandCwd("/repo", null), "/repo");
  assert.equal(commands.resolveCommandCwd("/repo", "  "), "/repo");
  assert.equal(commands.resolveCommandCwd("/repo", "./apps/web"), "/repo/apps/web");
  assert.equal(commands.resolveCommandCwd("/repo", "/apps/web"), "/repo/apps/web");
  assert.equal(commands.resolveCommandCwd("/repo", "../shared"), "/repo/../shared");
});
