import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertModuleInspection,
  assertModuleOperation,
  assertVerificationResult,
} from "../contracts.fixture.ts";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}`, import.meta.url), "utf8"));
}

test("TypeScript checks the shared Rust inspection goldens", () => {
  const enabled = fixture("inspection.valid.json");
  assertModuleInspection(enabled);
  assert.equal(enabled.desired.enabled, true);
  assert.equal("rebuildCargo" in enabled, false);

  const disabled = fixture("desired.disabled-selected-artifact.valid.json");
  assert.equal(typeof disabled, "object");
  assertModuleInspection({
    schemaVersion: 1,
    manifest: enabled.manifest,
    desired: disabled,
    observed: [],
    grants: [],
    contributions: [],
    leases: [],
    diagnostics: [],
  });
  if (typeof disabled !== "object" || disabled === null) throw new Error("disabled fixture must be an object");
  assert.equal((disabled as { enabled: boolean }).enabled, false);
  assert.notEqual((disabled as { selectedArtifact: unknown }).selectedArtifact, null);
});

test("TypeScript checks the shared Rust operation and verification goldens", () => {
  const operation = fixture("operation.valid.json");
  assertModuleOperation(operation);
  assert.equal(operation.kind, "enable");

  const verification = fixture("verification-result.valid.json");
  assertVerificationResult(verification);
  assert.equal(verification.matched, true);
});
