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
  if (argument === undefined) return randomBytes(4).readUInt32LE(0) & 0x7fff_ffff;
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("--seed must be a non-negative safe integer");
  }
  return seed;
}

const seed = configuredSeed();
const replayCommand = `node ops/architecture/bin/run-usage-sources-properties.mjs --seed=${seed}`;
const environment = {
  ...process.env,
  SHIPCTL_PROPERTY_SEED: String(seed),
  PROPTEST_RNG_SEED: String(seed),
};

const { stdout, stderr } = await exec("pnpm", [
  "exec",
  "node",
  "--test",
  "--test-concurrency=1",
  "ops/architecture/tests/usageSourcesCapability.test.mjs",
  "modules/usage/frontend/tests/ingestCompleted.test.ts",
  "modules/usage/frontend/tests/usageCharacterization.test.ts",
], {
  cwd: repositoryRoot,
  env: environment,
});
process.stdout.write(stdout);
process.stderr.write(stderr);

const rust = await exec("cargo", [
  "test",
  "-p",
  "shipctl-core",
  "--no-fail-fast",
  "architecture_provider_usage_sources_",
  "--",
  "--nocapture",
], { cwd: repositoryRoot, env: environment });
process.stdout.write(rust.stdout);
process.stderr.write(rust.stderr);

await mkdir(evidenceDirectory, { recursive: true });
const repository = await repositoryIdentity(repositoryRoot);
const fastCheckVersion = require("fast-check/package.json").version;
const properties = [
  {
    propertyId: "PROP-B-ADAPTER-001",
    testId: "architecture.usage-sources-authority.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      operations: ["inspect-source", "refresh-sources"],
      outcomes: ["success", "stable-redacted-error", "invalid-request"],
    },
  },
  {
    propertyId: "PROP-B-REQUEST-001",
    testId: "architecture.usage-sources-authority.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      outcomes: ["success", "invalid-request", "transport-failed"],
      dispatch: ["scoped", "suppressed"],
    },
  },
  {
    propertyId: "PROP-B-ACTIVATION-001",
    testId: "architecture.usage-sources-authority.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      activation: ["exact", "released-on-disposal"],
      correlation: ["exact"],
    },
  },
  {
    propertyId: "PROP-B-EVENT-001",
    testId: "architecture.usage-sources-ownership.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["activation-leased", "subscription-disposed"],
      scope: ["approved-source"],
    },
  },
  {
    propertyId: "PROP-B-FAKE-001",
    testId: "architecture.usage-sources-ownership.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      implementation: ["headless", "tauri-free"],
      workflow: ["inspect", "refresh", "subscribe"],
    },
  },
  {
    propertyId: "PROP-D-PARITY-001",
    testId: "architecture.provider.usage-sources.parity.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      policy: ["pricing", "aggregation", "rollup-deduplication", "alias-review"],
      projections: ["snapshots", "overview"],
    },
  },
  {
    propertyId: "PROP-D-AUTHORITY-001",
    testId: "architecture.provider.usage-sources.authority.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      authority: ["native-source", "native-credential", "native-process", "native-storage"],
      outcomes: ["scoped", "invalid", "redacted", "released"],
    },
  },
  {
    propertyId: "PROP-D-OWNERSHIP-001",
    testId: "architecture.provider.usage-sources.ownership.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      ownership: ["typescript-policy", "rust-authority", "tauri-free-module"],
      harness: ["public-fake", "headless"],
    },
  },
  {
    propertyId: "PROP-D-CLOSURE-001",
    testId: "architecture.usage-sources-closure.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      deletion_gate: ["DELETE-D-NATIVE-MODULE"],
      absent: ["rust-module", "cargo-feature", "tauri-plugin", "acl"],
    },
  },
];

const evidenceFiles = [];
for (const property of properties) {
  const evidence = propertyEvidence({
    ...property,
    phaseId: property.propertyId.startsWith("PROP-B-") ? "phase-b" : "phase-d",
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
