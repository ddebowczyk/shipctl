#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildPluginArtifactStaging } from "../lib/plugin-artifact-build.mjs";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const sourceDirectory = path.resolve(
  repositoryRoot,
  option("--source") ?? "ops/architecture/fixtures/plugin-artifacts/headless-service",
);
const outputArgument = option("--to");
assert.ok(outputArgument, "Usage: build-plugin-artifact.mjs [--source DIR] --to FILE [--shipctl FILE]");
const outputPath = path.resolve(process.cwd(), outputArgument);
const shipctlPath = path.resolve(
  repositoryRoot,
  option("--shipctl") ?? "target/debug/shipctl",
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "shipctl-plugin-artifact-"));

try {
  const stagingDirectory = path.join(temporaryRoot, "staging");
  const buildReport = await buildPluginArtifactStaging({ sourceDirectory, stagingDirectory });
  await mkdir(path.dirname(outputPath), { recursive: true });
  const packaged = await exec(shipctlPath, [
    "modules",
    "pack",
    stagingDirectory,
    "--to",
    outputPath,
    "--output",
    "json",
  ], { cwd: repositoryRoot });
  assert.equal(packaged.stderr, "", "Artifact pack diagnostics must use structured stdout");
  const packageReport = JSON.parse(packaged.stdout);
  assert.equal(packageReport.status, "success");
  assert.equal(packageReport.code, "module.artifact.packed");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    operation: "architecture.plugin_artifact.build",
    status: "success",
    data: { build: buildReport, package: packageReport.data },
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
