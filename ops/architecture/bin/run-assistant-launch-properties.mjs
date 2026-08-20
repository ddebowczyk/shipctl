#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
const evidenceDirectory = path.join(repositoryRoot, "target/architecture-evidence/assistant-launch");

function configuredSeed() {
  const argument = process.argv.find((value) => value.startsWith("--seed="));
  if (argument === undefined) return randomBytes(4).readInt32LE(0);
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  return seed;
}

const seed = configuredSeed();
const replayCommand = `node ops/architecture/bin/run-assistant-launch-properties.mjs --seed=${seed}`;
const { stdout, stderr } = await exec("pnpm", [
  "exec",
  "node",
  "--test",
  "--test-concurrency=1",
  "ops/architecture/tests/assistantLaunchCapability.test.mjs",
  "ops/architecture/tests/assistantCaptureMeasurement.test.mjs",
  "modules/assistants/frontend/tests/assistantsCharacterization.test.ts",
  "modules/assistants/frontend/tests/assistantProvidersCharacterization.test.ts",
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
    testId: "architecture.service-adapter.assistant-launch.property",
    classifications: {
      outcomes: ["success", "stable-error", "private-identity-redacted"],
      attribution: ["activation", "correlation"],
    },
  },
  {
    propertyId: "PROP-B-REQUEST-001",
    testId: "architecture.service-request.assistant-launch.property",
    classifications: {
      outcomes: ["invalid", "cancelled", "denied", "disposed"],
      dispatch: ["suppressed"],
    },
  },
  {
    propertyId: "PROP-B-ACTIVATION-001",
    testId: "architecture.service-request.assistant-launch.property",
    classifications: {
      activation: ["live-exact", "disposed-rejected"],
      grants: ["launch", "session-record"],
    },
  },
  {
    propertyId: "PROP-B-EVENT-001",
    testId: "architecture.service-event.assistant-launch.property",
    classifications: {
      delivery: ["ordered", "leased", "disposed"],
      scope: ["session", "project"],
    },
  },
  {
    propertyId: "PROP-B-FAKE-001",
    testId: "architecture.assistant-launch-service-fake.property",
    classifications: {
      workflow: ["launch", "capture", "placement", "shutdown", "resume"],
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
