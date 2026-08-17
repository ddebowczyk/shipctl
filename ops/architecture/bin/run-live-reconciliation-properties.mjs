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
  "target/architecture-evidence/live-reconciliation",
);

function configuredSeed() {
  const argument = process.argv.find((value) => value.startsWith("--seed="));
  if (argument === undefined) return randomBytes(4).readInt32LE(0);
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  return seed;
}

const seed = configuredSeed();
const environment = {
  ...process.env,
  SHIPCTL_PROPERTY_SEED: String(seed),
  PROPTEST_RNG_SEED: String(seed),
};
const testFile = "ops/architecture/tests/liveReconciliation.test.mjs";
const testArguments = ["exec", "node", "--test", "--test-concurrency=1", testFile];
const replayCommand = [
  `SHIPCTL_PROPERTY_SEED=${seed}`,
  "pnpm exec node --test --test-concurrency=1",
  testFile,
].join(" ");

const { stdout, stderr } = await exec("pnpm", testArguments, {
  cwd: repositoryRoot,
  env: environment,
});
process.stdout.write(stdout);
process.stderr.write(stderr);

const native = await exec("cargo", [
  "test",
  "-p",
  "shipctl-core",
  "module_control::live::tests::external_registry_commit_notifies_the_running_service",
  "--",
  "--exact",
], { cwd: repositoryRoot });
process.stdout.write(native.stdout);
process.stderr.write(native.stderr);

const declaredScheduleTransaction = await exec("cargo", [
  "test",
  "-p",
  "shipctl-tauri-adapter",
  "message_bridge::tests::architecture_declared_schedule_transaction_property",
  "--",
  "--exact",
], { cwd: repositoryRoot, env: environment });
process.stdout.write(declaredScheduleTransaction.stdout);
process.stderr.write(declaredScheduleTransaction.stderr);

const controlPlane = await exec("cargo", [
  "test",
  "-p",
  "shipctl-core",
  "--test",
  "live_module_control",
], { cwd: repositoryRoot });
process.stdout.write(controlPlane.stdout);
process.stderr.write(controlPlane.stderr);

await mkdir(evidenceDirectory, { recursive: true });
const repository = await repositoryIdentity(repositoryRoot);
const fastCheckVersion = require("fast-check/package.json").version;
const properties = [
  {
    propertyId: "PROP-F-RECONCILE-001",
    testId: "architecture.live-reconcile.property",
    classifications: {
      transitions: ["add", "retain", "replace", "remove", "stale", "repeated"],
      failures: ["observe", "prepare", "validate", "publish", "dispose"],
    },
  },
  {
    propertyId: "PROP-F-ATOMIC-001",
    testId: "architecture.catalog-atomicity.property",
    classifications: {
      observations: ["old-family", "new-family"],
      catalogs: ["services", "contributions", "activations"],
    },
  },
  {
    propertyId: "PROP-F-REVISION-001",
    testId: "architecture.runtime-revision.property",
    classifications: {
      notifications: ["ordered", "duplicate", "delayed", "skipped", "reordered"],
      outcome: ["monotonic", "highest-successful"],
    },
  },
  {
    propertyId: "PROP-F-CONTINUITY-001",
    testId: "architecture.terminal-plugin-continuity.property",
    classifications: {
      ownership: ["host-resource", "activation-resource"],
      transitions: ["replacement", "rejection", "disable", "remove"],
    },
  },
  {
    propertyId: "PROP-F-INSPECTION-001",
    testId: "architecture.runtime-inspection.property",
    classifications: {
      ownership: ["artifact", "activation", "contribution", "service", "effect"],
      failures: ["revision-linked", "module-linked", "activation-linked"],
    },
  },
  {
    propertyId: "PROP-F-SERVICE-001",
    testId: "architecture.service-routing.property",
    classifications: {
      providers: ["candidate", "accepted", "disposed"],
      calls: ["before-publication", "after-publication", "after-disposal"],
    },
  },
  {
    propertyId: "PROP-F-RESTART-001",
    testId: "architecture.runtime-restart.property",
    classifications: {
      recovery: ["last-good", "newer-rejected-desired", "stable-activation-identity"],
      comparison: ["live", "cold-start"],
    },
  },
  {
    propertyId: "PROP-F-SCHEDULE-ATOMIC-001",
    testId: "architecture.declared-schedule-transaction.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      candidate: ["valid", "invalid"],
      outcome: ["replace-routes-and-schedules", "retain-last-good-graph"],
    },
  },
];

const evidenceFiles = [];
for (const property of properties) {
  const evidence = propertyEvidence({
    phaseId: "phase-f",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    ...property,
    repository,
    seed,
    replayCommand,
    result: "pass",
    deletionGates: ["DELETE-F-RESTART-LIFECYCLE"],
  });
  const file = path.join(evidenceDirectory, `${property.propertyId}.evidence.json`);
  await writePropertyEvidence({ repositoryRoot, file, evidence });
  evidenceFiles.push(path.relative(repositoryRoot, file));
}

process.stdout.write(`${JSON.stringify({ ok: true, seed, evidence_files: evidenceFiles }, null, 2)}\n`);
