import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = (path: string) => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  "utf8",
);

test("the module owns the current five CLI providers and their exact flags", () => {
  const catalogue = source("../../modules/assistants/frontend/src/catalog.ts");

  assert.match(catalogue, /id: "claude"[\s\S]*command: "claude"[\s\S]*yoloFlag: "--dangerously-skip-permissions"[\s\S]*modelFlag: "--model"/);
  assert.match(catalogue, /id: "codex"[\s\S]*command: "codex"[\s\S]*yoloFlag: "--yolo"[\s\S]*modelFlag: "--model"/);
  assert.match(catalogue, /id: "antigravity"[\s\S]*command: "agy"/);
  assert.match(catalogue, /id: "opencode"[\s\S]*command: "opencode"[\s\S]*yoloFlag: null/);
  assert.match(catalogue, /id: "pi"[\s\S]*command: "pi"[\s\S]*yoloFlag: null/);
  assert.match(catalogue, /ASSISTANT_INSTALL_URLS/);
  assert.doesNotMatch(catalogue, /sdk|apiKey/i);
});

test("the module-owned launcher bounds unavailable, model, mode, and start behavior", () => {
  const launcher = source("../../modules/assistants/frontend/src/SessionLauncher.tsx");

  assert.match(launcher, /await Promise\.all\([\s\S]*checkCommandExists\(a\.command\)\.catch\(\(\) => false\)/);
  assert.match(launcher, /const isAvailable = available\[assistant\.id\] !== false/);
  assert.match(launcher, /if \(isAvailable\) \{[\s\S]*handleSelectAssistant\(assistant\)[\s\S]*\} else \{[\s\S]*setInstallPopover/s);
  assert.match(launcher, /getModelsForProvider\(assistant\.id\)/);
  assert.match(launcher, /supportsModelSelection = \(id: string\) => id !== "pi" && id !== "opencode"/);
  assert.match(launcher, /supportsMode = \(id: string\) => id !== "pi" && id !== "opencode"/);
  assert.match(launcher, /const started = await launchAssistant\([\s\S]*selectedAssistant\.id,[\s\S]*mode,[\s\S]*selectedModel \?\? undefined,[\s\S]*services/s);
  assert.match(launcher, /if \(started\) close\(\);\s*else setLaunching\(false\);/);
});

test("only Claude and Codex enter durable provider-session capture", () => {
  const catalogue = source("../../modules/assistants/frontend/src/catalog.ts");
  const runtime = source("../../modules/assistants/frontend/src/runtime.ts");

  assert.match(catalogue, /return id === "claude" \|\| id === "codex" \? id : null/);
  assert.match(runtime, /if \(!provider\) \{[\s\S]*terminalSessions\.launch\(\{/s);
  assert.match(runtime, /terminalSessions\.launchManaged\(\{[\s\S]*spawnAssistantSession\([\s\S]*provider,[\s\S]*launchRepoPath: projectPath,[\s\S]*placementProjectPath: projectPath/s);
  assert.match(runtime, /captureCodexSession\(event\.session, metadata, services\)/);
});

test("Codex identity capture is bounded and fails without guessing", () => {
  const runtime = source("../../modules/assistants/frontend/src/runtime.ts");
  const registry = source("../../src-tauri/src/assistant_sessions/mod.rs");

  assert.match(runtime, /CODEX_CAPTURE_RETRY_MS = 500/);
  assert.match(runtime, /CODEX_CAPTURE_MAX_ATTEMPTS = 20/);
  assert.match(runtime, /const failed = await failSessionCapture\(record\.recordId\)/);
  assert.match(runtime, /Shep could not identify this Codex session without guessing/);
  assert.match(registry, /transcript must be both new since the[\s\S]*explicitly associated with this launch directory/);
  assert.match(
    registry,
    /Found \{count\} new Codex sessions for this directory; restore was not enabled so Shep will not guess/,
  );
});

test("resume preserves provider identity, placement, and quick-exit recovery", () => {
  const runtime = source("../../modules/assistants/frontend/src/runtime.ts");
  const providers = source("../../src-tauri/src/assistant_sessions/providers.rs");

  assert.match(runtime, /RESTORE_PROBATION_MS = 5000/);
  assert.match(runtime, /projectPath: record\.placementProjectPath/);
  assert.match(runtime, /cwd: record\.launchRepoPath/);
  assert.match(runtime, /ownerKey: `\$\{OWNER_PREFIX\}\$\{record\.provider\}`/);
  assert.match(runtime, /if \(metadata\.restoring\) \{[\s\S]*await rearmSession\(metadata\.record\.recordId\)/s);
  assert.match(providers, /Claude => \{[\s\S]*"--resume"/);
  assert.match(providers, /Codex => \{[\s\S]*args\.push\("resume"\.to_string\(\)\)/);
  assert.match(providers, /failed resume must remain a failed[\s\S]*no fresh-session fallback/i);
});

test("tab close and natural exit retain the current restore-record semantics", () => {
  const runtime = source("../../modules/assistants/frontend/src/runtime.ts");
  const pty = source("../../src/hooks/usePty.ts");

  assert.match(runtime, /event\.type === "stop-requested"[\s\S]*if \(metadata\.record\) await discardSession\(metadata\.record\.recordId\)/s);
  assert.match(runtime, /if \(!metadata\.record \|\| event\.reason === "manual-stop"\) return/);
  assert.match(runtime, /await discardSession\(metadata\.record\.recordId\)\.catch/);
  assert.match(pty, /type: "stop-requested"/);
  assert.doesNotMatch(pty, /discardAssistantSession|rearmAssistantSession|failAssistantSessionCapture/);
});

test("startup restore and recovery are module-owned", () => {
  const runtime = source("../../modules/assistants/frontend/src/runtime.ts");
  const moduleEntry = source("../../modules/assistants/frontend/src/index.ts");
  const shell = source("../../src/components/layout/AppShell.tsx");

  assert.match(runtime, /const records = await listRestorableSessions\(\)/);
  assert.match(runtime, /for \(const record of records\) await restoreRecord\(record, registered, services\)/);
  assert.match(runtime, /Its placement project is no longer registered in Shep/);
  assert.match(runtime, /The saved session was kept for a future retry/);
  assert.match(runtime, /label: "Retry"/);
  assert.match(runtime, /label: "Discard saved session"/);
  assert.match(runtime, /updateSessionPlacement\(metadata\.record\.recordId, event\.projectPath\)/);
  assert.match(runtime, /updateSessionLabel\(metadata\.record\.recordId, event\.label\)/);
  assert.match(moduleEntry, /onProjectsChanged: restoreAssistantSessions/);
  assert.match(shell, /notifyModulesProjectsChanged/);
  assert.doesNotMatch(shell, /listRestorableAssistantSessions|resumeAssistantSession|AssistantSessionRecord/);
});

test("normal shutdown freezes ready records before PTYs receive signals", () => {
  const shell = source("../../src/components/layout/AppShell.tsx");
  const commands = source("../../src-tauri/src/commands.rs");
  const registry = source("../../src-tauri/src/assistant_sessions/mod.rs");

  assert.match(shell, /await notifyModulesBeforeShutdown\(MODULE_HOST_SERVICES\);\s*await shutdownAndQuit\(\)/);
  assert.match(commands, /registry\.try_capture_pending_codex_sessions\(\);\s*registry\.begin_preserving_shutdown\(\)\?;[\s\S]*pty_manager\.kill_all\(\)/);
  assert.match(registry, /retain\(\|record\| \{\s*record\.capture_state == CaptureState::Ready\s*&& record\.provider_session_id\.is_some\(\)/);
  assert.match(registry, /record\.restore_on_next_launch = true/);
  assert.match(registry, /state\.preserving_shutdown = true/);
});

test("the restore manifest persists identity metadata, not transcripts or commands", () => {
  const manifest = source("../../src-tauri/src/assistant_sessions/manifest.rs");
  const registry = source("../../src-tauri/src/assistant_sessions/mod.rs");

  assert.match(registry, /\.join\("\.shep\/assistant-sessions\.json"\)/);
  assert.match(manifest, /options\.mode\(0o600\)/);
  assert.match(manifest, /let mode = if path\.is_dir\(\) \{ 0o700 \} else \{ 0o600 \}/);
  assert.match(manifest, /atomically replace restore manifest/);
  assert.doesNotMatch(manifest, /transcript_content|prompt|credential|command_args/);
});

test("the frontend extraction seam is module-owned and host-generic", () => {
  const moduleEntry = source("../../modules/assistants/frontend/src/index.ts");
  const composition = source("../../src/core/modules/enabledModules.ts");
  const shell = source("../../src/components/layout/AppShell.tsx");
  const pty = source("../../src/hooks/usePty.ts");
  const builtinRuntime = source("../../src/core/modules/builtinPanelRuntime.tsx");
  const nativeHost = source("../../src-tauri/src/lib.rs");

  assert.match(moduleEntry, /id: "shep\.assistants"/);
  assert.match(moduleEntry, /load: \(\) => import\("\.\/SessionLauncher"\)/);
  assert.match(moduleEntry, /activateAssistantRuntime/);
  assert.match(composition, /import \{ assistantsModule \} from "@shep\/module-assistants"/);
  assert.doesNotMatch(shell, /spawnAssistantSession|resumeAssistantSession|tryCaptureCodex|listRestorableAssistantSessions/);
  assert.doesNotMatch(pty, /spawnAssistantSession|resumeAssistantSession|tryCaptureCodex|CODEX_CAPTURE_RETRY_MS|RESTORE_PROBATION_MS/);
  assert.doesNotMatch(builtinRuntime, /components\/session\/SessionLauncher/);
  assert.match(nativeHost, /\.manage\(AssistantSessionRegistry::new\(\)\)/);
  assert.match(nativeHost, /commands::spawn_assistant_session/);
  assert.match(nativeHost, /commands::begin_assistant_session_preserving_shutdown/);
});
