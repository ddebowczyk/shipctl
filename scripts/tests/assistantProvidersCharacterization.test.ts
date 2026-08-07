import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = (path: string) => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  "utf8",
);

test("the launcher exposes the current five CLI providers and their exact flags", () => {
  const catalogue = source("../../src/components/sidebar/constants.ts");

  assert.match(catalogue, /id: "claude"[\s\S]*command: "claude"[\s\S]*yoloFlag: "--dangerously-skip-permissions"[\s\S]*modelFlag: "--model"/);
  assert.match(catalogue, /id: "codex"[\s\S]*command: "codex"[\s\S]*yoloFlag: "--yolo"[\s\S]*modelFlag: "--model"/);
  assert.match(catalogue, /id: "antigravity"[\s\S]*command: "agy"/);
  assert.match(catalogue, /id: "opencode"[\s\S]*command: "opencode"[\s\S]*yoloFlag: null/);
  assert.match(catalogue, /id: "pi"[\s\S]*command: "pi"[\s\S]*yoloFlag: null/);
  assert.match(catalogue, /ASSISTANT_INSTALL_URLS/);
  assert.doesNotMatch(catalogue, /sdk|apiKey/i);
});

test("the launcher bounds unavailable, model, mode, and start behavior", () => {
  const launcher = source("../../src/components/session/SessionLauncher.tsx");

  assert.match(launcher, /await Promise\.all\([\s\S]*checkCommandExists\(a\.command\)\.catch\(\(\) => false\)/);
  assert.match(launcher, /const isAvailable = available\[assistant\.id\] !== false/);
  assert.match(launcher, /if \(isAvailable\) \{[\s\S]*handleSelectAssistant\(assistant\)[\s\S]*\} else \{[\s\S]*setInstallPopover/s);
  assert.match(launcher, /getModelsForProvider\(assistant\.id\)/);
  assert.match(launcher, /supportsModelSelection = \(id: string\) => id !== "pi" && id !== "opencode"/);
  assert.match(launcher, /supportsMode = \(id: string\) => id !== "pi" && id !== "opencode"/);
  assert.match(launcher, /await onStartSession\([\s\S]*selectedAssistant\.id,[\s\S]*mode,[\s\S]*selectedModel \?\? undefined/s);
  assert.match(launcher, /if \(!started\) \{\s*setLaunching\(false\);\s*\}/);
});

test("only Claude and Codex enter durable provider-session capture", () => {
  const pty = source("../../src/hooks/usePty.ts");

  assert.match(pty, /return assistantId === "claude" \|\| assistantId === "codex" \? assistantId : null/);
  assert.match(pty, /if \(!provider\) \{[\s\S]*spawnSession\([\s\S]*assistant\.command,[\s\S]*commandArgs/s);
  assert.match(pty, /if \(!provider\) \{[\s\S]*restoreRecordId: null,[\s\S]*providerSessionId: null,[\s\S]*captureState: null/s);
  assert.match(pty, /const spawned = await spawnAssistantSession\([\s\S]*provider,[\s\S]*launchRepoPath: activeRepoPath,[\s\S]*placementProjectPath: activeRepoPath/s);
  assert.match(pty, /if \(provider === "codex"\) \{\s*captureCodexSession\(spawned\.record, id\);\s*\}/);
});

test("Codex identity capture is bounded and fails without guessing", () => {
  const pty = source("../../src/hooks/usePty.ts");
  const registry = source("../../src-tauri/src/assistant_sessions/mod.rs");

  assert.match(pty, /CODEX_CAPTURE_RETRY_MS = 500/);
  assert.match(pty, /CODEX_CAPTURE_MAX_ATTEMPTS = 20/);
  assert.match(pty, /const failed = await failAssistantSessionCapture\(record\.recordId\)/);
  assert.match(pty, /Shep could not identify this Codex session without guessing/);
  assert.match(registry, /transcript must be both new since the[\s\S]*explicitly associated with this launch directory/);
  assert.match(
    registry,
    /Found \{count\} new Codex sessions for this directory; restore was not enabled so Shep will not guess/,
  );
});

test("resume preserves provider identity, placement, and quick-exit recovery", () => {
  const pty = source("../../src/hooks/usePty.ts");
  const providers = source("../../src-tauri/src/assistant_sessions/providers.rs");

  assert.match(pty, /RESTORE_PROBATION_MS = 5000/);
  assert.match(pty, /addTabToProject\(spawned\.record\.placementProjectPath/);
  assert.match(pty, /repoPath: spawned\.record\.launchRepoPath/);
  assert.match(pty, /assistantId: spawned\.record\.provider/);
  assert.match(pty, /void rearmAssistantSession\(tab\.restoreRecordId\)/);
  assert.match(providers, /Claude => \{[\s\S]*"--resume"/);
  assert.match(providers, /Codex => \{[\s\S]*args\.push\("resume"\.to_string\(\)\)/);
  assert.match(providers, /failed resume must remain a failed[\s\S]*no fresh-session fallback/i);
});

test("tab close and natural exit retain the current restore-record semantics", () => {
  const pty = source("../../src/hooks/usePty.ts");

  assert.match(pty, /if \(tab\?\.restoreRecordId && !stoppedByUser\)/);
  assert.match(pty, /A naturally exited established provider has no live session to[\s\S]*discardAssistantSession\(tab\.restoreRecordId\)/);
  assert.match(pty, /if \(tab\.restoreRecordId\) \{[\s\S]*await discardAssistantSession\(tab\.restoreRecordId\)[\s\S]*await killPty\(tab\.ptyId\)/s);
});

test("startup restore keeps missing projects and failed resumes recoverable", () => {
  const shell = source("../../src/components/layout/AppShell.tsx");

  assert.match(shell, /const records = await listRestorableAssistantSessions\(\)/);
  assert.match(shell, /for \(const record of records\) \{\s*await restoreRecord\(record\);\s*\}/);
  assert.match(shell, /Its placement project is no longer registered in Shep/);
  assert.match(shell, /The saved session was kept for a future retry/);
  assert.match(shell, /label: "Retry"/);
  assert.match(shell, /label: "Discard saved session"/);
  assert.match(shell, /await updateAssistantSessionPlacement\(tab\.restoreRecordId, destinationPath\)/);
  assert.match(shell, /await updateAssistantSessionLabel\(tab\.restoreRecordId, label\)/);
});

test("normal shutdown freezes ready records before PTYs receive signals", () => {
  const commands = source("../../src-tauri/src/commands.rs");
  const registry = source("../../src-tauri/src/assistant_sessions/mod.rs");

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

test("the current extraction seam is explicit and still host-owned", () => {
  const shell = source("../../src/components/layout/AppShell.tsx");
  const runtime = source("../../src/core/modules/builtinPanelRuntime.tsx");
  const nativeHost = source("../../src-tauri/src/lib.rs");

  assert.match(runtime, /import\("\.\.\/\.\.\/components\/session\/SessionLauncher"\)/);
  assert.match(shell, /const \{ spawnBlankShell, launchAssistant, resumeAssistant, closeTab, killProjectPtys \} =\s*usePty\(\)/);
  assert.match(shell, /listRestorableAssistantSessions/);
  assert.match(nativeHost, /\.manage\(AssistantSessionRegistry::new\(\)\)/);
  assert.match(nativeHost, /commands::spawn_assistant_session/);
  assert.match(nativeHost, /commands::begin_assistant_session_preserving_shutdown/);
});
