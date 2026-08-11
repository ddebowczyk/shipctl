/**
 * The register holds the harness to a checklist, and the harness holds the
 * register to reality.
 *
 * Without these, coverage is whatever somebody wrote a scenario for. Every
 * assertion below is about that loop: a claim needs proof, a proof needs to
 * exist, and a scenario needs a claim.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  blockingCapabilities,
  DISPOSITIONS_WITHOUT_PROOF,
  requiredScenarioIds,
  TERMINAL_CAPABILITY_REGISTER,
} from "../scenarios/capabilityRegister.ts";
import {
  createTerminalScenarios,
  type TerminalSurfaceProbe,
} from "../scenarios/scenarioCatalog.ts";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

/** A probe that answers everything and does nothing. */
const inertProbe: TerminalSurfaceProbe = {
  loseGpuContext: () => false,
  surfaceUsable: () => true,
  secondModelPresent: () => false,
  writeOutput: () => Promise.resolve(),
  bufferRows: () => 0,
  resize: () => Promise.resolve(),
};

const catalog = createTerminalScenarios(inertProbe);

test("every capability has a unique id", () => {
  const seen = new Set<string>();
  for (const entry of TERMINAL_CAPABILITY_REGISTER) {
    assert.ok(!seen.has(entry.id), `duplicate capability id: ${entry.id}`);
    seen.add(entry.id);
  }
  assert.ok(seen.size > 0, "the register is not empty");
});

test("a claim of implementation carries proof", () => {
  for (const entry of TERMINAL_CAPABILITY_REGISTER) {
    if (DISPOSITIONS_WITHOUT_PROOF.has(entry.disposition)) continue;
    assert.notEqual(
      entry.proof.by,
      "none",
      `${entry.id} claims "${entry.disposition}" and proves nothing`,
    );
  }
});

test("a deliberate change names the owner who decided it", () => {
  for (const entry of TERMINAL_CAPABILITY_REGISTER) {
    if (entry.disposition !== "changed") continue;
    assert.ok(
      entry.owner && entry.owner.trim().length > 0,
      `${entry.id} changes product behaviour without naming an owner`,
    );
  }
});

test("every lane proof names a test file that exists", () => {
  for (const entry of TERMINAL_CAPABILITY_REGISTER) {
    if (entry.proof.by !== "lane") continue;
    assert.ok(
      existsSync(path.join(repositoryRoot, entry.proof.test)),
      `${entry.id} cites a missing test: ${entry.proof.test}`,
    );
  }
});

test("every manual proof names a procedure that exists", () => {
  for (const entry of TERMINAL_CAPABILITY_REGISTER) {
    if (entry.proof.by !== "manual") continue;
    assert.ok(
      existsSync(path.join(repositoryRoot, entry.proof.procedure)),
      `${entry.id} defers to a person but cites no written procedure: ` +
        `${entry.proof.procedure}. "A human checks it" is not a proof unless ` +
        "somebody wrote down what they check.",
    );
  }
});

test("every scenario proof names a scenario the catalog builds", () => {
  const built = new Set(catalog.map((entry) => entry.id));
  for (const id of requiredScenarioIds()) {
    assert.ok(built.has(id), `the register requires a scenario the catalog lacks: ${id}`);
  }
});

test("every scenario in the catalog is claimed by the register", () => {
  const ids = new Set(TERMINAL_CAPABILITY_REGISTER.map((entry) => entry.id));
  for (const scenario of catalog) {
    assert.ok(
      scenario.proves.length > 0,
      `${scenario.id} proves nothing and is therefore a demo`,
    );
    for (const claim of scenario.proves) {
      assert.ok(ids.has(claim), `${scenario.id} claims an unknown capability: ${claim}`);
    }
  }
});

test("scenario ids are unique", () => {
  const seen = new Set<string>();
  for (const scenario of catalog) {
    assert.ok(!seen.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    seen.add(scenario.id);
  }
});

test("what a scenario cannot falsify stays marked manual", () => {
  // These two are the residue the whole browser-capability argument ends at. A
  // scenario can prove the corpus painted without throwing; only a person can
  // prove it read correctly. If either is ever downgraded to a scenario proof,
  // that is a claim to have automated human perception, and it fails here.
  for (const id of ["unicode.glyph-fits-span", "input.ime"]) {
    const entry = TERMINAL_CAPABILITY_REGISTER.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} is missing from the register`);
    assert.equal(
      entry.proof.by,
      "manual",
      `${id} cannot be proved by a self-driven scenario: it needs a reader`,
    );
  }
});

test("the cutover's remaining blockers are enumerable", () => {
  const blocking = blockingCapabilities();

  assert.ok(
    blocking.length > 0,
    "area 04 is not finished; a register reporting nothing blocking would be wrong",
  );
  for (const entry of blocking) {
    assert.ok(
      entry.proof.by === "none" || entry.proof.by === "scenario" || entry.proof.by === "manual",
      `${entry.id} is blocking but cites a lane proof, which would make it implemented`,
    );
  }
});
