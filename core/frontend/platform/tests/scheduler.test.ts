import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  RegisterScheduleInput,
  ScheduleLeaseInspection,
  SchedulerService,
} from "@shipctl/module-api";
import type {
  SemanticServiceTestHost as SemanticServiceTestHostType,
  createTestActivationIdentity as CreateTestActivationIdentity,
} from "@shipctl/module-api/testing";
import { createServer, type ViteDevServer } from "vite";

import type {
  SchedulerDeliveryFrame as SchedulerDeliveryFrameType,
  SchedulerServiceProviderOptions,
  SchedulerTransport,
} from "../scheduler.ts";

type SchedulerModule = typeof import("../scheduler.ts");
type ModuleApi = typeof import("@shipctl/module-api");

let vite: ViteDevServer;
let createSchedulerServiceProvider: SchedulerModule["createSchedulerServiceProvider"];
let createSchedulerTransport: SchedulerModule["createSchedulerTransport"];
let schedulerService: ModuleApi["schedulerService"];
let SemanticServiceTestHost: typeof SemanticServiceTestHostType;
let createTestActivationIdentity: typeof CreateTestActivationIdentity;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
  });
  ({ createSchedulerServiceProvider, createSchedulerTransport } = await vite.ssrLoadModule(
    "/core/frontend/platform/scheduler.ts",
  ) as SchedulerModule);
  ({ schedulerService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi);
  ({ SemanticServiceTestHost, createTestActivationIdentity } = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ));
});

after(async () => {
  await vite.close();
});

const MODULE_ID = "shipctl.fixture";
const ACTIVATION_ID = "shipctl.fixture@digest#one";
const BRIDGE_ID = "bridge-one";
const DIGEST = "a".repeat(64);

function scheduleInput(scheduleId = "fixture.periodic"): RegisterScheduleInput<unknown> {
  return {
    scheduleId,
    cron: "* * * * * Etc/UTC",
    target: {
      kind: "channel",
      endpoint: {
        id: "fixture.schedule-target",
        message: { id: "fixture.schedule-fired", version: 1 },
      },
    },
    payload: {},
  };
}

function inspection(scheduleId = "fixture.periodic"): ScheduleLeaseInspection {
  return {
    schemaVersion: 1,
    leaseId: "lease-one",
    ownerModuleId: MODULE_ID,
    ownerActivationId: ACTIVATION_ID,
    scheduleId,
    definitionDigestSha256: DIGEST,
    registeredAtUnixMs: 1,
  };
}

function binding(): SchedulerServiceProviderOptions["bindingsByActivation"] {
  return new Map([[ACTIVATION_ID, {
    moduleId: MODULE_ID as never,
    activationId: ACTIVATION_ID,
    bridgeId: BRIDGE_ID,
  }]]);
}

test("scheduler transport owns the private Tauri command and Channel mapping", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const channel = { onmessage: null as ((frame: SchedulerDeliveryFrameType) => void) | null };
  const transport = createSchedulerTransport(
    async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "observe_semantic_schedule_deliveries") return "observer-one" as T;
      if (command === "inspect_semantic_schedules") return [] as T;
      if (command === "register_semantic_schedule") return inspection() as T;
      return true as T;
    },
    () => channel,
  );
  const request = {
    bridgeId: BRIDGE_ID,
    activation: { moduleId: MODULE_ID as never, activationId: ACTIVATION_ID as never },
    correlationId: "request-one" as never,
    input: { owner: "activation" as const },
  };

  await transport.inspect(request);
  await transport.observe(request, () => undefined);
  await transport.stopObserver({ ...request, input: { observerId: "observer-one" } });

  assert.deepEqual(calls.map(({ command }) => command), [
    "inspect_semantic_schedules",
    "observe_semantic_schedule_deliveries",
    "stop_semantic_schedule_observer",
  ]);
  assert.equal(calls[1]?.args?.onDelivery, channel);
  assert.equal(typeof channel.onmessage, "function");
});

test("production adapter preserves identity, order, and activation-owned cleanup", async () => {
  const calls: Array<{ operation: string; request: unknown }> = [];
  let deliver: ((frame: SchedulerDeliveryFrameType) => void) | undefined;
  const transport: SchedulerTransport = {
    async register(request) {
      calls.push({ operation: "register", request });
      return inspection(request.input.scheduleId);
    },
    async inspect(request) {
      calls.push({ operation: "inspect", request });
      return [inspection()];
    },
    async cancel(request) {
      calls.push({ operation: "cancel", request });
      return true;
    },
    async observe(request, onDelivery) {
      calls.push({ operation: "observe", request });
      deliver = onDelivery;
      return "observer-one";
    },
    async stopObserver(request) {
      calls.push({ operation: "stop", request });
      return true;
    },
  };
  let correlation = 0;
  const provider = createSchedulerServiceProvider({
    bindingsByActivation: binding(),
    transport,
    correlationId: () => `request-${correlation += 1}` as never,
  });
  const host = new SemanticServiceTestHost([provider]);
  const activation = host.activate(createTestActivationIdentity(MODULE_ID, ACTIVATION_ID));
  const service: SchedulerService = activation.context.services.require(schedulerService);

  const registered = await service.registerSchedule.execute(scheduleInput());
  assert.equal(registered.result.ok, true);
  const inspected = await service.inspectSchedules.execute({ owner: "activation" });
  assert.equal(inspected.result.ok, true);
  const observed: number[] = [];
  await service.observeDelivery.subscribe({ owner: "activation" }, async (event) => {
    observed.push(event.sequence);
  });
  deliver?.({
    sequence: 2,
    event: {
      scheduleId: "fixture.periodic",
      occurrenceUtc: "2026-08-16T12:01:00Z",
      outcome: "delivered",
      routeGeneration: 1,
    },
  });
  deliver?.({
    sequence: 1,
    event: {
      scheduleId: "fixture.periodic",
      occurrenceUtc: "2026-08-16T12:00:00Z",
      outcome: "delivered",
      routeGeneration: 1,
    },
  });
  deliver?.({
    sequence: 3,
    event: {
      scheduleId: "fixture.periodic",
      occurrenceUtc: "invalid",
      outcome: "delivered",
      routeGeneration: 1,
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(observed, [2]);

  await activation.dispose();
  deliver?.({
    sequence: 4,
    event: {
      scheduleId: "fixture.periodic",
      occurrenceUtc: "2026-08-16T12:02:00Z",
      outcome: "delivered",
      routeGeneration: 1,
    },
  });
  await Promise.resolve();
  assert.deepEqual(observed, [2]);
  assert.deepEqual(calls.map(({ operation }) => operation), [
    "register", "inspect", "observe", "stop", "cancel",
  ]);
  for (const { request } of calls) {
    const envelope = request as {
      bridgeId: string;
      activation: { moduleId: string; activationId: string };
    };
    assert.equal(envelope.bridgeId, BRIDGE_ID);
    assert.deepEqual(envelope.activation, {
      moduleId: MODULE_ID,
      activationId: ACTIVATION_ID,
    });
  }
});

test("adapter rejects forged responses and redacts unknown transport failures", async () => {
  const invalidTransport: SchedulerTransport = {
    async register() {
      return { ...inspection(), ownerActivationId: "forged" };
    },
    async inspect() {
      throw { code: "private.secret.code", message: "token=secret-value" };
    },
    async cancel() { return true; },
    async observe() { return "observer"; },
    async stopObserver() { return true; },
  };
  const provider = createSchedulerServiceProvider({
    bindingsByActivation: binding(),
    transport: invalidTransport,
    correlationId: () => "request" as never,
  });
  const host = new SemanticServiceTestHost([provider]);
  const activation = host.activate(createTestActivationIdentity(MODULE_ID, ACTIVATION_ID));
  const service: SchedulerService = activation.context.services.require(schedulerService);

  const registered = await service.registerSchedule.execute(scheduleInput());
  assert.deepEqual(registered.result, {
    ok: false,
    error: {
      code: "scheduler.response.invalid",
      message: "The scheduler service returned an invalid response",
      retryable: false,
    },
  });
  const inspected = await service.inspectSchedules.execute({ owner: "activation" });
  assert.deepEqual(inspected.result, {
    ok: false,
    error: {
      code: "scheduler.transport.failed",
      message: "The scheduler transport failed",
      retryable: false,
    },
  });
  await activation.dispose();
});
