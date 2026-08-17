import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { WorkspacePersistedRecord } from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

type WorkspacePersistenceModule = typeof import("../workspacePersistence.ts");

let vite: ViteDevServer;
let createTauriWorkspacePersistencePort: WorkspacePersistenceModule["createTauriWorkspacePersistencePort"];
let WorkspacePersistencePortError: WorkspacePersistenceModule["WorkspacePersistencePortError"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({
    createTauriWorkspacePersistencePort,
    WorkspacePersistencePortError,
  } = await vite.ssrLoadModule(
    "/core/frontend/platform/workspacePersistence.ts",
  ) as WorkspacePersistenceModule);
});

after(async () => {
  await vite.close();
});

const WORKSPACE_ID = "shipctl.workspace";

function record(
  revision: number,
  originId = "workspace-webview",
  catalogRevision = 0,
): WorkspacePersistedRecord {
  return {
    storageSchemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    revision: revision as WorkspacePersistedRecord["revision"],
    originId,
    catalogRevision,
    document: {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      profileId: "shipctl.test",
      instances: [],
      root: null,
      floating: [],
      maximizedStackId: null,
    },
  };
}

test("the semantic workspace port owns the exact Tauri load and compare-and-save mapping", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createTauriWorkspacePersistencePort({
    invokeCommand: async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "load_workspace_document") return record(4, "saved-webview", 3) as T;
      return { status: "saved", record: record(5, "active-webview", 4) } as T;
    },
  });

  assert.deepEqual(await port.load(WORKSPACE_ID), record(4, "saved-webview", 3));
  assert.deepEqual(await port.compareAndSave({
    workspaceId: WORKSPACE_ID,
    expectedRevision: 4 as WorkspacePersistedRecord["revision"],
    record: record(5, "active-webview", 4),
  }), {
    status: "saved",
    record: record(5, "active-webview", 4),
  });
  assert.deepEqual(calls, [
    {
      command: "load_workspace_document",
      args: { workspaceId: WORKSPACE_ID },
    },
    {
      command: "save_workspace_document",
      args: {
        workspaceId: WORKSPACE_ID,
        expectedRevision: 4,
        record: record(5, "active-webview", 4),
      },
    },
  ]);
});

test("a compare-and-save conflict preserves the optional missing-current case", async () => {
  const port = createTauriWorkspacePersistencePort({
    invokeCommand: async <T>() => ({ status: "conflict", current: null }) as T,
  });

  assert.deepEqual(await port.compareAndSave({
    workspaceId: WORKSPACE_ID,
    expectedRevision: 1 as WorkspacePersistedRecord["revision"],
    record: record(2),
  }), { status: "conflict", current: undefined });
});

test("a malformed confirmation is rejected before it reaches the workspace authority", async () => {
  const port = createTauriWorkspacePersistencePort({
    invokeCommand: async <T>() => ({
      status: "saved",
      record: record(2, "different-origin"),
    }) as T,
  });

  await assert.rejects(
    port.compareAndSave({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 1 as WorkspacePersistedRecord["revision"],
      record: record(2, "expected-origin"),
    }),
    (error: unknown) => (
      error instanceof WorkspacePersistencePortError
      && error.code === "WORKSPACE_PERSISTENCE_TRANSPORT_INVALID"
      && !error.message.includes("profileId")
    ),
  );
});

test("the bootstrap catalog revision zero remains valid at the native boundary", async () => {
  const port = createTauriWorkspacePersistencePort({
    invokeCommand: async <T>() => record(1, "bootstrap", 0) as T,
  });

  assert.deepEqual(await port.load(WORKSPACE_ID), record(1, "bootstrap", 0));
});
