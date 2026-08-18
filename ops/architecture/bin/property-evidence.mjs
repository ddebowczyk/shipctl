import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CAMPAIGN_KINDS = new Set(["fresh", "replay"]);

function hashCommand(hash, command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(bytes);
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

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
  const { stdout: revision } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  const hash = createHash("sha256");
  const statusBytes = await hashCommand(
    hash,
    "git",
    ["status", "--porcelain=v1", "-z"],
    repositoryRoot,
  );
  await hashCommand(hash, "git", ["diff", "--binary", "HEAD"], repositoryRoot);
  return {
    revision: String(revision).trim(),
    dirty: statusBytes > 0,
    diff_digest: hash.digest("hex"),
  };
}

export function configuredCampaign({
  argv = process.argv,
  env = process.env,
} = {}) {
  const argumentsForCampaign = argv
    .filter((value) => value.startsWith("--campaign="))
    .map((value) => value.slice("--campaign=".length));
  const requested = argumentsForCampaign[0] ?? env.SHIPCTL_PROPERTY_CAMPAIGN ?? "fresh";

  if (argumentsForCampaign.some((value) => value !== requested)) {
    throw new Error("--campaign may name only one campaign kind");
  }
  if (!CAMPAIGN_KINDS.has(requested)) {
    throw new Error("campaign must be fresh or replay");
  }
  return requested;
}

export function propertyEvidenceCampaignFile(file, kind) {
  const suffix = ".evidence.json";
  if (!file.endsWith(suffix)) {
    throw new Error(`property evidence file must end with ${suffix}: ${file}`);
  }
  return `${file.slice(0, -suffix.length)}.${kind}${suffix}`;
}

function replayCampaignCommand(command) {
  if (/\bSHIPCTL_PROPERTY_CAMPAIGN=/.test(command)) return command;
  return `SHIPCTL_PROPERTY_CAMPAIGN=replay ${command}`;
}

export function propertyEvidence({
  propertyId,
  testId,
  phaseId = "phase-a",
  language,
  library,
  version,
  repository,
  kind = configuredCampaign(),
  seed,
  shrinkPath,
  classifications,
  counterexamplePath,
  replayCommand,
  result = "fail",
  deletionGates = [],
}) {
  if (!CAMPAIGN_KINDS.has(kind)) {
    throw new Error("campaign must be fresh or replay");
  }
  const campaign = {
    kind,
    seed: String(seed),
    classifications,
    replay_command: replayCampaignCommand(replayCommand),
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
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  const campaignFile = propertyEvidenceCampaignFile(file, evidence.campaign.kind);
  const schema = path.join(
    repositoryRoot,
    "docs/4-layer-architecture/spec/schema/property-evidence.v1.schema.yaml",
  );
  await writeFile(file, body);
  await writeFile(campaignFile, body);
  await exec("ys", ["-f", schema, file], { cwd: repositoryRoot });
  await exec("ys", ["-f", schema, campaignFile], { cwd: repositoryRoot });
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
