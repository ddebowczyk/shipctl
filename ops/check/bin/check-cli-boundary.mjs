#!/usr/bin/env node
/**
 * Keep the standalone CLI independent from Tauri and the WebKit runtime.
 *
 * `shipctl` and `shipctl-ui` ship in one macOS app bundle, but they are
 * separate Rust executables. The CLI may use `shipctl-core`; the UI alone may
 * use `shipctl-tauri-adapter` and Tauri. Check both dependency closures so a
 * later optional feature cannot silently join them again.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const forbiddenPackages = new Set(["tauri", "tauri-runtime", "tauri-runtime-wry", "wry"]);

function fail(message) {
  console.error(`CLI boundary: ${message}`);
  process.exit(1);
}

function dependencyTree(packageName) {
  const result = spawnSync(
    "cargo",
    ["tree", "-p", packageName, "--edges", "normal,build", "--prefix", "none"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`could not inspect ${packageName}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function forbiddenDependencies(tree) {
  return tree
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((packageName) => forbiddenPackages.has(packageName));
}

function main() {
  const coreManifest = readFileSync(
    path.join(repositoryRoot, "core/backend/Cargo.toml"),
    "utf8",
  );
  if (/^\s*(tauri|tauri-runtime|tauri-runtime-wry|wry)\s*=/m.test(coreManifest)) {
    fail("core/backend/Cargo.toml directly declares a desktop runtime dependency");
  }

  for (const packageName of ["shipctl-core", "shipctl-cli"]) {
    const forbidden = forbiddenDependencies(dependencyTree(packageName));
    if (forbidden.length > 0) {
      fail(`${packageName} depends on ${[...new Set(forbidden)].join(", ")}`);
    }
  }

  console.log("CLI boundary: OK (core and CLI exclude Tauri and Wry)");
}

main();
