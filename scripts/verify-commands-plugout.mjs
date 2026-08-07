#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  readJson,
  replaceOnce,
  run,
  verifyModulePlugout,
  writeJson,
} from "./lib/module-plugout.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function removeFrontendComposition(root) {
  replaceOnce(
    root,
    "core/frontend/host/enabledModules.ts",
    'import { commandsModule } from "@shep/module-commands";\n',
    "",
  );
  replaceOnce(
    root,
    "core/frontend/host/enabledModules.ts",
    '  ...(import.meta.env.VITE_SHEP_COMMANDS_MODULE === "disabled" ? [] : [commandsModule]),\n',
    "",
  );
  replaceOnce(
    root,
    "scripts/tests/moduleComposition.test.ts",
    `test("default profile enables the extracted Commands surfaces", () => {
  const registry = createEnabledPanelRegistry(builtinPanelLoaders);
  assert.equal(registry.has("core.commands"), true);
  assert.equal(registry.panel("core.commands")?.legacyTab?.kind, "commands");
  assert.equal(
    moduleProjectNavigationContributions().some(
      ({ id, panelId }) => id === "commands.project-navigation" && panelId === "core.commands",
    ),
    true,
  );
});

`,
    "",
  );
}

function prepareDisabled(root) {
  removeFrontendComposition(root);
}

function prepareSourceAbsent(root) {
  prepareDisabled(root);
  rmSync(path.join(root, "modules/commands"), { recursive: true, force: true });

  const packageJson = readJson(root, "package.json");
  delete packageJson.dependencies["@shep/module-commands"];
  delete packageJson.scripts["test:commands-characterization"];
  delete packageJson.scripts["verify:commands-frontend-disabled"];
  delete packageJson.scripts["verify:commands-plugout"];
  writeJson(root, "package.json", packageJson);
}

function assertSourceAbsent(root) {
  const patterns = [
    "@shep/module-commands",
    "CommandsPanel",
    "CommandsProjectRow",
    "useCommandsStore",
    "commands-panel",
    "commands.project-navigation",
  ];
  const targets = [
    "modules",
    "src",
    "package.json",
    "scripts/smoke/panel-host/main.tsx",
  ];
  const result = spawnSync("rg", ["-n", patterns.join("|"), ...targets], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error(`Commands module reference remains after plug-out:\n${result.stdout}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || `rg exited with status ${result.status}`);
  }
}

function assertBundleAbsent(root) {
  const result = spawnSync(
    "rg",
    [
      "-n",
      "CommandsPanel|CommandsProjectRow|commands-panel|commands.project-navigation|@shep/module-commands",
      "dist",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error(`Commands implementation remains in disabled bundle:\n${result.stdout}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || `rg exited with status ${result.status}`);
  }
}

function verifyEnabled(root) {
  run("pnpm", ["test:commands-characterization"], root);
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
}

function verifyDisabled(root) {
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["build"], root);
  assertBundleAbsent(root);
}

function verifySourceAbsent(root) {
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  assertBundleAbsent(root);
}

verifyModulePlugout({
  repositoryRoot,
  moduleName: "commands",
  packages: { pnpm: "@shep/module-commands" },
  verifyEnabled,
  prepareDisabled,
  verifyDisabled,
  prepareSourceAbsent,
  assertSourceAbsent,
  verifySourceAbsent,
  sourceAbsentOnly: process.argv.includes("--source-absent-only"),
});
