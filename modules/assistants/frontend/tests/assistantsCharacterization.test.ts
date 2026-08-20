import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ModuleActivationContext, ModuleNotice } from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

type AssistantsModule = typeof import("../src/index.ts");
type CredentialClientModule = typeof import("../src/credentialStoreClient.ts");
type TestingApi = typeof import("@shipctl/module-api/testing");

let vite: ViteDevServer;
let assistants: AssistantsModule;
let credentials: CredentialClientModule;
let testing: TestingApi;

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
  credentials = await vite.ssrLoadModule(
    "/modules/assistants/frontend/src/credentialStoreClient.ts",
  ) as CredentialClientModule;
  testing = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts") as TestingApi;
});

after(async () => {
  await vite.close();
});

function activationWithNotices(
  base: ModuleActivationContext,
  notices: ModuleNotice[],
): ModuleActivationContext {
  return Object.freeze({
    identity: base.identity,
    services: base.services,
    notices: {
      push: (notice: ModuleNotice) => { notices.push(notice); },
    },
    contributions: base.contributions,
    get disposed() { return base.disposed; },
    own: base.own,
  });
}

function fixture(options: {
  readonly deniedTerminalGrants?: readonly "terminal.start"[];
  readonly deniedCredentialGrants?: readonly ("credential.inspect" | "credential.write")[];
  readonly projectIds?: readonly string[];
} = {}) {
  const terminalTraces: Array<{ readonly operation: string; readonly request: { readonly input: unknown } }> = [];
  const assistantTraces: Array<{ readonly operation: string }> = [];
  const credentialTraces: Array<{ readonly operation: string; readonly secret?: "[REDACTED]" }> = [];
  const projectChanges = new testing.FakeProjectsChangeController(options.projectIds ?? []);
  const terminal = testing.createFakeTerminalSessionsServiceProvider({
    columns: 132,
    rows: 42,
    deniedGrants: options.deniedTerminalGrants,
    traces: terminalTraces,
  });
  const host = new testing.SemanticServiceTestHost([
    terminal.provider,
    testing.createFakeAssistantLaunchServiceProvider({ trace: assistantTraces }),
    testing.createFakeCredentialStoreServiceProvider({
      deniedGrants: options.deniedCredentialGrants,
      trace: credentialTraces,
    }),
    testing.createFakeProcessesServiceProvider({ availableCommands: ["claude", "codex"] }),
    testing.createFakeProjectsServiceProvider({ changes: projectChanges }),
  ]);
  const controller = host.activate(testing.createTestActivationIdentity("shipctl.assistants"));
  const notices: ModuleNotice[] = [];
  return {
    activation: activationWithNotices(controller.context, notices),
    assistantTraces,
    controller,
    credentialTraces,
    notices,
    projectChanges,
    terminal,
    terminalTraces,
  };
}

test("direct contribution identity and launcher migration metadata remain stable", () => {
  assert.equal(assistants.ASSISTANTS_MODULE_ID, "shipctl.assistants");
  assert.equal(assistants.assistantsContributions.panels[0].id, "assistants.launcher");
  assert.equal(assistants.assistantsContributions.panels[0].migrationAlias?.kind, "launcher");
  assert.equal(assistants.assistantsContributions.panels[0].newSession?.label, "Agent");
});

test("provider discovery and Pi settings use artifact policy through activation-scoped resources", () => {
  const client = readFileSync(
    fileURLToPath(new URL("../src/assistantLaunchClient.ts", import.meta.url)),
    "utf8",
  );
  const providerPolicy = readFileSync(
    fileURLToPath(new URL("../src/assistantProviderPolicy.ts", import.meta.url)),
    "utf8",
  );
  assert.match(client, /activation\.services\.require\(assistantLaunchService\)/);
  assert.match(client, /activation\.services\.require\(processesService\)/);
  assert.match(client, /service\.readResource/);
  assert.match(client, /service\.writeResource/);
  assert.match(client, /service\.executeResource/);
  assert.match(client, /getAssistantModels/);
  assert.match(client, /readPiConfig/);
  assert.match(client, /writePiSettings/);
  assert.match(providerPolicy, /codexModelsFromOutput/);
  assert.match(providerPolicy, /readPiConfig/);
  assert.doesNotMatch(client, /@tauri-apps|invoke|plugin:shipctl-assistants/);
  assert.doesNotMatch(providerPolicy, /@tauri-apps|invoke/);

  const credentialSource = readFileSync(
    fileURLToPath(new URL("../src/credentialStoreClient.ts", import.meta.url)),
    "utf8",
  );
  assert.match(credentialSource, /activation\.services\.require\(credentialStoreService\)/);
  assert.doesNotMatch(credentialSource, /@tauri-apps|invoke|Keychain|security/);
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

test("non-restorable providers launch through the activation-scoped terminal service", async () => {
  const current = fixture();
  try {
    assert.equal(
      await assistants.launchAssistant(
        "/repo",
        "antigravity",
        "yolo",
        "gemini-3",
        current.activation,
      ),
      true,
    );
    assert.deepEqual(current.terminalTraces.map(({ operation }) => operation), ["dimensions", "start"]);
    const request = current.terminalTraces.find(({ operation }) => operation === "start")?.request.input as {
      readonly moduleSessionId: string;
      readonly ownerKey: string;
      readonly command: string;
      readonly arguments: readonly string[];
      readonly columns: number;
      readonly rows: number;
    };
    assert.equal(request.ownerKey, "assistants:antigravity");
    assert.equal(request.command, "agy");
    assert.deepEqual(request.arguments, ["--model", "gemini-3", "--dangerously-skip-permissions"]);
    assert.equal(request.columns, 132);
    assert.equal(request.rows, 42);
    assert.match(request.moduleSessionId, /^assistants:/);
  } finally {
    await current.controller.dispose();
  }
});

test("Claude and Codex launch only through the managed terminal seam", async () => {
  const current = fixture();
  try {
    assert.equal(
      await assistants.launchAssistant("/repo", "claude", "standard", "sonnet", current.activation),
      true,
    );
    assert.deepEqual(current.terminalTraces.map(({ operation }) => operation), [
      "dimensions",
      "start-managed",
    ]);
    assert.deepEqual(current.assistantTraces.map(({ operation }) => operation), ["start-session"]);
    const request = current.terminalTraces.find(({ operation }) => operation === "start-managed")
      ?.request.input as { readonly ownerKey: string; readonly moduleSessionId: string };
    assert.equal(request.ownerKey, "assistants:claude");
    assert.match(request.moduleSessionId, /^assistants:/);
    assert.equal(current.terminal.host.sessions()[0]?.moduleId, "shipctl.assistants");
  } finally {
    await current.controller.dispose();
  }
});

test("terminal failures and denied credential writes stay explicit and activation-scoped", async () => {
  const terminalDenied = fixture({ deniedTerminalGrants: ["terminal.start"] });
  try {
    assert.equal(
      await assistants.launchAssistant("/repo", "opencode", "standard", undefined, terminalDenied.activation),
      false,
    );
    assert.equal(terminalDenied.notices[0]?.tone, "error");
    assert.match(terminalDenied.notices[0]?.message ?? "", /denied/i);
  } finally {
    await terminalDenied.controller.dispose();
  }

  const credentialDenied = fixture({ deniedCredentialGrants: ["credential.write"] });
  try {
    await assert.rejects(
      () => credentials.piCredentialClientFor(credentialDenied.activation).saveApiKey("anthropic", "secret"),
      /denied/i,
    );
    assert.equal(credentialDenied.credentialTraces[0]?.operation, "save-credential");
    assert.equal(credentialDenied.credentialTraces[0]?.secret, "[REDACTED]");
    assert.equal(credentialDenied.credentialTraces[0]?.activation.moduleId, "shipctl.assistants");
  } finally {
    await credentialDenied.controller.dispose();
  }
});

test("direct runtime owns and releases terminal and project subscriptions", async () => {
  const current = fixture({ projectIds: ["/repo"] });
  try {
    const cleanup = await assistants.activateAssistantsRuntime(current.activation);
    assert.deepEqual(current.assistantTraces.map(({ operation }) => operation), [
      "take-startup-warning",
      "inspect-restorable-sessions",
    ]);
    await cleanup();
    await current.projectChanges.setProjects(["/after-cleanup"]);
    assert.deepEqual(current.assistantTraces.map(({ operation }) => operation), [
      "take-startup-warning",
      "inspect-restorable-sessions",
    ]);
  } finally {
    await current.controller.dispose();
  }
});
