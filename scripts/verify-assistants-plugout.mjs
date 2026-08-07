#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  nativeModuleFeaturesExcept,
  readJson,
  removeCargoDefaultFeature,
  removeNativeModuleFeatureFromScripts,
  replaceOnce,
  run,
  verifyModulePlugout,
  writeJson,
} from "./lib/module-plugout.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function cargoEnvironment(root) {
  return {
    CARGO_TARGET_DIR: path.join(root, "src-tauri/target/assistants-plugout"),
  };
}

function removeFrontendComposition(root) {
  replaceOnce(
    root,
    "src/core/modules/enabledModules.ts",
    'import { assistantsModule } from "@shep/module-assistants";\n',
    "",
  );
  replaceOnce(
    root,
    "src/core/modules/enabledModules.ts",
    '  ...(import.meta.env.VITE_SHEP_ASSISTANTS_MODULE === "disabled" ? [] : [assistantsModule]),\n',
    "",
  );
}

function removeNativeComposition(root) {
  removeCargoDefaultFeature(root, "assistants-module");
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'assistants-module = ["dep:shep-module-assistants"]\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'shep-module-assistants = { package = "tauri-plugin-shep-assistants", path = "../modules/assistants/backend", optional = true }\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/enabled_modules.rs",
    "pub fn install<R: Runtime>(builder: Builder<R>, pty_manager: PtyManager) -> Builder<R> {\n",
    "pub fn install<R: Runtime>(builder: Builder<R>, _pty_manager: PtyManager) -> Builder<R> {\n",
  );
  replaceOnce(
    root,
    "src-tauri/src/enabled_modules.rs",
    `    #[cfg(feature = "assistants-module")]
    let builder = builder.plugin(shep_module_assistants::init(
        crate::assistants_module::host_services(pty_manager),
    ));

    #[cfg(not(feature = "assistants-module"))]
    let _ = pty_manager;

`,
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/lib.rs",
    '#[cfg(feature = "assistants-module")]\nmod assistants_module;\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/lib.rs",
    '#[cfg(feature = "assistants-module")]\nmod pi_config;\n',
    "",
  );
  rmSync(path.join(root, "src-tauri/src/assistants_module.rs"), { force: true });
  rmSync(path.join(root, "src-tauri/src/pi_config.rs"), { force: true });
}

function removeAssistantCapability(root, relativePath) {
  if (!existsSync(path.join(root, relativePath))) return;
  const config = readJson(root, relativePath);
  const capabilities = config.app?.security?.capabilities;
  if (Array.isArray(capabilities)) {
    config.app.security.capabilities = capabilities.filter(
      (capability) => typeof capability !== "object" || capability?.identifier !== "assistants",
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

  rmSync(path.join(root, "modules/assistants"), { recursive: true, force: true });
  rmSync(path.join(root, "profiles/assistants-disabled"), { recursive: true, force: true });
  rmSync(path.join(root, "scripts/verify-assistants-frontend-disabled.mjs"), { force: true });
  rmSync(path.join(root, "scripts/tests/assistantProvidersCharacterization.test.ts"), { force: true });

  const packageJson = readJson(root, "package.json");
  delete packageJson.dependencies["@shep/module-assistants"];
  delete packageJson.scripts["test:assistant-providers-characterization"];
  delete packageJson.scripts["verify:assistants-native-disabled"];
  delete packageJson.scripts["verify:assistants-frontend-disabled"];
  delete packageJson.scripts["verify:assistants-plugout"];
  removeNativeModuleFeatureFromScripts(packageJson, "assistants-module");
  writeJson(root, "package.json", packageJson);

  removeAssistantCapability(root, "src-tauri/tauri.conf.json");
}

function assertNoMatches(root, targets, patterns, message) {
  const result = spawnSync("rg", ["-n", patterns.join("|"), ...targets], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error(`${message}:\n${result.stdout}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || `rg exited with status ${result.status}`);
  }
}

function assertSourceAbsent(root) {
  assertNoMatches(
    root,
    [
      "modules",
      "src",
      "src-tauri/src",
      "src-tauri/Cargo.toml",
      "src-tauri/tauri.conf.json",
      "package.json",
      "scripts/smoke/panel-host/main.tsx",
    ],
    [
      "@shep/module-assistants",
      "shep_module_assistants",
      "shep-module-assistants",
      "tauri-plugin-shep-assistants",
      "plugin:shep-assistants",
      "shep-assistants:allow",
      "assistants-module",
      "shep.assistants",
      "assistants.launcher",
      "SessionLauncher",
      "AssistantSessionRecord",
      "spawnAssistantSession",
      "get_pi_config",
      "save_pi_settings",
      "save_pi_api_key",
      "delete_pi_api_key",
      "ASSISTANT_LAUNCHER_PANEL_ID",
      "new_agent",
    ],
    "Assistant module reference remains after plug-out",
  );
}

function assertBundleAbsent(root) {
  assertNoMatches(
    root,
    ["dist"],
    [
      "@shep/module-assistants",
      "plugin:shep-assistants",
      "shep.assistants",
      "assistants.launcher",
      "SessionLauncher",
    ],
    "Assistant implementation remains in disabled bundle",
  );
}

function verifyEnabled(root) {
  const cargoEnv = cargoEnvironment(root);
  run("pnpm", ["test:assistant-providers-characterization"], root);
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:terminal-sessions"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root, cargoEnv);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root, cargoEnv);
}

function verifyDisabled(root) {
  const cargoEnv = cargoEnvironment(root);
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:terminal-sessions"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["build"], root);
  assertBundleAbsent(root);
  run("pnpm", [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--config",
    "profiles/assistants-disabled/tauri.conf.json",
    "--",
    "--no-default-features",
    "--features",
    nativeModuleFeaturesExcept("assistants-module"),
  ], root, cargoEnv);
}

function verifySourceAbsent(root) {
  const cargoEnv = cargoEnvironment(root);
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:terminal-sessions"], root);
  run("pnpm", ["test:module-boundaries"], root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  assertBundleAbsent(root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root, cargoEnv);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root, cargoEnv);
}

verifyModulePlugout({
  repositoryRoot,
  moduleName: "assistants",
  packages: {
    pnpm: "@shep/module-assistants",
    cargo: "tauri-plugin-shep-assistants",
  },
  verifyEnabled,
  prepareDisabled,
  verifyDisabled,
  prepareSourceAbsent,
  assertSourceAbsent,
  verifySourceAbsent,
  sourceAbsentOnly: process.argv.includes("--source-absent-only"),
});
