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

const ASSISTANT_GRANTS = Object.freeze([
  "assistant.launch",
  "assistant.session-record",
  "assistant.resource.read",
  "assistant.resource.write",
  "assistant.resource.execute",
]);

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
        captureState: input.initialSessionIdentity === undefined ? "pending" : "ready",
        restoreOnNextLaunch: false,
      }),
    }),
    resumeSession: async ({ input }) => ({
      terminalId: "assistant-terminal-1",
      record: nativeRecord("codex", { recordId: input.recordId, restoreOnNextLaunch: false }),
    }),
    recordSessionIdentity: async ({ input }) => nativeRecord("codex", {
      recordId: input.recordId,
      captureState: "ready",
    }),
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
    readResource: async ({ input }) => (
      input.request.kind === "file"
        ? { kind: "file", resourceId: input.request.resourceId, content: "" }
        : { kind: "tree", resourceId: input.request.resourceId, files: [] }
    ),
    writeResource: async () => undefined,
    executeResource: async ({ input }) => ({
      resourceId: input.resourceId,
      stdout: "",
      stderr: "",
      status: 0,
    }),
    releaseActivation: async () => true,
    ...overrides,
  };
}

function acceptedAdmission(moduleId, grants = ASSISTANT_GRANTS) {
  return {
    artifact: {
      contentDigest: "test-artifact",
      entryUrl: "file:///test-artifact.mjs",
      moduleId,
      version: "0.0.0",
    },
    effectiveGrants: grants,
  };
}

function productionService({
  moduleId = "shipctl.assistants",
  transport = transportWith(),
  authorize,
  admission = acceptedAdmission(moduleId),
} = {}) {
  const registry = new SemanticServiceRegistry([
    createAssistantLaunchServiceProvider({ transport, authorize }),
  ]);
  const identity = createTestActivationIdentity(moduleId);
  const activation = registry.activate(identity, admission);
  return {
    activation,
    identity,
    service: activation.context.services.require(assistantLaunchService),
  };
}

function startInput(provider, projectPath, label) {
  return {
    provider: assistantProviderId(provider),
    launchRepoPath: projectPath,
    placementProjectPath: projectPath,
    label,
    sessionMode: "standard",
    launch: { program: "fixture", arguments: ["--provider", provider] },
    terminal,
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
      const input = startInput(provider, projectPath, label);
      const outcome = await service.startSession.execute(input);
      assert.equal(outcome.result.ok, true);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].activation, {
        moduleId: identity.moduleId,
        activationId: identity.activationId,
        effectiveGrants: ASSISTANT_GRANTS,
      });
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
  const outcome = await failed.service.startSession.execute(
    startInput("codex", "/workspace/repo", "Codex"),
  );
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.error.code, "assistant-launch.transport-failed");
  assert.equal(JSON.stringify(outcome).includes(secret), false);
  await failed.activation.dispose();
});

test("architecture.service-request.assistant-launch.property", async () => {
  let dispatches = 0;
  const fixture = productionService({
    transport: transportWith({ readResource: async () => { dispatches += 1; return {
      kind: "file", resourceId: "fixture", content: "",
    }; } }),
  });
  const cancelled = new TestCancellation(fixture.activation.context);
  cancelled.cancel();
  const cancelledOutcome = await fixture.service.readResource.execute(
    { request: { kind: "file", resourceId: "fixture", relativePath: ".fixture" } },
    { cancellation: cancelled },
  );
  assert.equal(cancelledOutcome.result.ok, false);
  assert.equal(cancelledOutcome.result.error.code, "assistant-launch.cancelled");
  assert.equal(dispatches, 0);

  const invalid = await fixture.service.startSession.execute({
    ...startInput("codex", "/workspace/repo", "Codex"),
    launchRepoPath: "",
  });
  assert.equal(invalid.result.ok, false);
  assert.equal(invalid.result.error.code, "assistant-launch.invalid-request");

  const unsafeResource = await fixture.service.executeResource.execute({
    resourceId: "fixture",
    program: "/bin/unsafe",
    arguments: [],
  });
  assert.equal(unsafeResource.result.ok, false);
  assert.equal(unsafeResource.result.error.code, "assistant-launch.invalid-request");

  await fixture.activation.dispose();
  const disposed = await fixture.service.readResource.execute({
    request: { kind: "file", resourceId: "fixture", relativePath: ".fixture" },
  });
  assert.equal(disposed.result.ok, false);
  assert.equal(disposed.result.error.code, "assistant-launch.activation-disposed");

  const denied = productionService({ admission: null });
  const deniedOutcome = await denied.service.readResource.execute({
    request: { kind: "file", resourceId: "fixture", relativePath: ".fixture" },
  });
  assert.equal(deniedOutcome.result.ok, false);
  assert.equal(deniedOutcome.result.error.code, "assistant-launch.denied");
  await denied.activation.dispose();

  const external = productionService({ moduleId: "plugin.external" });
  const externalOutcome = await external.service.startSession.execute(
    startInput("external-policy", "/workspace/repo", "External"),
  );
  assert.equal(externalOutcome.result.ok, true);
  await external.activation.dispose();
});

test("architecture.assistant-launch-external-provider.fixture", async () => {
  const recordId = "external-fixture-record";
  const pending = nativeRecord("fixture-policy", {
    recordId,
    captureState: "pending",
    restoreOnNextLaunch: false,
  });
  const ready = nativeRecord("fixture-policy", {
    recordId,
    captureState: "ready",
    restoreOnNextLaunch: true,
  });
  const transport = transportWith({
    startSession: async ({ input }) => {
      assert.equal(input.provider, "fixture-policy");
      assert.deepEqual(input.launch, { program: "fixture-cli", arguments: ["start"] });
      return { terminalId: "fixture-terminal", record: pending };
    },
    recordSessionIdentity: async ({ input }) => {
      assert.equal(input.recordId, recordId);
      assert.equal(input.providerSessionId, "fixture-private-id");
      return ready;
    },
    inspectRestorableSessions: async () => [ready],
    resumeSession: async ({ input }) => {
      assert.equal(input.recordId, recordId);
      assert.deepEqual(input.launch, {
        program: "fixture-cli",
        arguments: ["resume", { kind: "captured-session-id" }],
      });
      return { terminalId: "fixture-terminal", record: { ...ready, restoreOnNextLaunch: false } };
    },
  });
  const fixture = productionService({
    moduleId: "plugin.external-fixture",
    transport,
    admission: acceptedAdmission("plugin.external-fixture"),
  });
  const started = await fixture.service.startSession.execute({
    ...startInput("fixture-policy", "/workspace/repo", "Fixture"),
    sessionMode: "fixture-mode",
    launch: { program: "fixture-cli", arguments: ["start"] },
  });
  assert.equal(started.result.ok, true);
  if (!started.result.ok) throw new Error("fixture start did not succeed");
  const captured = await fixture.service.recordSessionIdentity.execute({
    recordId: started.result.value.record.recordId,
    providerSessionId: "fixture-private-id",
  });
  assert.equal(captured.result.ok, true);
  await fixture.service.prepareForShutdown.execute({});
  const restorable = await fixture.service.inspectRestorableSessions.execute({});
  assert.equal(restorable.result.ok, true);
  if (!restorable.result.ok) throw new Error("fixture session was not restorable");
  const resumed = await fixture.service.resumeSession.execute({
    recordId: restorable.result.value[0].recordId,
    launch: {
      program: "fixture-cli",
      arguments: ["resume", { kind: "captured-session-id" }],
    },
    terminal,
  });
  assert.equal(resumed.result.ok, true);
  await fixture.activation.dispose();
});

test("architecture.service-event.assistant-launch.property", async () => {
  const fixture = productionService();
  const events = [];
  const lease = await fixture.service.observeSessions.subscribe({}, (event) => {
    events.push(event);
  });
  const started = await fixture.service.startSession.execute(
    startInput("codex", "/workspace/repo", "Codex"),
  );
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
        createFakeAssistantLaunchServiceProvider({ trace }),
        createFakeProcessesServiceProvider({ availableCommands: ["codex"] }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.assistants"));
      const client = assistantLaunchClientFor(activation.context);
      assert.equal(await client.checkCommandExists("codex"), true);
      assert.deepEqual(await client.getModelsForProvider("claude"), ["fable", "opus", "sonnet", "haiku"]);

      const started = await client.spawnAssistantSession({
        provider: "codex",
        launchRepoPath: "/workspace/repo",
        placementProjectPath: "/workspace/repo",
        label,
        sessionMode: "standard",
        launch: { program: "codex", arguments: [] },
      }, terminal);
      const captured = await client.recordSessionIdentity(started.record.recordId, "captured-session-id");
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
      const resumed = await client.resumeAssistantSession(restorable[0].recordId, {
        program: "codex",
        arguments: ["resume", { kind: "captured-session-id" }],
      }, terminal);
      assert.equal(resumed.record.restoreOnNextLaunch, false);
      assert.deepEqual(trace.map(({ operation }) => operation), [
        "read-resource",
        "start-session",
        "record-session-identity",
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

  const [clientSource, runtimeSource, contractSource, nativeSource] = await Promise.all([
    readFile(`${ROOT}/modules/assistants/frontend/src/assistantLaunchClient.ts`, "utf8"),
    readFile(`${ROOT}/modules/assistants/frontend/src/runtime.ts`, "utf8"),
    readFile(`${ROOT}/module-api/frontend/src/protocol/assistantLaunch.ts`, "utf8"),
    readFile(`${ROOT}/core/backend/src/assistant_launch/mod.rs`, "utf8"),
  ]);
  assert.doesNotMatch(`${clientSource}\n${runtimeSource}`, /@tauri-apps|invoke\(/);
  const recoveryRecord = contractSource.match(
    /export interface AssistantRecoveryRecord[\s\S]*?\n}/,
  )?.[0] ?? "";
  assert.doesNotMatch(recoveryRecord, /providerSessionId/);
  assert.doesNotMatch(contractSource, /plugin:shipctl-assistants|apiKey/);
  assert.doesNotMatch(nativeSource, /AssistantProvider|Claude|Codex|PiConfig|inspect_models/);
});
