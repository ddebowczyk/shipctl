import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  checkArchitectureSpec,
  loadArchitectureSpec,
  validateArchitectureRecords,
} from "../bin/check-spec.mjs";

const liveSpec = await loadArchitectureSpec();

function codes(spec) {
  return validateArchitectureRecords(spec).map((item) => item.code);
}

function expectCode(spec, code) {
  assert.ok(codes(spec).includes(code), `expected diagnostic ${code}`);
}

test("architecture.spec.live", async () => {
  const result = await checkArchitectureSpec();
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.ok, true);
});

test("architecture.spec.rejects-unknown-phase-dependency", () => {
  const spec = structuredClone(liveSpec);
  spec.phases[0].depends_on = ["phase-unknown"];
  expectCode(spec, "architecture.phase.dependency.unknown");
});

test("architecture.spec.rejects-phase-cycle", () => {
  const spec = structuredClone(liveSpec);
  spec.phases[0].depends_on = [spec.phases[1].id];
  spec.phases[1].depends_on = [spec.phases[0].id];
  expectCode(spec, "architecture.phase.dependency.cycle");
});

test("architecture.spec.rejects-unknown-evidence", () => {
  const spec = structuredClone(liveSpec);
  spec.phases[0].properties[0].evidence = ["SEM-A-999"];
  expectCode(spec, "architecture.property.evidence.unknown");
});

test("architecture.spec.rejects-duplicate-property", () => {
  const spec = structuredClone(liveSpec);
  spec.phases[1].properties.push(structuredClone(spec.phases[0].properties[0]));
  expectCode(spec, "architecture.property.id.duplicate");
});

test("architecture.spec.rejects-unknown-module-capability", () => {
  const spec = structuredClone(liveSpec);
  spec.modules[0].target.capabilities.push("unknown-capability");
  expectCode(spec, "architecture.module.capability.unknown");
});

test("architecture.spec.rejects-unknown-deletion-gate", () => {
  const spec = structuredClone(liveSpec);
  spec.modules[0].deletion_gates[0].id = "DELETE-A-UNKNOWN";
  expectCode(spec, "architecture.module.deletion-gate.unknown");
});

test("architecture.spec.rejects-unknown-deletion-proof", () => {
  const spec = structuredClone(liveSpec);
  spec.modules[0].deletion_gates[0].proof_ids = ["PROP-A-UNKNOWN-001"];
  expectCode(spec, "architecture.module.proof.unknown");
});

test("architecture.spec.graph.property", () => {
  const ids = liveSpec.phases.map((phase) => phase.id);
  const dagArbitrary = fc.tuple(...ids.map((_, index) => (
    fc.subarray(ids.slice(0, index))
  )));
  const distinctPair = fc.tuple(
    fc.constantFrom(...ids),
    fc.constantFrom(...ids),
  ).filter(([left, right]) => left !== right);

  fc.assert(fc.property(dagArbitrary, (dependencies) => {
    const spec = structuredClone(liveSpec);
    for (const [index, phase] of spec.phases.entries()) {
      phase.depends_on = dependencies[index];
    }
    assert.equal(
      codes(spec).some((code) => code.startsWith("architecture.phase.dependency")),
      false,
    );
  }));

  fc.assert(fc.property(distinctPair, ([left, right]) => {
    const spec = structuredClone(liveSpec);
    const leftPhase = spec.phases.find((phase) => phase.id === left);
    const rightPhase = spec.phases.find((phase) => phase.id === right);
    leftPhase.depends_on = [right];
    rightPhase.depends_on = [left];
    expectCode(spec, "architecture.phase.dependency.cycle");
  }));

  fc.assert(fc.property(fc.constantFrom(...ids), (id) => {
    const spec = structuredClone(liveSpec);
    spec.phases.find((phase) => phase.id === id).depends_on = [
      "phase-unknown",
    ];
    expectCode(spec, "architecture.phase.dependency.unknown");
  }));
});
