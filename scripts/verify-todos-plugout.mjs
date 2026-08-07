#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  readJson,
  removeCargoDefaultFeature,
  removeFrontendModuleComposition,
  replaceOnce,
  run,
  verifyModulePlugout,
  writeJson,
} from "./lib/module-plugout.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function removeFrontendComposition(root) {
  removeFrontendModuleComposition(root, "@shep/module-todos", "todosModule");
}

function removeNativeComposition(root) {
  removeCargoDefaultFeature(root, "todos-module");
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'todos-module = ["dep:shep-module-todos"]\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'shep-module-todos = { package = "tauri-plugin-shep-todos", path = "../modules/todos/backend", optional = true }\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/enabled_modules.rs",
    '    #[cfg(feature = "todos-module")]\n    let builder = builder.plugin(shep_module_todos::init());\n\n',
    "",
  );
}

function removeTodoCapability(root, relativePath) {
  if (!existsSync(path.join(root, relativePath))) return;
  const config = readJson(root, relativePath);
  const capabilities = config.app?.security?.capabilities;
  if (Array.isArray(capabilities)) {
    config.app.security.capabilities = capabilities.filter(
      (capability) => typeof capability !== "object" || capability?.identifier !== "todos",
    );
  }
  writeJson(root, relativePath, config);
}

function prepareDisabled(root) {
  removeFrontendComposition(root);
}

function prepareSourceAbsent(root) {
  prepareDisabled(root);
  removeNativeComposition(root);

  rmSync(path.join(root, "modules/todos"), { recursive: true, force: true });
  rmSync(path.join(root, "profiles/todos-disabled"), { recursive: true, force: true });

  const packageJson = readJson(root, "package.json");
  delete packageJson.dependencies["@shep/module-todos"];
  delete packageJson.scripts["test:todos-characterization"];
  delete packageJson.scripts["verify:todos-native-disabled"];
  delete packageJson.scripts["verify:todos-plugout"];
  writeJson(root, "package.json", packageJson);

  removeTodoCapability(root, "src-tauri/tauri.conf.json");
  removeTodoCapability(root, "profiles/fixture/tauri.conf.json");
}

function assertSourceAbsent(root) {
  const patterns = [
    "@shep/module-todos",
    "shep_module_todos",
    "shep-module-todos",
    "tauri-plugin-shep-todos",
    "plugin:shep-todos",
    "shep-todos:allow",
    "todos-module",
    "todos.board",
    "showTodos",
    "todoFileStyle",
    "show_todos",
    "todo_file_style",
  ];
  const targets = [
    "src",
    "src-tauri/src",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
    "package.json",
  ];
  const result = spawnSync("rg", ["-n", patterns.join("|"), ...targets], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error(`TODO module reference remains after plug-out:\n${result.stdout}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || `rg exited with status ${result.status}`);
  }
}

function verifyEnabled(root) {
  run("pnpm", ["test:todos-characterization"], root);
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["build"], root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root);
}

function verifyDisabled(root) {
  run("pnpm", ["build"], root);
  run("pnpm", [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--config",
    "profiles/todos-disabled/tauri.conf.json",
    "--",
    "--no-default-features",
    "--features",
    "ports-module,skills-module",
  ], root);
}

function verifySourceAbsent(root) {
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root);
}

verifyModulePlugout({
  repositoryRoot,
  moduleName: "todos",
  packages: {
    pnpm: "@shep/module-todos",
    cargo: "tauri-plugin-shep-todos",
  },
  verifyEnabled,
  prepareDisabled,
  verifyDisabled,
  prepareSourceAbsent,
  assertSourceAbsent,
  verifySourceAbsent,
  sourceAbsentOnly: process.argv.includes("--source-absent-only"),
});
