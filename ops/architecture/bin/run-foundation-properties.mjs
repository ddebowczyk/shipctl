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
const evidenceDirectory = path.join(repositoryRoot, "target/architecture-evidence/foundation");

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
const testFiles = [
  "ops/architecture/tests/checkSpec.test.mjs",
  "ops/architecture/tests/passiveImport.test.mjs",
  "ops/architecture/tests/architectureBaseline.test.mjs",
  "ops/architecture/tests/propertyReplay.test.mjs",
];
const { stdout, stderr } = await exec("pnpm", [
  "exec",
  "node",
  "--test",
  "--test-concurrency=1",
  ...testFiles,
], {
  cwd: repositoryRoot,
  env: { ...process.env, SHIPCTL_PROPERTY_SEED: String(seed) },
});
process.stdout.write(stdout);
process.stderr.write(stderr);

const repository = await repositoryIdentity(repositoryRoot);
const fastCheckVersion = require("fast-check/package.json").version;
const replayCommand = `node ops/architecture/bin/run-foundation-properties.mjs --seed=${seed}`;
const properties = [
  {
    propertyId: "PROP-A-SPEC-001",
    testId: "architecture.spec.graph.property",
    classifications: { graph: ["valid", "unresolved", "cyclic", "duplicate", "uncovered"] },
  },
  {
    propertyId: "PROP-A-IMPORT-001",
    testId: "architecture.plugin.passive-import.property",
    classifications: { effect: ["passive", "filesystem", "network", "timer", "registry", "tauri"] },
  },
  {
    propertyId: "PROP-A-COMPOSITION-001",
    testId: "architecture.module-composition.property",
    classifications: { ownership: ["unique", "duplicate-same-kind", "duplicate-cross-kind"] },
  },
  {
    propertyId: "PROP-A-REPLAY-001",
    testId: "architecture.property-replay.property",
    classifications: { runner: ["typescript", "rust"], outcome: ["identity-mismatch", "replay-match"] },
  },
];

const evidenceFiles = [];
for (const property of properties) {
  const evidence = propertyEvidence({
    ...property,
    phaseId: "phase-a",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    repository,
    seed,
    replayCommand,
    result: "pass",
  });
  const file = path.join(evidenceDirectory, `${property.propertyId}.evidence.json`);
  await writePropertyEvidence({ repositoryRoot, file, evidence });
  evidenceFiles.push(path.relative(repositoryRoot, file));
}

process.stdout.write(`${JSON.stringify({ ok: true, seed, evidence_files: evidenceFiles }, null, 2)}\n`);
