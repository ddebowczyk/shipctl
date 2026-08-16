#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
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
  "target/architecture-evidence/usage-sources",
);

function configuredSeed() {
  const argument = process.argv.find((value) => value.startsWith("--seed="));
  if (argument === undefined) return randomBytes(4).readInt32LE(0);
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  return seed;
}

const seed = configuredSeed();
const replayCommand = [
  `SHIPCTL_PROPERTY_SEED=${seed}`,
  "pnpm exec node --test --test-concurrency=1",
  "ops/architecture/tests/usageSourcesCapability.test.mjs",
].join(" ");

const { stdout, stderr } = await exec("pnpm", [
  "exec",
  "node",
  "--test",
  "--test-concurrency=1",
  "ops/architecture/tests/usageSourcesCapability.test.mjs",
], {
  cwd: repositoryRoot,
  env: { ...process.env, SHIPCTL_PROPERTY_SEED: String(seed) },
});
process.stdout.write(stdout);
process.stderr.write(stderr);

await mkdir(evidenceDirectory, { recursive: true });
const repository = await repositoryIdentity(repositoryRoot);
const fastCheckVersion = require("fast-check/package.json").version;
const properties = [
  {
    propertyId: "PROP-B-ADAPTER-001",
    testId: "architecture.service-adapter.usage-sources.property",
    classifications: {
      operations: ["source-snapshots", "legacy-overview-projection"],
      outcomes: ["success", "redacted", "stable-error"],
    },
  },
  {
    propertyId: "PROP-B-REQUEST-001",
    testId: "architecture.service-request.usage-sources.property",
    classifications: {
      outcomes: ["invalid", "denied", "cancelled", "success", "disposed"],
      dispatch: ["suppressed", "exactly-once"],
    },
  },
  {
    propertyId: "PROP-B-ACTIVATION-001",
    testId: "architecture.service-request.usage-sources.property",
    classifications: {
      activation: ["live-exact", "disposed-rejected"],
      correlation: ["exact"],
    },
  },
  {
    propertyId: "PROP-B-EVENT-001",
    testId: "architecture.service-event.usage-sources.property",
    classifications: {
      delivery: ["matching", "filtered", "ordered", "disposed"],
      activation: ["live-exact"],
    },
  },
  {
    propertyId: "PROP-B-FAKE-001",
    testId: "architecture.usage-sources-service-fake.property",
    classifications: {
      operations: ["inspect", "refresh", "observe"],
      transport: ["headless", "tauri-free"],
    },
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
  });
  const file = path.join(evidenceDirectory, `${property.propertyId}.evidence.json`);
  await writePropertyEvidence({ repositoryRoot, file, evidence });
  evidenceFiles.push(path.relative(repositoryRoot, file));
}

process.stdout.write(`${JSON.stringify({ ok: true, seed, evidence_files: evidenceFiles }, null, 2)}\n`);
