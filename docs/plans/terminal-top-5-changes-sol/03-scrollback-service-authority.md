# Scrollback has one service authority

## Outcome

Make normalized backend terminal settings the sole product-policy authority for
scrollback, and make `TerminalService` deliver that policy to every new runtime
without allowing individual launch callers to override it. Running terminals
follow the explicitly approved construction-only or owned-setter contract.

## Context and purpose

The UI, frontend settings store, workspace config, xterm instances, and Ghostty
runtime currently hold disconnected scrollback values. The host parser ignores
the persisted setting and uses a private value named as lines even though
Ghostty enforces it as bytes.

The team proposal correctly elevates this to a foundational change, but placing
scrollback on `TerminalLaunchRequest` would move policy to every spawn caller.
Tauri, module adapters, the control socket, and future callers could then bypass
or disagree with workspace normalization. The app-long-lived
`TerminalService` is the correct authority: launch requests describe terminals;
the service supplies host policy.

Physical host retention and user-visible row projection are separate facts.
Without a Ghostty row-trim API, the no-fork path uses a measured byte safety cap
and applies the row policy to xterm and recovery selection. It does not claim
that lowering the row setting physically erased older host rows.

## Affected areas

- `core/backend/src/workspace/config.rs`
- `core/backend/src/workspace/loader.rs`
- `core/backend/src/workspace/manager.rs`
- `core/backend/src/workspace/migration.rs`
- `core/backend/src/terminal/replay.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/service.rs`
- `core/backend/src/terminal/commands.rs`
- `src-tauri/src/lib.rs`
- `core/frontend/terminal/useTerminalSettingsStore.ts`
- `core/frontend/terminal/terminalTheme.ts`
- `core/frontend/shell/SettingsPanel.tsx`

## Work to be done

1. Commit measurements proving the actual unit and behavior of Ghostty's
   `max_scrollback` through output, reflow, compression, Unicode, styles,
   primary/alternate screens, and output produced with no renderer attached.
2. Decide whether the existing UI presets are the exact persisted domain or
   examples within a wider supported range. Encode only that approved policy in
   `normalize_terminal_settings`; do not infer validation limits from the UI.
3. Make `workspace/config.rs` the sole validator/canonicalizer. Hand-edited
   config and IPC saves pass through the same normalization, and save returns
   the canonical result. `normalize_terminal_settings`
   (`config.rs:195-197`) currently normalizes only the URL allowlist and never
   inspects scrollback, so this is new validation rather than a tightened
   rule.
4. Define what happens to values already persisted in user workspaces.
   Tightened validation reaches saved state, and `workspace/migration.rs`
   exists for this purpose. Choose one path and record it: canonicalize on
   every load, or migrate once and record the migration. An out-of-domain
   stored value must never reach a runtime, and a user must never silently
   lose a setting they previously chose without the change being visible in
   the settings panel.
5. Rename the misleading line-named Ghostty constant/fields to byte-valued
   names. Derive the byte safety cap from checked-in measurements and the
   approved product policy; do not use a guessed bytes-per-line multiplier.
6. Add a backend-owned `TerminalRetentionPolicy { row_limit, byte_limit,
   revision }` to `TerminalService`. Construct/load workspace settings before
   terminal service activation and seed the policy before any spawn.
7. Keep scrollback out of public `TerminalLaunchRequest`
   (`terminal/types.rs:360-370`). It is a `Deserialize` IPC payload supplied by
   every Tauri, module, and control-socket caller, so a policy field there is
   caller-controlled. The service already establishes this pattern with
   `inject_host_environment` and its
   `host_identity_overrides_untrusted_environment` test. Every spawn path
   inherits the service policy automatically.
8. Add a serialized settings update path:

   ```text
   normalize
   -> persist
   -> commit service revision
   -> apply to every later runtime construction
   -> notify live logical projections
   -> apply a live physical cap only if the dependency supports it
   -> return canonical settings and revision
   -> update frontend store and xterms
   ```

9. Define branch-specific live semantics:
   - construction-only dependency: every new runtime gets the latest physical
     byte cap; existing runtimes retain the cap they were created with, and the
     settings UI discloses that scope. Logical viewport or snapshot policy may
     update independently, but it cannot be described as increased physical
     retention;
   - owned live-setter dependency: update the physical cap inside the serialized
     runtime actor and prove the change preserves existing history. If exact row
     retention is selected, trim only complete oldest rows under the same owned
     contract.
   Rebuilding Ghostty to apply a setting is not a branch because it destroys the
   history being configured.
10. Make concurrent saves monotonic across persistence, runtime application, and
    frontend commit. A delayed older response cannot overwrite a newer policy.
11. Add `TerminalRetentionStats` for observed retained rows/bytes and physical
    host-eviction cause. Snapshot omission belongs to the later bounded-recovery
    phase, not this authority change.
12. Cover save-before-spawn, multiple running terminals under the selected
    branch, exit during notification or live delivery, increase, decrease,
    invalid persisted input, invalid IPC input, restart, pre-existing persisted
    values, and all host/module/control-socket spawn paths.

## Acceptance criteria

- A committed executable fixture, not the dependency documentation, establishes
  the effective unit of `max_scrollback`.
- No source symbol describes Ghostty's byte cap as a line count.
- `workspace/config.rs` is the only product row-policy validation authority,
  using an owner-approved domain rather than assumed UI preset limits.
- `TerminalService`, not `TerminalLaunchRequest`, owns retention policy. Every
  spawn path inherits the same normalized revision without caller input.
- Every new terminal receives the latest physical retention policy revision.
- A running terminal either keeps its construction-time physical cap with that
  scope visible to the user, or applies a proved owned live update without
  discarding existing history.
- The frontend commits and applies only the canonical backend response and
  cannot roll back because an older save resolves late.
- The no-fork branch never describes byte-bounded retention or a row-setting
  decrease as exact physical row deletion.
- Retention statistics distinguish physical host eviction from future snapshot
  selection loss.
- The retention fix ships without depending on binary IPC or the later bounded
  snapshot implementation.
- A workspace saved before this change loads to a supported value by a
  recorded path, and the resulting value is what the settings panel shows.

## How to validate

Add Rust settings, service, runtime, and replay fixtures plus a serial frontend
settings-store suite. Use content with different byte/row expansion so the unit
test cannot accidentally pass under either interpretation.

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
cargo test --manifest-path core/backend/Cargo.toml terminal::service
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalSettingsStore.test.ts
./research/20260809-124553-fut-tty/vt-proof/run.sh
rg -n 'MAX_SCROLLBACK_LINES|scrollback:.*TerminalLaunchRequest' \
  core/backend/src
just check all
just test fast
just test rust
git diff --check
```
