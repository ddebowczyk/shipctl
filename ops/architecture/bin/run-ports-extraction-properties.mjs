#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
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
  "target/architecture-evidence/ports-extraction",
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
const typescriptTests = [
  "ops/architecture/tests/processesCapability.test.mjs",
  "ops/architecture/tests/portsNativeExtraction.test.mjs",
  "modules/ports/frontend/tests/ports.test.ts",
];
const environment = {
  ...process.env,
  SHIPCTL_PROPERTY_SEED: String(seed),
  PROPTEST_RNG_SEED: String(seed),
};

const typescript = await exec("pnpm", [
  "exec",
  "node",
  "--test",
  "--test-concurrency=1",
  ...typescriptTests,
], { cwd: repositoryRoot, env: environment });
process.stdout.write(typescript.stdout);
process.stderr.write(typescript.stderr);

const rust = await exec("cargo", [
  "test",
  "-p",
  "shipctl-core",
  "--no-fail-fast",
  "architecture_provider_processes_",
  "--",
  "--nocapture",
], { cwd: repositoryRoot, env: environment });
process.stdout.write(rust.stdout);
process.stderr.write(rust.stderr);

await mkdir(evidenceDirectory, { recursive: true });
const repository = await repositoryIdentity(repositoryRoot);
const fastCheckVersion = require("fast-check/package.json").version;
const replayCommand = `node ops/architecture/bin/run-ports-extraction-properties.mjs --seed=${seed}`;
const properties = [
  {
    propertyId: "PROP-D-PARITY-001",
    testId: "architecture.provider.processes.parity.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      capability: ["processes"],
      pilot: ["ports"],
      outcomes: ["projection", "identity", "ordering"],
    },
  },
  {
    propertyId: "PROP-D-AUTHORITY-001",
    testId: "architecture.provider.processes.authority.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      capability: ["processes"],
      authorization: ["allowed", "unknown", "disposed", "grant-denied"],
    },
  },
  {
    propertyId: "PROP-D-OWNERSHIP-001",
    testId: "architecture.provider.processes.ownership.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      capability: ["processes"],
      ownership: ["activation-lease", "host-process"],
    },
  },
  {
    propertyId: "PROP-D-CLOSURE-001",
    testId: "architecture.native-extraction-closure.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      pilot: ["ports"],
      edges: ["native-authority", "feature-policy", "rust", "cargo", "tauri", "acl", "private-command"],
    },
  },
];

const evidenceFiles = [];
for (const property of properties) {
  const evidence = propertyEvidence({
    ...property,
    phaseId: "phase-d",
    repository,
    seed,
    replayCommand,
    result: "pass",
    deletionGates: ["DELETE-D-NATIVE-MODULE"],
  });
  const file = path.join(evidenceDirectory, `${property.propertyId}.evidence.json`);
  await writePropertyEvidence({ repositoryRoot, file, evidence });
  evidenceFiles.push(path.relative(repositoryRoot, file));
}

process.stdout.write(`${JSON.stringify({ ok: true, seed, evidence_files: evidenceFiles }, null, 2)}\n`);
