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
  const registry = source("../../modules/assistants/backend/src/lib.rs");

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
  const providers = source("../../modules/assistants/backend/src/providers.rs");

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
  const pty = source("../../core/frontend/terminal/usePty.ts");

  assert.match(runtime, /event\.type === "stop-requested"[\s\S]*if \(metadata\.record\) await discardSession\(metadata\.record\.recordId\)/s);
  assert.match(runtime, /if \(!metadata\.record \|\| event\.reason === "manual-stop"\) return/);
  assert.match(runtime, /await discardSession\(metadata\.record\.recordId\)\.catch/);
  assert.match(pty, /type: "stop-requested"/);
  assert.doesNotMatch(pty, /discardAssistantSession|rearmAssistantSession|failAssistantSessionCapture/);
});

test("startup restore and recovery are module-owned", () => {
  const runtime = source("../../modules/assistants/frontend/src/runtime.ts");
  const moduleEntry = source("../../modules/assistants/frontend/src/index.ts");
  const shell = source("../../core/frontend/shell/AppShell.tsx");

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
  const shell = source("../../core/frontend/shell/AppShell.tsx");
  const moduleEntry = source("../../modules/assistants/frontend/src/index.ts");
  const client = source("../../modules/assistants/frontend/src/client.ts");
  const backend = source("../../modules/assistants/backend/src/lib.rs");
  const commands = source("../../src-tauri/src/lifecycle.rs");

  assert.match(shell, /await notifyModulesBeforeShutdown\(MODULE_HOST_SERVICES\);\s*await shutdownAndQuit\(\)/);
  assert.match(moduleEntry, /beforeShutdown: beginAssistantSessionPreservingShutdown/);
  assert.match(client, /assistantCommand\("begin_assistant_session_preserving_shutdown"\)/);
  assert.match(backend, /state\.registry\.try_capture_pending_codex_sessions\(\);\s*state\.registry\.begin_preserving_shutdown\(\)/);
  assert.match(backend, /retain\(\|record\| \{\s*record\.capture_state == CaptureState::Ready\s*&& record\.provider_session_id\.is_some\(\)/);
  assert.match(backend, /record\.restore_on_next_launch = true/);
  assert.match(backend, /state\.preserving_shutdown = true/);
  assert.match(commands, /pty_manager\.kill_all\(\)/);
  assert.doesNotMatch(commands, /AssistantSessionRegistry|try_capture_pending_codex_sessions|begin_preserving_shutdown/);
});

test("the restore manifest persists identity metadata, not transcripts or commands", () => {
  const manifest = source("../../modules/assistants/backend/src/manifest.rs");
  const registry = source("../../modules/assistants/backend/src/lib.rs");

  assert.match(registry, /\.join\("\.shep\/assistant-sessions\.json"\)/);
  assert.match(manifest, /options\.mode\(0o600\)/);
  assert.match(manifest, /let mode = if path\.is_dir\(\) \{ 0o700 \} else \{ 0o600 \}/);
  assert.match(manifest, /atomically replace restore manifest/);
  assert.doesNotMatch(manifest, /transcript_content|prompt|credential|command_args/);
});

test("the Assistant implementation is module-owned behind generic host ports", () => {
  const moduleEntry = source("../../modules/assistants/frontend/src/index.ts");
  const composition = source("../../core/frontend/host/enabledModules.ts");
  const shell = source("../../core/frontend/shell/AppShell.tsx");
  const pty = source("../../core/frontend/terminal/usePty.ts");
  const nativeHost = source("../../src-tauri/src/lib.rs");
  const nativeComposition = source("../../src-tauri/src/modules/mod.rs");
  const terminalAdapter = source("../../src-tauri/src/modules/assistants.rs");
  const piConfig = source("../../modules/assistants/backend/src/pi_config.rs");
  const backend = source("../../modules/assistants/backend/src/lib.rs");
  const client = source("../../modules/assistants/frontend/src/client.ts");

  assert.match(moduleEntry, /id: "shep\.assistants"/);
  assert.match(moduleEntry, /load: \(\) => import\("\.\/SessionLauncher"\)/);
  assert.match(moduleEntry, /activateAssistantRuntime/);
  assert.match(composition, /import \{ assistantsModule \} from "@shep\/module-assistants"/);
  assert.doesNotMatch(shell, /spawnAssistantSession|resumeAssistantSession|tryCaptureCodex|listRestorableAssistantSessions/);
  assert.doesNotMatch(pty, /spawnAssistantSession|resumeAssistantSession|tryCaptureCodex|CODEX_CAPTURE_RETRY_MS|RESTORE_PROBATION_MS/);
  assert.doesNotMatch(nativeHost, /AssistantSessionRegistry|commands::spawn_assistant_session|commands::begin_assistant_session_preserving_shutdown/);
  assert.match(nativeComposition, /shep_module_assistants::init\(/);
  assert.match(terminalAdapter, /impl TerminalAuthority for HostTerminalAuthority/);
  // The PTY is the only thing this module cannot own. pi's own config —
  // ~/.pi/agent and its Keychain entries — is module business and stays in the
  // module crate; the host adapter must not grow a second authority for it.
  assert.match(terminalAdapter, /HostServices::new\(Arc::new\(HostTerminalAuthority \{ manager \}\)\)/);
  assert.doesNotMatch(terminalAdapter, /PiConfig|pi_config/);
  assert.doesNotMatch(backend, /trait PiConfigAuthority/);
  assert.match(backend, /fn get_pi_config\(\) -> Result<PiConfig, String> \{\s*pi_config::get_pi_config\(\)/);
  assert.match(piConfig, /\.join\("\.pi"\)\s*\.join\("agent"\)/);
  assert.match(piConfig, /"add-generic-password"/);
  assert.match(backend, /app\.manage\(AssistantPluginState \{/);
  assert.match(backend, /pub fn init<R: Runtime>\(services: HostServices\) -> TauriPlugin<R>/);
  assert.match(client, /const ASSISTANTS_COMMAND_NAMESPACE = "plugin:shep-assistants\|"/);
});
