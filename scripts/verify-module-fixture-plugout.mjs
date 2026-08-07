#!/usr/bin/env node

// Run the complete enabled/disabled/source-absent matrix by default. During
// development, pass --source-absent-only to exercise only the disposable copy.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryPrefix = path.join(os.tmpdir(), "shep-fixture-plugout-");

function run(command, args, cwd = repositoryRoot) {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function capture(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} exited with status ${result.status}`);
  }
  return result.stdout;
}

function replaceOnce(root, relativePath, expected, replacement) {
  const file = path.join(root, relativePath);
  const source = readFileSync(file, "utf8");
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`Expected one plug-out marker in ${relativePath}`);
  }
  writeFileSync(file, source.replace(expected, replacement));
}

function exportHead(destination) {
  const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], {
    cwd: repositoryRoot,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.error) throw archive.error;
  if (archive.status !== 0) {
    throw new Error(archive.stderr.toString() || "git archive failed");
  }

  const extract = spawnSync("tar", ["-xf", "-", "-C", destination], {
    input: archive.stdout,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) {
    throw new Error(extract.stderr.toString() || "archive extraction failed");
  }
}

function removeFixtureComposition(root) {
  for (const relativePath of [
    "modules/fixture",
    "profiles/fixture",
    "scripts/smoke/module-fixture",
  ]) {
    rmSync(path.join(root, relativePath), { recursive: true, force: true });
  }

  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  delete packageJson.scripts["build:module-fixture"];
  delete packageJson.scripts["smoke:module-fixture"];
  delete packageJson.scripts["verify:module-fixture-plugout"];
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'fixture-module = ["dep:shep-module-fixture"]\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/Cargo.toml",
    'shep-module-fixture = { package = "tauri-plugin-shep-fixture", path = "../modules/fixture/backend", optional = true }\n',
    "",
  );
  replaceOnce(
    root,
    "src-tauri/src/modules/mod.rs",
    '    #[cfg(feature = "fixture-module")]\n    let builder = builder.plugin(shep_module_fixture::init());\n\n',
    "",
  );
}

function assertFixtureImplementationAbsent(root) {
  const result = spawnSync(
    "rg",
    [
      "-n",
      "shep_module_fixture|shep-module-fixture|tauri-plugin-shep-fixture|@shep/module-fixture",
      "src",
      "src-tauri/src",
      "src-tauri/Cargo.toml",
      "package.json",
      "Cargo.toml",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error(`Fixture implementation reference remains after plug-out:\n${result.stdout}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || `rg exited with status ${result.status}`);
  }
}

function assertFixtureDependencyGraphsAbsent(root) {
  const pnpmPackages = JSON.parse(
    capture("pnpm", ["--recursive", "list", "--depth", "-1", "--json"], root),
  );
  const pnpmFixture = pnpmPackages.find(
    (workspacePackage) => workspacePackage.name === "@shep/module-fixture",
  );
  if (pnpmFixture) {
    throw new Error("Fixture remains in the pnpm workspace graph after plug-out");
  }

  const cargoMetadata = JSON.parse(
    capture(
      "cargo",
      ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", "src-tauri/Cargo.toml"],
      root,
    ),
  );
  const cargoFixture = cargoMetadata.packages.find(
    (workspacePackage) => workspacePackage.name === "tauri-plugin-shep-fixture",
  );
  if (cargoFixture) {
    throw new Error("Fixture remains in the Cargo workspace graph after plug-out");
  }
}

function verifySourcePresentProfiles() {
  run("pnpm", ["test:module-composition"]);
  run("pnpm", ["tauri", "build", "--debug", "--no-bundle"]);
  run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"]);
  run("pnpm", [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--features",
    "fixture-module",
    "--config",
    "profiles/fixture/tauri.conf.json",
  ]);
  run("cargo", [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--features",
    "fixture-module",
  ]);
}

function verifySourceAbsentProfile() {
  const temporaryRoot = mkdtempSync(temporaryPrefix);
  try {
    exportHead(temporaryRoot);
    removeFixtureComposition(temporaryRoot);
    assertFixtureImplementationAbsent(temporaryRoot);

    const sharedTarget = path.join(repositoryRoot, "target");
    if (existsSync(sharedTarget)) {
      symlinkSync(sharedTarget, path.join(temporaryRoot, "target"), "dir");
    }
    run("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], temporaryRoot);
    assertFixtureDependencyGraphsAbsent(temporaryRoot);
    run("pnpm", ["build"], temporaryRoot);
    run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], temporaryRoot);
    run("pnpm", ["tauri", "build", "--debug", "--no-bundle"], temporaryRoot);
  } finally {
    if (!temporaryRoot.startsWith(temporaryPrefix)) {
      throw new Error(`Refusing to remove unexpected path: ${temporaryRoot}`);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const discoveredRoot = path.resolve(capture("git", ["rev-parse", "--show-toplevel"]).trim());
if (discoveredRoot !== repositoryRoot) {
  throw new Error(`Expected repository root ${repositoryRoot}, found ${discoveredRoot}`);
}
if (!process.argv.includes("--source-absent-only")) {
  verifySourcePresentProfiles();
}
verifySourceAbsentProfile();
process.stdout.write("\nFixture enabled, disabled, and source-absent profiles: OK\n");
