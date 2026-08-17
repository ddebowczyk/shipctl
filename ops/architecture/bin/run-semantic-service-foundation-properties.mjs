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
  "target/architecture-evidence/semantic-service-foundation",
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
const testFiles = [
  "ops/architecture/tests/semanticServiceFoundation.test.mjs",
  "ops/architecture/tests/projectDocumentsCapability.test.mjs",
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
const replayCommand = `node ops/architecture/bin/run-semantic-service-foundation-properties.mjs --seed=${seed}`;
const properties = [
  {
    propertyId: "PROP-B-BOUNDARY-001",
    testId: "architecture.plugin-imports.property",
    classifications: { owner: ["allowed", "tauri", "core", "cordis", "layman", "cross-plugin"] },
  },
  {
    propertyId: "PROP-B-ADAPTER-001",
    testId: "architecture.service-adapter.service.property",
    classifications: { outcome: ["success", "domain-error", "transport-error", "cancellation"] },
  },
  {
    propertyId: "PROP-B-FAKE-001",
    testId: "architecture.plugin-service-fake.property",
    classifications: { execution: ["headless", "fake", "disposed"] },
  },
  {
    propertyId: "PROP-B-ACTIVATION-001",
    testId: "architecture.service-activation.property",
    classifications: { activation: ["live", "disposed", "concurrent", "reuse-attempt"] },
  },
  {
    propertyId: "PROP-B-REQUEST-001",
    testId: "architecture.service-request.service.property",
    classifications: { outcome: ["denied", "cancelled", "failed", "succeeded", "retried"] },
  },
  {
    propertyId: "PROP-B-EVENT-001",
    testId: "architecture.service-event.service.property",
    classifications: { delivery: ["matching", "filtered", "disposed", "duplicate-value"] },
  },
  {
    propertyId: "PROP-B-STREAM-001",
    testId: "architecture.service-stream.semantic-terminal.property",
    classifications: { attachment: ["live", "backpressured", "replaying", "detached", "reattached"] },
  },
];

const evidenceFiles = [];
for (const property of properties) {
  const evidence = propertyEvidence({
    ...property,
    phaseId: "phase-b",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    repository,
    seed,
    replayCommand,
    result: "pass",
    deletionGates: ["DELETE-B-TAURI-EDGES"],
  });
  const file = path.join(evidenceDirectory, `${property.propertyId}.evidence.json`);
  await writePropertyEvidence({ repositoryRoot, file, evidence });
  evidenceFiles.push(path.relative(repositoryRoot, file));
}

process.stdout.write(`${JSON.stringify({ ok: true, seed, evidence_files: evidenceFiles }, null, 2)}\n`);
