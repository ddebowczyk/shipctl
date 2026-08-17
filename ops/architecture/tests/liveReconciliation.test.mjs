import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
let runtime;
let assertCompleteRuntimeFamily;
let vite;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) {
    throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  }
  return { seed };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: repositoryRoot,
    server: { hmr: false, middlewareMode: true },
  });
  runtime = await vite.ssrLoadModule("/core/frontend/runtime/liveReconciler.ts");
  ({ assertCompleteRuntimeFamily } = await vite.ssrLoadModule(
    "/core/frontend/runtime/runtimeFamilyValidation.ts",
  ));
});

after(async () => {
  await vite?.close();
});

function normalized(snapshot) {
  return {
    registryRevision: snapshot.registryRevision,
    modules: snapshot.modules.map((module) => ({ ...module }))
      .sort((left, right) => left.moduleId.localeCompare(right.moduleId)),
  };
}

function activationId(module) {
  return `${module.moduleId}@${module.version}#${module.contentDigest}`;
}

function familyFor(desired, generation, hostResources, providerCalls, state = "candidate") {
  const identities = desired.modules.map(activationId);
  const providers = desired.modules.map((module) => ({
    activationId: activationId(module),
    generation,
    state,
    invoke() {
      providerCalls.push({ activationId: this.activationId, state: this.state });
      if (this.state !== "accepted") throw new Error(`provider is ${this.state}`);
      return this.activationId;
    },
  }));
  const services = Object.fromEntries(
    desired.modules.map((module, index) => [module.moduleId, providers[index]]),
  );
  const contributions = desired.modules.map((module) => ({
    family: "panel",
    id: `${module.moduleId}.surface`,
    moduleId: module.moduleId,
    ownerActivationId: activationId(module),
  }));
  const inspection = Object.freeze({
    activations: desired.modules.map((module) => ({
      moduleId: module.moduleId,
      activationId: activationId(module),
      artifactContentDigest: module.contentDigest,
      desiredRevision: desired.registryRevision,
      status: "active",
      grants: [`${module.moduleId}.read`],
      leases: [`${module.moduleId}.lease`],
    })),
    contributions,
    services: desired.modules.map((module) => ({
      id: `${module.moduleId}.service`,
      version: 1,
      moduleId: module.moduleId,
      ownerActivationId: activationId(module),
    })),
    effects: desired.modules.map((module) => ({
      kind: "subscription",
      id: `${module.moduleId}.effect`,
      moduleId: module.moduleId,
      ownerActivationId: activationId(module),
    })),
  });
  return Object.freeze({
    revision: desired.registryRevision,
    identities,
    services,
    contributions,
    inspection,
    providers,
    hostResources,
  });
}

const failureStages = ["prepare", "validate", "publish", "dispose"];

function injectedFailure(desired) {
  for (const module of desired.modules) {
    const stage = failureStages.find((candidate) =>
      module.contentDigest.startsWith(`fail-${candidate}-`));
    if (stage !== undefined) {
      return { stage, moduleId: module.moduleId, activationId: activationId(module) };
    }
  }
  return null;
}

function sameGraph(left, right) {
  if (left === null || left.modules.length !== right.modules.length) return false;
  const leftKeys = left.modules.map(activationId).sort();
  const rightKeys = right.modules.map(activationId).sort();
  return leftKeys.every((value, index) => value === rightKeys[index]);
}

function acceptFamily(family) {
  for (const provider of family.providers) provider.state = "accepted";
}

function disposeFamily(family) {
  for (const provider of family.providers) provider.state = "disposed";
}

function createHarness() {
  const hostResources = Object.freeze(["terminal-1", "process-1"]);
  const providerCalls = [];
  const allProviders = [];
  const publication = new runtime.AtomicRuntimePublication(
    familyFor({ registryRevision: 0, modules: [] }, 0, hostResources, providerCalls, "accepted"),
  );
  const activations = [];
  const disposed = [];
  let generation = 0;
  const reconciler = new runtime.LivePluginReconciler({
    prepare: async (desired) => {
      const failure = injectedFailure(desired);
      if (failure?.stage === "prepare") {
        throw new runtime.RuntimeReconciliationError(
          "module.runtime.injected_prepare_failure",
          "injected prepare failure",
          failure,
        );
      }
      generation += 1;
      const candidateId = `candidate-${generation}`;
      activations.push(candidateId);
      const family = familyFor(desired, generation, hostResources, providerCalls);
      allProviders.push(...family.providers);
      let isDisposed = false;
      return {
        desired,
        publicFamily: family,
        validate: () => {
          if (failure?.stage === "validate") {
            throw new runtime.RuntimeReconciliationError(
              "module.runtime.injected_validate_failure",
              "injected validate failure",
              failure,
            );
          }
        },
        dispose: () => {
          if (isDisposed) return;
          isDisposed = true;
          disposed.push(candidateId);
          disposeFamily(family);
          if (failure?.stage === "dispose") {
            throw new runtime.RuntimeReconciliationError(
              "module.runtime.injected_dispose_failure",
              "injected dispose failure",
              failure,
            );
          }
        },
      };
    },
    publish: (candidate) => {
      const failure = injectedFailure(candidate.desired);
      for (const provider of Object.values(publication.getSnapshot().services)) provider.invoke();
      assert.ok(candidate.publicFamily.providers.every(({ state }) => state === "candidate"));
      if (failure?.stage === "publish") {
        throw new runtime.RuntimeReconciliationError(
          "module.runtime.injected_publish_failure",
          "injected publish failure",
          failure,
        );
      }
      acceptFamily(candidate.publicFamily);
      publication.publish(candidate.publicFamily);
      for (const provider of Object.values(publication.getSnapshot().services)) provider.invoke();
      return {
        desired: candidate.desired,
        publicFamily: candidate.publicFamily,
        dispose: candidate.dispose,
      };
    },
    publishRetained: (accepted, desired) => {
      const family = Object.freeze({ ...accepted.publicFamily, revision: desired.registryRevision });
      publication.publish(family);
      return { desired, publicFamily: family, dispose: accepted.dispose };
    },
  });
  return {
    activations,
    allProviders,
    disposed,
    hostResources,
    providerCalls,
    publication,
    reconciler,
  };
}

const moduleIdentity = fc.record({
  moduleId: fc.integer({ min: 0, max: 5 }).map((value) => `fixture.module-${value}`),
  version: fc.integer({ min: 1, max: 3 }).map(String),
  contentDigest: fc.oneof(
    fc.integer({ min: 0, max: 20 }).map((value) => `good-${value}`),
    fc.tuple(fc.constantFrom(...failureStages), fc.integer({ min: 0, max: 5 }))
      .map(([stage, value]) => `fail-${stage}-${value}`),
  ),
});

const desiredSnapshot = fc.record({
  registryRevision: fc.integer({ min: 0, max: 40 }),
  modules: fc.uniqueArray(moduleIdentity, { selector: ({ moduleId }) => moduleId }),
});

test("architecture.live-reconcile.property", async () => {
  await fc.assert(fc.asyncProperty(fc.array(desiredSnapshot), async (history) => {
    const harness = createHarness();
    let settledRevision = -1;
    let expected = null;
    for (const snapshot of history) {
      const result = await harness.reconciler.reconcile(snapshot);
      if (snapshot.registryRevision > settledRevision) {
        settledRevision = snapshot.registryRevision;
        const candidate = normalized(snapshot);
        const changed = expected === null || !sameGraph(expected, candidate);
        const stage = changed ? injectedFailure(candidate)?.stage : undefined;
        if (stage !== "prepare" && stage !== "validate" && stage !== "publish") {
          expected = candidate;
        }
      }
      assert.deepEqual(
        harness.reconciler.accepted?.desired ?? null,
        expected,
        `result ${result.disposition} diverged at desired revision ${snapshot.registryRevision}`,
      );
    }
    await harness.reconciler.dispose().catch(() => undefined);
    assert.equal(new Set(harness.disposed).size, harness.disposed.length);
  }), propertyParameters());

  const harness = createHarness();
  for (const [index, stage] of failureStages.entries()) {
    const result = await harness.reconciler.reconcile({
      registryRevision: index + 1,
      modules: [{
        moduleId: "fixture.failure-owner",
        version: String(index + 1),
        contentDigest: `fail-${stage}-fixture`,
      }],
    });
    if (stage === "dispose") {
      assert.equal(result.disposition, "applied");
    } else {
      assert.equal(result.disposition, "rejected");
      assert.equal(result.diagnostic?.stage, stage);
      assert.equal(result.diagnostic?.moduleId, "fixture.failure-owner");
      assert.match(result.diagnostic?.activationId ?? "", /^fixture\.failure-owner@/);
    }
  }
  const disposeFailure = await harness.reconciler.reconcile({
    registryRevision: failureStages.length + 1,
    modules: [{
      moduleId: "fixture.replacement",
      version: "1",
      contentDigest: "good-replacement",
    }],
  });
  assert.equal(disposeFailure.disposition, "applied");
  assert.equal(disposeFailure.diagnostic?.stage, "dispose");
  assert.equal(disposeFailure.diagnostic?.moduleId, "fixture.failure-owner");
  const observeFailure = await harness.reconciler.reconcile({
    registryRevision: -1,
    modules: [],
  });
  assert.equal(observeFailure.disposition, "rejected");
  assert.equal(observeFailure.diagnostic?.stage, "observe");
  await harness.reconciler.dispose().catch(() => undefined);
});

test("architecture.catalog-atomicity.property", async () => {
  await fc.assert(fc.asyncProperty(desiredSnapshot, desiredSnapshot, async (left, right) => {
    const publication = new runtime.AtomicRuntimePublication(familyFor(left, 1, [], [], "accepted"));
    const oldFamily = publication.getSnapshot();
    const nextFamily = familyFor(right, 2, [], [], "accepted");
    const observations = [publication.getSnapshot()];
    const unsubscribe = publication.subscribe(() => { observations.push(publication.getSnapshot()); });
    publication.publish(nextFamily);
    observations.push(publication.getSnapshot());
    unsubscribe();
    assert.equal(publication.getSnapshot(), nextFamily);
    assert.ok(observations.every((family) => family === oldFamily || family === nextFamily));
    assert.ok(observations.every((family) =>
      family.identities.length === family.contributions.length
      && Object.keys(family.services).length === family.identities.length));
  }), propertyParameters());

  const initial = familyFor({ registryRevision: 0, modules: [] }, 0, [], [], "accepted");
  const successor = familyFor({ registryRevision: 1, modules: [] }, 1, [], [], "accepted");
  const publication = new runtime.AtomicRuntimePublication(initial);
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    publication.subscribe(() => { throw new Error("injected observer failure"); });
    assert.doesNotThrow(() => publication.publish(successor));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(publication.getSnapshot(), successor);
});

test("architecture.runtime-revision.property", async () => {
  await fc.assert(fc.asyncProperty(fc.array(desiredSnapshot), async (notifications) => {
    const harness = createHarness();
    const applied = [];
    for (const notification of notifications) {
      const result = await harness.reconciler.reconcile(notification);
      if (result.disposition === "applied") applied.push(result.desiredRevision);
    }
    assert.ok(applied.every((revision, index) => index === 0 || revision > applied[index - 1]));
    let settled = -1;
    let expected = null;
    for (const snapshot of notifications) {
      if (snapshot.registryRevision <= settled) continue;
      settled = snapshot.registryRevision;
      const candidate = normalized(snapshot);
      const changed = expected === null || !sameGraph(expected, candidate);
      const stage = changed ? injectedFailure(candidate)?.stage : undefined;
      if (stage !== "prepare" && stage !== "validate" && stage !== "publish") {
        expected = candidate;
      }
    }
    assert.equal(
      harness.reconciler.accepted?.desired.registryRevision,
      expected?.registryRevision,
    );
    await harness.reconciler.dispose().catch(() => undefined);
  }), propertyParameters());
});

test("architecture.terminal-plugin-continuity.property", async () => {
  await fc.assert(fc.asyncProperty(fc.array(desiredSnapshot), async (history) => {
    const harness = createHarness();
    for (const snapshot of history) {
      await harness.reconciler.reconcile(snapshot);
      assert.equal(harness.publication.getSnapshot().hostResources, harness.hostResources);
    }
    await harness.reconciler.dispose().catch(() => undefined);
  }), propertyParameters());
});

test("architecture.runtime-inspection.property", async () => {
  await fc.assert(fc.asyncProperty(desiredSnapshot, async (snapshot) => {
    const harness = createHarness();
    const result = await harness.reconciler.reconcile(snapshot);
    if (result.disposition === "applied") {
      const family = harness.publication.getSnapshot();
      const owners = new Set(family.identities);
      assert.ok(family.contributions.every(({ ownerActivationId }) => owners.has(ownerActivationId)));
      assert.ok(family.inspection.services.every(({ ownerActivationId }) => owners.has(ownerActivationId)));
      assert.ok(family.inspection.effects.every(({ ownerActivationId }) => owners.has(ownerActivationId)));
      assert.ok(family.inspection.activations.every((activation) =>
        activation.desiredRevision === snapshot.registryRevision
        && activation.grants.length === 1
        && activation.leases.length === 1));
    } else if (result.disposition === "rejected") {
      assert.equal(result.diagnostic?.desiredRevision, snapshot.registryRevision);
      assert.match(result.diagnostic?.code ?? "", /^module\.runtime\./);
      assert.ok(result.diagnostic?.moduleId);
      assert.ok(result.diagnostic?.activationId);
    }
    await harness.reconciler.dispose().catch(() => undefined);
  }), propertyParameters());

  await fc.assert(fc.property(
    fc.uniqueArray(moduleIdentity, { minLength: 1, selector: ({ moduleId }) => moduleId }),
    (modules) => {
      const desired = normalized({ registryRevision: 1, modules });
      const family = familyFor(desired, 1, [], [], "accepted");
      const contexts = new Map(modules.map((module) => [module.moduleId, {}]));
      const expected = new Map(modules.map((module) => [module.moduleId, activationId(module)]));
      assertCompleteRuntimeFamily({
        modules: modules.map(({ moduleId }) => ({ id: moduleId })),
        activationContextsByModule: contexts,
        inspection: family.inspection,
        expectedActivationIdsByModule: expected,
      });
      const [first] = family.inspection.contributions;
      assert.throws(
        () => assertCompleteRuntimeFamily({
          modules: modules.map(({ moduleId }) => ({ id: moduleId })),
          activationContextsByModule: contexts,
          inspection: {
            ...family.inspection,
            contributions: [{ ...first, ownerActivationId: "fixture.missing@1#digest" }],
          },
          expectedActivationIdsByModule: expected,
        }),
        (error) => error.code === "module.runtime.owner_missing"
          && error.moduleId === first.moduleId,
      );
    },
  ), propertyParameters());
});

test("architecture.service-routing.property", async () => {
  await fc.assert(fc.asyncProperty(fc.array(desiredSnapshot), async (history) => {
    const harness = createHarness();
    for (const snapshot of history) {
      const before = harness.publication.getSnapshot();
      const result = await harness.reconciler.reconcile(snapshot);
      const publicFamily = harness.publication.getSnapshot();
      if (result.disposition === "rejected") assert.equal(publicFamily, before);
      for (const [moduleId, provider] of Object.entries(publicFamily.services)) {
        const identity = publicFamily.identities.find((value) => value.startsWith(`${moduleId}@`));
        assert.equal(provider.invoke(), identity);
      }
      assert.ok(harness.providerCalls.every(({ state }) => state === "accepted"));
      assert.ok(harness.allProviders
        .filter(({ state }) => state === "disposed")
        .every((provider) => !Object.values(publicFamily.services).includes(provider)));
    }
    await harness.reconciler.dispose().catch(() => undefined);
    for (const provider of harness.allProviders) {
      assert.equal(provider.state, "disposed");
      assert.throws(() => provider.invoke(), /provider is disposed/);
    }
  }), propertyParameters());
});

test("architecture.runtime-restart.property", async () => {
  await fc.assert(fc.asyncProperty(fc.array(desiredSnapshot), async (history) => {
    const live = createHarness();
    let accepted = null;
    let durableDesired = null;
    let settledRevision = -1;
    for (const snapshot of history) {
      await live.reconciler.reconcile(snapshot);
      if (snapshot.registryRevision > settledRevision) {
        settledRevision = snapshot.registryRevision;
        durableDesired = normalized(snapshot);
        const candidate = normalized(snapshot);
        const changed = accepted === null || !sameGraph(accepted, candidate);
        const stage = changed ? injectedFailure(candidate)?.stage : undefined;
        if (stage !== "prepare" && stage !== "validate" && stage !== "publish") {
          accepted = candidate;
        }
      }
    }
    const restarted = createHarness();
    if (accepted !== null) {
      await restarted.reconciler.reconcile(accepted);
    }
    if (durableDesired !== null
      && (accepted === null || durableDesired.registryRevision > accepted.registryRevision)) {
      await restarted.reconciler.reconcile(durableDesired);
    }
    assert.deepEqual(restarted.reconciler.accepted?.desired, live.reconciler.accepted?.desired);
    assert.deepEqual(
      restarted.publication.getSnapshot().identities,
      live.publication.getSnapshot().identities,
    );
    assert.deepEqual(
      restarted.publication.getSnapshot().inspection.activations,
      live.publication.getSnapshot().inspection.activations,
    );
    await restarted.reconciler.dispose().catch(() => undefined);
    await live.reconciler.dispose().catch(() => undefined);
  }), propertyParameters());
});
