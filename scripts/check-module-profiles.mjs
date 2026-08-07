#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { NATIVE_MODULE_FEATURES } from "./lib/module-plugout.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const modules = NATIVE_MODULE_FEATURES.map((feature) => ({
  id: feature.slice(0, -"-module".length),
  feature,
}));

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
  }
}

const tauriConfig = await readJson("src-tauri/tauri.conf.json");
const defaultCapabilities = tauriConfig.app.security.capabilities;
const capabilityIds = defaultCapabilities.map((capability) =>
  typeof capability === "string" ? capability : capability.identifier,
);
assertEqual(
  capabilityIds,
  ["default", ...modules.map(({ id }) => id)],
  "Default Tauri capabilities must match the native module catalogue",
);

const cargoManifest = await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8");
const defaultFeatureMatch = cargoManifest.match(/^default = (\[[^\n]+\])$/m);
if (!defaultFeatureMatch) throw new Error("Could not read the host default feature list");
assertEqual(
  JSON.parse(defaultFeatureMatch[1]),
  NATIVE_MODULE_FEATURES,
  "Cargo default features must match the native module catalogue",
);

const packageJson = await readJson("package.json");

for (const { id, feature } of modules) {
  const expectedModules = modules.filter((candidate) => candidate.id !== id);
  const expectedCapabilities = [
    "default",
    ...defaultCapabilities.filter((capability) =>
      typeof capability !== "string" && capability.identifier !== id,
    ),
  ];
  const profile = await readJson(`profiles/${id}-disabled/tauri.conf.json`);
  assertEqual(
    profile.app.security.capabilities,
    expectedCapabilities,
    `${id}-disabled capabilities drifted from the default profile`,
  );

  const scriptName = `verify:${id}-native-disabled`;
  const command = packageJson.scripts[scriptName];
  if (!command) throw new Error(`Missing package script ${scriptName}`);
  const featureMatch = command.match(/--features ([^\s]+)/);
  if (!featureMatch) throw new Error(`${scriptName} has no explicit feature list`);
  assertEqual(
    featureMatch[1].split(","),
    expectedModules.map((candidate) => candidate.feature),
    `${scriptName} must enable every non-target module`,
  );
  if (!command.includes(`CARGO_TARGET_DIR="$PWD/target/${id}-native-disabled"`)) {
    throw new Error(`${scriptName} must use an isolated Cargo target directory`);
  }

  const plugout = await readFile(path.join(root, `scripts/verify-${id}-plugout.mjs`), "utf8");
  if (!plugout.includes(`nativeModuleFeaturesExcept("${feature}")`)) {
    throw new Error(`${id} plug-out verifier does not derive its peer feature list`);
  }
}

// A relative CARGO_TARGET_DIR resolves against the Tauri CLI's working directory,
// which is src-tauri/ — producing a second build tree at src-tauri/src-tauri/target.
// The scripts above are asserted to pass an absolute path; this catches a rerun that
// slipped through anyway.
if (existsSync(path.join(root, "src-tauri/src-tauri"))) {
  throw new Error(
    "src-tauri/src-tauri exists: a build wrote outside the workspace target directory",
  );
}

process.stdout.write("Native module features, permissions, and disabled profiles: OK\n");
