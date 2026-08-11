#!/usr/bin/env node
/**
 * No scenario entry point survives a release build.
 *
 * The packaged-app scenario harness runs inside the shipped webview, which is
 * the only engine whose answers count for area 04's font, renderer and
 * measurement criteria. The cost of that choice is a new surface in the app, and area 05
 * completes on deletion plus durable negative proof — so the harness has to be
 * provably absent from what ships, or the cutover trades a second VT for a
 * second entry point.
 *
 * The guard is `import.meta.env.DEV` in
 * `core/frontend/terminal/scenarios/terminalScenarioEntry.ts`, which Vite folds
 * to a literal so Rollup drops the branch and the dynamic import beneath it.
 * That is reasoning; this is the check.
 *
 *   node ops/check/bin/check-release-bundle.mjs
 *
 * Every marker is asserted to exist in the source tree first. A check that
 * looked for strings nobody writes any more would pass while proving nothing,
 * and a rename is the likeliest way for that to happen.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Strings that exist only because the harness does.
 *
 * Each names something a release bundle must not contain: the global it
 * installs under, the composition root that drives a live terminal, the
 * NDJSON record kinds, and the scenarios themselves.
 */
const FORBIDDEN_MARKERS = [
  "__shipctlTerminalScenarios",
  "runTerminalScenarios",
  "scenario-begin",
  "renderer.primary-failure",
  "automatic Canvas2D renderer recreation failed",
  "sustained output line",
];

/** Where each marker must still be findable, so a rename fails loudly. */
const SOURCE_ROOTS = ["core/frontend/terminal"];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath)));
    else if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

async function bundleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await bundleFiles(entryPath)));
    else if (entry.isFile() && /\.(js|mjs|cjs|html|css|map)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

async function markersPresentInSource() {
  const files = (
    await Promise.all(SOURCE_ROOTS.map((root) => sourceFiles(path.join(repositoryRoot, root))))
  ).flat();
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const joined = contents.join("\n");
  return FORBIDDEN_MARKERS.filter((marker) => !joined.includes(marker));
}

async function main() {
  const stale = await markersPresentInSource();
  if (stale.length > 0) {
    console.error(
      "Release bundle check is misconfigured: these markers no longer appear in "
        + `${SOURCE_ROOTS.join(", ")}, so scanning for them proves nothing:\n  `
        + stale.join("\n  "),
    );
    process.exit(2);
  }

  const outDir = await mkdtemp(path.join(os.tmpdir(), "shipctl-release-bundle-"));
  try {
    const build = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"],
      { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (build.status !== 0) {
      console.error(`Release build failed:\n${build.stderr || build.stdout}`);
      process.exit(1);
    }

    const files = await bundleFiles(outDir);
    if (files.length === 0) {
      console.error(`Release build produced no files in ${outDir}`);
      process.exit(1);
    }

    const violations = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      for (const marker of FORBIDDEN_MARKERS) {
        if (contents.includes(marker)) {
          violations.push(`${path.basename(file)}: ${marker}`);
        }
      }
    }

    if (violations.length > 0) {
      console.error(
        "Scenario harness reached the release bundle:\n  "
          + violations.join("\n  ")
          + "\n\nThe dev guard must stay a bare `import.meta.env.DEV` test so the "
          + "bundler can fold it; a function call around it will not fold.",
      );
      process.exit(1);
    }

    console.log(
      `Release bundle: OK (${files.length} files, no scenario entry point)`,
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

await main();
