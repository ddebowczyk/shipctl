#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = spawnSync("pnpm", ["build"], {
  cwd: repositoryRoot,
  env: { ...process.env, VITE_SHEP_GIT_MODULE: "disabled" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Git-disabled frontend build exited with status ${result.status}`);
}

process.stdout.write("\nGit-disabled frontend composition: OK\n");
