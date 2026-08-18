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
  "target/architecture-evidence/semantic-terminals",
);

function configuredSeed() {
  const argument = process.argv.find((value) => value.startsWith("--seed="));
  if (argument === undefined) return randomBytes(4).readInt32LE(0);
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  return seed;
}

const seed = configuredSeed();
const propertyTest = "ops/architecture/tests/semanticTerminalsCapability.test.mjs";
const adapterTest = "core/frontend/platform/tests/semanticTerminals.test.ts";
const testArguments = [
  "exec",
  "node",
  "--test",
  "--test-concurrency=1",
  propertyTest,
  adapterTest,
];
const replayCommand = [
  `SHIPCTL_PROPERTY_SEED=${seed}`,
  "pnpm exec node --test --test-concurrency=1",
  propertyTest,
  adapterTest,
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
    testId: "semantic-terminal adapter attaches without owning the original terminal session",
    classifications: {
      adapter: ["trusted-native-transport", "wire-validation", "cross-owner-attachment"],
      values: ["history", "selection", "anchors", "paste-safety"],
    },
  },
  {
    propertyId: "PROP-B-REQUEST-001",
    testId: "architecture.semantic-terminal-service-fake.property",
    classifications: {
      operations: ["input", "resize", "history", "anchors", "selection", "paste-safety"],
      outcomes: ["typed-success", "activation-attributed"],
    },
  },
  {
    propertyId: "PROP-B-FAKE-001",
    testId: "architecture.semantic-terminal-service-fake.property",
    classifications: {
      implementation: ["tauri-free", "activation-bound"],
      values: ["history", "selection", "anchors", "paste-safety"],
    },
  },
  {
    propertyId: "PROP-B-STREAM-001",
    testId: "architecture.service-stream.semantic-terminal.property",
    classifications: {
      delivery: ["snapshot", "latest-screen", "ordered-effects"],
      flow_control: ["credit", "acknowledgement", "disposal"],
    },
  },
  {
    propertyId: "PROP-B-ACTIVATION-001",
    testId: "architecture.semantic-terminal-activation.property",
    classifications: {
      attribution: ["exact-activation", "disposed-refusal"],
      ownership: ["attachment-lease"],
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
