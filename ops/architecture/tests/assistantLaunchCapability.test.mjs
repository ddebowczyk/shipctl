import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let assistantLaunchService;
let assistantProviderId;
let createAssistantLaunchServiceProvider;
let createFakeAssistantLaunchServiceProvider;
let createFakeProcessesServiceProvider;
let createTestActivationIdentity;
let SemanticServiceRegistry;
let SemanticServiceTestHost;
let TestCancellation;
let assistantLaunchClientFor;
let vite;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  return { seed };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ assistantLaunchService, assistantProviderId } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeAssistantLaunchServiceProvider,
    createFakeProcessesServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
    TestCancellation,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createAssistantLaunchServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/assistantLaunch.ts",
  ));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ));
  ({ assistantLaunchClientFor } = await vite.ssrLoadModule(
    "/modules/assistants/frontend/src/assistantLaunchClient.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const providerArbitrary = fc.stringMatching(/^[a-z][a-z0-9_-]*$/);
const textArbitrary = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/);
const pathArbitrary = textArbitrary.map((value) => `/workspace/${value}`);
const terminal = {
  moduleSessionId: "assistants:property-session",
  columns: 120,
  rows: 40,
  environment: { TERM: "xterm-256color" },
  colorTheme: { foreground: "#ffffff", background: "#000000", palette: [] },
};

function nativeRecord(provider = "codex", overrides = {}) {
  return {
    recordId: "assistant-record-1",
    provider,
    providerSessionId: "native-provider-secret",
    launchRepoPath: "/workspace/repo",
    placementProjectPath: "/workspace/repo",
    label: "Assistant",
    sessionMode: "standard",
    model: null,
    captureState: "ready",
    restoreOnNextLaunch: true,
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function transportWith(overrides = {}) {
  return {
    startSession: async ({ input }) => ({
      terminalId: "assistant-terminal-1",
      record: nativeRecord(input.provider, {
        launchRepoPath: input.launchRepoPath,
        placementProjectPath: input.placementProjectPath,
        label: input.label,
        sessionMode: input.sessionMode,
        model: input.model ?? null,
        captureState: "pending",
        restoreOnNextLaunch: false,
      }),
    }),
    resumeSession: async ({ input }) => ({
      terminalId: "assistant-terminal-1",
      record: nativeRecord("codex", { recordId: input.recordId, restoreOnNextLaunch: false }),
    }),
    refreshSessionIdentity: async () => nativeRecord(),
    markSessionIdentityFailed: async () => nativeRecord("codex", { captureState: "failed" }),
    recordSessionPlacement: async ({ input }) => nativeRecord("codex", {
      recordId: input.recordId,
      placementProjectPath: input.placementProjectPath,
    }),
    recordSessionLabel: async ({ input }) => nativeRecord("codex", {
      recordId: input.recordId,
      label: input.label,
    }),
    discardSession: async () => undefined,
    rearmSession: async () => undefined,
    inspectRestorableSessions: async () => [nativeRecord()],
    takeStartupWarning: async () => null,
    prepareForShutdown: async () => undefined,
    inspectModels: async () => ["default"],
    inspectProviderConfiguration: async () => ({
      settings: {
        defaultProvider: null,
        defaultModel: null,
        defaultThinkingLevel: null,
      },
      configuredProviders: [],
    }),
    saveProviderConfiguration: async () => undefined,
    releaseActivation: async () => true,
    ...overrides,
  };
}

function productionService({
  moduleId = "shipctl.assistants",
  transport = transportWith(),
  authorize,
} = {}) {
  const registry = new SemanticServiceRegistry([
    createAssistantLaunchServiceProvider({ transport, authorize }),
  ]);
  const identity = createTestActivationIdentity(moduleId);
  const activation = registry.activate(identity);
  return {
    activation,
    identity,
    service: activation.context.services.require(assistantLaunchService),
  };
}

test("architecture.service-adapter.assistant-launch.property", async () => {
  await fc.assert(fc.asyncProperty(
    providerArbitrary,
    pathArbitrary,
    textArbitrary,
    async (provider, projectPath, label) => {
      const requests = [];
      const secret = `provider-secret-${provider}`;
      const transport = transportWith({
        startSession: async (request) => {
          requests.push(request);
          return {
            terminalId: "assistant-terminal-1",
            record: nativeRecord(provider, {
              providerSessionId: secret,
              launchRepoPath: projectPath,
              placementProjectPath: projectPath,
              label,
              captureState: "pending",
              restoreOnNextLaunch: false,
            }),
          };
        },
      });
      const { activation, identity, service } = productionService({ transport });
      const input = {
        provider: assistantProviderId(provider),
        launchRepoPath: projectPath,
        placementProjectPath: projectPath,
        label,
        sessionMode: "standard",
        terminal,
      };
      const outcome = await service.startSession.execute(input);
      assert.equal(outcome.result.ok, true);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].activation, identity);
      assert.equal(requests[0].correlationId, outcome.correlationId);
      assert.deepEqual(requests[0].input, input);
      assert.equal("providerSessionId" in outcome.result.value.record, false);
      assert.equal(JSON.stringify(outcome).includes(secret), false);
      await activation.dispose();
    },
  ), propertyParameters());

  const secret = "/private/assistant-native-secret";
  const failed = productionService({
    transport: transportWith({ startSession: async () => { throw new Error(secret); } }),
  });
  const outcome = await failed.service.startSession.execute({
    provider: assistantProviderId("codex"),
    launchRepoPath: "/workspace/repo",
    placementProjectPath: "/workspace/repo",
    label: "Codex",
    sessionMode: "standard",
    terminal,
  });
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.error.code, "assistant-launch.transport-failed");
  assert.equal(JSON.stringify(outcome).includes(secret), false);
  await failed.activation.dispose();
});

test("architecture.service-request.assistant-launch.property", async () => {
  let dispatches = 0;
  const fixture = productionService({
    transport: transportWith({ inspectModels: async () => { dispatches += 1; return []; } }),
  });
  const cancelled = new TestCancellation(fixture.activation.context);
  cancelled.cancel();
  const cancelledOutcome = await fixture.service.inspectModels.execute(
    { provider: assistantProviderId("codex") },
    { cancellation: cancelled },
  );
  assert.equal(cancelledOutcome.result.ok, false);
  assert.equal(cancelledOutcome.result.error.code, "assistant-launch.cancelled");
  assert.equal(dispatches, 0);

  const invalid = await fixture.service.startSession.execute({
    provider: assistantProviderId("codex"),
    launchRepoPath: "",
    placementProjectPath: "/workspace/repo",
    label: "Codex",
    sessionMode: "standard",
    terminal,
  });
  assert.equal(invalid.result.ok, false);
  assert.equal(invalid.result.error.code, "assistant-launch.invalid-request");

  const secretSettings = {
    defaultProvider: null,
    defaultModel: null,
    defaultThinkingLevel: null,
    apiKey: "must-not-cross-the-contract",
  };
  const secretOutcome = await fixture.service.saveProviderConfiguration.execute({
    provider: assistantProviderId("pi"),
    settings: secretSettings,
  });
  assert.equal(secretOutcome.result.ok, false);
  assert.equal(secretOutcome.result.error.code, "assistant-launch.invalid-request");

  await fixture.activation.dispose();
  const disposed = await fixture.service.inspectModels.execute({
    provider: assistantProviderId("codex"),
  });
  assert.equal(disposed.result.ok, false);
  assert.equal(disposed.result.error.code, "assistant-launch.activation-disposed");

  const denied = productionService({ moduleId: "shipctl.foreign" });
  const deniedOutcome = await denied.service.inspectModels.execute({
    provider: assistantProviderId("codex"),
  });
  assert.equal(deniedOutcome.result.ok, false);
  assert.equal(deniedOutcome.result.error.code, "assistant-launch.denied");
  await denied.activation.dispose();
});

test("architecture.service-event.assistant-launch.property", async () => {
  const fixture = productionService();
  const events = [];
  const lease = await fixture.service.observeSessions.subscribe({}, (event) => {
    events.push(event);
  });
  const started = await fixture.service.startSession.execute({
    provider: assistantProviderId("codex"),
    launchRepoPath: "/workspace/repo",
    placementProjectPath: "/workspace/repo",
    label: "Codex",
    sessionMode: "standard",
    terminal,
  });
  assert.equal(started.result.ok, true);
  const recordId = started.result.value.record.recordId;
  await fixture.service.recordSessionLabel.execute({ recordId, label: "Renamed" });
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2]);
  assert.deepEqual(events.map(({ value }) => value.kind), ["started", "label-recorded"]);
  assert.equal(events.every(({ value }) => value.recordId === recordId), true);

  await lease.dispose();
  await fixture.service.recordSessionLabel.execute({ recordId, label: "After disposal" });
  assert.equal(events.length, 2);
  await fixture.activation.dispose();
});

test("architecture.assistant-launch-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    textArbitrary,
    pathArbitrary,
    async (label, placementProjectPath) => {
      const trace = [];
      const host = new SemanticServiceTestHost([
        createFakeAssistantLaunchServiceProvider({
          models: { codex: ["default", "reasoning"] },
          trace,
        }),
        createFakeProcessesServiceProvider({ availableCommands: ["codex"] }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.assistants"));
      const client = assistantLaunchClientFor(activation.context);
      assert.equal(await client.checkCommandExists("codex"), true);
      assert.deepEqual(await client.getModelsForProvider("codex"), ["default", "reasoning"]);

      const started = await client.spawnAssistantSession({
        provider: "codex",
        launchRepoPath: "/workspace/repo",
        placementProjectPath: "/workspace/repo",
        label,
        sessionMode: "standard",
      }, terminal);
      const captured = await client.tryCaptureSessionIdentity(started.record.recordId);
      assert.equal(captured.captureState, "ready");
      const placed = await client.updateSessionPlacement(
        started.record.recordId,
        placementProjectPath,
      );
      assert.equal(placed.placementProjectPath, placementProjectPath.trim());
      const renamed = await client.updateSessionLabel(started.record.recordId, `${label} renamed`);
      assert.equal(renamed.label, `${label} renamed`);

      await client.beginAssistantSessionPreservingShutdown();
      const restorable = await client.listRestorableSessions();
      assert.equal(restorable.length, 1);
      const resumed = await client.resumeAssistantSession(restorable[0].recordId, terminal);
      assert.equal(resumed.record.restoreOnNextLaunch, false);
      assert.deepEqual(trace.map(({ operation }) => operation), [
        "inspect-models",
        "start-session",
        "refresh-session-identity",
        "record-session-placement",
        "record-session-label",
        "prepare-for-shutdown",
        "inspect-restorable-sessions",
        "resume-session",
      ]);
      assert.equal(JSON.stringify(trace).includes("plugin:shipctl-assistants"), false);
      assert.equal(JSON.stringify(trace).includes("apiKey"), false);
      await activation.dispose();
    },
  ), propertyParameters());

  const [clientSource, runtimeSource, contractSource] = await Promise.all([
    readFile(`${ROOT}/modules/assistants/frontend/src/assistantLaunchClient.ts`, "utf8"),
    readFile(`${ROOT}/modules/assistants/frontend/src/runtime.ts`, "utf8"),
    readFile(`${ROOT}/module-api/frontend/src/protocol/assistantLaunch.ts`, "utf8"),
  ]);
  assert.doesNotMatch(`${clientSource}\n${runtimeSource}`, /@tauri-apps|invoke\(/);
  assert.doesNotMatch(contractSource, /providerSessionId|plugin:shipctl-assistants|apiKey/);
});
