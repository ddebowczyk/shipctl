import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import fc from "fast-check";

import {
  normalizeCounterexample,
  readCounterexample,
  repositoryIdentity,
} from "./property-evidence.mjs";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function sameIdentity(left, right) {
  return left.revision === right.revision
    && left.dirty === right.dirty
    && left.diff_digest === right.diff_digest;
}

async function replayFastCheck(evidence) {
  const property = fc.property(fc.integer({ min: 1 }), (value) => value < 1);
  const details = fc.check(property, {
    seed: Number(evidence.campaign.seed),
    path: evidence.campaign.shrink_path,
    examples: [[100]],
  });
  return {
    failed: details.failed,
    property_id: evidence.property_id,
    seed: String(details.seed),
    counterexample: normalizeCounterexample(details.counterexample),
  };
}

async function replayProptest(evidence) {
  const { stdout } = await exec("cargo", [
    "run",
    "--quiet",
    "-p",
    "shipctl-architecture-proptest-replay",
    "--",
    "--seed",
    evidence.campaign.seed,
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: path.join(repositoryRoot, "target/architecture-proptest"),
    },
  });
  return JSON.parse(stdout);
}

const evidencePath = argument("--evidence");
if (!evidencePath) throw new Error("usage: replay-property.mjs --evidence <path>");
const evidence = JSON.parse(await readFile(path.resolve(evidencePath), "utf8"));
const currentRepository = await repositoryIdentity(repositoryRoot);
if (!sameIdentity(evidence.repository, currentRepository)) {
  throw new Error("property evidence repository identity does not match the current checkout");
}
const expectedCounterexample = normalizeCounterexample(
  await readCounterexample(repositoryRoot, evidence),
);
const actual = evidence.runner.library === "fast-check"
  ? await replayFastCheck(evidence)
  : await replayProptest(evidence);
if (
  !actual.failed
  || actual.property_id !== evidence.property_id
  || JSON.stringify(actual.counterexample) !== JSON.stringify(expectedCounterexample)
) {
  throw new Error("property replay did not reproduce the recorded failure");
}
console.log(JSON.stringify({
  ok: true,
  property_id: evidence.property_id,
  runner: evidence.runner,
  seed: actual.seed,
  counterexample: actual.counterexample,
}));
