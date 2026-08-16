import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let createFakeSchedulerServiceProvider;
let createSchedulerServiceProvider;
let createTestActivationIdentity;
let FakeSchedulerClock;
let schedulerService;
let SemanticServiceTestHost;
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
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ schedulerService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeSchedulerServiceProvider,
    createTestActivationIdentity,
    FakeSchedulerClock,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createSchedulerServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/scheduler.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const MODULE_ID = "fixture.scheduler";
const ACTIVATION_ID = "fixture.scheduler@1#active";
const TARGET = {
  kind: "channel",
  endpoint: {
    id: "fixture.schedule-target",
    message: { id: "fixture.schedule-fired", version: 1 },
  },
};

function scheduleId(suffix) {
  return `fixture.${suffix}`;
}

function input(id) {
  return {
    scheduleId: id,
    cron: "* * * * * Etc/UTC",
    target: TARGET,
    payload: { reason: id },
  };
}

class MemorySchedulerTransport {
  calls = [];
  registrations = new Map();
  observers = new Map();
  responseMutation = null;
  failure = null;
  nextLease = 1;
  nextObserver = 1;

  async register(request) {
    this.calls.push({ operation: "register", request });
    if (this.failure) throw this.failure;
    if (this.registrations.has(request.input.scheduleId)) {
      throw {
        code: "scheduler.registration.conflict",
        message: "The schedule identity is already registered",
      };
    }
    const inspection = {
      schemaVersion: 1,
      leaseId: `lease-${this.nextLease}`,
      ownerModuleId: request.activation.moduleId,
      ownerActivationId: request.activation.activationId,
      scheduleId: request.input.scheduleId,
      definitionDigestSha256: "b".repeat(64),
      registeredAtUnixMs: 0,
    };
    this.nextLease += 1;
    this.registrations.set(request.input.scheduleId, inspection);
    return this.responseMutation?.(inspection) ?? inspection;
  }

  async inspect(request) {
    this.calls.push({ operation: "inspect", request });
    if (this.failure) throw this.failure;
    return [...this.registrations.values()]
      .filter((record) => record.ownerActivationId === request.activation.activationId)
      .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
  }

  async cancel(request) {
    this.calls.push({ operation: "cancel", request });
    const record = [...this.registrations.entries()].find(
      ([, inspection]) => inspection.leaseId === request.input.leaseId,
    );
    if (record) this.registrations.delete(record[0]);
    return record !== undefined;
  }

  async observe(request, onDelivery) {
    this.calls.push({ operation: "observe", request });
    const observerId = `observer-${this.nextObserver}`;
    this.nextObserver += 1;
    this.observers.set(observerId, onDelivery);
    return observerId;
  }

  async stopObserver(request) {
    this.calls.push({ operation: "stop", request });
    return this.observers.delete(request.input.observerId);
  }

  emit(frame) {
    for (const observer of this.observers.values()) observer(frame);
  }
}

function productionFixture(transport = new MemorySchedulerTransport()) {
  const identity = createTestActivationIdentity(MODULE_ID, ACTIVATION_ID);
  let nextCorrelation = 1;
  const provider = createSchedulerServiceProvider({
    bindingsByActivation: new Map([[identity.activationId, {
      moduleId: identity.moduleId,
      activationId: identity.activationId,
      bridgeId: "fixture-bridge",
    }]]),
    transport,
    correlationId: () => `request-${nextCorrelation++}`,
  });
  const host = new SemanticServiceTestHost([provider]);
  const activation = host.activate(identity);
  return {
    activation,
    identity,
    service: activation.context.services.require(schedulerService),
    transport,
  };
}

function normalizedInspection(result) {
  if (!result.ok) return result;
  return {
    ok: true,
    value: result.value.map(({ ownerModuleId, ownerActivationId, scheduleId }) => ({
      ownerModuleId,
      ownerActivationId,
      scheduleId,
    })),
  };
}

const suffixArbitrary = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);

test("architecture.service-adapter.scheduler.property", async () => {
  await fc.assert(fc.asyncProperty(suffixArbitrary, async (suffix) => {
    const fixture = productionFixture();
    const outcome = await fixture.service.registerSchedule.execute(input(scheduleId(suffix)));
    assert.equal(outcome.result.ok, true);
    const call = fixture.transport.calls[0];
    assert.equal(call.operation, "register");
    assert.equal(call.request.bridgeId, "fixture-bridge");
    assert.deepEqual(call.request.activation, fixture.identity);
    assert.equal(call.request.correlationId, outcome.correlationId);
    assert.deepEqual(call.request.input, input(scheduleId(suffix)));
    await fixture.activation.dispose();
  }), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.constantFrom("module", "activation", "digest", "schema"),
    async (mutation) => {
      const transport = new MemorySchedulerTransport();
      transport.responseMutation = (inspection) => ({
        ...inspection,
        ...(mutation === "module" ? { ownerModuleId: "fixture.forged" } : {}),
        ...(mutation === "activation" ? { ownerActivationId: "forged" } : {}),
        ...(mutation === "digest" ? { definitionDigestSha256: "secret" } : {}),
        ...(mutation === "schema" ? { schemaVersion: 2 } : {}),
      });
      const fixture = productionFixture(transport);
      const outcome = await fixture.service.registerSchedule.execute(input("fixture.invalid"));
      assert.equal(outcome.result.ok, false);
      assert.equal(outcome.result.error.code, "scheduler.response.invalid");
      await fixture.activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(
      { code: "scheduler.activation.denied", message: "Registration denied" },
      { code: "private.scheduler.secret", message: "token=secret-value" },
      new Error("unknown command register_semantic_schedule"),
    ),
    async (failure) => {
      const transport = new MemorySchedulerTransport();
      transport.failure = failure;
      const fixture = productionFixture(transport);
      const outcome = await fixture.service.registerSchedule.execute(input("fixture.failure"));
      assert.equal(outcome.result.ok, false);
      assert.equal(outcome.result.error.message.includes("secret-value"), false);
      assert.equal(
        outcome.result.error.code,
        failure.code === "scheduler.activation.denied"
          ? "scheduler.activation.denied"
          : String(failure).includes("unknown command")
            ? "scheduler.service.unavailable"
            : "scheduler.transport.failed",
      );
      await fixture.activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-request.scheduler.property", async () => {
  await fc.assert(fc.asyncProperty(suffixArbitrary, async (suffix) => {
    const cancelledFixture = productionFixture();
    const cancelled = await cancelledFixture.service.registerSchedule.execute(
      input(scheduleId(suffix)),
      { cancellation: { cancelled: true } },
    );
    assert.equal(cancelled.result.ok, false);
    assert.equal(cancelled.result.error.code, "scheduler.request.cancelled");
    assert.equal(cancelledFixture.transport.calls.length, 0);
    await cancelledFixture.activation.dispose();

    const disposedFixture = productionFixture();
    await disposedFixture.activation.dispose();
    const disposed = await disposedFixture.service.registerSchedule.execute(input(scheduleId(suffix)));
    assert.equal(disposed.result.ok, false);
    assert.equal(disposed.result.error.code, "scheduler.activation.disposed");
    assert.equal(disposedFixture.transport.calls.length, 0);
  }), propertyParameters());
});

test("architecture.scheduler-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(suffixArbitrary, { minLength: 1, maxLength: 8 }),
    async (suffixes) => {
      const trace = [];
      const provider = createFakeSchedulerServiceProvider({ trace });
      const identity = createTestActivationIdentity(MODULE_ID, ACTIVATION_ID);
      const host = new SemanticServiceTestHost([provider]);
      const activation = host.activate(identity);
      const service = activation.context.services.require(schedulerService);
      for (const suffix of suffixes) {
        const outcome = await service.registerSchedule.execute(input(scheduleId(suffix)));
        assert.equal(outcome.result.ok, true);
      }
      const duplicate = await service.registerSchedule.execute(input(scheduleId(suffixes[0])));
      assert.equal(duplicate.result.ok, false);
      assert.equal(duplicate.result.error.code, "scheduler.registration.conflict");
      const inspected = await service.inspectSchedules.execute({ owner: "activation" });
      assert.equal(inspected.result.ok, true);
      assert.deepEqual(
        inspected.result.value.map(({ scheduleId: id }) => id),
        suffixes.map(scheduleId).sort(),
      );
      assert.equal(trace.filter(({ operation }) => operation === "register").length, suffixes.length + 1);
      await activation.dispose();
    },
  ), propertyParameters());

  const deniedIdentity = createTestActivationIdentity(MODULE_ID, `${ACTIVATION_ID}-denied`);
  const deniedHost = new SemanticServiceTestHost([
    createFakeSchedulerServiceProvider({ deniedGrants: ["schedule.register"] }),
  ]);
  const deniedActivation = deniedHost.activate(deniedIdentity);
  const denied = await deniedActivation.context.services.require(schedulerService)
    .registerSchedule.execute(input("fixture.denied"));
  assert.equal(denied.result.ok, false);
  assert.equal(denied.result.error.code, "scheduler.activation.denied");
  await deniedActivation.dispose();
});

test("architecture.scheduler-adapter-parity.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(suffixArbitrary, { minLength: 1, maxLength: 8 }),
    async (suffixes) => {
      const production = productionFixture();
      const fakeTrace = [];
      const fakeHost = new SemanticServiceTestHost([
        createFakeSchedulerServiceProvider({ trace: fakeTrace }),
      ]);
      const fakeActivation = fakeHost.activate(production.identity);
      const fake = fakeActivation.context.services.require(schedulerService);

      for (const suffix of suffixes) {
        const schedule = input(scheduleId(suffix));
        const current = await production.service.registerSchedule.execute(schedule);
        const modeled = await fake.registerSchedule.execute(schedule);
        assert.equal(modeled.result.ok, current.result.ok);
      }
      const currentInspection = await production.service.inspectSchedules.execute({ owner: "activation" });
      const fakeInspection = await fake.inspectSchedules.execute({ owner: "activation" });
      assert.deepEqual(
        normalizedInspection(fakeInspection.result),
        normalizedInspection(currentInspection.result),
      );
      assert.deepEqual(
        production.transport.calls
          .filter(({ operation }) => operation === "register")
          .map(({ request }) => request.input),
        fakeTrace
          .filter(({ operation }) => operation === "register")
          .map(({ request }) => request.input),
      );
      await fakeActivation.dispose();
      await production.activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-event.scheduler.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 20 }),
    fc.integer({ min: 0, max: 100_000 }),
    async (generatedOccurrences, releaseAt) => {
      const occurrences = [...generatedOccurrences].sort((left, right) => left - right);
      const clock = new FakeSchedulerClock(0);
      clock.setOccurrences("fixture.clock", occurrences);
      const host = new SemanticServiceTestHost([
        createFakeSchedulerServiceProvider({ clock }),
      ]);
      const identity = createTestActivationIdentity(MODULE_ID, ACTIVATION_ID);
      const activation = host.activate(identity);
      const service = activation.context.services.require(schedulerService);
      const events = [];
      await service.observeDelivery.subscribe({ owner: "activation" }, (event) => {
        events.push(event);
      });
      const registered = await service.registerSchedule.execute(input("fixture.clock"));
      assert.equal(registered.result.ok, true);
      await clock.advanceTo(releaseAt);
      await registered.result.value.dispose();
      await clock.advanceTo(100_000);

      const expected = occurrences.filter((occurrence) => occurrence <= releaseAt);
      assert.deepEqual(
        events.map(({ value }) => Date.parse(value.occurrenceUtc)),
        expected,
      );
      assert.deepEqual(events.map(({ sequence }) => sequence), expected.map((_, index) => index + 1));
      await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.scheduler-ownership.property", async () => {
  const [usageModule, composition, publicContract] = await Promise.all([
    readFile(new URL("../../../modules/usage/frontend/src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../core/frontend/host/moduleComposition.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../module-api/frontend/src/module/module.ts", import.meta.url), "utf8"),
  ]);
  assert.match(usageModule, /scheduledTasks:\s*\[/);
  assert.match(usageModule, /target:\s*\{\s*kind:\s*"channel"/);
  assert.doesNotMatch(usageModule, /delayMs|intervalMs|setTimeout|setInterval|writeFile/);
  assert.doesNotMatch(composition, /setTimeout|setInterval|\.shipctl\/schedules/);
  assert.match(publicContract, /Omit<RegisterScheduleInput<unknown>, "scheduleId">/);
  assert.doesNotMatch(publicContract, /readonly run:/);
});
