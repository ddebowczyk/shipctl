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
const evidenceDirectory = path.join(repositoryRoot, "target/architecture-evidence/messages");

function configuredSeed() {
  const argument = process.argv.find((value) => value.startsWith("--seed="));
  if (argument === undefined) return randomBytes(4).readInt32LE(0);
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  return seed;
}

const seed = configuredSeed();
const testFile = "ops/architecture/tests/messagesCapability.test.mjs";
const testArguments = ["exec", "node", "--test", "--test-concurrency=1", testFile];
const replayCommand = [
  `SHIPCTL_PROPERTY_SEED=${seed}`,
  "pnpm exec node --test --test-concurrency=1",
  testFile,
].join(" ");

const { stdout, stderr } = await exec("pnpm", testArguments, {
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
    testId: "architecture.service-adapter.messages.property",
    classifications: {
      outcomes: ["success", "stable-redacted-error", "invalid-response"],
      attribution: ["activation", "correlation"],
    },
  },
  {
    propertyId: "PROP-B-REQUEST-001",
    testId: "architecture.service-request.messages.property",
    classifications: {
      outcomes: ["cancelled", "success", "disposed"],
      dispatch: ["suppressed", "exactly-once"],
    },
  },
  {
    propertyId: "PROP-B-ACTIVATION-001",
    testId: "architecture.service-event.messages.property",
    classifications: {
      authority: ["exact-activation", "stale-rejected"],
      lifecycle: ["live-delivery", "disposed-handler-rejected"],
    },
  },
  {
    propertyId: "PROP-B-FAKE-001",
    testId: "architecture.messages-bridge-parity.property",
    classifications: {
      routing: ["send", "publish", "request"],
      parity: ["tauri-free-fake", "current-bridge-client"],
    },
  },
  {
    propertyId: "PROP-B-EVENT-001",
    testId: "architecture.messages-service-fake.property",
    classifications: {
      delivery: ["ordered", "all-live-subscribers"],
      lifecycle: ["subscription-disposed", "owner-disposed"],
    },
  },
  {
    propertyId: "PROP-C-EFFECTS-001",
    testId: "architecture.service-event.messages.property",
    classifications: {
      ownership: ["activation-owned-handler", "reverse-disposal"],
      stale_effects: ["rejected"],
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
