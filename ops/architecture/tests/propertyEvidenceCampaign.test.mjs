import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configuredPropertyEvidenceCampaign,
  propertyEvidenceFile,
  validatePropertyEvidenceRunnerPlan,
  verifyPropertyEvidenceCampaign,
} from "../bin/property-evidence-campaign.mjs";

const repository = {
  revision: "0123456789abcdef",
  dirty: true,
  diff_digest: "fedcba9876543210",
};

const fixtureRunner = {
  id: "fixture",
  phaseId: "phase-a",
  script: "fixture.mjs",
  evidenceDirectory: "target/architecture-evidence/fixture",
  propertyIds: ["PROP-A-FIXTURE-001"],
};

function fixtureRecord({ kind = "fresh", seed = 7 } = {}) {
  return {
    schema_version: "property-evidence/v1",
    property_id: "PROP-A-FIXTURE-001",
    test_id: "architecture.fixture.property",
    phase_id: "phase-a",
    repository,
    runner: { language: "typescript", library: "fast-check", version: "4.9.0" },
    campaign: {
      kind,
      seed: String(seed),
      classifications: {},
      replay_command: "node fixture.mjs --seed=7",
    },
    result: "pass",
    deletion_gates: [],
  };
}

test("architecture.property-evidence-campaign.configuration.property", () => {
  assert.deepEqual(configuredPropertyEvidenceCampaign({
    argv: ["node", "campaign", "--campaign=both", "--seed=41"],
  }), { kinds: ["fresh", "replay"], seed: 41 });
  assert.deepEqual(configuredPropertyEvidenceCampaign({
    argv: ["node", "campaign", "--campaign=fresh"],
    randomSeed: () => 19,
  }), { kinds: ["fresh"], seed: 19 });
  assert.throws(
    () => configuredPropertyEvidenceCampaign({ argv: ["node", "campaign", "--seed=-1"] }),
    /non-negative safe integer/,
  );
});

test("architecture.property-evidence-campaign.runner-plan.property", () => {
  const spec = {
    phases: [{
      id: "phase-a",
      properties: [{ id: "PROP-A-FIXTURE-001" }],
    }],
  };
  const incomplete = validatePropertyEvidenceRunnerPlan({ spec, runners: [fixtureRunner] });
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.diagnostics.some((item) => item.code === "property-runner-plan.native-slice-missing"));

  const noCoverage = validatePropertyEvidenceRunnerPlan({
    spec: {
      phases: [{ id: "phase-a", properties: [{ id: "PROP-A-MISSING-001" }] }],
    },
    runners: [],
  });
  assert.ok(noCoverage.diagnostics.some((item) => item.code === "property-runner-plan.missing-property"));
});

test("architecture.property-evidence-campaign.capability-coverage.property", () => {
  const spec = {
    phases: [{
      id: "phase-b",
      properties: [{ id: "PROP-B-FIXTURE-001" }],
    }],
    capabilities: [{
      id: "fixture-service",
      property_ids: ["PROP-B-FIXTURE-001"],
    }],
  };
  const uncovered = validatePropertyEvidenceRunnerPlan({
    spec,
    runners: [{
      ...fixtureRunner,
      phaseId: "phase-b",
      propertyIds: ["PROP-B-FIXTURE-001"],
    }],
  });
  assert.ok(uncovered.diagnostics.some((item) => (
    item.code === "property-runner-plan.capability-property-missing"
  )));

  const covered = validatePropertyEvidenceRunnerPlan({
    spec,
    runners: [{
      ...fixtureRunner,
      phaseId: "phase-b",
      propertyIds: ["PROP-B-FIXTURE-001"],
      capabilityIds: ["fixture-service"],
    }],
  });
  assert.equal(
    covered.diagnostics.some((item) => item.code === "property-runner-plan.capability-property-missing"),
    false,
  );
  assert.deepEqual(covered.phaseBCapabilityCoverage, [{
    capabilityId: "fixture-service",
    propertyId: "PROP-B-FIXTURE-001",
    runnerIds: ["fixture"],
  }]);
});

test("architecture.property-evidence-campaign.rejects-stale-or-mismatched-evidence", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "shipctl-property-evidence-"));
  try {
    const file = propertyEvidenceFile({
      repositoryRoot,
      runner: fixtureRunner,
      propertyId: "PROP-A-FIXTURE-001",
      kind: "fresh",
    });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(fixtureRecord({ seed: 8 }))}\n`);
    const mismatch = await verifyPropertyEvidenceCampaign({
      repositoryRoot,
      kind: "fresh",
      seed: 7,
      repository,
      runners: [fixtureRunner],
    });
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.diagnostics.some((item) => item.code === "property-evidence.seed-mismatch"));

    await writeFile(file, `${JSON.stringify(fixtureRecord())}\n`);
    const verified = await verifyPropertyEvidenceCampaign({
      repositoryRoot,
      kind: "fresh",
      seed: 7,
      repository,
      runners: [fixtureRunner],
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.evidenceFiles.length, 1);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
