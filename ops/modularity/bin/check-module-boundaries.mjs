#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import {
  checkModuleBoundaries,
  formatDiagnostics,
} from "../lib/module-boundaries.mjs";

export * from "../lib/module-boundaries.mjs";

const root = path.resolve(process.argv[2] ?? process.cwd());
const diagnostics = await checkModuleBoundaries(root);
if (diagnostics.length > 0) {
  console.error(`Frontend module boundary violations:\n${formatDiagnostics(diagnostics)}`);
  process.exitCode = 1;
} else {
  console.log("Frontend module boundaries: OK");
}
