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
const evidenceDirectory = path.join(repositoryRoot, "target/architecture-evidence/cordis");

function configuredSeed() {
  const argument = process.argv.find((value) => value.startsWith("--seed="));
  if (argument === undefined) return randomBytes(4).readInt32LE(0);
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  return seed;
}

const seed = configuredSeed();
const testFile = "ops/architecture/tests/cordisStaticComposition.test.mjs";
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
    propertyId: "PROP-C-LIFECYCLE-001",
    testId: "architecture.cordis-lifecycle.property",
    classifications: {
      states: ["active", "failed", "replaced", "disposed", "denied"],
      identity: ["unique", "not-reused"],
    },
  },
  {
    propertyId: "PROP-C-EFFECTS-001",
    testId: "architecture.cordis-effect-conservation.property",
    classifications: {
      ownership: ["active-owner", "failed-owner", "disposed-owner"],
      cleanup: ["reverse-order", "exactly-once"],
    },
  },
  {
    propertyId: "PROP-C-STATIC-PARITY-001",
    testId: "architecture.static-cordis-parity.property",
    classifications: {
      catalog: ["all-current-families", "declared-order"],
      conflicts: ["same-family-rejected", "cross-family-accepted"],
    },
  },
  {
    propertyId: "PROP-C-DISPOSE-001",
    testId: "architecture.cordis-dispose.property",
    classifications: {
      calls: ["once", "repeated"],
      outcome: ["effects-removed", "catalog-removed", "disposed"],
    },
  },
  {
    propertyId: "PROP-C-ROLE-001",
    testId: "architecture.cordis-plugin-role.property",
    classifications: {
      roles: ["headless", "presentation", "compound"],
      owned_entities: ["services", "effects", "contributions"],
    },
  },
  {
    propertyId: "PROP-C-BOUNDARY-001",
    testId: "architecture.cordis-boundary.property",
    classifications: {
      imports: ["public-contract", "cordis-denied"],
      entrypoint: ["passive", "top-level-effect-denied"],
    },
  },
];

const evidenceFiles = [];
for (const property of properties) {
  const evidence = propertyEvidence({
    ...property,
    phaseId: "phase-c",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    repository,
    seed,
    replayCommand,
    result: "pass",
    deletionGates: ["DELETE-C-LEGACY-LIFECYCLE"],
  });
  const file = path.join(evidenceDirectory, `${property.propertyId}.evidence.json`);
  await writePropertyEvidence({ repositoryRoot, file, evidence });
  evidenceFiles.push(path.relative(repositoryRoot, file));
}

process.stdout.write(`${JSON.stringify({ ok: true, seed, evidence_files: evidenceFiles }, null, 2)}\n`);
