import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let createFakeMessagesServiceProvider;
let createMessagesServiceProvider;
let createModuleMessageActivations;
let createTestActivationIdentity;
let MessageBusBridge;
let messagesService;
let moduleMessageGrants;
let SemanticServiceRegistry;
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
  ({ messagesService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeMessagesServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createMessagesServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/messages.ts",
  ));
  ({
    createModuleMessageActivations,
    MessageBusBridge,
    moduleMessageGrants,
  } = await vite.ssrLoadModule("/core/frontend/host/messageBusBridge.ts"));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const VALUE = { id: "fixture.value", version: 1 };
const RESPONSE = { id: "fixture.response", version: 1 };
const CHANNEL = { id: "fixture.directed", message: VALUE };
const TOPIC = { id: "fixture.events", message: VALUE };
const PORT = { id: "fixture.lookup", request: VALUE, response: RESPONSE };
const MAX_ENCODED_BYTES = new TextEncoder().encode(
  JSON.stringify({ value: Number.MIN_SAFE_INTEGER }),
).byteLength;

function contract(message, name) {
  const root = `fixture/${name}.schema.json`;
  return {
    message,
    schema: {
      draft: "https://json-schema.org/draft/2020-12/schema",
      root,
      resources: {
        [root]: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: `shipctl-artifact:///${root}`,
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "integer" } },
        },
      },
      maxEncodedBytes: MAX_ENCODED_BYTES,
      redactedFields: [],
      compatibleVersions: [1],
    },
  };
}

function fixtureModule({
  id = "fixture.owner",
  directed = () => undefined,
  broadcast = () => undefined,
  request = ({ value }) => ({ value }),
} = {}) {
  return {
    id,
    version: "1.0.0",
    messages: {
      provides: [contract(VALUE, "value"), contract(RESPONSE, "response")],
      handles: [{
        channel: CHANNEL,
        capacity: 1,
        requiredGrant: "message.send.fixture.directed",
        schedulerAllowed: false,
        handle: directed,
      }],
      publishes: [{
        topic: TOPIC,
        capacity: 1,
        requiredGrant: "message.publish.fixture.events",
        schedulerAllowed: false,
      }],
      subscribes: [{ topic: TOPIC, handle: broadcast }],
      ports: [{
        port: PORT,
        capacity: 1,
        requiredGrant: "message.request.fixture.lookup",
        schedulerAllowed: false,
        handle: request,
      }],
    },
  };
}

function snapshot(routeGeneration = 1) {
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

class MemoryRuntimeMessageTransport {
  calls = [];
  closes = 0;
  onFrame = null;
  responseMutation = null;
  failure = null;

  async open(_registrations, onFrame) {
    this.onFrame = onFrame;
    return { schemaVersion: 1, bridgeId: "fixture-bridge", snapshot: snapshot() };
  }

  async reconcile(_bridgeId, expectedRouteGeneration) {
    return {
      schemaVersion: 1,
      bridgeId: "fixture-bridge",
      snapshot: snapshot(expectedRouteGeneration + 1),
    };
  }

  async close() {
    this.closes += 1;
    return snapshot(2);
  }

  async send(bridgeId, activationId, envelope) {
    if (this.failure) throw new Error(this.failure);
    this.calls.push({ operation: "send", bridgeId, activationId, envelope });
    const response = {
      schemaVersion: 1,
      endpoint: envelope.endpoint,
      message: envelope.message,
      routeGeneration: 1,
    };
    return this.responseMutation?.(response) ?? response;
  }

  async publish(bridgeId, activationId, envelope) {
    if (this.failure) throw new Error(this.failure);
    this.calls.push({ operation: "publish", bridgeId, activationId, envelope });
    const response = {
      schemaVersion: 1,
      endpoint: envelope.endpoint,
      message: envelope.message,
      routeGeneration: 1,
      subscriberCount: 1,
    };
    return this.responseMutation?.(response) ?? response;
  }

  async request(bridgeId, activationId, envelope) {
    if (this.failure) throw new Error(this.failure);
    this.calls.push({ operation: "request", bridgeId, activationId, envelope });
    const response = {
      schemaVersion: 1,
      endpoint: envelope.endpoint,
      message: RESPONSE,
      payload: structuredClone(envelope.payload),
      correlationId: envelope.correlationId,
    };
    return this.responseMutation?.(response) ?? response;
  }

  async reply() {}
  async reportFailure() {}
}

async function productionFixture(module = fixtureModule()) {
  const identity = createTestActivationIdentity(
    module.id,
    `${module.id}@${module.version}#fixture`,
  );
  const transport = new MemoryRuntimeMessageTransport();
  const bridge = new MessageBusBridge(
    createModuleMessageActivations([module], () => identity.activationId),
    transport,
  );
  const opened = await bridge.open();
  const registry = new SemanticServiceRegistry([
    createMessagesServiceProvider({
      clientsByActivation: opened.clientsByActivation,
      deactivateActivation: (activationId) => bridge.deactivateActivation(activationId),
    }),
  ]);
  const activation = registry.activate(identity);
  const service = activation.context.services.require(messagesService);
  return { activation, bridge, identity, service, transport };
}

function execute(service, operation, value, options) {
  if (operation === "send") {
    return service.sendMessage.execute({ channel: CHANNEL, payload: { value } }, options);
  }
  if (operation === "publish") {
    return service.publishMessage.execute({ topic: TOPIC, payload: { value } }, options);
  }
  return service.requestMessage.execute({ port: PORT, payload: { value } }, options);
}

test("architecture.service-adapter.messages.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.shuffledSubarray(["send", "publish", "request"], { minLength: 3, maxLength: 3 }),
    fc.integer(),
    async (operations, value) => {
      const fixture = await productionFixture();
      for (const operation of operations) {
        const outcome = await execute(fixture.service, operation, value);
        assert.equal(outcome.result.ok, true);
        const call = fixture.transport.calls.at(-1);
        assert.equal(call.operation, operation);
        assert.equal(call.activationId, fixture.identity.activationId);
        assert.equal(call.envelope.correlationId, outcome.correlationId);
        assert.deepEqual(call.envelope.payload, { value });
      }
      await fixture.activation.dispose();
      await fixture.bridge.close();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(
      "message.sender.unauthorized: denied",
      "message.payload.too_large: rejected",
      "unknown command",
      "transport included secret-token-value",
    ),
    async (failure) => {
      const fixture = await productionFixture();
      fixture.transport.failure = failure;
      const outcome = await fixture.service.sendMessage.execute({
        channel: CHANNEL,
        payload: { value: 1 },
      });
      assert.equal(outcome.result.ok, false);
      assert.equal(
        outcome.result.error.code,
        failure.startsWith("message.sender")
          ? "message.sender.unauthorized"
          : failure.startsWith("message.payload")
            ? "message.payload.too_large"
            : failure === "unknown command"
              ? "message.transport.unavailable"
              : "message.transport.failed",
      );
      assert.equal(outcome.result.error.message.includes("secret-token-value"), false);
      await fixture.activation.dispose();
      await fixture.bridge.close();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.constantFrom("endpoint", "message", "correlation", "malformed"),
    async (mutation) => {
      const fixture = await productionFixture();
      fixture.transport.responseMutation = (response) => mutation === "malformed"
        ? { schemaVersion: 1 }
        : ({
        ...response,
        ...(mutation === "endpoint" ? { endpoint: "fixture.changed" } : {}),
        ...(mutation === "message" ? { message: VALUE } : {}),
        ...(mutation === "correlation" ? { correlationId: "forged" } : {}),
        });
      const outcome = await fixture.service.requestMessage.execute({
        port: PORT,
        payload: { value: 1 },
      });
      assert.equal(outcome.result.ok, false);
      assert.equal(outcome.result.error.code, "message.response.invalid");
      await fixture.activation.dispose();
      await fixture.bridge.close();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.constantFrom("", "fixture\ninvalid"),
    async (endpoint) => {
      const fixture = await productionFixture();
      const outcome = await fixture.service.sendMessage.execute({
        channel: { ...CHANNEL, id: endpoint },
        payload: { value: 1 },
      });
      assert.equal(outcome.result.ok, false);
      assert.equal(
        outcome.result.error.code,
        endpoint === ""
          ? "message.contract.invalid_json"
          : "message.contract.identifier.invalid",
      );
      assert.equal(fixture.transport.calls.length, 0);
      await fixture.activation.dispose();
      await fixture.bridge.close();
    },
  ), propertyParameters());

  await fc.assert(fc.property(
    fc.stringMatching(/^[a-z][a-z0-9-]*$/),
    (suffix) => {
      const identity = createTestActivationIdentity(
        `fixture.${suffix}`,
        `fixture.${suffix}@1#identity-check`,
      );
      const deactivated = [];
      const registry = new SemanticServiceRegistry([
        createMessagesServiceProvider({
          clientsByActivation: new Map([[identity.activationId, {
            moduleId: "fixture.substituted",
            activationId: identity.activationId,
            client: {
              send: async () => ({}),
              publish: async () => ({}),
              request: async () => ({}),
            },
          }]]),
          deactivateActivation: (activationId) => { deactivated.push(activationId); },
        }),
      ]);
      const activation = registry.activate(identity);
      assert.throws(
        () => activation.context.services.require(messagesService),
        /no admitted message bridge client/,
      );
      assert.deepEqual(deactivated, [identity.activationId]);
    },
  ), propertyParameters());
});

test("architecture.service-request.messages.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("send", "publish", "request"),
    fc.integer(),
    async (operation, value) => {
      const fixture = await productionFixture();
      const cancelled = await execute(fixture.service, operation, value, {
        cancellation: { cancelled: true },
      });
      assert.equal(cancelled.result.ok, false);
      assert.equal(cancelled.result.error.code, "message.request.cancelled");
      assert.equal(fixture.transport.calls.length, 0);

      await fixture.activation.dispose();
      const disposed = await execute(fixture.service, operation, value);
      assert.equal(disposed.result.ok, false);
      assert.equal(disposed.result.error.code, "message.activation.disposed");
      assert.equal(fixture.transport.calls.length, 0);
      await fixture.bridge.close();
    },
  ), propertyParameters());
});

test("architecture.messages-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.shuffledSubarray(["send", "publish", "request"], { minLength: 3, maxLength: 3 }),
    fc.integer(),
    async (operations, value) => {
      const handled = [];
      const delivered = [];
      const ownerModule = fixtureModule({
        id: "fixture.owner",
        directed: ({ value: observed }) => { handled.push(["send", observed]); },
        request: ({ value: observed }) => {
          handled.push(["request", observed]);
          return { value: observed };
        },
      });
      const sender = createTestActivationIdentity("fixture.sender", "fixture.sender@1#one");
      const owner = createTestActivationIdentity(ownerModule.id, "fixture.owner@1#one");
      const subscriber = createTestActivationIdentity(
        "fixture.subscriber",
        "fixture.subscriber@1#one",
      );
      const trace = [];
      const provider = createFakeMessagesServiceProvider({
        registrations: [
          {
            activation: sender,
            grants: [
              "message.send.fixture.directed",
              "message.publish.fixture.events",
              "message.request.fixture.lookup",
            ],
            messages: {},
          },
          {
            activation: owner,
            grants: [],
            messages: ownerModule.messages,
          },
          {
            activation: subscriber,
            grants: ["message.subscribe.fixture.events"],
            messages: {
              subscribes: [{
                topic: TOPIC,
                handle: ({ value: observed }) => { delivered.push(observed); },
              }],
            },
          },
        ],
        trace,
      });
      const host = new SemanticServiceTestHost([provider]);
      const senderActivation = host.activate(sender);
      const ownerActivation = host.activate(owner);
      const subscriberActivation = host.activate(subscriber);
      const service = senderActivation.context.services.require(messagesService);
      ownerActivation.context.services.require(messagesService);
      subscriberActivation.context.services.require(messagesService);

      for (const operation of operations) {
        const result = await execute(service, operation, value);
        assert.equal(result.result.ok, true);
      }
      assert.deepEqual(
        trace.map(({ operation }) => operation),
        operations,
      );
      assert.deepEqual(
        handled,
        operations.filter((operation) => operation !== "publish")
          .map((operation) => [operation, value]),
      );
      assert.deepEqual(delivered, [value]);

      await subscriberActivation.dispose();
      const afterSubscriberDisposal = await service.publishMessage.execute({
        topic: TOPIC,
        payload: { value },
      });
      assert.equal(afterSubscriberDisposal.result.ok, true);
      assert.equal(
        afterSubscriberDisposal.result.value.subscriberCount,
        ownerModule.messages.subscribes.length,
      );
      assert.deepEqual(delivered, [value]);

      await ownerActivation.dispose();
      const afterOwnerDisposal = await service.sendMessage.execute({
        channel: CHANNEL,
        payload: { value },
      });
      assert.equal(afterOwnerDisposal.result.ok, false);
      assert.equal(afterOwnerDisposal.result.error.code, "message.channel.owner.absent");
      await senderActivation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(fc.integer(), async (value) => {
    const ownerModule = fixtureModule();
    const denied = createTestActivationIdentity("fixture.denied", "fixture.denied@1#one");
    const owner = createTestActivationIdentity(ownerModule.id, "fixture.owner@1#denied");
    const host = new SemanticServiceTestHost([
      createFakeMessagesServiceProvider({
        registrations: [
          { activation: denied, grants: [], messages: {} },
          { activation: owner, grants: [], messages: ownerModule.messages },
        ],
      }),
    ]);
    const deniedActivation = host.activate(denied);
    const ownerActivation = host.activate(owner);
    const service = deniedActivation.context.services.require(messagesService);
    ownerActivation.context.services.require(messagesService);
    const outcome = await service.sendMessage.execute({
      channel: CHANNEL,
      payload: { value },
    });
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.error.code, "message.sender.unauthorized");
    await ownerActivation.dispose();
    await deniedActivation.dispose();
  }), propertyParameters());

  const ownerModule = fixtureModule();
  const sender = createTestActivationIdentity("fixture.sender", "fixture.sender@1#bound");
  const owner = createTestActivationIdentity(ownerModule.id, "fixture.owner@1#bound");
  const host = new SemanticServiceTestHost([
    createFakeMessagesServiceProvider({
      registrations: [
        {
          activation: sender,
          grants: ["message.send.fixture.directed"],
          messages: {},
        },
        { activation: owner, grants: [], messages: ownerModule.messages },
      ],
    }),
  ]);
  const senderActivation = host.activate(sender);
  const ownerActivation = host.activate(owner);
  const service = senderActivation.context.services.require(messagesService);
  ownerActivation.context.services.require(messagesService);
  const oversized = await service.sendMessage.execute({
    channel: CHANNEL,
    payload: { value: "x".repeat(MAX_ENCODED_BYTES) },
  });
  assert.equal(oversized.result.ok, false);
  assert.equal(oversized.result.error.code, "message.payload.too_large");
  await ownerActivation.dispose();
  await senderActivation.dispose();
});

test("architecture.messages-bridge-parity.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.shuffledSubarray(["send", "publish", "request"], { minLength: 3, maxLength: 3 }),
    fc.integer(),
    async (operations, value) => {
      const module = fixtureModule();
      const production = await productionFixture(module);
      const fakeTrace = [];
      const fakeHost = new SemanticServiceTestHost([
        createFakeMessagesServiceProvider({
          registrations: [{
            activation: production.identity,
            grants: moduleMessageGrants(module),
            messages: module.messages,
          }],
          trace: fakeTrace,
        }),
      ]);
      const fakeActivation = fakeHost.activate(production.identity);
      const fake = fakeActivation.context.services.require(messagesService);

      for (const operation of operations) {
        const nativeOutcome = await execute(production.service, operation, value);
        const fakeOutcome = await execute(fake, operation, value);
        assert.deepEqual(fakeOutcome.result, nativeOutcome.result);
        assert.equal(
          production.transport.calls.at(-1).envelope.correlationId,
          nativeOutcome.correlationId,
        );
        assert.equal(fakeTrace.at(-1).correlationId, fakeOutcome.correlationId);
      }
      assert.deepEqual(
        fakeTrace.map(({ operation, envelope }) => ({
          operation,
          endpoint: envelope.endpoint,
          message: envelope.message,
          payload: envelope.payload,
        })),
        production.transport.calls.map(({ operation, envelope }) => ({
          operation,
          endpoint: envelope.endpoint,
          message: envelope.message,
          payload: envelope.payload,
        })),
      );

      await fakeActivation.dispose();
      await production.activation.dispose();
      await production.bridge.close();
    },
  ), propertyParameters());
});

test("architecture.service-event.messages.property", async () => {
  await fc.assert(fc.asyncProperty(fc.integer(), async (value) => {
    const calls = [];
    const module = fixtureModule({
      directed: ({ value: observed }) => { calls.push(observed); },
    });
    const fixture = await productionFixture(module);
    const frame = {
      schemaVersion: 1,
      bridgeId: "fixture-bridge",
      sequence: 1,
      routeGeneration: 1,
      activationId: fixture.identity.activationId,
      kind: "directed",
      endpoint: CHANNEL.id,
      message: VALUE,
      payload: { value },
    };
    assert.equal((await fixture.bridge.dispatch(frame)).accepted, true);
    assert.deepEqual(calls, [value]);

    await fixture.activation.dispose();
    const rejected = await fixture.bridge.dispatch({ ...frame, sequence: 2 });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.code, "message.route.generation_changed");
    assert.deepEqual(calls, [value]);
    await fixture.bridge.close();
  }), propertyParameters());
});
