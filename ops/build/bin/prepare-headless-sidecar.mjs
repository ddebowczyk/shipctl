#!/usr/bin/env node

import { execFile } from "node:child_process";
import { copyFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as esbuild from "esbuild";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const source = path.join(repositoryRoot, "ops/build/headless-runtime/runner.ts");
const generatedRoot = path.join(repositoryRoot, "src-tauri/generated");
const program = path.join(generatedRoot, "shipctl-headless-runtime.mjs");
const binariesRoot = path.join(repositoryRoot, "src-tauri/binaries");

async function targetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const { stdout } = await exec("rustc", ["-vV"], { cwd: repositoryRoot });
  const match = /^host: (.+)$/m.exec(stdout);
  if (!match) throw new Error("Could not determine the Rust target triple.");
  return match[1];
}

function expectedNodeArchitecture(target) {
  if (target.startsWith("aarch64-apple-")) return "arm64";
  if (target.startsWith("x86_64-apple-")) return "x86_64";
  throw new Error(`The bundled headless runtime supports macOS targets only: ${target}`);
}

async function verifyNodeArchitecture(target) {
  const expected = expectedNodeArchitecture(target);
  const { stdout } = await exec("lipo", ["-archs", process.execPath]);
  const architectures = stdout.trim().split(/\s+/);
  if (!architectures.includes(expected)) {
    throw new Error(
      `Node runtime ${process.execPath} lacks ${expected} required by ${target}: ${architectures.join(" ")}`,
    );
  }
}

const target = await targetTriple();
await verifyNodeArchitecture(target);
await mkdir(generatedRoot, { recursive: true });
await mkdir(binariesRoot, { recursive: true });
await esbuild.build({
  absWorkingDir: repositoryRoot,
  bundle: true,
  entryPoints: [source],
  format: "esm",
  outfile: program,
  platform: "node",
  target: `node${process.versions.node.split(".")[0]}`,
});

const runtime = path.join(binariesRoot, `shipctl-runtime-${target}`);
await copyFile(process.execPath, runtime);
await chmod(runtime, 0o755);

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  operation: "build.prepare-headless-sidecar",
  status: "success",
  target,
  nodeVersion: process.version,
  runtime,
  program,
})}\n`);
