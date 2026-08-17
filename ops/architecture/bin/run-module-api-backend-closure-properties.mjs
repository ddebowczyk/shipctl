#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  propertyEvidence,
  repositoryIdentity,
  writePropertyEvidence,
} from "./property-evidence.mjs";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const evidenceDirectory = path.join(
  repositoryRoot,
  "target/architecture-evidence/module-api-backend-closure",
);

function configuredSeed() {
  const argument = process.argv.find((value) => value.startsWith("--seed="));
  if (argument === undefined) return randomBytes(4).readUInt32LE(0) & 0x7fff_ffff;
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("--seed must be a non-negative safe integer");
  }
  return seed;
}

const seed = configuredSeed();
const testFile = "ops/architecture/tests/moduleApiBackendClosure.test.mjs";
const { stdout, stderr } = await exec("pnpm", [
  "exec",
  "node",
  "--test",
  "--test-concurrency=1",
  testFile,
], {
  cwd: repositoryRoot,
  env: { ...process.env, SHIPCTL_PROPERTY_SEED: String(seed) },
});
process.stdout.write(stdout);
process.stderr.write(stderr);

const repository = await repositoryIdentity(repositoryRoot);
const evidence = propertyEvidence({
  propertyId: "PROP-H-NATIVE-CLOSURE-001",
  testId: "architecture.module-api-backend-closure.property",
  phaseId: "phase-h",
  language: "typescript",
  library: "fast-check",
  version: require("fast-check/package.json").version,
  repository,
  seed,
  classifications: {
    edge: ["module-cargo-manifest", "module-rust-source", "compatibility-cargo-edge", "compatibility-import", "core-owner"],
  },
  replayCommand: `node ops/architecture/bin/run-module-api-backend-closure-properties.mjs --seed=${seed}`,
  result: "pass",
  deletionGates: ["DELETE-H-COMPATIBILITY"],
});
const file = path.join(evidenceDirectory, "PROP-H-NATIVE-CLOSURE-001.evidence.json");
await writePropertyEvidence({ repositoryRoot, file, evidence });

process.stdout.write(`${JSON.stringify({
  ok: true,
  seed,
  evidence_files: [path.relative(repositoryRoot, file)],
}, null, 2)}\n`);
