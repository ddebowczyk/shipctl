import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import type { CommandConfig, CommandState } from "../../src/lib/types.ts";

type CommandStoreModule = typeof import("../../src/stores/useCommandStore.ts");
type CommandsPanelModule = typeof import("../../src/components/commands/CommandsPanel.tsx");
type PtyModule = typeof import("../../src/hooks/usePty.ts");

const source = (path: string) => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  "utf8",
);

const command = (overrides: Partial<CommandConfig> = {}): CommandConfig => ({
  name: "dev",
  command: "pnpm dev",
  autostart: false,
  env: {},
  cwd: null,
  ...overrides,
});

let vite: ViteDevServer;
let useCommandStore: CommandStoreModule["useCommandStore"];
let generateCommandName: CommandsPanelModule["generateCommandName"];
let resolveCommandCwd: PtyModule["resolveCommandCwd"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ useCommandStore } = await vite.ssrLoadModule(
    "/src/stores/useCommandStore.ts",
  ) as CommandStoreModule);
  ({ generateCommandName } = await vite.ssrLoadModule(
    "/src/components/commands/CommandsPanel.tsx",
  ) as CommandsPanelModule);
  ({ resolveCommandCwd } = await vite.ssrLoadModule(
    "/src/hooks/usePty.ts",
  ) as PtyModule);
});

after(async () => {
  await vite.close();
});

beforeEach(() => {
  useCommandStore.setState({ projectCommands: {}, activeProjectPath: null });
});

test("loading commands creates project-local stopped runtime state", () => {
  useCommandStore.getState().loadCommands("/alpha", [command({
    autostart: true,
    env: { PORT: "3000" },
    cwd: "apps/web",
  })]);
  useCommandStore.getState().loadCommands("/beta", [command({
    name: "test",
    command: "pnpm test",
  })]);

  assert.deepEqual(useCommandStore.getState().projectCommands["/alpha"], [{
    ...command({ autostart: true, env: { PORT: "3000" }, cwd: "apps/web" }),
    status: "stopped",
    ptyId: null,
  }]);
  assert.equal(useCommandStore.getState().hasProject("/alpha"), true);
  assert.equal(useCommandStore.getState().hasProject("/missing"), false);
  assert.deepEqual(
    useCommandStore.getState().projectCommands["/beta"].map(({ name }) => name),
    ["test"],
  );
});

test("catalogue CRUD and runtime updates remain isolated by project", () => {
  const store = useCommandStore.getState();
  store.loadCommands("/alpha", [command()]);
  store.loadCommands("/beta", [command({ command: "beta dev" })]);
  store.addCommandForProject("/alpha", command({ name: "test", command: "pnpm test" }));
  store.updateCommandForProject("/alpha", "dev", command({ command: "pnpm dev --host" }));
  store.setCommandStatusForProject("/alpha", "dev", "running");
  store.setCommandPtyIdForProject("/alpha", "dev", 42);

  assert.deepEqual(
    useCommandStore.getState().projectCommands["/alpha"].map(({ name, command, status, ptyId }) => (
      { name, command, status, ptyId }
    )),
    [
      { name: "dev", command: "pnpm dev --host", status: "running", ptyId: 42 },
      { name: "test", command: "pnpm test", status: "stopped", ptyId: null },
    ],
  );
  assert.equal(useCommandStore.getState().projectCommands["/beta"][0].command, "beta dev");

  store.removeCommandForProject("/alpha", "test");
  store.removeProject("/alpha");
  assert.equal(useCommandStore.getState().projectCommands["/alpha"], undefined);
  assert.equal(useCommandStore.getState().projectCommands["/beta"].length, 1);
});

test("active-project wrappers update only the selected project", () => {
  const store = useCommandStore.getState();
  store.loadCommands("/alpha", [command()]);
  store.loadCommands("/beta", [command({ command: "beta dev" })]);
  store.switchProject("/beta");
  store.setCommandStatus("dev", "crashed");
  store.setCommandPtyId("dev", 9);

  assert.equal(useCommandStore.getState().projectCommands["/alpha"][0].status, "stopped");
  assert.deepEqual(
    useCommandStore.getState().projectCommands["/beta"][0],
    { ...command({ command: "beta dev" }), status: "crashed", ptyId: 9 },
  );

  store.removeProject("/beta");
  assert.equal(useCommandStore.getState().activeProjectPath, null);
});

test("generated command names preserve normalization and collision behavior", () => {
  const existing = [
    { ...command({ name: "pnpm_dev" }), status: "stopped", ptyId: null },
    { ...command({ name: "pnpm_dev_2" }), status: "stopped", ptyId: null },
  ] satisfies CommandState[];

  assert.equal(generateCommandName("  PNPM   dev!!!  ", existing), "pnpm_dev_3");
  assert.equal(generateCommandName("$$$", existing), "command");
  assert.equal(generateCommandName("A very long command name beyond thirty two chars", []), "a_very_long_command_name_beyond");
});

test("command cwd resolution preserves current relative and permissive behavior", () => {
  assert.equal(resolveCommandCwd("/repo", null), "/repo");
  assert.equal(resolveCommandCwd("/repo", "  "), "/repo");
  assert.equal(resolveCommandCwd("/repo", "./apps/web"), "/repo/apps/web");
  assert.equal(resolveCommandCwd("/repo", "/apps/web"), "/repo/apps/web");
  assert.equal(resolveCommandCwd("/repo", "../shared"), "/repo/../shared");
});

test("host workflow preserves workspace siblings and persists before store mutation", () => {
  const appShell = source("../../src/components/layout/AppShell.tsx");

  assert.match(appShell, /assistants:\s*activeConfig\?\.assistants\s*\?\?\s*\[\]/);
  assert.match(appShell, /commands:\s*nextCommands/);
  assert.match(
    appShell,
    /const saved = await persistWorkspaceCommands\(nextCommands\);\s*if \(!saved\) return false;\s*useCommandStore\.getState\(\)\.addCommandForProject/s,
  );
  assert.match(
    appShell,
    /const saved = await persistWorkspaceCommands\(nextCommands\);\s*if \(!saved\) return false;\s*await stopCommand\(previousName\);\s*useCommandStore\.getState\(\)\.updateCommandForProject/s,
  );
  assert.match(
    appShell,
    /const saved = await persistWorkspaceCommands\(nextCommands\);\s*if \(!saved\) return;\s*await stopCommand\(name\);\s*useCommandStore\.getState\(\)\.removeCommandForProject/s,
  );
});

test("project selection loads and autostarts commands only on first visit", () => {
  const appShell = source("../../src/components/layout/AppShell.tsx");

  assert.match(appShell, /const isFirstVisit = !useCommandStore\.getState\(\)\.hasProject\(repoPath\)/);
  assert.match(
    appShell,
    /if \(isFirstVisit\) \{\s*useCommandStore\.getState\(\)\.loadCommands\(repoPath, config\.commands\);\s*for \(const cmd of config\.commands\) \{\s*if \(cmd\.autostart\)/s,
  );
  assert.match(appShell, /await startCommand\(cmd, cols, rows\)/);
});

test("Commands is still a host-owned built-in surface pending extraction", () => {
  const adapters = source("../../src/core/modules/builtinPanelAdapters.ts");
  const runtime = source("../../src/core/modules/builtinPanelRuntime.tsx");
  const row = source("../../src/components/sidebar/CommandsRow.tsx");
  const tabBar = source("../../src/components/layout/TabBar.tsx");
  const menu = source("../../src-tauri/src/menu.rs");

  assert.match(adapters, /id:\s*BUILTIN_PANEL_IDS\.commands/);
  assert.match(adapters, /shortcut:\s*"⇧⌘C"/);
  assert.match(runtime, /import\("\.\.\/\.\.\/components\/commands\/CommandsPanel"\)/);
  assert.match(row, /togglePanelTab\("commands"\)/);
  assert.match(tabBar, /Commands/);
  assert.match(menu, /"new_commands"/);
});

test("PTY handoff retains command identity and maps exits to stopped or crashed", () => {
  const pty = source("../../src/hooks/usePty.ts");

  assert.match(pty, /spawnSession\(\s*command\.command,\s*null,\s*command\.env/s);
  assert.match(pty, /const commandName = command\.name/);
  assert.match(pty, /label:\s*commandName,[\s\S]*commandName,/);
  assert.match(pty, /setCommandStatus\(commandName, "running"\)/);
  assert.match(pty, /const nextStatus = stoppedByUser \|\| msg\.data\.code === 0 \? "stopped" : "crashed"/);
  assert.match(pty, /setCommandPtyIdForProject\(repoPath, commandName, null\)/);
});
