# Claude and Codex session restore implementation plan

Status: automated validation complete; live macOS verification pending
(`shep-5j1.5`)
Created: 2026-08-03 11:17 CEST
Scope: preserve and resume Shep-launched Claude Code and Codex interactive
assistant sessions across a normal Shep quit and relaunch.

## Outcome

When a user quits Shep with running Claude or safely identified Codex tabs,
Shep has already persisted their provider session identity before terminating
its PTYs. Claude gets a caller-assigned ID before launch; Codex is protected
only after unique transcript discovery. On the next launch, Shep recreates
ready records with the provider's supported resume command, preserving:

- the provider session ID and conversation history;
- the original PTY working directory;
- the tab's current project placement, including tabs moved to another project;
- the tab label and standard/YOLO mode.

The implementation must capture session identity during launch. It must not
depend on a CLI printing a resume ID while Shep is shutting down. Both providers
persist session data continuously, and their end hooks are cleanup notifications,
not a reliable handoff protocol.

## Baseline evidence and corrected pre-implementation claims

The current dirty worktree was indexed as a dedicated qmd collection named
`shep` in the `shep-code` index. The evidence pass covered 124 Markdown,
TypeScript, TSX, and Rust source files before this plan was added as document
125. Candidate files were found with qmd, retrieved with `qmd get`, and mapped
with `ast-grep outline` before detailed inspection.

| Claim | Baseline evidence | Conclusion |
| --- | --- | --- |
| Assistant launch is generic and returns only a process-local PTY ID. | [`spawnSession`](../../../src/hooks/usePty.ts#L171) calls `spawnPty`; [`launchAssistant`](../../../src/hooks/usePty.ts#L367) adds a tab containing `ptyId`, `assistantId`, and mode. | No provider session ID is captured. |
| The tab model cannot represent a resumable conversation. | [`TerminalTabData`](../../../src/lib/types.ts#L110) contains no provider session ID, capture status, or stable restore-record ID. | The model must be extended. |
| Terminal tabs are not persisted. | [`useTerminalStore`](../../../src/stores/useTerminalStore.ts#L48) is an in-memory Zustand store without persistence middleware. | A backend-owned durable registry is required. |
| Startup restores only the last selected project. | [`AppShell`](../../../src/components/layout/AppShell.tsx#L556) reads `shep:last-repo-path` from `localStorage`. | There is no tab or PTY restoration. |
| Shep does attempt graceful signals, but the grace window is very short. | Quit flows through [`shutdown_and_quit`](../../../src-tauri/src/commands.rs#L307) and [`kill_all`](../../../src-tauri/src/pty/manager.rs#L94). [`PtySession::kill`](../../../src-tauri/src/pty/session.rs#L507) sends `SIGHUP`/`SIGTERM`, waits 100 ms, then sends `SIGKILL` to survivors. | Provider end hooks may run, but Shep cannot rely on them completing. The earlier shorthand “Shep immediately kills” is too strong; “best-effort 100 ms grace, then force kill” is accurate. |
| Existing cross-project tab work separates placement from launch origin in practice. | [`moveTab`](../../../src/stores/useTerminalStore.ts#L191) moves the same tab object between `projectState` entries, while `tab.repoPath` remains unchanged. [`AppShell`](../../../src/components/layout/AppShell.tsx#L108) now renders by the containing project key. | Restore data must explicitly store both placement and launch directory. It must build on, not revert, the current uncommitted tab-move changes. |
| Shep already knows how to locate and parse provider transcripts. | [`ingest_claude`](../../../src-tauri/src/usage/ingest.rs#L77) scans `~/.claude/projects`; [`ingest_claude_file`](../../../src-tauri/src/usage/ingest.rs#L131) derives the ID from the filename. [`ingest_codex`](../../../src-tauri/src/usage/ingest.rs#L629) scans `~/.codex/sessions`; [`ingest_codex_file`](../../../src-tauri/src/usage/ingest.rs#L681) reads `session_meta.payload.id` and `cwd`. | Extract shared provider-file parsing instead of implementing a second incompatible parser. |
| Shep already has a machine-local persistence root. | [`shep_home`](../../../src-tauri/src/workspace/loader.rs#L16) resolves `~/.shep`; global settings are stored in `~/.shep/config.yml`. | Volatile restore state should use a separate versioned file under `~/.shep`, not project configuration or browser storage. |

The provider behavior is supported by the official
[Claude session documentation](https://code.claude.com/docs/en/sessions),
[Claude hooks reference](https://code.claude.com/docs/en/hooks),
[Codex CLI reference](https://developers.openai.com/codex/cli/reference/), and
[Codex hooks reference](https://learn.chatgpt.com/docs/hooks). The locally
validated command surfaces are Claude Code 2.1.221 and Codex CLI 0.146.0.

## Requirements

1. Capture an exact provider session ID before a Shep-launched Claude or Codex
   session is marked protected. A Codex launch with no unique match remains live
   but explicitly unprotected; Shep never guesses an ID.
2. Persist restore state incrementally during the app's lifetime, not only in
   the final quit handler.
3. Persist the restore manifest before sending termination signals.
4. Resume Claude with `claude --resume <session-id>` and Codex with
   `codex resume <session-id>` in the original launch directory.
5. Preserve the current project placement separately from the original launch
   directory.
6. Treat explicit tab close or normal provider exit as an instruction not to
   restore that session.
7. Keep failed restore records recoverable and visible; never silently start a
   fresh conversation when resume fails.
8. Do not edit or replace the user's global Claude or Codex configuration.
9. Do not persist transcript contents, prompts, credentials, arbitrary commands,
   or process-local PTY IDs.
10. Bound shutdown latency across all PTYs with one shared grace deadline rather
    than multiplying a timeout by the number of sessions.

## Non-goals

- Reattaching to an existing OS PTY after Shep has exited.
- Restoring blank shells, saved commands, or unsupported assistant providers in
  the first version.
- Reconstructing a conversation from terminal screen output.
- Treating Claude or Codex transcript JSONL as a permanently stable public API.
- Automatically killing or attaching to an orphan process after an abnormal app
  crash. Crash recovery may offer resume only after confirming the old process
  is not still running.

## Proposed architecture

### 1. Backend-owned restore registry

Add `src-tauri/src/assistant_sessions/` with focused modules:

```text
assistant_sessions/
  mod.rs          domain types and registry API
  manifest.rs     versioned atomic persistence
  providers.rs    launch/resume specifications
  capture.rs      transcript metadata capture
```

Register an `AssistantSessionRegistry` as Tauri managed state. Store a versioned
manifest at `~/.shep/assistant-sessions.json`. Keep this file separate from
`config.yml`: settings are durable user preferences, while the restore manifest
is frequently changing runtime state.

Suggested schema:

```json
{
  "version": 1,
  "sessions": [
    {
      "recordId": "stable-shep-uuid",
      "provider": "claude",
      "providerSessionId": "provider-session-uuid",
      "launchRepoPath": "/absolute/original/repo",
      "placementProjectPath": "/absolute/sidebar/project",
      "label": "Claude Code",
      "sessionMode": "standard",
      "captureState": "ready",
      "startedAt": "2026-08-03T09:17:00Z",
      "updatedAt": "2026-08-03T09:18:00Z"
    }
  ]
}
```

Do not persist `ptyId`; it is allocated by `PtyManager` and is meaningful only
inside one Shep process. Use `recordId` as the stable tab identity across app
launches.

Write updates through `file.tmp -> fsync -> rename` and create the file with
user-only permissions. A corrupt or newer-version manifest must be quarantined
or ignored with a visible notice, never cause application startup to fail.

### 2. Provider adapter contract

Represent providers as an allowlisted enum rather than persisted command text.
Each supported adapter implements the equivalent of:

```text
prepare_new(provider-owned ID or capture strategy, mode) -> command + argv
prepare_resume(provider_session_id, mode) -> command + argv
validate_capture(capture) -> provider session identity
```

The adapter builds argv arrays passed through the existing `spawn_pty` path; it
must never build a shell command by concatenating provider IDs or paths.

#### Claude

- Generate a valid UUID before spawning.
- Launch new sessions with `claude --session-id <uuid>` plus the existing model
  and mode flags.
- Persist the UUID before PTY spawn, then mark the record ready only after the
  allowlisted launch adapter has accepted the exact same generated value.
- Resume with `claude --resume <uuid>` plus the original permission-mode flag.
- Use the shared Claude transcript parser for validation and stale-session
  diagnostics, not as the primary identity source.

This gives Shep an unambiguous ID even when two Claude tabs are opened in the
same directory at nearly the same time.

#### Codex

- Snapshot the paths in `~/.codex/sessions` before spawning.
- Poll only for transcripts that are new after that snapshot and whose parsed
  `session_meta.payload.cwd` canonicalizes to the exact launch directory.
- Bind the parsed `session_meta.payload.id` only if exactly one candidate
  matches. Zero candidates time out; two or more candidates are an ambiguity.
- Resume with `codex resume <session-id>` plus the original mode flags and the
  original cwd.
- Extract Codex `session_meta` parsing from `usage/ingest.rs` and use it as the
  sole capture source. If discovery finds more than one eligible session, report
  ambiguity instead of guessing.

The implementation spike verified that a `-c hooks.SessionStart=...` value is
accepted as TOML by Codex 0.146.0. It is deliberately not shipped: Codex treats
non-managed command hooks as trust-reviewed user configuration, so dynamically
injecting one would create a trust/configuration side effect. The shipped path
does not edit global config, bypass hook trust, or replace user hooks.

### 3. Shared transcript metadata parsing

Move provider metadata parsing out of the usage-only ingestion functions into a
small shared module. Keep usage token extraction in `usage/ingest.rs`.

The shared surface should return metadata only:

```text
ProviderSessionMetadata {
  provider,
  session_id,
  cwd,
  transcript_path,
  started_at,
}
```

For Claude, the existing parser knows the filename-derived session ID but not an
exact cwd; add a tested path-to-project/cwd resolution helper. For Codex, parse
only the first `session_meta` record needed for identity rather than reading the
whole transcript. Treat parse failures as provider compatibility errors and do
not disturb usage ingestion.

### 4. Frontend tab model and placement

Extend assistant tabs in [`src/lib/types.ts`](../../../src/lib/types.ts) with:

```text
restoreRecordId: string | null
providerSessionId: string | null
captureState: "pending" | "ready" | "failed" | null
```

Keep `repoPath` as the launch/origin cwd for compatibility with the current
cross-project move work. The containing `projectState` key remains placement.
Add store operations that accept placement explicitly:

- `addTabToProject(projectPath, tab)` for startup restore;
- `updateTabById(tabId, patch)` across all project buckets;
- registry placement update inside `moveTab`;
- registry label update when an assistant tab is renamed.

Do not make `repoPath` mutable when a tab is moved. A resumed provider must run
in the original directory even if its tab is displayed under another project.

### 5. Incremental lifecycle

#### New launch

1. Create a pending restore record before process spawn.
2. Spawn the provider through its adapter.
3. Add the tab with `captureState: ready` for Claude or `pending` for Codex.
4. Capture and validate the Codex provider ID.
5. Atomically update the record and tab to `ready`.
6. If capture times out, keep the live tab but show that it is not protected by
   restore. Do not invent an ID or select an ambiguous transcript.

#### Move or rename

- Moving a tab updates only `placementProjectPath` in the manifest.
- Renaming updates only `label`.
- The provider identity and `launchRepoPath` remain unchanged.

#### Explicit close or natural exit

- Explicit close removes the restore record before calling `killPty`.
- A normal provider exit removes the active restore record after the exit event
  is classified as provider-initiated.
- During application shutdown, freeze removal processing before signals are sent
  so the resulting PTY exit events cannot erase the records intended for the
  next launch.

#### Quit

1. Freeze the registry and flush all `ready` records atomically.
2. Update the confirmation text to distinguish resumable assistants from other
   PTYs that will simply stop.
3. Signal all PTY process groups and escaped descendants first.
4. Wait one shared, bounded grace period of up to three seconds.
5. Force-kill only surviving processes and exit Shep.

Refactor [`PtySession::kill`](../../../src-tauri/src/pty/session.rs#L507) into
request-termination and force-kill phases so `kill_all` does not sleep once per
session. Session identity is already durable before this phase; provider
`SessionEnd` hooks are best-effort cleanup only.

#### Startup restore

1. Load and validate the manifest while registered repos are loading.
2. Restore only `ready` Claude/Codex records armed by a completed normal quit,
   whose launch directory still exists. A record persisted during a live
   session is not enough to infer that its process was stopped after a crash.
3. Spawn each provider with its resume argv in `launchRepoPath`.
4. Insert the tab into `placementProjectPath`; if that project is no longer
   registered, keep the record and show a recoverable notice rather than moving
   it silently.
5. Bind the new `ptyId` to the existing stable record/tab ID.
6. Keep failed resume records on disk for the next launch and show a notice.
   Do not automatically start a new session.

Restores run sequentially so startup cannot flood provider authentication
prompts. Each failed resume remains durable for the next app launch.

## Tauri command and event surface

Add narrow commands rather than exposing manifest file access to the frontend:

- `spawn_assistant_session(...) -> { ptyId, record }` (persist-before-spawn)
- `resume_assistant_session(record_id, ...) -> { ptyId, record }`
- `try_capture_codex_assistant_session(record_id)`
- `prepare_assistant_session(...)` and `confirm_assistant_session_capture(...)`
  for narrow backend lifecycle operations
- `discard_assistant_session(record_id)`
- `list_restorable_assistant_sessions() -> Vec<RestorableAssistantSession>`
- `begin_session_preserving_shutdown()`

Implement matching wrappers in [`src/lib/tauri.ts`](../../../src/lib/tauri.ts)
and register commands in [`commands.rs`](../../../src-tauri/src/commands.rs) and
[`lib.rs`](../../../src-tauri/src/lib.rs).

## Delivery sequence

### Phase 1: Characterize provider capture and extract shared parsing

- Add fixtures containing minimal Claude and Codex session metadata.
- Extract the metadata readers from usage ingestion without changing usage
  results.
- Prove Claude's assigned `--session-id` flow with the installed CLI.
- Probe Codex's process-local `SessionStart` hook syntax and trust model with
  the installed CLI; retain bounded transcript discovery when injection would
  require user trust.

Exit criteria:

- Exact parser IDs and cwd are captured in tests. A live macOS integration run
  remains required for each provider.
- Existing user provider config files are byte-for-byte unchanged.
- Existing usage tests still pass.

### Phase 2: Implement the durable registry

- Add versioned domain types and atomic manifest persistence.
- Add pending, ready, failed, update, discard, freeze, and load operations.
- Register backend state and narrow Tauri commands.

Exit criteria:

- Round-trip, corruption, unknown-version, permissions, and atomic-replacement
  tests pass.
- No record contains transcript contents, command strings, or PTY IDs.

### Phase 3: Integrate new launches and tab mutations

- Route Claude/Codex launches through adapters in `usePty`.
- Surface capture state in assistant tabs and notices.
- Update the registry on move, rename, explicit close, and natural exit.
- Preserve the current uncommitted cross-project tab behavior.

Exit criteria:

- Two concurrent same-cwd sessions are either captured unambiguously or visibly
  marked unprotected; they are never cross-associated.
- Moving a tab changes placement but not the process cwd or provider ID.

### Phase 4: Implement bounded session-preserving shutdown

- Flush and freeze the registry before PTY termination.
- Split graceful and forceful PTY termination into shared-deadline phases.
- Update quit messaging and keep Cancel behavior unchanged.

Exit criteria:

- Quit with multiple sessions completes within the shared deadline plus a small
  fixed overhead.
- The on-disk manifest is complete before the first termination signal.
- Canceling quit neither freezes the registry nor stops a PTY.

### Phase 5: Restore on startup and add recovery UX

- Load records after repo registration is available.
- Resume through provider adapters and insert tabs by explicit placement.
- Preserve failed resume records and show a recoverable notice for missing,
  expired, or incompatible sessions.
- Prevent duplicate restore attempts during one app launch.

Exit criteria:

- Claude and uniquely captured Codex sessions return to the same conversation
  IDs after a full quit and relaunch.
- Moved tabs return under their destination projects while their resumed PTYs
  use the original cwd.
- A failed resume never silently creates a new conversation.

### Phase 6: Documentation and compatibility guardrails

- Document automatic restore, explicit-close semantics, and failure recovery in
  the README.
- Record the minimum verified Claude/Codex CLI versions or feature probes.
- Add provider compatibility errors that include the detected CLI version and a
  useful next action.

## Verification matrix

Automated gates:

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Add Rust tests for:

- Claude new/resume argv generation in standard and YOLO modes;
- Codex new/resume argv generation in standard and YOLO modes;
- Codex snapshot correlation and ambiguous-session rejection;
- Claude filename metadata and Codex `session_meta` parsing;
- manifest migration, corruption recovery, atomic writes, and restrictive
  permissions;
- freeze-before-kill behavior and shared shutdown deadline;
- ambiguous transcript fallback rejection.

Manual macOS integration matrix:

<!-- markdownlint-disable MD013 -->

| Scenario | Expected evidence |
| --- | --- |
| Claude prompt -> quit -> relaunch | Same Claude session ID and prior conversation visible. |
| Codex prompt -> quit -> relaunch | Same Codex session ID and prior conversation visible. |
| Two Codex tabs in the same cwd | Each tab is uniquely captured or visibly left unprotected; no cross-association. |
| Move tab from project A to B before quit | Tab returns under B; provider cwd remains A. |
| Rename moved tab before quit | Custom label and placement both return. |
| Explicitly close tab, then relaunch | Closed tab is not restored. |
| Exit provider normally, then relaunch | Ended session is not auto-restored. |
| Cancel quit | All PTYs remain alive and registry remains writable. |
| Missing launch directory | No spawn; record is kept and a recoverable error is shown. |
| Invalid/expired provider session ID | No fresh session is created; record is kept and a recoverable error is shown. |
| Existing Claude/Codex hooks configured | User hooks still run and config files remain unchanged. |
| Four active PTYs at quit | Shutdown uses one bounded grace window, not four sequential waits. |

<!-- markdownlint-enable MD013 -->

Baseline before implementation on the current dirty worktree:

- `pnpm build`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 37 passed, 0 failed.
- `git diff --check`: passed.

## Risks and mitigations

<!-- markdownlint-disable MD013 -->

| Risk | Mitigation |
| --- | --- |
| Provider transcript formats change. | Claude uses a caller-assigned ID; Codex parsing is isolated, fixture-tested, and fails closed. |
| Codex command-hook trust changes. | Do not inject a command hook; the shipped path leaves global config and hook trust untouched. |
| Shutdown exit events delete records. | Freeze and flush the registry before signaling PTYs. |
| Same-cwd sessions are associated incorrectly. | Snapshot pre-spawn paths, require exact canonical cwd, and reject ambiguity. |
| Cross-project movement confuses cwd and placement. | Persist `launchRepoPath` and `placementProjectPath` as distinct required fields. |
| Many PTYs make quit slow. | Signal all first, wait one shared deadline, then force-kill survivors. |
| Manifest corruption blocks startup. | Version, validate, isolate bad data, and start Shep with a visible recovery notice. |
| Crash leaves an old provider process alive. | Arm records only after normal quit; abnormal-crash reattachment remains out of scope. |

<!-- markdownlint-enable MD013 -->

## Completion definition

This feature is complete only when the automated gates pass and the manual
matrix proves exact ID continuity for both Claude and Codex, including moved
tabs. Seeing old text on screen, finding a transcript file, or observing a
successful process spawn is insufficient: the provider-reported session ID
before quit and after restore must match.
