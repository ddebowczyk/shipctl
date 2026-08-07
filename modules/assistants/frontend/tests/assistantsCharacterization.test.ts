import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ModuleHostServices,
  ModuleManagedTerminalSessionLaunchRequest,
  ModuleTerminalSessionLaunchRequest,
  ModuleTerminalSessionLifecycleEvent,
} from "@shep/module-api";
import { createServer, type ViteDevServer } from "vite";

type AssistantsModule = typeof import("../src/index.ts");

let vite: ViteDevServer;
let assistants: AssistantsModule;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  assistants = await vite.ssrLoadModule(
    "/modules/assistants/frontend/src/index.ts",
  ) as AssistantsModule;
});

after(async () => {
  await vite.close();
});

function fixtureServices() {
  const calls: Array<readonly [string, unknown?]> = [];
  let listener: ((event: ModuleTerminalSessionLifecycleEvent) => void | Promise<void>) | null = null;
  const services = {
    panels: {
      open: () => "fixture-panel",
      reveal: () => undefined,
      close: () => undefined,
    },
    appearance: {
      getSnapshot: () => ({ themeId: "fixture", background: "#000" }),
      subscribe: () => () => undefined,
    },
    globalData: {
      read: async () => undefined,
      replace: async () => undefined,
    },
    projectData: {
      read: async () => undefined,
      replace: async () => undefined,
    },
    terminalSessions: {
      getDimensions: () => ({ columns: 132, rows: 42 }),
      launch: async (request: ModuleTerminalSessionLaunchRequest) => {
        calls.push(["launch", request]);
        return {
          id: "fixture-terminal",
          projectPath: request.projectPath,
          ownerKey: request.ownerKey,
          label: request.label,
          ownerMetadata: request.ownerMetadata,
          presentation: request.presentation,
        };
      },
      launchManaged: async (request: ModuleManagedTerminalSessionLaunchRequest) => {
        calls.push(["launch-managed", request]);
        return {
          id: "fixture-managed-terminal",
          projectPath: request.projectPath,
          ownerKey: request.ownerKey,
          label: request.label,
          ownerMetadata: request.ownerMetadata,
          presentation: request.presentation,
        };
      },
      update: async (sessionId, update) => ({
        id: sessionId,
        projectPath: "/repo",
        ownerKey: "assistants:fixture",
        label: update.label ?? "Fixture",
        ownerMetadata: update.ownerMetadata,
        presentation: update.presentation,
      }),
      stop: async () => undefined,
      focus: async () => undefined,
      subscribe: (next) => {
        calls.push(["subscribe"]);
        listener = next;
        return () => {
          calls.push(["unsubscribe"]);
          if (listener === next) listener = null;
        };
      },
    },
    settings: {
      getSnapshot: () => ({ values: {}, isSaving: false, error: null }),
      subscribe: () => () => undefined,
      update: async () => undefined,
    },
    skills: {
      getSnapshot: () => ({ byProject: {} }),
      subscribe: () => () => undefined,
      install: async () => undefined,
    },
    notices: { push: (notice) => calls.push(["notice", notice]) },
    externalLinks: { open: async () => undefined },
  } satisfies ModuleHostServices;
  return { calls, services };
}

test("module identity and launcher migration metadata remain stable", () => {
  assert.equal(assistants.assistantsModule.id, "shep.assistants");
  assert.equal(assistants.assistantsModule.panels[0].id, "assistants.launcher");
  assert.equal(assistants.assistantsModule.panels[0].migrationAlias.kind, "launcher");
  assert.equal(assistants.assistantsModule.panels[0].newSession.label, "Agent");
});

test("provider discovery and Pi settings are namespaced to the Assistants native module", () => {
  const client = readFileSync(
    fileURLToPath(new URL("../src/client.ts", import.meta.url)),
    "utf8",
  );
  assert.match(client, /assistantCommand\("get_models_for_provider"\)/);
  assert.match(client, /assistantCommand\("get_pi_config"\)/);
  assert.match(client, /assistantCommand\("save_pi_settings"\)/);
  assert.match(client, /assistantCommand\("save_pi_api_key"\)/);
  assert.match(client, /assistantCommand\("delete_pi_api_key"\)/);
  assert.doesNotMatch(client, /invoke\("get_models_for_provider"/);
  assert.doesNotMatch(client, /invoke\("(?:get|save|delete)_pi_/);
});

test("the provider catalogue preserves commands and exact launch flags", () => {
  assert.deepEqual(
    assistants.CODING_ASSISTANTS.map(({ id, command, yoloFlag, modelFlag }) => ({
      id,
      command,
      yoloFlag,
      modelFlag,
    })),
    [
      { id: "claude", command: "claude", yoloFlag: "--dangerously-skip-permissions", modelFlag: "--model" },
      { id: "codex", command: "codex", yoloFlag: "--yolo", modelFlag: "--model" },
      { id: "antigravity", command: "agy", yoloFlag: "--dangerously-skip-permissions", modelFlag: "--model" },
      { id: "opencode", command: "opencode", yoloFlag: null, modelFlag: "--model" },
      { id: "pi", command: "pi", yoloFlag: null, modelFlag: "--model" },
    ],
  );
});

test("non-restorable providers launch through the generic terminal port", async () => {
  const fixture = fixtureServices();
  assert.equal(
    await assistants.launchAssistant("/repo", "antigravity", "yolo", "gemini-3", fixture.services),
    true,
  );
  const request = fixture.calls.find(([kind]) => kind === "launch")?.[1] as ModuleTerminalSessionLaunchRequest;
  assert.deepEqual(request, {
    projectPath: "/repo",
    ownerKey: "assistants:antigravity",
    command: "agy",
    arguments: ["--model", "gemini-3", "--dangerously-skip-permissions"],
    cwd: "/repo",
    label: "Antigravity",
    ownerMetadata: {
      provider: "antigravity",
      mode: "yolo",
      record: null,
      restoring: false,
    },
    presentation: request.presentation,
    columns: 132,
    rows: 42,
  });
  assert.equal(request.presentation?.showInSessionList, true);
});

test("Claude and Codex launch only through the managed terminal seam", async () => {
  const fixture = fixtureServices();
  assert.equal(
    await assistants.launchAssistant("/repo", "claude", "standard", "sonnet", fixture.services),
    true,
  );
  assert.equal(fixture.calls.some(([kind]) => kind === "launch"), false);
  const request = fixture.calls.find(([kind]) => kind === "launch-managed")?.[1] as ModuleManagedTerminalSessionLaunchRequest;
  assert.equal(request.ownerKey, "assistants:claude");
  assert.equal(request.cwd, "/repo");
  assert.equal(request.presentation?.showInSessionList, true);
  assert.equal(request.presentation?.badge?.label, "saving");
  assert.deepEqual(request.ownerMetadata, {
    provider: "claude",
    mode: "standard",
    record: null,
    restoring: false,
  });
  assert.equal(typeof request.start, "function");
});

test("module activation owns and releases its terminal lifecycle subscription", async () => {
  const fixture = fixtureServices();
  const activation = assistants.assistantsModule.activate?.({
    panels: fixture.services.panels,
    services: fixture.services,
  });
  assert.ok(activation);
  assert.deepEqual(fixture.calls.map(([kind]) => kind), ["subscribe"]);
  await activation.deactivate();
  assert.deepEqual(fixture.calls.map(([kind]) => kind), ["subscribe", "unsubscribe"]);
});
