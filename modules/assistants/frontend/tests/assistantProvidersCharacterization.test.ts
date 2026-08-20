import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

type ProviderPolicyModule = typeof import("../src/assistantProviderPolicy.ts");

let vite: ViteDevServer;
let policy: ProviderPolicyModule;

const source = (path: string) => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  "utf8",
);

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  policy = await vite.ssrLoadModule(
    "/modules/assistants/frontend/src/assistantProviderPolicy.ts",
  ) as ProviderPolicyModule;
});

after(async () => {
  await vite.close();
});

test("the module owns the current five CLI providers and their exact flags", () => {
  const catalogue = source("../src/catalog.ts");

  assert.match(catalogue, /id: "claude"[\s\S]*command: "claude"[\s\S]*yoloFlag: "--dangerously-skip-permissions"[\s\S]*modelFlag: "--model"/);
  assert.match(catalogue, /id: "codex"[\s\S]*command: "codex"[\s\S]*yoloFlag: "--yolo"[\s\S]*modelFlag: "--model"/);
  assert.match(catalogue, /id: "antigravity"[\s\S]*command: "agy"/);
  assert.match(catalogue, /id: "opencode"[\s\S]*command: "opencode"[\s\S]*yoloFlag: null/);
  assert.match(catalogue, /id: "pi"[\s\S]*command: "pi"[\s\S]*yoloFlag: null/);
  assert.match(catalogue, /ASSISTANT_INSTALL_URLS/);
  assert.doesNotMatch(catalogue, /sdk|apiKey/i);
});

test("the artifact owns provider launch and recovery policy", () => {
  const catalog = policy.createAssistantProviderPolicyCatalog();
  const claude = catalog.get("claude");
  const codex = catalog.get("codex");
  const pi = catalog.get("pi");

  assert.equal(claude?.restorable, true);
  assert.equal(codex?.restorable, true);
  assert.equal(pi?.restorable, false);
  assert.equal(claude?.capture, undefined);
  assert.equal(typeof codex?.capture?.snapshot, "function");

  const claudeLaunch = claude?.prepareNew?.({ mode: "yolo", model: "sonnet" });
  assert.equal(claudeLaunch?.launch.program, "claude");
  assert.deepEqual(claudeLaunch?.launch.arguments.slice(0, -2), [
    "--model",
    "sonnet",
    "--dangerously-skip-permissions",
  ]);
  assert.deepEqual(claudeLaunch?.launch.arguments.slice(-2), [
    "--session-id",
    claudeLaunch.initialSessionIdentity,
  ]);

  assert.deepEqual(codex?.prepareNew?.({ mode: "yolo", model: "gpt-5" }), {
    launch: { program: "codex", arguments: ["--model", "gpt-5", "--yolo"] },
  });
  assert.deepEqual(codex?.prepareResume?.({
    recordId: "record" as never,
    provider: "codex" as never,
    launchRepoPath: "/repo",
    placementProjectPath: "/repo",
    label: "Codex",
    sessionMode: "yolo",
    model: "gpt-5",
    captureState: "ready",
    restoreOnNextLaunch: true,
    startedAt: 1,
    updatedAt: 1,
  }), {
    program: "codex",
    arguments: ["--model", "gpt-5", "--yolo", "resume", { kind: "captured-session-id" }],
  });
});

test("Codex transcript capture is plugin-owned, exact, and refuses ambiguity", () => {
  const known = new Set(["old.jsonl"]);
  const files = [
    { relativePath: "old.jsonl", content: '{"type":"session_meta","payload":{"id":"old","cwd":"/repo"}}' },
    { relativePath: "new.jsonl", content: '{"type":"session_meta","payload":{"id":"new","cwd":"/repo"}}' },
  ];
  assert.equal(policy.selectCodexCaptureIdentity(known, "/repo", files), "new");
  assert.equal(policy.selectCodexCaptureIdentity(known, "/other", files), null);
  assert.throws(() => policy.selectCodexCaptureIdentity(new Set(), "/repo", [
    ...files.slice(1),
    { relativePath: "other.jsonl", content: '{"type":"session_meta","payload":{"id":"other","cwd":"/repo"}}' },
  ]), /will not guess/);
});

test("an externally declared fixture policy can launch and capture through generic ports", async () => {
  const defaultCatalog = policy.createAssistantProviderPolicyCatalog();
  const reads: string[] = [];
  const resources = {
    async readResource(input: { request: { resourceId: string } }) {
      reads.push(input.request.resourceId);
      return {
        kind: "tree" as const,
        resourceId: input.request.resourceId,
        files: [{ relativePath: "new.fixture", content: "fixture-session" }],
      };
    },
    async writeResource() {},
    async executeResource() {
      return { resourceId: "fixture", stdout: "", stderr: "", status: 0 };
    },
  };
  const fixture = {
    id: "fixture-policy",
    restorable: true as const,
    prepareNew: () => ({
      launch: { program: "fixture-cli", arguments: ["start"] },
    }),
    prepareResume: () => ({
      program: "fixture-cli",
      arguments: ["resume", { kind: "captured-session-id" as const }],
    }),
    capture: {
      async snapshot(port: typeof resources) {
        const result = await port.readResource({
          request: { kind: "tree", resourceId: "fixture-transcripts", relativePath: ".fixture" },
        });
        return { knownTranscriptPaths: new Set(result.files.map((file) => file.relativePath)) };
      },
      async findIdentity(_record: unknown, _snapshot: unknown, port: typeof resources) {
        const result = await port.readResource({
          request: { kind: "tree", resourceId: "fixture-transcripts", relativePath: ".fixture" },
        });
        return result.files.find(({ relativePath }) => relativePath === "new.fixture")?.content ?? null;
      },
    },
  };
  const catalog = policy.createAssistantProviderPolicyCatalog([
    ...defaultCatalog.policies,
    fixture,
  ]);
  const declared = catalog.get("fixture-policy");
  assert.deepEqual(declared?.prepareNew?.({ mode: "fixture" }), {
    launch: { program: "fixture-cli", arguments: ["start"] },
  });
  const snapshot = await declared?.capture?.snapshot(resources);
  const identity = await declared?.capture?.findIdentity({} as never, snapshot!, resources);
  assert.equal(identity, "fixture-session");
  assert.deepEqual(reads, ["fixture-transcripts", "fixture-transcripts"]);
});

test("resource, model, and Pi configuration policy stay in the artifact", () => {
  const providerPolicy = source("../src/assistantProviderPolicy.ts");
  const client = source("../src/assistantLaunchClient.ts");
  const runtime = source("../src/runtime.ts");
  const backend = source("../../../../core/backend/src/assistant_launch/mod.rs");
  const resources = source("../../../../core/backend/src/assistant_launch/resources.rs");

  assert.match(providerPolicy, /readResource[\s\S]*writeResource[\s\S]*executeResource/);
  assert.match(providerPolicy, /codexModelsFromOutput/);
  assert.match(providerPolicy, /jsonl-response-id/);
  assert.match(providerPolicy, /readPiConfig[\s\S]*writePiSettings/);
  assert.match(client, /service\.readResource/);
  assert.match(client, /service\.writeResource/);
  assert.match(client, /service\.executeResource/);
  assert.match(runtime, /CAPTURE_RETRY_MS = 500/);
  assert.match(runtime, /CAPTURE_MAX_ATTEMPTS = 20/);
  assert.match(runtime, /client\.recordSessionIdentity/);
  assert.match(runtime, /prepareAssistantsForShutdown/);
  assert.doesNotMatch(providerPolicy, /@tauri-apps|invoke\(/);
  assert.doesNotMatch(backend, /AssistantProvider|Claude|Codex|PiConfig|inspect_models|save_provider_configuration/);
  assert.match(resources, /home_candidate/);
  assert.match(resources, /validate_program/);
});

test("the module-owned launcher bounds unavailable, model, mode, and start behavior", () => {
  const launcher = source("../src/SessionLauncher.tsx");

  assert.match(launcher, /await Promise\.all\([\s\S]*assistantClient\.checkCommandExists\(a\.command\)\.catch\(\(\) => false\)/);
  assert.match(launcher, /const isAvailable = available\[assistant\.id\] !== false/);
  assert.match(launcher, /if \(isAvailable\) \{[\s\S]*handleSelectAssistant\(assistant\)[\s\S]*\} else \{[\s\S]*setInstallPopover/s);
  assert.match(launcher, /assistantClient\.getModelsForProvider\(assistant\.id\)/);
  assert.match(launcher, /supportsModelSelection = \(id: string\) => id !== "pi" && id !== "opencode"/);
  assert.match(launcher, /supportsMode = \(id: string\) => id !== "pi" && id !== "opencode"/);
  assert.match(launcher, /const started = await launchAssistant\([\s\S]*selectedAssistant\.id,[\s\S]*mode,[\s\S]*selectedModel \?\? undefined,[\s\S]*activation,[\s\S]*assistantClient/s);
  assert.match(launcher, /if \(started\) close\(\);\s*else setLaunching\(false\);/);
});

test("resume, close, startup recovery, and normal shutdown remain module-owned", () => {
  const runtime = source("../src/runtime.ts");
  const artifact = source("../../artifact/src/index.ts");
  const shell = source("../../../../core/frontend/shell/AppShell.tsx");
  const terminalActions = source("../../../../core/frontend/terminal-host/useTerminalActions.ts");

  assert.match(runtime, /RESTORE_PROBATION_MS = 5000/);
  assert.match(runtime, /projectPath: record\.placementProjectPath/);
  assert.match(runtime, /cwd: record\.launchRepoPath/);
  assert.match(runtime, /ownerKey: `\$\{OWNER_PREFIX\}\$\{record\.provider\}`/);
  assert.match(runtime, /if \(metadata\.restoring\) \{[\s\S]*await client\.rearmSession\(metadata\.record\.recordId\)/s);
  assert.match(runtime, /event\.type === "stop-requested"[\s\S]*await client\.discardSession\(metadata\.record\.recordId\)/s);
  assert.match(runtime, /const records = await client\.listRestorableSessions\(\)/);
  assert.match(runtime, /for \(const record of records\) await restoreRecord\(record, registered, activation, client\)/);
  assert.match(artifact, /beforeShutdown\(context\)[\s\S]*prepareAssistantsForShutdown/);
  assert.match(shell, /await beforeShutdown\(\);\s*await shutdownAndQuit\(\)/);
  assert.doesNotMatch(terminalActions, /discardAssistantSession|rearmAssistantSession|failAssistantSessionCapture/);
});
