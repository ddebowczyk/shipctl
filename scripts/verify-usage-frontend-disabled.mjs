#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = spawnSync("pnpm", ["build"], {
  cwd: repositoryRoot,
  env: { ...process.env, VITE_SHEP_USAGE_MODULE: "disabled" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Usage-disabled frontend build exited with status ${result.status}`);
}

const implementation = spawnSync(
  "rg",
  [
    "-n",
    "Usage Providers|usage.global-navigation|usage-ingest-complete|usage.snapshots-after-startup|Usage unavailable",
    "dist",
  ],
  { cwd: repositoryRoot, encoding: "utf8" },
);
if (implementation.error) throw implementation.error;
if (implementation.status === 0) {
  throw new Error(`Usage implementation remains in disabled bundle:\n${implementation.stdout}`);
}
if (implementation.status !== 1) {
  throw new Error(implementation.stderr || `rg exited with status ${implementation.status}`);
}

process.stdout.write("\nUsage-disabled frontend composition: OK\n");
