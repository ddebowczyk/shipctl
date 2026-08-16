import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  MessageEnvelope,
  MessageRouteSnapshot,
  ShipctlModule,
} from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

import type {
  FrontendBridgeRegistration,
  HostMessageFrame,
  MessageBridgeReply,
  RuntimeMessageTransport,
} from "../../platform/runtimeMessages.ts";

type BridgeModule = typeof import("../messageBusBridge.ts");

let vite: ViteDevServer;
let MessageBusBridge: BridgeModule["MessageBusBridge"];
let createModuleMessageActivations: BridgeModule["createModuleMessageActivations"];
let moduleMessageGrants: BridgeModule["moduleMessageGrants"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
  });
  ({
    MessageBusBridge,
    createModuleMessageActivations,
    moduleMessageGrants,
  } = await vite.ssrLoadModule(
    "/core/frontend/host/messageBusBridge.ts",
  ) as BridgeModule);
});

after(async () => {
  await vite.close();
});

const VALUE = { id: "fixture.value", version: 1 } as const;
const RESPONSE = { id: "fixture.response", version: 1 } as const;
const CHANNEL = { id: "fixture.directed", message: VALUE } as const;
const TOPIC = { id: "fixture.events", message: VALUE } as const;
const PORT = { id: "fixture.lookup", request: VALUE, response: RESPONSE } as const;

function snapshot(routeGeneration = 7): MessageRouteSnapshot {
  return {
    schemaVersion: 1,
    instanceId: "fixture-instance",
    incarnation: "fixture-incarnation",
    routeGeneration,
    channels: [],
    topics: [],
    ports: [],
  };
}

class FakeTransport implements RuntimeMessageTransport {
  registrations: readonly FrontendBridgeRegistration[] = [];
  onFrame: ((frame: HostMessageFrame) => void) | null = null;
  closes = 0;
  calls: Array<{ kind: string; bridgeId: string; activationId: string }> = [];
  replies: MessageBridgeReply[] = [];
  failureReports: Array<{
    bridgeId: string;
    activationId: string;
    endpoint: string;
    code: string;
  }> = [];
  reconcileFailure: Error | null = null;

  async open(
    registrations: readonly FrontendBridgeRegistration[],
    onFrame: (frame: HostMessageFrame) => void,
  ) {
    this.registrations = registrations;
    this.onFrame = onFrame;
    return { schemaVersion: 1 as const, bridgeId: "fixture-bridge", snapshot: snapshot() };
  }

  async reconcile(
    _bridgeId: string,
    expectedRouteGeneration: number,
    registrations: readonly FrontendBridgeRegistration[],
  ) {
    if (this.reconcileFailure) throw this.reconcileFailure;
    this.registrations = registrations;
    return {
      schemaVersion: 1 as const,
      bridgeId: "fixture-bridge",
      snapshot: snapshot(expectedRouteGeneration + 1),
    };
  }

  async close() {
    this.closes += 1;
    return snapshot(8);
  }

  async send(bridgeId: string, activationId: string, envelope: MessageEnvelope) {
    this.calls.push({ kind: `send:${envelope.endpoint}`, bridgeId, activationId });
    return {
      schemaVersion: 1,
      endpoint: envelope.endpoint,
      message: envelope.message,
      routeGeneration: 7,
    };
  }

  async publish(bridgeId: string, activationId: string, envelope: MessageEnvelope) {
    this.calls.push({ kind: `publish:${envelope.endpoint}`, bridgeId, activationId });
    return {
      schemaVersion: 1,
      endpoint: envelope.endpoint,
      message: envelope.message,
      routeGeneration: 7,
      subscriberCount: 1,
    };
  }

  async request(bridgeId: string, activationId: string, envelope: MessageEnvelope) {
    this.calls.push({ kind: `request:${envelope.endpoint}`, bridgeId, activationId });
    return {
      schemaVersion: 1,
      endpoint: envelope.endpoint,
      message: RESPONSE,
      payload: { value: 4 },
    };
  }

  async reply(_bridgeId: string, reply: MessageBridgeReply) {
    this.replies.push(reply);
  }

  async reportFailure(bridgeId: string, activationId: string, endpoint: string, code: string) {
    this.failureReports.push({ bridgeId, activationId, endpoint, code });
  }
}

function frame(
  sequence: number,
  kind: HostMessageFrame["kind"],
  endpoint: string,
  activationId = "fixture@digest#one",
  routeGeneration = 7,
): HostMessageFrame {
  return {
    schemaVersion: 1,
    bridgeId: "fixture-bridge",
    sequence,
    routeGeneration,
    activationId,
    kind,
    endpoint,
    message: VALUE,
    payload: { value: sequence },
    ...(kind === "portRequest" ? { correlationId: `reply-${sequence}` } : {}),
  };
}

test("activation facade binds identity and bridge while declarations stay data-only", async () => {
  const transport = new FakeTransport();
  const module: ShipctlModule = {
    id: "fixture",
    version: "1.0.0",
    messages: {
      handles: [{
        channel: CHANNEL,
        capacity: 2,
        requiredGrant: "message.send.fixture.directed",
        schedulerAllowed: true,
        handle: () => undefined,
      }],
      publishes: [{
        topic: TOPIC,
        capacity: 3,
        requiredGrant: "message.publish.fixture.events",
      }],
      subscribes: [{ topic: TOPIC, handle: () => undefined }],
      ports: [{
        port: PORT,
        capacity: 1,
        requiredGrant: "message.request.fixture.lookup",
        schedulerAllowed: false,
        handle: () => ({ value: 4 }),
      }],
    },
  };
  const activations = createModuleMessageActivations(
    [module],
    () => "fixture@digest#one",
  );
  const bridge = new MessageBusBridge(activations, transport);
  const opened = await bridge.open();
  const client = opened.clientsByActivation.get("fixture@digest#one")?.client;
  assert(client);

  await client.send({
    schemaVersion: 1,
    endpoint: CHANNEL.id,
    message: CHANNEL.message,
    payload: { value: 1 },
    correlationId: "send-1",
  });
  await client.publish({
    schemaVersion: 1,
    endpoint: TOPIC.id,
    message: TOPIC.message,
    payload: { value: 2 },
    correlationId: "publish-1",
  });
  const response = await client.request({
    schemaVersion: 1,
    endpoint: PORT.id,
    message: PORT.request,
    payload: { value: 3 },
    correlationId: "request-1",
  }) as MessageEnvelope;
  assert.deepEqual(response.payload, { value: 4 });
  assert.deepEqual(
    transport.calls,
    [
      { kind: "send:fixture.directed", bridgeId: "fixture-bridge", activationId: "fixture@digest#one" },
      { kind: "publish:fixture.events", bridgeId: "fixture-bridge", activationId: "fixture@digest#one" },
      { kind: "request:fixture.lookup", bridgeId: "fixture-bridge", activationId: "fixture@digest#one" },
    ],
  );
  assert.deepEqual(moduleMessageGrants(module), [
    "message.send.fixture.directed",
    "message.publish.fixture.events",
    "message.request.fixture.lookup",
    "message.subscribe.fixture.events",
  ]);
  assert.equal(transport.registrations[0]?.activationId, "fixture@digest#one");
  assert.equal(transport.registrations[0]?.declarations.handles[0]?.endpoint.id, CHANNEL.id);
});

test("schedule-only modules receive an admitted scheduler binding and grant", async () => {
  const transport = new FakeTransport();
  const module: ShipctlModule = {
    id: "fixture.scheduler",
    version: "1.0.0",
    scheduledTasks: [{
      id: "fixture.refresh",
      moduleId: "fixture.scheduler",
      schedule: {
        cron: "* * * * * Etc/UTC",
        target: { kind: "channel", endpoint: CHANNEL },
        payload: { value: 1 },
      },
    }],
  };
  const activationId = "fixture.scheduler@digest#one";
  const activations = createModuleMessageActivations([module], () => activationId);
  assert.equal(activations.length, 1);
  assert.deepEqual(moduleMessageGrants(module), ["schedule.register"]);

  const bridge = new MessageBusBridge(activations, transport);
  const opened = await bridge.open();
  assert.deepEqual(opened.schedulerBindingsByActivation.get(activationId), {
    moduleId: "fixture.scheduler",
    activationId,
    bridgeId: "fixture-bridge",
  });
  assert.deepEqual(transport.registrations[0]?.grants, [{
    id: "schedule.register",
    effective: true,
  }]);
  await bridge.close();
});

test("terminal-only modules receive one activation identity and exact grants", async () => {
  const transport = new FakeTransport();
  const module: ShipctlModule = {
    id: "fixture.terminal",
    version: "1.0.0",
    requiredGrants: ["terminal.attach", "terminal.input", "terminal.attach"],
  };
  const activationId = "fixture.terminal@digest#one";
  const activations = createModuleMessageActivations([module], () => activationId);
  assert.equal(activations.length, 1);
  assert.deepEqual(moduleMessageGrants(module), ["terminal.attach", "terminal.input"]);

  const bridge = new MessageBusBridge(activations, transport);
  const opened = await bridge.open();
  assert.deepEqual(opened.activationIdsByModule.get("fixture.terminal"), activationId);
  assert.deepEqual(
    [...(opened.terminalBindingsByActivation.get(activationId)?.grants ?? [])],
    ["terminal.attach", "terminal.input"],
  );
  assert.deepEqual(transport.registrations[0]?.grants, [
    { id: "terminal.attach", effective: true },
    { id: "terminal.input", effective: true },
  ]);
  await bridge.close();
});

test("ordered dispatch contains handler failure and rejects stale activations", async () => {
  const calls: string[] = [];
  const transport = new FakeTransport();
  const module: ShipctlModule = {
    id: "fixture",
    version: "1.0.0",
    messages: {
      handles: [{
        channel: CHANNEL,
        capacity: 1,
        requiredGrant: "message.send.fixture.directed",
        schedulerAllowed: false,
        handle: async () => {
          calls.push("directed");
          throw new Error("secret payload must not enter the bridge result");
        },
      }],
      subscribes: [{
        topic: TOPIC,
        handle: () => { calls.push("broadcast"); },
      }],
      ports: [{
        port: PORT,
        capacity: 1,
        requiredGrant: "message.request.fixture.lookup",
        schedulerAllowed: false,
        handle: () => ({ value: 9 }),
      }],
    },
  };
  const bridge = new MessageBusBridge(
    createModuleMessageActivations([module], () => "fixture@digest#one"),
    transport,
  );
  await bridge.open();
  transport.onFrame?.(frame(1, "directed", CHANNEL.id));
  transport.onFrame?.(frame(2, "broadcast", TOPIC.id));
  transport.onFrame?.(frame(3, "portRequest", PORT.id));
  await bridge.settled();

  assert.deepEqual(calls, ["directed", "broadcast"]);
  assert.equal(transport.replies[0]?.response?.payload &&
    (transport.replies[0]?.response?.payload as { value: number }).value, 9);
  const stale = await bridge.dispatch(frame(4, "directed", CHANNEL.id, "fixture@digest#old"));
  assert.deepEqual(stale, {
    sequence: 4,
    accepted: false,
    code: "message.route.generation_changed",
  });

  await bridge.close();
  await bridge.close();
  assert.equal(transport.closes, 1);
});

test("broadcast contains a failed subscriber, diagnoses it, and continues dispatch", async () => {
  const calls: string[] = [];
  const transport = new FakeTransport();
  const module: ShipctlModule = {
    id: "fixture",
    version: "1.0.0",
    messages: {
      subscribes: [
        {
          topic: TOPIC,
          handle: () => {
            calls.push("failing");
            throw new Error("subscriber failure stays local");
          },
        },
        {
          topic: TOPIC,
          handle: () => { calls.push("healthy"); },
        },
      ],
    },
  };
  const bridge = new MessageBusBridge(
    createModuleMessageActivations([module], () => "fixture@digest#one"),
    transport,
  );
  await bridge.open();

  assert.deepEqual(await bridge.dispatch(frame(1, "broadcast", TOPIC.id)), {
    sequence: 1,
    accepted: false,
    code: "message.handler.failed",
  });
  assert.deepEqual(calls, ["failing", "healthy"]);
  assert.deepEqual(transport.failureReports, [{
    bridgeId: "fixture-bridge",
    activationId: "fixture@digest#one",
    endpoint: TOPIC.id,
    code: "message.handler.failed",
  }]);

  await bridge.close();
});

test("reconciliation swaps activation ownership only after native publication succeeds", async () => {
  const calls: string[] = [];
  const moduleFor = (version: string, marker: string): ShipctlModule => ({
    id: "fixture",
    version,
    messages: {
      handles: [{
        channel: CHANNEL,
        capacity: 1,
        requiredGrant: "message.send.fixture.directed",
        schedulerAllowed: false,
        handle: () => { calls.push(marker); },
      }],
    },
  });
  const transport = new FakeTransport();
  const bridge = new MessageBusBridge(
    createModuleMessageActivations([moduleFor("1.0.0", "a")], () => "fixture@sha-a#a"),
    transport,
  );
  await bridge.open();
  assert.equal((await bridge.dispatch(
    frame(1, "directed", CHANNEL.id, "fixture@sha-a#a"),
  )).accepted, true);

  const messages = await bridge.reconcile(
    createModuleMessageActivations([moduleFor("2.0.0", "b")], () => "fixture@sha-b#b"),
  );
  assert(messages.has("fixture@sha-b#b"));
  assert.equal((await bridge.dispatch(
    frame(2, "directed", CHANNEL.id, "fixture@sha-a#a", 7),
  )).accepted, false);
  assert.equal((await bridge.dispatch(
    frame(3, "directed", CHANNEL.id, "fixture@sha-b#b", 8),
  )).accepted, true);

  transport.reconcileFailure = new Error("message.route.generation_changed");
  await assert.rejects(() => bridge.reconcile(
    createModuleMessageActivations([moduleFor("3.0.0", "c")], () => "fixture@sha-c#c"),
  ));
  assert.equal((await bridge.dispatch(
    frame(4, "directed", CHANNEL.id, "fixture@sha-b#b", 8),
  )).accepted, true);
  assert.deepEqual(calls, ["a", "b", "b"]);
  await bridge.close();
});
