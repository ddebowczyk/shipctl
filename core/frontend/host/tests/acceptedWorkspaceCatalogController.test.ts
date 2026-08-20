import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { WorkspaceCatalogSnapshot, WorkspacePersistedRecord } from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

type ControllerModule = typeof import("../acceptedWorkspaceCatalogController.ts");
type WorkspaceModule = typeof import("../../workspace/index.ts");

let vite: ViteDevServer;
let AcceptedWorkspaceCatalogController: ControllerModule["AcceptedWorkspaceCatalogController"];
let WorkspaceAuthority: WorkspaceModule["WorkspaceAuthority"];
let InMemoryWorkspacePersistence: WorkspaceModule["InMemoryWorkspacePersistence"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ AcceptedWorkspaceCatalogController } = await vite.ssrLoadModule(
    "/core/frontend/host/acceptedWorkspaceCatalogController.ts",
  ) as ControllerModule);
  ({ WorkspaceAuthority, InMemoryWorkspacePersistence } = await vite.ssrLoadModule(
    "/core/frontend/workspace/index.ts",
  ) as WorkspaceModule);
});

after(async () => {
  await vite.close();
});

const WORKSPACE_ID = "shipctl.workspace";

function catalog(revision: number, includeUsage = true): WorkspaceCatalogSnapshot {
  return {
    schemaVersion: 2,
    revision,
    definitions: includeUsage ? [{
      viewTypeId: "shipctl.usage",
      ownerModuleId: "shipctl.usage",
      ownerActivationId: "shipctl.usage@1#test",
      label: "Usage",
      scope: "global",
      cardinality: "singleton",
      closeBehavior: "hide",
      requiredCapabilityIds: [],
      placement: { defaultRegion: "primary", allowSplit: true },
      presentation: { loaderId: "shipctl.usage", exportName: "default" },
      migrationAliases: [],
    }] : [],
  };
}

function emptyProfile({ workspaceId }: { readonly workspaceId: string }) {
  return {
    schemaVersion: 2,
    workspaceId,
    instances: [],
    root: null,
    floating: [],
    maximizedStackId: null,
  };
}

test("an accepted catalog synchronizes after publication and becomes durable", async () => {
  const persistence = new InMemoryWorkspacePersistence();
  const authority = await WorkspaceAuthority.open({
    workspaceId: WORKSPACE_ID,
    catalog: catalog(0, false),
    persistence,
    defaultProfile: emptyProfile,
    deferCatalogReconciliationUntilFirstAcceptedSnapshot: true,
  });
  const controller = new AcceptedWorkspaceCatalogController({ authority });

  await controller.submit(catalog(4));

  assert.equal(authority.inspect().catalogRevision, 4);
  assert.equal(authority.revision, 1);
  assert.equal((await persistence.load(WORKSPACE_ID))?.catalogRevision, 4);
});

test("a stale accepted catalog cannot regress an already queued runtime stream", async () => {
  const persistence = new InMemoryWorkspacePersistence();
  const authority = await WorkspaceAuthority.open({
    workspaceId: WORKSPACE_ID,
    catalog: catalog(0, false),
    persistence,
    defaultProfile: emptyProfile,
    deferCatalogReconciliationUntilFirstAcceptedSnapshot: true,
  });
  const controller = new AcceptedWorkspaceCatalogController({ authority });

  await controller.submit(catalog(5, false));
  await controller.submit(catalog(4));

  assert.equal(authority.inspect().catalogRevision, 5);
  assert.deepEqual(authority.inspect().viewDefinitions, []);
});

test("an invalid observer catalog cannot suppress a later accepted catalog", async () => {
  const failures: Array<{ catalogRevision: number; message: string }> = [];
  const persistence = new InMemoryWorkspacePersistence();
  const authority = await WorkspaceAuthority.open({
    workspaceId: WORKSPACE_ID,
    catalog: catalog(0, false),
    persistence,
    defaultProfile: emptyProfile,
    deferCatalogReconciliationUntilFirstAcceptedSnapshot: true,
  });
  const controller = new AcceptedWorkspaceCatalogController({
    authority,
    onFailure: (failure) => failures.push(failure),
  });

  await controller.submit(catalog(Number.POSITIVE_INFINITY));
  await controller.submit(catalog(6));

  assert.equal(failures.length, 1);
  assert.equal(authority.inspect().catalogRevision, 6);
});

test("bootstrap preserves a matching persisted catalog until the first accepted snapshot", async () => {
  const seed = new InMemoryWorkspacePersistence();
  const first = await WorkspaceAuthority.open({
    workspaceId: WORKSPACE_ID,
    catalog: catalog(4),
    persistence: seed,
    defaultProfile: emptyProfile,
  });
  await first.mutate({
    kind: "open",
    expectedRevision: first.revision,
    originId: "seed",
    instanceId: "usage",
    viewTypeId: "shipctl.usage",
    resource: { kind: "global" },
    placement: { kind: "default" },
    label: null,
  });

  const restored = await WorkspaceAuthority.open({
    workspaceId: WORKSPACE_ID,
    catalog: catalog(0, false),
    persistence: seed,
    defaultProfile: emptyProfile,
    deferCatalogReconciliationUntilFirstAcceptedSnapshot: true,
  });
  assert.equal(restored.inspect(true).document.instances[0]?.availability.kind, "available");

  const controller = new AcceptedWorkspaceCatalogController({ authority: restored });
  await controller.submit(catalog(4));

  assert.equal(restored.revision, 1);
  assert.equal(restored.inspect().catalogRevision, 4);
  assert.equal(restored.inspect(true).document.instances[0]?.availability.kind, "available");
});

test("a persistence failure is reported without rejecting the accepted runtime catalog", async () => {
  const failures: Array<{ catalogRevision: number; message: string }> = [];
  const persistence = {
    load: async () => undefined,
    compareAndSave: async () => { throw new Error("storage unavailable"); },
  };
  const authority = await WorkspaceAuthority.open({
    workspaceId: WORKSPACE_ID,
    catalog: catalog(0, false),
    persistence,
    defaultProfile: emptyProfile,
    deferCatalogReconciliationUntilFirstAcceptedSnapshot: true,
  });
  const controller = new AcceptedWorkspaceCatalogController({
    authority,
    onFailure: (failure) => failures.push(failure),
  });

  await controller.submit(catalog(1));

  assert.equal(authority.inspect().catalogRevision, 0);
  assert.equal(authority.revision, 0);
  assert.deepEqual(failures, [{ catalogRevision: 1, message: "storage unavailable" }]);
});
