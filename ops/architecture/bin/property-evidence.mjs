import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function normalizeCounterexample(value) {
  return canonical(value);
}

export async function repositoryIdentity(repositoryRoot) {
  const [{ stdout: revision }, { stdout: status }, { stdout: diff }] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    exec("git", ["status", "--porcelain=v1", "-z"], { cwd: repositoryRoot, encoding: "buffer" }),
    exec("git", ["diff", "--binary", "HEAD"], { cwd: repositoryRoot, encoding: "buffer" }),
  ]);
  const digest = createHash("sha256").update(status).update(diff).digest("hex");
  return {
    revision: String(revision).trim(),
    dirty: status.length > 0,
    diff_digest: digest,
  };
}

export function propertyEvidence({
  propertyId,
  testId,
  phaseId = "phase-a",
  language,
  library,
  version,
  repository,
  kind = "fresh",
  seed,
  shrinkPath,
  classifications,
  counterexamplePath,
  replayCommand,
  result = "fail",
  deletionGates = [],
}) {
  const campaign = {
    kind,
    seed: String(seed),
    classifications,
    replay_command: replayCommand,
  };
  if (shrinkPath !== undefined) campaign.shrink_path = shrinkPath;
  if (counterexamplePath !== undefined) campaign.counterexample_path = counterexamplePath;
  return {
    schema_version: "property-evidence/v1",
    property_id: propertyId,
    test_id: testId,
    phase_id: phaseId,
    repository,
    runner: { language, library, version },
    campaign,
    result,
    deletion_gates: deletionGates,
  };
}

export async function writePropertyEvidence({ repositoryRoot, file, evidence }) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  await exec("ys", [
    "-f",
    path.join(repositoryRoot, "docs/4-layer-architecture/spec/schema/property-evidence.v1.schema.yaml"),
    file,
  ], { cwd: repositoryRoot });
  return file;
}

export async function writePropertyFailure({
  repositoryRoot,
  directory,
  name,
  evidence,
  counterexample,
}) {
  await mkdir(directory, { recursive: true });
  const counterexampleFile = path.join(directory, `${name}.counterexample.json`);
  const evidenceFile = path.join(directory, `${name}.evidence.json`);
  await writeFile(
    counterexampleFile,
    `${JSON.stringify(normalizeCounterexample(counterexample), null, 2)}\n`,
  );
  await writePropertyEvidence({ repositoryRoot, file: evidenceFile, evidence });
  return { counterexampleFile, evidenceFile };
}

export async function readCounterexample(repositoryRoot, evidence) {
  const file = path.resolve(repositoryRoot, evidence.campaign.counterexample_path);
  return JSON.parse(await readFile(file, "utf8"));
}
