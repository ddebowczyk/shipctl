import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ModuleHostServices,
  ModuleTerminalSessionLifecycleEvent,
} from "@shep/module-api";
import { createServer, type ViteDevServer } from "vite";

import type { CommandConfig, CommandState } from "../src/types.ts";

type CommandsModule = typeof import("../src/index.ts");

let vite: ViteDevServer;
let commands: CommandsModule;

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
});

after(async () => {
  await vite.close();
});

beforeEach(() => {
  commands.useCommandsStore.setState({ projectCommands: {} });
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
} = {}) {
  const calls = options.calls ?? [];
  let listener: ((event: ModuleTerminalSessionLifecycleEvent) => void) | null = null;
  let sequence = 0;
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
    projectData: {
      read: async (projectPath, capabilityId) => {
        calls.push(["read", projectPath, capabilityId]);
        return options.data;
      },
      replace: async (projectPath, capabilityId, value) => {
        calls.push(["replace", projectPath, capabilityId, value]);
      },
    },
    terminalSessions: {
      getDimensions: () => ({ columns: 132, rows: 42 }),
      launch: async (request) => {
        const session = {
          id: `session-${++sequence}`,
          projectPath: request.projectPath,
          ownerKey: request.ownerKey,
          label: request.label,
        };
        calls.push(["launch", request]);
        listener?.({ type: "started", session });
        return session;
      },
      update: async (sessionId, patch) => ({
        id: sessionId,
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
  return {
    calls,
    services,
    publish: (event: ModuleTerminalSessionLifecycleEvent) => listener?.(event),
  };
}

test("module identity, panel identity, navigation, and migration metadata are stable", () => {
  assert.equal(commands.commandsModule.id, "shep.commands");
  assert.equal(commands.commandsModule.panels[0].id, "core.commands");
  assert.equal(commands.commandsModule.panels[0].shortcut, "⇧⌘C");
  assert.equal(commands.commandsModule.panels[0].legacyTab.kind, "commands");
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
  assert.equal(state[0].sessionId, "session-1");
  assert.equal(fixture.calls.filter(([kind]) => kind === "read").length, 1);
  const launch = fixture.calls.find(([kind]) => kind === "launch")?.[1] as Record<string, unknown>;
  assert.deepEqual(launch, {
    projectPath: "/alpha",
    ownerKey: launch.ownerKey,
    command: "pnpm dev",
    environment: { PORT: "3000" },
    cwd: "/alpha/apps/web",
    label: "dev",
    columns: 132,
    rows: 42,
  });
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
  const request = fixture.calls.find(([kind]) => kind === "launch")?.[1] as { ownerKey: string };
  const session = {
    id: "session-1",
    projectPath: "/alpha",
    ownerKey: request.ownerKey,
    label: "dev",
  };

  fixture.publish({ type: "exited", session, reason: "nonzero-exit", exitCode: 2 });
  assert.equal(commands.useCommandsStore.getState().projectCommands["/alpha"][0].status, "crashed");
  assert.equal(commands.useCommandsStore.getState().projectCommands["/alpha"][0].sessionId, "session-1");
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
