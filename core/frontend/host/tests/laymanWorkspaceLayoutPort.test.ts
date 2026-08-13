import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createServer, type ViteDevServer } from "vite";
import type { LaymanSerializedState, LaymanWorkspaceUpdate } from "react-layman";

type WorkspaceLayoutPortModule = typeof import("../laymanWorkspaceLayoutPort.ts");

let vite: ViteDevServer;
let createTauriWorkspaceLayoutSnapshotPort: WorkspaceLayoutPortModule["createTauriWorkspaceLayoutSnapshotPort"];
let WorkspaceLayoutPortError: WorkspaceLayoutPortModule["WorkspaceLayoutPortError"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({
    createTauriWorkspaceLayoutSnapshotPort,
    WorkspaceLayoutPortError,
  } = await vite.ssrLoadModule(
    "/core/frontend/host/laymanWorkspaceLayoutPort.ts",
  ) as WorkspaceLayoutPortModule);
});

after(async () => {
  await vite.close();
});

const WORKSPACE_ID = "shipctl.canvas";
const SNAPSHOT: LaymanSerializedState = {
  schemaVersion: 2,
  layout: null,
  floatingWindows: [],
};

function record(revision: number, originId = "other-webview") {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    revision,
    originId,
    snapshot: SNAPSHOT,
  };
}

test("the host port owns the exact Tauri command, CAS, and event mapping", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const events: string[] = [];
  let receiveEvent: ((event: { readonly payload: unknown }) => void) | undefined;
  const port = createTauriWorkspaceLayoutSnapshotPort({
    invokeCommand: async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "load_workspace_layout") return record(4, "saved-webview") as T;
      return {
        status: "saved",
        record: record(5, "active-webview"),
      } as T;
    },
    listenEvent: async (event, receive) => {
      events.push(event);
      receiveEvent = receive as (event: { readonly payload: unknown }) => void;
      return () => {
        receiveEvent = undefined;
      };
    },
  });

  assert.deepEqual(await port.load(WORKSPACE_ID), {
    revision: 4,
    originId: "saved-webview",
    snapshot: SNAPSHOT,
  });
  assert.deepEqual(await port.compareAndSave(WORKSPACE_ID, {
    expectedRevision: 4,
    originId: "active-webview",
    snapshot: SNAPSHOT,
  }), {
    status: "saved",
    update: {
      revision: 5,
      originId: "active-webview",
      snapshot: SNAPSHOT,
    },
  });

  const received: LaymanWorkspaceUpdate[] = [];
  const unsubscribe = await port.subscribe?.(WORKSPACE_ID, (update) => received.push(update));
  receiveEvent?.({ payload: record(6, "other-webview") });
  unsubscribe?.();
  receiveEvent?.({ payload: record(7, "other-webview") });

  assert.deepEqual(calls, [
    {
      command: "load_workspace_layout",
      args: { workspaceId: WORKSPACE_ID },
    },
    {
      command: "save_workspace_layout",
      args: {
        workspaceId: WORKSPACE_ID,
        expectedRevision: 4,
        originId: "active-webview",
        snapshot: SNAPSHOT,
      },
    },
  ]);
  assert.deepEqual(events, ["shipctl://workspace-layout-changed"]);
  assert.deepEqual(received, [{
    revision: 6,
    originId: "other-webview",
    snapshot: SNAPSHOT,
  }]);
});

test("a compare-and-save conflict returns the current record for Layman recovery", async () => {
  const port = createTauriWorkspaceLayoutSnapshotPort({
    invokeCommand: async <T>() => ({
      status: "conflict",
      current: record(5, "other-webview"),
    }) as T,
  });

  assert.deepEqual(await port.compareAndSave(WORKSPACE_ID, {
    expectedRevision: 4,
    originId: "active-webview",
    snapshot: SNAPSHOT,
  }), {
    status: "conflict",
    current: {
      revision: 5,
      originId: "other-webview",
      snapshot: SNAPSHOT,
    },
  });
});

test("a conflict without a current record is a payload-free transport error", async () => {
  const port = createTauriWorkspaceLayoutSnapshotPort({
    invokeCommand: async <T>() => ({
      status: "conflict",
      current: null,
    }) as T,
  });

  await assert.rejects(
    port.compareAndSave(WORKSPACE_ID, {
      expectedRevision: 4,
      originId: "active-webview",
      snapshot: SNAPSHOT,
    }),
    (error: unknown) => (
      error instanceof WorkspaceLayoutPortError
      && error.code === "CANVAS_LAYOUT_TRANSPORT_INVALID"
      && !error.message.includes("floatingWindows")
    ),
  );
});

test("a persisted revision-zero record is rejected before Layman receives it", async () => {
  const port = createTauriWorkspaceLayoutSnapshotPort({
    invokeCommand: async <T>() => record(0) as T,
  });

  await assert.rejects(
    port.load(WORKSPACE_ID),
    (error: unknown) => (
      error instanceof WorkspaceLayoutPortError
      && error.code === "CANVAS_LAYOUT_REVISION_INVALID"
    ),
  );
});

test("a malformed layout event is rejected and sent to the diagnostics callback", async () => {
  const errors: Array<{ code: string; message: string }> = [];
  let receiveEvent: ((event: { readonly payload: unknown }) => void) | undefined;
  const port = createTauriWorkspaceLayoutSnapshotPort({
    listenEvent: async (_event, receive) => {
      receiveEvent = receive as (event: { readonly payload: unknown }) => void;
      return () => undefined;
    },
    onTransportError: (error) => errors.push({ code: error.code, message: error.message }),
  });

  await port.subscribe?.(WORKSPACE_ID, () => undefined);
  receiveEvent?.({ payload: { workspaceId: WORKSPACE_ID } });

  assert.deepEqual(errors, [{
    code: "CANVAS_LAYOUT_STORAGE_SCHEMA_UNSUPPORTED",
    message: "[CANVAS_LAYOUT_STORAGE_SCHEMA_UNSUPPORTED] Layout change event has an unsupported workspace layout schema.",
  }]);
});
