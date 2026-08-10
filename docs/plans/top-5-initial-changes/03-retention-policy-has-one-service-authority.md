# Retention policy has one service authority

## Outcome

Make normalized backend settings the sole product-policy authority for terminal
retention, and make `TerminalService` apply the same policy revision to every
new runtime regardless of which adapter launches it.

The owner must also select and disclose the supported running-terminal
semantics: construction-only retention or an owned live setter that preserves
history.

## Context and purpose

The frontend currently persists a row-oriented `scrollback` setting and applies
it to xterm. The Ghostty host ignores it and constructs every parser with
`MAX_SCROLLBACK_LINES = 1_000`. The name and binding documentation are
misleading: Ghostty treats the value as a byte heuristic and applies a
geometry-derived minimum, so the current constant is normally not the effective
retention cap. The defect is not that replay omits history; the user setting
never reaches the host authority.

Putting retention on `TerminalLaunchRequest` would turn a product setting into
caller-controlled launch data. Tauri, the control socket, module adapters, and
future callers could then disagree. `TerminalService` is app-long-lived and
already mediates every runtime construction, so it is the correct policy owner.

This enabler connects and names the authority. The later semantic history-window
protocol decides how retained rows are projected to clients; it does not own
physical host retention.

## Affected areas

- `core/backend/src/workspace/config.rs`
- `core/backend/src/workspace/loader.rs`
- `core/backend/src/workspace/manager.rs`
- `core/backend/src/workspace/migration.rs`, if existing values require a
  persisted migration
- `core/backend/src/terminal/replay.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/service.rs`
- `core/backend/src/terminal/commands.rs`
- `src-tauri/src/lib.rs`
- `core/frontend/platform/tauri.ts`
- `core/frontend/platform/types.ts`
- `core/frontend/terminal/useTerminalSettingsStore.ts`
- `core/frontend/terminal/terminalTheme.ts`
- `core/frontend/shell/SettingsPanel.tsx`
- `ops/test/justfile`

## Work to be done

1. Commit an executable fixture that measures the effective unit and floor of
   Ghostty's `max_scrollback`. Use content that varies byte cost independently
   of displayed rows and include reflow, styles, Unicode, alternate screen, and
   output produced without an attached renderer.
2. Obtain owner decisions for:
   - the product promise: exact configured rows backed by an owned complete-row
     trim, or honestly stated byte-bounded host retention;
   - the persisted and user-facing setting shape for the selected promise; and
   - running terminals: settings apply only to terminals created afterward, or
     an owned live setter updates the cap without reconstructing the parser or
     losing retained history.
3. Make `normalize_terminal_settings` the single product-policy normalizer.
   Config loaded from disk and settings received over IPC pass through the same
   rule. An exact-row branch may expose a row count. A byte-bounded branch must
   expose a byte budget or explicitly byte-backed retention tier; it must not
   preserve a row-labelled product value that is passed to Ghostty by
   implication. Do not infer a domain from the current UI preset choices.
4. Define how pre-existing persisted values are handled. If the approved domain
   or setting shape changes, use an explicit load-time canonicalization or
   workspace migration and make the resulting value and unit visible to the
   user. The current row-oriented `scrollback` field cannot silently become a
   byte value.
5. Replace line-named Ghostty constants and fields with byte-accurate names.
   Derive any byte cap from the measured dependency behavior and approved
   product promise; do not invent a bytes-per-row multiplier.
6. Introduce a backend-owned branch-explicit `TerminalRetentionPolicy`, for
   example exact rows backed by an owned row operation or a byte budget backed
   by Ghostty's measured behavior, plus a monotonic revision. Seed
   `TerminalService` from normalized settings before any runtime can be spawned.
7. Keep retention out of `TerminalLaunchRequest`. All Tauri, control-socket,
   module, lifecycle, and test construction paths must receive the service
   policy without caller input.
8. Define and serialize the settings transaction. Durable persistence and the
   service revision form the authoritative commit; every terminal created after
   that commit uses the new revision. Running-terminal delivery is an observed
   application of that revision, not a second policy commit:

   ```text
   normalize -> persist -> commit service revision
             -> apply/record the approved per-runtime behavior
             -> return canonical policy, revision, and application outcome
             -> commit frontend store and transitional xterm adapter
   ```

9. Prevent a delayed older save response from replacing a newer committed
   policy in the frontend or service.
10. For the construction-only branch, disclose that physical retention changes
    apply to new terminals. For a live-setter branch, update the runtime actor
    serially and prove existing history survives both increases and decreases.
    A runtime that exits during delivery is no longer applicable. Any other
    failed application is recorded and reported or retried under an explicit
    contract; it does not roll back the durable policy or cause new terminals
    to receive an older revision. Reconstructing Ghostty is not an allowed
    update mechanism.
11. During migration, apply the backend-canonical policy to xterm through an
    explicit transitional adapter. Exact rows may map directly. A byte-backed
    policy needs a separately named, measured renderer safety policy; it cannot
    masquerade as the canonical product value. The closure plan removes that
    adapter when xterm is deleted.
12. Register the settings-store suite in the serial terminal lane in
    `ops/test/justfile` so `just test fast` actually executes it.

## Acceptance criteria

- An executable fixture, not dependency documentation, establishes the meaning
  and geometry floor of `max_scrollback`.
- No Shipctl symbol or user-facing copy describes Ghostty's physical byte cap
  as a line count.
- Backend normalization is the only product-policy validator and uses an
  owner-approved setting shape and domain. A row-labelled policy exists only
  in the exact-row branch.
- `TerminalService`, not `TerminalLaunchRequest`, owns the normalized retention
  policy and revision.
- Every runtime construction path receives the latest committed policy without
  a caller override.
- Save responses return canonical policy, revision, and the declared live
  application outcome; older responses cannot roll back newer frontend or
  service state.
- Running terminals follow the approved construction-only or owned-live-setter
  contract, and the UI states that behavior accurately.
- Exact row retention is claimed only when a complete-row operation exists and
  is covered by the dependency fixtures. The byte-bounded branch is described
  honestly.
- Existing persisted settings have an explicit, tested path to the approved
  domain.
- A runtime that fails or exits during live application cannot split the
  durable/service authority or change the revision inherited by new terminals.
- The new settings-store suite is included in the repository terminal test
  lane.
- This change ships independently of semantic transport, history windows, and
  xterm removal.

## How to validate

Add focused Rust fixtures for dependency behavior, settings normalization,
service construction/update ordering, and all spawn adapters. Add a serial
frontend settings-store suite for canonical responses, out-of-order saves, and
branch-specific setting shapes. Force a running runtime to fail and to exit
during live application when that branch is selected.

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
cargo test --manifest-path core/backend/Cargo.toml terminal::service
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalSettingsStore.test.ts
just test fast
just test rust
just check all
git diff --check
```
