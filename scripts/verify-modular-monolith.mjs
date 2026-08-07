#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./lib/module-plugout.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const gateTimeout = { timeoutMs: 60 * 60 * 1000 };

for (const script of [
  "check:module-profiles",
  "test:module-boundaries",
  "test:module-composition",
  "test:panels",
  "test:terminal-sessions",
]) {
  run("pnpm", [script], root);
}

run("pnpm", ["build"], root);
run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], root);

for (const verifier of [
  "verify:module-fixture-plugout",
  "verify:todos-plugout",
  "verify:ports-plugout",
  "verify:skills-plugout",
  "verify:git-plugout",
  "verify:commands-plugout",
  "verify:assistants-plugout",
  "verify:usage-plugout",
]) {
  run("pnpm", [verifier], root, {}, gateTimeout);
}

process.stdout.write("\nModular-monolith master verification: OK\n");
