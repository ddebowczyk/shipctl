import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import fc from "fast-check";

import {
  propertyEvidence,
  repositoryIdentity,
  writePropertyFailure,
} from "../bin/property-evidence.mjs";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const evidenceDirectory = path.join(repositoryRoot, "target/architecture-evidence/replay");
const replayScript = path.join(repositoryRoot, "ops/architecture/bin/replay-property.mjs");

async function replay(evidenceFile) {
  const { stdout } = await exec(process.execPath, [
    replayScript,
    "--evidence",
    evidenceFile,
  ], { cwd: repositoryRoot });
  return JSON.parse(stdout);
}

test("architecture.property-replay.property", async () => {
  const fastCheckVersion = JSON.parse(
    await readFile(path.join(repositoryRoot, "node_modules/fast-check/package.json"), "utf8"),
  ).version;
  const property = fc.property(fc.integer({ min: 1 }), (value) => value < 1);
  const details = fc.check(property, { examples: [[100]] });
  assert.equal(details.failed, true);
  assert.ok(details.numShrinks > 0, "the deliberate TypeScript failure must shrink");

  const typescriptCounterexample = path.join(evidenceDirectory, "typescript.counterexample.json");
  const typescriptEvidence = propertyEvidence({
    propertyId: "PROP-A-REPLAY-001",
    testId: "architecture.property-replay.property.typescript",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    repository: await repositoryIdentity(repositoryRoot),
    seed: details.seed,
    shrinkPath: details.counterexamplePath,
    classifications: { typescript: 1, injected_failure: 1 },
    counterexamplePath: path.relative(repositoryRoot, typescriptCounterexample),
    replayCommand: "node ops/architecture/bin/replay-property.mjs --evidence target/architecture-evidence/replay/typescript.evidence.json",
  });
  const typescriptFiles = await writePropertyFailure({
    repositoryRoot,
    directory: evidenceDirectory,
    name: "typescript",
    evidence: typescriptEvidence,
    counterexample: details.counterexample,
  });
  const typescriptReplay = await replay(typescriptFiles.evidenceFile);
  assert.deepEqual(typescriptReplay.counterexample, details.counterexample);
  assert.equal(typescriptReplay.property_id, "PROP-A-REPLAY-001");

  const rustSeed = randomBytes(8).readBigUInt64BE().toString();
  const cargoEnvironment = {
    ...process.env,
    CARGO_TARGET_DIR: path.join(repositoryRoot, "target/architecture-proptest"),
  };
  const { stdout: rustStdout } = await exec("cargo", [
    "run",
    "--quiet",
    "--manifest-path",
    "ops/architecture/fixtures/proptest-replay/Cargo.toml",
    "--",
    "--seed",
    rustSeed,
  ], { cwd: repositoryRoot, env: cargoEnvironment });
  const rustFailure = JSON.parse(rustStdout);
  assert.equal(rustFailure.failed, true);
  assert.deepEqual(rustFailure.counterexample, [1]);

  const rustCounterexample = path.join(evidenceDirectory, "rust.counterexample.json");
  const rustEvidence = propertyEvidence({
    propertyId: "PROP-A-REPLAY-001",
    testId: "architecture.property-replay.property.rust",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    repository: await repositoryIdentity(repositoryRoot),
    seed: rustSeed,
    shrinkPath: "minimal:1",
    classifications: { rust: 1, injected_failure: 1 },
    counterexamplePath: path.relative(repositoryRoot, rustCounterexample),
    replayCommand: "node ops/architecture/bin/replay-property.mjs --evidence target/architecture-evidence/replay/rust.evidence.json",
  });
  const rustFiles = await writePropertyFailure({
    repositoryRoot,
    directory: evidenceDirectory,
    name: "rust",
    evidence: rustEvidence,
    counterexample: rustFailure.counterexample,
  });
  const rustReplay = await replay(rustFiles.evidenceFile);
  assert.deepEqual(rustReplay.counterexample, rustFailure.counterexample);
  assert.equal(rustReplay.property_id, "PROP-A-REPLAY-001");
});
