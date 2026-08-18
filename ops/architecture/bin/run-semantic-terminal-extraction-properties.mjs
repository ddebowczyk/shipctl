#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
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
  "target/architecture-evidence/semantic-terminal-extraction",
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
const moduleTestRoot = "modules/semantic-terminal/frontend/tests";
const moduleTests = (await readdir(path.join(repositoryRoot, moduleTestRoot)))
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => path.join(moduleTestRoot, file));
const typescriptTests = [
  "ops/architecture/tests/semanticTerminalsCapability.test.mjs",
  "ops/architecture/tests/semanticTerminalNativeExtraction.test.mjs",
  "core/frontend/platform/tests/semanticTerminals.test.ts",
  ...moduleTests,
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
  "architecture_provider_semantic_terminal_",
  "--",
  "--nocapture",
], { cwd: repositoryRoot, env: environment });
process.stdout.write(rust.stdout);
process.stderr.write(rust.stderr);

await mkdir(evidenceDirectory, { recursive: true });
const repository = await repositoryIdentity(repositoryRoot);
const fastCheckVersion = require("fast-check/package.json").version;
const replayCommand = `node ops/architecture/bin/run-semantic-terminal-extraction-properties.mjs --seed=${seed}`;
const properties = [
  {
    propertyId: "PROP-D-PARITY-001",
    testId: "architecture.provider.semantic-terminal.parity.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      capability: ["semantic-terminal"],
      outcomes: ["snapshot", "input", "history", "selection"],
    },
  },
  {
    propertyId: "PROP-D-AUTHORITY-001",
    testId: "architecture.provider.semantic-terminal.authority.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      capability: ["semantic-terminal"],
      authorization: ["allowed", "unknown", "disposed", "terminal-driver-denied"],
    },
  },
  {
    propertyId: "PROP-D-OWNERSHIP-001",
    testId: "architecture.provider.semantic-terminal.ownership.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      capability: ["semantic-terminal"],
      ownership: ["activation-attachment", "host-terminal"],
    },
  },
  {
    propertyId: "PROP-D-CLOSURE-001",
    testId: "architecture.semantic-terminal-native-extraction-closure.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      pilot: ["semantic-terminal"],
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
