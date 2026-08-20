import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AcceptedPluginAdmission } from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

type UsageArtifactModule = typeof import("../../artifact/src/index.ts");
type UsageRuntimeModule = typeof import("../src/pluginContributions.ts");
type UsageSourcesClientModule = typeof import("../src/usageSourcesClient.ts");
type ModuleApi = typeof import("../../../../module-api/frontend/src/index.ts");
type RuntimeApi = typeof import("../../../../core/frontend/runtime/cordis/staticPluginRuntime.ts");
type SemanticRuntime = typeof import("../../../../core/frontend/runtime/semanticServiceRuntime.ts");
type TestingApi = typeof import("../../../../module-api/frontend/src/testing.ts");

let vite: ViteDevServer;
let usageArtifact: UsageArtifactModule;
let usageRuntime: UsageRuntimeModule;
let usageSourcesClient: UsageSourcesClientModule;
let pluginApi: ModuleApi;
let runtimeApi: RuntimeApi;
let SemanticServiceRegistry: SemanticRuntime["SemanticServiceRegistry"];
let testingApi: TestingApi;
let activeActivations: Array<{ deactivate(): Promise<void> }> = [];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  usageArtifact = await vite.ssrLoadModule(
    "/modules/usage/artifact/src/index.ts",
  ) as UsageArtifactModule;
  usageRuntime = await vite.ssrLoadModule(
    "/modules/usage/frontend/src/pluginContributions.ts",
  ) as UsageRuntimeModule;
  usageSourcesClient = await vite.ssrLoadModule(
    "/modules/usage/frontend/src/usageSourcesClient.ts",
  ) as UsageSourcesClientModule;
  pluginApi = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi;
  runtimeApi = await vite.ssrLoadModule(
    "/core/frontend/runtime/cordis/staticPluginRuntime.ts",
  ) as RuntimeApi;
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  ) as SemanticRuntime);
  testingApi = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ) as TestingApi;
});

after(async () => {
  await vite.close();
});

afterEach(async () => {
  for (const activation of activeActivations.reverse()) await activation.deactivate();
  activeActivations = [];
  usageSourcesClient.configureUsageSourcesClient(null);
});

function admission(
  definition: ReturnType<UsageArtifactModule["createShipctlPlugin"]>,
): AcceptedPluginAdmission {
  return {
    artifact: {
      contentDigest: "0".repeat(64),
      entryUrl: "shipctl://test/usage",
      moduleId: definition.id,
      version: definition.version,
    },
    effectiveGrants: definition.requiredGrants ?? [],
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function activateUsage(options: {
  readonly activationSuffix: string;
  readonly changes: InstanceType<TestingApi["FakeUsageSourceChangeController"]>;
  readonly deniedGrants?: readonly import("@shipctl/module-api/testing").FakeUsageSourcesGrant[];
}) {
  const definition = usageArtifact.createShipctlPlugin({ pluginApi });
  const activationId = `${definition.id}@${definition.version}#${options.activationSuffix}`;
  const usageTrace: import("@shipctl/module-api/testing").FakeUsageSourcesTrace[] = [];
  const messageTrace: import("@shipctl/module-api/testing").FakeMessageTrace[] = [];
  const semanticServices = new SemanticServiceRegistry([
    testingApi.createFakeUsageSourcesServiceProvider({
      changes: options.changes,
      deniedGrants: options.deniedGrants,
      trace: usageTrace,
    }),
    testingApi.createFakePluginDataServiceProvider(),
    testingApi.createFakeMessagesServiceProvider({
      registrations: [{
        activation: { moduleId: definition.id, activationId },
        grants: definition.requiredGrants ?? [],
        messages: usageRuntime.usageContributions.messages,
      }],
      trace: messageTrace,
    }),
    testingApi.createFakeSchedulerServiceProvider(),
  ]);
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    undefined,
    [definition],
    new Map([[definition.id, activationId]]),
    semanticServices,
    false,
    new Map([[definition.id, admission(definition)]]),
  );
  activeActivations.push(activation);
  return { activation, definition, messageTrace, usageTrace };
}

test("direct Usage activation routes its scheduled refresh message and releases every runtime lease", async () => {
  const changes = new testingApi.FakeUsageSourceChangeController();
  const first = await activateUsage({ activationSuffix: "first", changes });

  assert.deepEqual(first.activation.failures, []);
  assert.deepEqual(
    first.activation.inspect().contributions.map(({ family, id }) => ({ family, id })),
    [
      { family: "global-navigation", id: "usage.global-navigation" },
      { family: "global-surface", id: "core.usage" },
      { family: "message-graph", id: "shipctl.usage.messages" },
      { family: "scheduled-task", id: "usage.periodic-refresh" },
      { family: "settings", id: "usage.settings" },
      { family: "sidebar", id: "usage.sidebar" },
    ],
  );
  assert.deepEqual(
    first.activation.inspect().effects
      .filter(({ kind }) => kind === "background")
      .map(({ id }) => id),
    [usageRuntime.USAGE_RUNTIME_EFFECT_ID],
  );

  const contributions = first.activation.contributionsByModule.get(
    usageRuntime.USAGE_MODULE_ID,
  );
  assert.ok(contributions);
  const task = contributions.scheduledTasks[0];
  const messages = contributions.messages[0];
  assert.ok(task);
  assert.ok(messages);
  assert.equal(task.schedule.target.kind, "channel");
  if (task.schedule.target.kind !== "channel") throw new Error("Usage task must target a channel");
  assert.equal(task.schedule.target.endpoint.id, usageRuntime.USAGE_REFRESH_CHANNEL.id);
  assert.equal(messages.handles?.[0]?.channel.id, task.schedule.target.endpoint.id);

  await settle();
  const traceBeforeScheduledDelivery = first.usageTrace.length;
  const messageService = first.activation.activationContextsByModule
    .get(usageRuntime.USAGE_MODULE_ID)
    ?.services.require(pluginApi.messagesService);
  assert.ok(messageService);
  const delivery = await messageService.sendMessage.execute({
    channel: task.schedule.target.endpoint,
    payload: task.schedule.payload,
  });
  assert.equal(delivery.result.ok, true);
  assert.equal(first.messageTrace.length, 1);
  assert.ok(first.usageTrace.length > traceBeforeScheduledDelivery);

  const traceBeforeChange = first.usageTrace.length;
  await changes.publish(["claude"]);
  assert.ok(first.usageTrace.length > traceBeforeChange);

  await first.activation.deactivate();
  await first.activation.deactivate();
  assert.deepEqual(first.activation.inspect().contributions, []);
  assert.deepEqual(first.activation.inspect().effects, []);
  assert.deepEqual(first.activation.inspect().services, []);
  assert.throws(
    () => usageSourcesClient.activeUsageSourcesClient(),
    /Usage Sources service is unavailable/,
  );

  const firstTraceAfterDeactivation = first.usageTrace.length;
  await changes.publish(["claude"]);
  assert.equal(first.usageTrace.length, firstTraceAfterDeactivation);

  const second = await activateUsage({ activationSuffix: "second", changes });
  assert.deepEqual(second.activation.failures, []);
  await settle();
  const secondTraceBeforeChange = second.usageTrace.length;
  await changes.publish(["claude"]);
  assert.equal(first.usageTrace.length, firstTraceAfterDeactivation);
  assert.ok(second.usageTrace.length > secondTraceBeforeChange);
  await second.activation.deactivate();
  await second.activation.deactivate();
});

test("a denied Usage source observation grant fails atomically without retaining clients or contributions", async () => {
  const denied = await activateUsage({
    activationSuffix: "denied-observe",
    changes: new testingApi.FakeUsageSourceChangeController(),
    deniedGrants: ["usage-source.observe"],
  });

  assert.deepEqual(denied.activation.failures, [{
    moduleId: usageRuntime.USAGE_MODULE_ID,
    message: "Plugin activation failed",
  }]);
  assert.deepEqual([...denied.activation.activeModuleIds], []);
  assert.deepEqual(denied.activation.inspect().contributions, []);
  assert.deepEqual(denied.activation.inspect().effects, []);
  assert.deepEqual(denied.activation.inspect().services, []);
  assert.throws(
    () => usageSourcesClient.activeUsageSourcesClient(),
    /Usage Sources service is unavailable/,
  );
  await denied.activation.deactivate();
  await denied.activation.deactivate();
});
