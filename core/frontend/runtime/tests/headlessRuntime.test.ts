import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";
import type { WorkspaceCatalogSnapshot } from "@shipctl/module-api";
import type { HeadlessRuntimeArtifact } from "../headlessRuntime.ts";

type HeadlessRuntimeModule = typeof import("../headlessRuntime.ts");
type SemanticRuntimeModule = typeof import("../semanticServiceRuntime.ts");
type StaticRuntimeModule = typeof import("../cordis/staticPluginRuntime.ts");
type WorkspaceAuthorityModule = typeof import("../../workspace/authority.ts");
type WorkspaceCatalogModule = typeof import("../../workspace/catalog.ts");
type WorkspaceDocumentModule = typeof import("../../workspace/document.ts");
type WorkspacePersistenceModule = typeof import("../../workspace/persistence.ts");
type WorkspaceServiceModule = typeof import("../../workspace/service.ts");
type ConfigurationModule = typeof import("../../configuration/headless.ts");
type ArtifactModule = typeof import("../../../../modules/runtime-operations/artifact/src/index.ts");
type TestingModule = typeof import("@shipctl/module-api/testing");
type PluginApi = typeof import("@shipctl/module-api");

interface RuntimeOperationsTemplate {
  readonly id: string;
  readonly version: string;
  readonly application: unknown;
  readonly capabilities: unknown;
  readonly messages: unknown;
  readonly requestedGrants: readonly string[];
}

let vite: ViteDevServer;
let createHeadlessRuntime: HeadlessRuntimeModule["createHeadlessRuntime"];
let SemanticServiceRegistry: SemanticRuntimeModule["SemanticServiceRegistry"];
let activatePluginDefinitionsObserved: StaticRuntimeModule["activatePluginDefinitionsObserved"];
let WorkspaceAuthority: WorkspaceAuthorityModule["WorkspaceAuthority"];
let parseWorkspaceCatalogSnapshot: WorkspaceCatalogModule["parseWorkspaceCatalogSnapshot"];
let parseUiWorkspaceDocument: WorkspaceDocumentModule["parseUiWorkspaceDocument"];
let InMemoryWorkspacePersistence: WorkspacePersistenceModule["InMemoryWorkspacePersistence"];
let createWorkspaceServiceProvider: WorkspaceServiceModule["createWorkspaceServiceProvider"];
let createHostConfigurationRuntime: ConfigurationModule["createHostConfigurationRuntime"];
let createHostConfigurationServiceProvider: ConfigurationModule["createHostConfigurationServiceProvider"];
let createShipctlPlugin: ArtifactModule["createShipctlPlugin"];
let createFakePluginDataServiceProvider: TestingModule["createFakePluginDataServiceProvider"];
let pluginApi: PluginApi;
let template: RuntimeOperationsTemplate;
let onlineActivationSequence = 0;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../../", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ createHeadlessRuntime } = await vite.ssrLoadModule(
    "/core/frontend/runtime/headlessRuntime.ts",
  ) as HeadlessRuntimeModule);
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  ) as SemanticRuntimeModule);
  ({ activatePluginDefinitionsObserved } = await vite.ssrLoadModule(
    "/core/frontend/runtime/cordis/staticPluginRuntime.ts",
  ) as StaticRuntimeModule);
  ({ WorkspaceAuthority } = await vite.ssrLoadModule(
    "/core/frontend/workspace/authority.ts",
  ) as WorkspaceAuthorityModule);
  ({ parseWorkspaceCatalogSnapshot } = await vite.ssrLoadModule(
    "/core/frontend/workspace/catalog.ts",
  ) as WorkspaceCatalogModule);
  ({ parseUiWorkspaceDocument } = await vite.ssrLoadModule(
    "/core/frontend/workspace/document.ts",
  ) as WorkspaceDocumentModule);
  ({ InMemoryWorkspacePersistence } = await vite.ssrLoadModule(
    "/core/frontend/workspace/persistence.ts",
  ) as WorkspacePersistenceModule);
  ({ createWorkspaceServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/workspace/service.ts",
  ) as WorkspaceServiceModule);
  ({
    createHostConfigurationRuntime,
    createHostConfigurationServiceProvider,
  } = await vite.ssrLoadModule(
    "/core/frontend/configuration/headless.ts",
  ) as ConfigurationModule);
  ({ createShipctlPlugin } = await vite.ssrLoadModule(
    "/modules/runtime-operations/artifact/src/index.ts",
  ) as ArtifactModule);
  ({ createFakePluginDataServiceProvider } = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ) as TestingModule);
  pluginApi = await vite.ssrLoadModule("/module-api/frontend/src/index.ts") as PluginApi;
  template = JSON.parse(await readFile(
    fileURLToPath(new URL(
      "../../../../modules/runtime-operations/artifact/module.template.json",
      import.meta.url,
    )),
    "utf8",
  )) as RuntimeOperationsTemplate;
});

after(async () => {
  await vite?.close();
});

function emptyCatalog(): WorkspaceCatalogSnapshot {
  return parseWorkspaceCatalogSnapshot({
    schemaVersion: 2,
    revision: 1,
    definitions: [],
  });
}

async function fixtureServices(workspaceId = "fixture.headless"): Promise<{
  readonly services: InstanceType<typeof SemanticServiceRegistry>;
  dispose(): Promise<void>;
}> {
  const authority = await WorkspaceAuthority.open({
    workspaceId,
    catalog: emptyCatalog(),
    persistence: new InMemoryWorkspacePersistence(),
    defaultProfile: ({ workspaceId: id }) => parseUiWorkspaceDocument({
      schemaVersion: 2,
      workspaceId: id,
      instances: [],
      root: null,
      floating: [],
      maximizedStackId: null,
    }),
  });
  const configuration = createHostConfigurationRuntime({
    pluginDataServiceProvider: createFakePluginDataServiceProvider(),
    legacy: { read: async () => null },
  });
  return {
    services: new SemanticServiceRegistry([
      createWorkspaceServiceProvider({ authority }),
      createHostConfigurationServiceProvider({ runtime: configuration }),
    ]),
    dispose: () => configuration.dispose(),
  };
}

function admittedArtifact(contentDigest = "f".repeat(64)): HeadlessRuntimeArtifact {
  const definition = createShipctlPlugin({ pluginApi });
  return {
    definition,
    admission: {
      artifact: {
        contentDigest,
        entryUrl: "shipctl://fixture/runtime-operations/plugin.mjs",
        moduleId: definition.id,
        version: definition.version,
      },
      effectiveGrants: template.requestedGrants,
      application: template.application as HeadlessRuntimeArtifact["admission"]["application"],
      messages: template.messages as HeadlessRuntimeArtifact["admission"]["messages"],
    },
    capabilities: template.capabilities,
  };
}

async function invokeOnline(
  artifact: HeadlessRuntimeArtifact,
  services: InstanceType<typeof SemanticServiceRegistry>,
  capabilityId: string,
  portId: string,
  payload: unknown,
): Promise<unknown> {
  onlineActivationSequence += 1;
  const activation = await activatePluginDefinitionsObserved(
    undefined,
    [artifact.definition],
    new Map([[
      artifact.definition.id,
      `${artifact.definition.id}@fixture#online-${onlineActivationSequence}`,
    ]]),
    services,
    false,
    new Map([[artifact.definition.id, artifact.admission]]),
  );
  try {
    assert.deepEqual(activation.failures, []);
    const contribution = activation.contributionsByModule.get(artifact.definition.id)?.messages[0];
    const port = contribution?.ports?.find((candidate) => candidate.port.id === portId);
    assert(port, `online capability ${capabilityId}:${portId} is missing`);
    return await port.handle(payload);
  } finally {
    await activation.deactivate();
  }
}

test("admitted operation ports return byte-equivalent online and headless responses", async () => {
  const online = await fixtureServices();
  const offline = await fixtureServices();
  const onlineArtifact = admittedArtifact("1".repeat(64));
  const offlineArtifact = admittedArtifact("2".repeat(64));
  const headless = await createHeadlessRuntime({
    artifacts: [offlineArtifact],
    semanticServices: offline.services,
  });
  const workspaceId = "fixture.headless";
  const resetAt = (revision: number) => ({
    expectedRevision: revision,
    originId: "fixture.headless",
    kind: "reset",
  });
  const calls = [
    {
      capabilityId: "shipctl.workspace",
      portId: "shipctl.workspace.execute",
      payload: {
        schemaVersion: 1,
        operation: "workspace.inspect",
        workspaceId,
        includeDocument: true,
      },
    },
    {
      capabilityId: "shipctl.workspace",
      portId: "shipctl.workspace.execute",
      payload: { schemaVersion: 1, operation: "workspace.validate", workspaceId, command: resetAt(0) },
    },
    {
      capabilityId: "shipctl.workspace",
      portId: "shipctl.workspace.execute",
      payload: { schemaVersion: 1, operation: "workspace.plan", workspaceId, command: resetAt(0) },
    },
    {
      capabilityId: "shipctl.workspace",
      portId: "shipctl.workspace.execute",
      payload: { schemaVersion: 1, operation: "workspace.apply", workspaceId, command: resetAt(0) },
    },
    {
      capabilityId: "shipctl.workspace",
      portId: "shipctl.workspace.execute",
      payload: { schemaVersion: 1, operation: "workspace.mutate", workspaceId, command: resetAt(1) },
    },
    {
      capabilityId: "shipctl.configuration",
      portId: "shipctl.configuration.execute",
      payload: { schemaVersion: 1, operation: "configuration.inspect", key: "editor" },
    },
    {
      capabilityId: "shipctl.configuration",
      portId: "shipctl.configuration.execute",
      payload: {
        schemaVersion: 1,
        operation: "configuration.update",
        key: "editor",
        value: { preferredEditor: "zed" },
      },
    },
    {
      capabilityId: "shipctl.configuration",
      portId: "shipctl.configuration.execute",
      payload: { schemaVersion: 1, operation: "configuration.resolve", key: "editor" },
    },
  ] as const;

  try {
    for (const call of calls) {
      const onlineResponse = await invokeOnline(
        onlineArtifact,
        online.services,
        call.capabilityId,
        call.portId,
        call.payload,
      );
      const headlessResponse = await headless.invoke(call);
      assert.deepEqual(headlessResponse, onlineResponse, `${call.capabilityId}:${call.portId}`);
    }

    const unavailable = await headless.invoke({
      capabilityId: "shipctl.live-only",
      portId: "shipctl.live-only.execute",
      payload: {
        schemaVersion: 1,
        operation: "workspace.inspect",
        workspaceId,
        includeDocument: false,
      },
    });
    assert.deepEqual(unavailable, {
      schemaVersion: 1,
      status: "unavailable",
      operation: "workspace.inspect",
      code: "runtime.operation.unavailable",
      message: "The requested capability port is unavailable in the headless runtime.",
    });
  } finally {
    await headless.dispose();
    await online.dispose();
    await offline.dispose();
  }
});

test("headless execution rejects artifacts whose admission does not bind their code", async () => {
  const fixture = await fixtureServices();
  const artifact = admittedArtifact("3".repeat(64));
  const invalid: HeadlessRuntimeArtifact = {
    ...artifact,
    admission: {
      ...artifact.admission,
      artifact: { ...artifact.admission.artifact, moduleId: "shipctl.other" as never },
    },
  };
  try {
    await assert.rejects(
      createHeadlessRuntime({ artifacts: [invalid], semanticServices: fixture.services }),
      { code: "headless.runtime.invalid-artifact" },
    );
  } finally {
    await fixture.dispose();
  }
});

test("the headless entrypoint has no desktop or UI dependency", async () => {
  for (const relativePath of ["../headlessRuntime.ts", "../headless.ts"]) {
    const source = await readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /@tauri-apps|@shipctl\/core\/platform|react/i);
  }
});
