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
    CARGO_TARGET_DIR: path.join(root, "target/usage-plugout"),
  };
}

function removeFrontendComposition(root) {
  replaceOnce(
    root,
    "core/frontend/host/enabledModules.ts",
    'import { usageModule } from "@shep/module-usage";\n',
    "",
  );
  replaceOnce(
    root,
    "core/frontend/host/enabledModules.ts",
    '  ...(import.meta.env.VITE_SHEP_USAGE_MODULE === "disabled" ? [] : [usageModule]),\n',
    "",
  );
  replaceOnce(
    root,
    "scripts/tests/moduleComposition.test.ts",
    `test("default profile composes Usage only through its module contributions", () => {
  const registry = createEnabledGlobalSurfaceRegistry(builtinGlobalSurfaceLoaders);
  assert.equal(registry.surface("core.usage")?.moduleId, "shep.usage");
  assert.equal(
    registry.navigation().find(({ id }) => id === "usage.global-navigation")?.surfaceId,
    "core.usage",
  );
  assert.equal(
    moduleSidebarContributions().find(({ id }) => id === "usage.sidebar")?.surfaceId,
    "core.usage",
  );
  assert.deepEqual(
    moduleSettingsContributions(undefined, "terminal.after").map(({ id }) => id),
    ["usage.settings"],
  );
});

`,
    "",
  );
}

function removeNativeComposition(root) {
  removeCargoDefaultFeature(root, "usage-module");
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'usage-module = ["dep:shep-module-usage"]\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'shep-module-usage = { package = "tauri-plugin-shep-usage", path = "../modules/usage/backend", optional = true }\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/modules/mod.rs",
    `    #[cfg(feature = "usage-module")]
    let builder = builder.plugin(shep_module_usage::init(
        crate::modules::usage::host_services(),
    ));

`,
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/modules/mod.rs",
    '#[cfg(feature = "usage-module")]\npub mod usage;\n',
    "",
  );
  rmSync(path.join(root, "src-tauri/src/modules/usage.rs"), { force: true });
}

function removeUsageCapability(root, relativePath) {
  if (!existsSync(path.join(root, relativePath))) return;
  const config = readJson(root, relativePath);
  const capabilities = config.app?.security?.capabilities;
  if (Array.isArray(capabilities)) {
    config.app.security.capabilities = capabilities.filter(
      (capability) => typeof capability !== "object" || capability?.identifier !== "usage",
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

  rmSync(path.join(root, "modules/usage"), { recursive: true, force: true });
  rmSync(path.join(root, "profiles/usage-disabled"), { recursive: true, force: true });
  rmSync(path.join(root, "scripts/probe-usage.sh"), { force: true });
  rmSync(path.join(root, "scripts/update_model_pricing.py"), { force: true });
  rmSync(path.join(root, "scripts/verify-usage-frontend-disabled.mjs"), { force: true });
  rmSync(path.join(root, "scripts/tests/usageCharacterization.test.ts"), { force: true });
  rmSync(path.join(root, "scripts/tests/fixtures/usageSnapshots.json"), { force: true });

  const packageJson = readJson(root, "package.json");
  delete packageJson.dependencies["@shep/module-usage"];
  delete packageJson.scripts["test:usage-characterization"];
  delete packageJson.scripts["verify:usage-native-disabled"];
  delete packageJson.scripts["verify:usage-frontend-disabled"];
  delete packageJson.scripts["verify:usage-plugout"];
  removeNativeModuleFeatureFromScripts(packageJson, "usage-module");
  writeJson(root, "package.json", packageJson);

  removeUsageCapability(root, "src-tauri/tauri.conf.json");
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
      "@shep/module-usage",
      "shep_module_usage",
      "shep-module-usage",
      "tauri-plugin-shep-usage",
      "plugin:shep-usage",
      "shep-usage:allow",
      "usage-module",
      "shep.usage",
      "usage.global-navigation",
      "usage.sidebar",
      "usage.settings",
      "UsagePanel",
      "SidebarUsage",
      "useUsageStore",
      "useUsageSettingsStore",
    ],
    "Usage module reference remains after plug-out",
  );
}

function assertBundleAbsent(root) {
  assertNoMatches(
    root,
    ["dist"],
    [
      "@shep/module-usage",
      "plugin:shep-usage",
      "shep.usage",
      "usage.global-navigation",
      "usage-ingest-complete",
      "Usage Providers",
      "Usage unavailable",
    ],
    "Usage implementation remains in disabled bundle",
  );
}

function verifySharedSmoke(root) {
  run("pnpm", ["test:module-composition"], root);
  run("pnpm", ["test:global-surfaces"], root);
  run("pnpm", ["test:project-data"], root);
  run("pnpm", ["test:panels"], root);
  run("pnpm", ["test:terminal-sessions"], root);
  run("pnpm", ["test:module-boundaries"], root);
}

function verifyEnabled(root) {
  const cargoEnv = cargoEnvironment(root);
  run("pnpm", ["test:usage-characterization"], root);
  verifySharedSmoke(root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root, cargoEnv);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root, cargoEnv);
}

function verifyDisabled(root) {
  const cargoEnv = cargoEnvironment(root);
  verifySharedSmoke(root);
  run("pnpm", ["build"], root);
  assertBundleAbsent(root);
  run("pnpm", [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--config",
    "profiles/usage-disabled/tauri.conf.json",
    "--",
    "--no-default-features",
    "--features",
    nativeModuleFeaturesExcept("usage-module"),
  ], root, cargoEnv);
}

function verifySourceAbsent(root) {
  const cargoEnv = cargoEnvironment(root);
  verifySharedSmoke(root);
  run("pnpm", ["typecheck:panel-host-smoke"], root);
  run("pnpm", ["build"], root);
  assertBundleAbsent(root);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root, cargoEnv);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], root, cargoEnv);
}

verifyModulePlugout({
  repositoryRoot,
  moduleName: "usage",
  packages: {
    pnpm: "@shep/module-usage",
    cargo: "tauri-plugin-shep-usage",
  },
  verifyEnabled,
  prepareDisabled,
  verifyDisabled,
  prepareSourceAbsent,
  assertSourceAbsent,
  verifySourceAbsent,
  sourceAbsentOnly: process.argv.includes("--source-absent-only"),
});
