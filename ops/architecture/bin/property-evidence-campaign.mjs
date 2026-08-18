import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadArchitectureSpec } from "./check-spec.mjs";
import {
  propertyEvidenceCampaignFile,
  repositoryIdentity,
} from "./property-evidence.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "../../..");
const PHASE_D_PROPERTY_IDS = [
  "PROP-D-PARITY-001",
  "PROP-D-AUTHORITY-001",
  "PROP-D-OWNERSHIP-001",
  "PROP-D-CLOSURE-001",
];
const PHASE_B_PROPERTY_PREFIX = "PROP-B-";

/**
 * The Phase D cards are shared laws, but every migrated native capability must
 * exercise them independently. Keeping the slice list here makes that
 * obligation executable rather than relying on whatever stale files happen to
 * be left under target/.
 */
export const NATIVE_EXTRACTION_SLICES = Object.freeze([
  "ports-extraction",
  "todos-extraction",
  "git-extraction",
  "skills-extraction",
  "semantic-terminal-extraction",
  "usage-sources",
  "assistants-extraction",
]);

/**
 * Phase B laws are shared, but a capability that declares one must contribute
 * its own replayable evidence. The generic foundation runner proves the
 * framework model; this list proves that each real client is wired through it.
 *
 * `capabilityIds` is intentionally checked against the machine-readable
 * capability records below. Adding a service declaration without adding its
 * controlled evidence runner therefore fails the campaign plan before it can
 * produce a reassuring but incomplete report.
 */
export const SEMANTIC_SERVICE_CAPABILITY_RUNNERS = Object.freeze([
  {
    id: "processes",
    phaseId: "phase-b",
    script: "ops/architecture/bin/run-processes-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/processes",
    propertyIds: ["PROP-B-ADAPTER-001", "PROP-B-REQUEST-001"],
    capabilityIds: ["processes"],
  },
  {
    id: "project-documents",
    phaseId: "phase-b",
    script: "ops/architecture/bin/run-project-documents-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/project-documents",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-FAKE-001",
    ],
    capabilityIds: ["project-documents"],
  },
  {
    id: "git",
    phaseId: "phase-b",
    script: "ops/architecture/bin/run-git-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/git",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-EVENT-001",
      "PROP-B-FAKE-001",
    ],
    capabilityIds: ["git"],
  },
  {
    id: "skill-installation",
    phaseId: "phase-b",
    script: "ops/architecture/bin/run-skill-installation-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/skill-installation",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-FAKE-001",
    ],
    capabilityIds: ["skill-installation"],
  },
  {
    id: "credential-store",
    phaseId: "phase-b",
    script: "ops/architecture/bin/run-credential-store-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/credential-store",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-FAKE-001",
    ],
    capabilityIds: ["credential-store"],
  },
  {
    id: "assistant-launch",
    phaseId: "phase-b",
    script: "ops/architecture/bin/run-assistant-launch-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/assistant-launch",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-EVENT-001",
      "PROP-B-FAKE-001",
    ],
    capabilityIds: ["assistant-launch"],
  },
  {
    id: "plugin-data",
    phaseId: "phase-b",
    propertyPhaseIds: { "PROP-D-PARITY-001": "phase-d" },
    script: "ops/architecture/bin/run-plugin-data-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/plugin-data",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-FAKE-001",
      "PROP-D-PARITY-001",
    ],
    capabilityIds: ["plugin-data"],
  },
  {
    id: "scheduler",
    phaseId: "phase-b",
    propertyPhaseIds: { "PROP-D-OWNERSHIP-001": "phase-d" },
    script: "ops/architecture/bin/run-scheduler-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/scheduler",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-FAKE-001",
      "PROP-B-EVENT-001",
      "PROP-D-OWNERSHIP-001",
    ],
    capabilityIds: ["scheduler"],
  },
  {
    id: "messages",
    phaseId: "phase-b",
    propertyPhaseIds: { "PROP-C-EFFECTS-001": "phase-c" },
    script: "ops/architecture/bin/run-messages-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/messages",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-FAKE-001",
      "PROP-B-EVENT-001",
      "PROP-C-EFFECTS-001",
    ],
    capabilityIds: ["messages"],
  },
  {
    id: "terminal-sessions",
    phaseId: "phase-b",
    propertyPhaseIds: { "PROP-D-OWNERSHIP-001": "phase-d" },
    script: "ops/architecture/bin/run-terminal-sessions-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/terminal-sessions",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-FAKE-001",
      "PROP-B-EVENT-001",
      "PROP-B-STREAM-001",
      "PROP-D-OWNERSHIP-001",
    ],
    capabilityIds: ["terminal-sessions"],
  },
  {
    id: "semantic-terminals",
    phaseId: "phase-b",
    script: "ops/architecture/bin/run-semantic-terminals-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/semantic-terminals",
    propertyIds: [
      "PROP-B-ADAPTER-001",
      "PROP-B-REQUEST-001",
      "PROP-B-FAKE-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-STREAM-001",
    ],
    capabilityIds: ["semantic-terminals"],
  },
]);

export const PROPERTY_EVIDENCE_RUNNERS = Object.freeze([
  {
    id: "foundation",
    phaseId: "phase-a",
    script: "ops/architecture/bin/run-foundation-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/foundation",
    propertyIds: [
      "PROP-A-SPEC-001",
      "PROP-A-IMPORT-001",
      "PROP-A-COMPOSITION-001",
      "PROP-A-REPLAY-001",
    ],
  },
  {
    id: "semantic-service-foundation",
    phaseId: "phase-b",
    script: "ops/architecture/bin/run-semantic-service-foundation-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/semantic-service-foundation",
    propertyIds: [
      "PROP-B-BOUNDARY-001",
      "PROP-B-ADAPTER-001",
      "PROP-B-FAKE-001",
      "PROP-B-ACTIVATION-001",
      "PROP-B-REQUEST-001",
      "PROP-B-EVENT-001",
      "PROP-B-STREAM-001",
    ],
  },
  ...SEMANTIC_SERVICE_CAPABILITY_RUNNERS,
  {
    id: "cordis",
    phaseId: "phase-c",
    script: "ops/architecture/bin/run-cordis-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/cordis",
    propertyIds: [
      "PROP-C-LIFECYCLE-001",
      "PROP-C-EFFECTS-001",
      "PROP-C-STATIC-PARITY-001",
      "PROP-C-DISPOSE-001",
      "PROP-C-ROLE-001",
      "PROP-C-BOUNDARY-001",
    ],
  },
  ...NATIVE_EXTRACTION_SLICES.map((id) => ({
    id,
    phaseId: "phase-d",
    ...(id === "usage-sources" ? {
      propertyPhaseIds: {
        "PROP-B-ADAPTER-001": "phase-b",
        "PROP-B-REQUEST-001": "phase-b",
        "PROP-B-ACTIVATION-001": "phase-b",
        "PROP-B-EVENT-001": "phase-b",
        "PROP-B-FAKE-001": "phase-b",
      },
      propertyIds: [
        ...PHASE_D_PROPERTY_IDS,
        "PROP-B-ADAPTER-001",
        "PROP-B-REQUEST-001",
        "PROP-B-ACTIVATION-001",
        "PROP-B-EVENT-001",
        "PROP-B-FAKE-001",
      ],
      capabilityIds: ["usage-sources"],
    } : {
      propertyIds: PHASE_D_PROPERTY_IDS,
    }),
    script: `ops/architecture/bin/run-${id}-properties.mjs`,
    evidenceDirectory: `target/architecture-evidence/${id}`,
  })),
  {
    id: "plugin-artifacts",
    phaseId: "phase-e",
    script: "ops/architecture/bin/run-plugin-artifact-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/plugin-artifacts",
    propertyIds: [
      "PROP-E-ARTIFACT-001",
      "PROP-E-TAMPER-001",
      "PROP-E-EXTERNALS-001",
      "PROP-E-MANIFEST-RUNTIME-001",
      "PROP-E-BUILTIN-PARITY-001",
      "PROP-E-PORTS-PARITY-001",
      "PROP-E-TODOS-PARITY-001",
      "PROP-E-GIT-PARITY-001",
      "PROP-E-SKILLS-PARITY-001",
      "PROP-E-THIN-TERMINAL-PARITY-001",
      "PROP-E-SEMANTIC-TERMINAL-PARITY-001",
      "PROP-E-ASSISTANTS-PARITY-001",
      "PROP-E-USAGE-PARITY-001",
      "PROP-E-COMPATIBILITY-001",
      "PROP-E-HEADLESS-001",
    ],
  },
  {
    id: "live-reconciliation",
    phaseId: "phase-f",
    script: "ops/architecture/bin/run-live-reconciliation-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/live-reconciliation",
    propertyIds: [
      "PROP-F-RECONCILE-001",
      "PROP-F-ATOMIC-001",
      "PROP-F-SCHEDULE-ATOMIC-001",
      "PROP-F-REVISION-001",
      "PROP-F-CONTINUITY-001",
      "PROP-F-INSPECTION-001",
      "PROP-F-SERVICE-001",
      "PROP-F-RESTART-001",
    ],
  },
  {
    id: "workspace",
    phaseId: "phase-g",
    script: "ops/architecture/bin/run-workspace-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/workspace",
    propertyIds: [
      "PROP-G-WORKSPACE-001",
      "PROP-G-RENDERER-001",
      "PROP-G-LAYMAN-MOVE-001",
      "PROP-G-LAYMAN-SPLIT-001",
      "PROP-G-LAYOUT-001",
      "PROP-G-CONTRIBUTION-SCHEMA-001",
      "PROP-G-CONTRIBUTION-CLEANUP-001",
      "PROP-G-ABSENCE-001",
    ],
  },
  {
    // This is a repository-closure proof, deliberately outside phase-h.yaml's
    // semantic property cards because phase H is the final acceptance gate.
    id: "module-api-backend-closure",
    phaseId: "phase-h",
    script: "ops/architecture/bin/run-module-api-backend-closure-properties.mjs",
    evidenceDirectory: "target/architecture-evidence/module-api-backend-closure",
    propertyIds: ["PROP-H-NATIVE-CLOSURE-001"],
    closureProof: true,
  },
]);

function selectedArgument(argv, name) {
  const prefix = `--${name}=`;
  const values = argv
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length));
  if (new Set(values).size > 1) {
    throw new Error(`--${name} may name only one value`);
  }
  return values[0];
}

export function configuredPropertyEvidenceCampaign({
  argv = process.argv,
  randomSeed = () => randomBytes(4).readUInt32LE(0) & 0x7fff_ffff,
} = {}) {
  const requestedCampaign = selectedArgument(argv, "campaign") ?? "both";
  if (!["fresh", "replay", "both"].includes(requestedCampaign)) {
    throw new Error("--campaign must be fresh, replay, or both");
  }
  const rawSeed = selectedArgument(argv, "seed");
  const seed = rawSeed === undefined ? randomSeed() : Number(rawSeed);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("--seed must be a non-negative safe integer");
  }
  return {
    seed,
    kinds: requestedCampaign === "both" ? ["fresh", "replay"] : [requestedCampaign],
  };
}

export function propertyEvidenceFile({ repositoryRoot, runner, propertyId, kind }) {
  const base = path.join(
    repositoryRoot,
    runner.evidenceDirectory,
    `${propertyId}.evidence.json`,
  );
  return propertyEvidenceCampaignFile(base, kind);
}

function declaredPropertyOwners(spec) {
  return new Map(spec.phases.flatMap((phase) => (
    (phase.properties ?? []).map((property) => [property.id, phase.id])
  )));
}

function runnerPhaseId(runner, propertyId) {
  return runner.propertyPhaseIds?.[propertyId] ?? runner.phaseId;
}

export function validatePropertyEvidenceRunnerPlan({
  spec,
  runners = PROPERTY_EVIDENCE_RUNNERS,
} = {}) {
  const owners = declaredPropertyOwners(spec);
  const planned = new Map();
  const diagnostics = [];
  const closureProofs = new Set();
  const capabilities = new Map((spec.capabilities ?? []).map((capability) => [capability.id, capability]));
  const phaseBCapabilityCoverage = [];

  for (const runner of runners) {
    for (const propertyId of Object.keys(runner.propertyPhaseIds ?? {})) {
      if (!runner.propertyIds.includes(propertyId)) {
        diagnostics.push({
          code: "property-runner-plan.unlisted-phase-override",
          message: `${runner.id} defines a phase override for an unlisted property: ${propertyId}`,
        });
      }
    }
    for (const capabilityId of runner.capabilityIds ?? []) {
      if (!capabilities.has(capabilityId)) {
        diagnostics.push({
          code: "property-runner-plan.unknown-capability",
          message: `${runner.id} names unknown capability ${capabilityId}`,
        });
      }
    }
    for (const propertyId of runner.propertyIds) {
      const expectedPhase = owners.get(propertyId);
      const phaseId = runnerPhaseId(runner, propertyId);
      if (expectedPhase === undefined && !runner.closureProof) {
        diagnostics.push({
          code: "property-runner-plan.unknown-property",
          message: `${runner.id} names property not declared in the specification: ${propertyId}`,
        });
      } else if (expectedPhase !== undefined && expectedPhase !== phaseId) {
        diagnostics.push({
          code: "property-runner-plan.phase-mismatch",
          message: `${runner.id} records ${propertyId} for ${phaseId}, expected ${expectedPhase}`,
        });
      }
      if (runner.closureProof) closureProofs.add(propertyId);
      const assignments = planned.get(propertyId) ?? [];
      assignments.push(runner.id);
      planned.set(propertyId, assignments);
    }
  }

  for (const propertyId of owners.keys()) {
    if (!planned.has(propertyId)) {
      diagnostics.push({
        code: "property-runner-plan.missing-property",
        message: `no controlled campaign runner records ${propertyId}`,
      });
    }
  }
  for (const capability of capabilities.values()) {
    for (const propertyId of capability.property_ids ?? []) {
      if (!propertyId.startsWith(PHASE_B_PROPERTY_PREFIX)) continue;
      const coverage = runners.filter((runner) => (
        runner.capabilityIds?.includes(capability.id)
        && runner.propertyIds.includes(propertyId)
      ));
      phaseBCapabilityCoverage.push({
        capabilityId: capability.id,
        propertyId,
        runnerIds: coverage.map(({ id }) => id).sort(),
      });
      if (coverage.length === 0) {
        diagnostics.push({
          code: "property-runner-plan.capability-property-missing",
          message: `${capability.id} declares ${propertyId} but no controlled capability runner records it`,
        });
      }
    }
  }
  for (const slice of NATIVE_EXTRACTION_SLICES) {
    const runner = runners.find((candidate) => candidate.id === slice);
    if (runner === undefined) {
      diagnostics.push({
        code: "property-runner-plan.native-slice-missing",
        message: `Phase D native extraction slice is missing: ${slice}`,
      });
      continue;
    }
    const missing = PHASE_D_PROPERTY_IDS.filter((propertyId) => !runner.propertyIds.includes(propertyId));
    if (missing.length > 0) {
      diagnostics.push({
        code: "property-runner-plan.native-slice-incomplete",
        message: `Phase D native extraction slice ${slice} omits: ${missing.join(", ")}`,
      });
    }
  }
  if (!closureProofs.has("PROP-H-NATIVE-CLOSURE-001")) {
    diagnostics.push({
      code: "property-runner-plan.native-closure-missing",
      message: "the module-api/backend repository-closure proof is not in the controlled campaign",
    });
  }

  diagnostics.sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
  return {
    ok: diagnostics.length === 0,
    declaredPropertyIds: [...owners.keys()].sort(),
    closureProofIds: [...closureProofs].sort(),
    phaseBCapabilityCoverage: phaseBCapabilityCoverage.sort((left, right) => (
      left.capabilityId.localeCompare(right.capabilityId)
      || left.propertyId.localeCompare(right.propertyId)
    )),
    diagnostics,
  };
}

function equalRepository(left, right) {
  return left.revision === right.revision
    && left.dirty === right.dirty
    && left.diff_digest === right.diff_digest;
}

export async function verifyPropertyEvidenceCampaign({
  repositoryRoot = defaultRepositoryRoot,
  kind,
  seed,
  repository,
  runners = PROPERTY_EVIDENCE_RUNNERS,
} = {}) {
  const evidence = [];
  const diagnostics = [];
  for (const runner of runners) {
    for (const propertyId of runner.propertyIds) {
      const file = propertyEvidenceFile({ repositoryRoot, runner, propertyId, kind });
      let record;
      try {
        record = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        diagnostics.push({
          code: "property-evidence.missing",
          message: `${runner.id} did not emit ${path.relative(repositoryRoot, file)}: ${error.code ?? error.message}`,
        });
        continue;
      }
      const relativeFile = path.relative(repositoryRoot, file);
      evidence.push(relativeFile);
      if (record.property_id !== propertyId) {
        diagnostics.push({
          code: "property-evidence.property-mismatch",
          message: `${relativeFile} records ${record.property_id}, expected ${propertyId}`,
        });
      }
      const phaseId = runnerPhaseId(runner, propertyId);
      if (record.phase_id !== phaseId) {
        diagnostics.push({
          code: "property-evidence.phase-mismatch",
          message: `${relativeFile} records ${record.phase_id}, expected ${phaseId}`,
        });
      }
      if (record.result !== "pass") {
        diagnostics.push({
          code: "property-evidence.not-passing",
          message: `${relativeFile} has result ${record.result}`,
        });
      }
      if (record.campaign?.kind !== kind) {
        diagnostics.push({
          code: "property-evidence.campaign-kind-mismatch",
          message: `${relativeFile} records ${record.campaign?.kind}, expected ${kind}`,
        });
      }
      if (record.campaign?.seed !== String(seed)) {
        diagnostics.push({
          code: "property-evidence.seed-mismatch",
          message: `${relativeFile} records ${record.campaign?.seed}, expected ${seed}`,
        });
      }
      if (!equalRepository(record.repository ?? {}, repository)) {
        diagnostics.push({
          code: "property-evidence.repository-mismatch",
          message: `${relativeFile} does not identify the source state used to start this campaign`,
        });
      }
    }
  }
  diagnostics.sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
  return {
    ok: diagnostics.length === 0,
    kind,
    seed,
    evidenceFiles: evidence.sort(),
    diagnostics,
  };
}

async function removeCampaignEvidence({ repositoryRoot, kind, runners }) {
  await Promise.all(runners.flatMap((runner) => runner.propertyIds.map((propertyId) => (
    rm(propertyEvidenceFile({ repositoryRoot, runner, propertyId, kind }), { force: true })
  ))));
}

function runRunner({ repositoryRoot, runner, kind, seed }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner.script, `--seed=${seed}`], {
      cwd: repositoryRoot,
      env: { ...process.env, SHIPCTL_PROPERTY_CAMPAIGN: kind },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${runner.id} property runner exited with ${code ?? signal}`));
    });
  });
}

function campaignReportFile(repositoryRoot, seed, kinds) {
  const name = `${kinds.join("-")}-${seed}.json`;
  return path.join(repositoryRoot, "target/architecture-evidence/campaigns", name);
}

export async function runPropertyEvidenceCampaign({
  repositoryRoot = defaultRepositoryRoot,
  kinds,
  seed,
  runners = PROPERTY_EVIDENCE_RUNNERS,
  run = runRunner,
} = {}) {
  const spec = await loadArchitectureSpec(path.join(
    repositoryRoot,
    "docs/4-layer-architecture/spec",
  ));
  const plan = validatePropertyEvidenceRunnerPlan({ spec, runners });
  if (!plan.ok) {
    throw new Error(`invalid property evidence runner plan:\n${plan.diagnostics.map((item) => item.message).join("\n")}`);
  }
  const repository = await repositoryIdentity(repositoryRoot);
  const campaigns = [];
  for (const kind of kinds) {
    await removeCampaignEvidence({ repositoryRoot, kind, runners });
    for (const runner of runners) {
      await run({ repositoryRoot, runner, kind, seed });
    }
    const after = await repositoryIdentity(repositoryRoot);
    if (!equalRepository(after, repository)) {
      throw new Error("source state changed while the property evidence campaign was running");
    }
    const verified = await verifyPropertyEvidenceCampaign({
      repositoryRoot,
      kind,
      seed,
      repository,
      runners,
    });
    if (!verified.ok) {
      throw new Error(`invalid ${kind} property evidence:\n${verified.diagnostics.map((item) => item.message).join("\n")}`);
    }
    campaigns.push(verified);
  }
  const report = {
    schema_version: "architecture-property-evidence-campaign/v1",
    ok: true,
    repository,
    seed,
    declared_property_ids: plan.declaredPropertyIds,
    repository_closure_proof_ids: plan.closureProofIds,
    native_extraction_slices: NATIVE_EXTRACTION_SLICES,
    phase_b_capability_coverage: plan.phaseBCapabilityCoverage,
    campaigns: campaigns.map((campaign) => ({
      kind: campaign.kind,
      evidence_files: campaign.evidenceFiles,
    })),
  };
  const reportFile = campaignReportFile(repositoryRoot, seed, kinds);
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, report_file: path.relative(repositoryRoot, reportFile) };
}

async function main() {
  const configuration = configuredPropertyEvidenceCampaign();
  const result = await runPropertyEvidenceCampaign(configuration);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
