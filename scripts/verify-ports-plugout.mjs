#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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
    "src/core/modules/enabledModules.ts",
    'import { portsModule } from "@shep/module-ports";\n',
    "",
  );
  replaceOnce(
    root,
    "src/core/modules/enabledModules.ts",
    "export const ENABLED_MODULES = [portsModule, todosModule] as const satisfies readonly ShepModule[];",
    "export const ENABLED_MODULES = [todosModule] as const satisfies readonly ShepModule[];",
  );
}

function removeNativeComposition(root) {
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'default = ["todos-module", "ports-module"]\n',
    'default = ["todos-module"]\n',
  );
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'ports-module = ["dep:shep-module-ports"]\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'shep-module-ports = { package = "tauri-plugin-shep-ports", path = "../modules/ports/backend", optional = true }\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/enabled_modules.rs",
    '    #[cfg(feature = "ports-module")]\n    let builder = builder.plugin(shep_module_ports::init(crate::ports_module::host_services()));\n\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/lib.rs",
    '#[cfg(feature = "ports-module")]\nmod ports_module;\n',
    "",
  );
  rmSync(path.join(root, "src-tauri/src/ports_module.rs"), { force: true });
}

function removePortsCapability(root, relativePath) {
  if (!existsSync(path.join(root, relativePath))) return;
  const config = readJson(root, relativePath);
  const capabilities = config.app?.security?.capabilities;
  if (Array.isArray(capabilities)) {
    config.app.security.capabilities = capabilities.filter(
      (capability) => typeof capability !== "object" || capability?.identifier !== "ports",
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

  rmSync(path.join(root, "modules/ports"), { recursive: true, force: true });
  rmSync(path.join(root, "profiles/ports-disabled"), { recursive: true, force: true });

  const packageJson = readJson(root, "package.json");
  delete packageJson.dependencies["@shep/module-ports"];
  delete packageJson.scripts["test:ports-characterization"];
  delete packageJson.scripts["verify:ports-native-disabled"];
  delete packageJson.scripts["verify:ports-plugout"];
  writeJson(root, "package.json", packageJson);

  removePortsCapability(root, "src-tauri/tauri.conf.json");
}

function assertSourceAbsent(root) {
  const patterns = [
    "@shep/module-ports",
    "shep_module_ports",
    "shep-module-ports",
    "tauri-plugin-shep-ports",
    "plugin:shep-ports",
    "shep-ports:allow",
    "ports-module",
    "ports.overview",
    "ports.global-navigation",
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
    throw new Error(`Ports module reference remains after plug-out:\n${result.stdout}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || `rg exited with status ${result.status}`);
  }
}

function verifyEnabled(root) {
  run("pnpm", ["test:ports-characterization"], root);
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:global-surfaces"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["build"], root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root);
}

function verifyDisabled(root) {
  run("pnpm", ["test:global-surfaces"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["build"], root);
  run("pnpm", [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--config",
    "profiles/ports-disabled/tauri.conf.json",
    "--",
    "--no-default-features",
    "--features",
    "todos-module",
  ], root);
}

function verifySourceAbsent(root) {
  run("pnpm", ["test:global-surfaces"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root);
}

verifyModulePlugout({
  repositoryRoot,
  moduleName: "ports",
  packages: {
    pnpm: "@shep/module-ports",
    cargo: "tauri-plugin-shep-ports",
  },
  verifyEnabled,
  prepareDisabled,
  verifyDisabled,
  prepareSourceAbsent,
  assertSourceAbsent,
  verifySourceAbsent,
  sourceAbsentOnly: process.argv.includes("--source-absent-only"),
});
