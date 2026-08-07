# Current state and constraints

Snapshot: 2026-08-07, branch `codex/assistant-session-continuity`, commit
`834d78c`. Filenames and line numbers are evidence from this snapshot; the
refactor is active and they will move.

## How updates work today

The app uses `tauri-plugin-updater` v2 (`package.json:69`,
`src-tauri/Cargo.toml:40`), registered at `src-tauri/src/lib.rs:24` and
permitted by `updater:default` in `src-tauri/capabilities/default.json:18`.

Configuration lives in `src-tauri/tauri.conf.json`:

```json
"updater": {
  "endpoints": [
    "https://github.com/stumptowndoug/shep/releases/latest/download/latest.json"
  ],
  "pubkey": "<base64 minisign public key>"
}
```

The `pubkey` value is base64-wrapped minisign. Decoding it
(`jq -r '.plugins.updater.pubkey' src-tauri/tauri.conf.json | base64 -d`) yields
upstream's key ID **`1D5B928ECB5A8F3B`**. Use that ID to confirm at a glance
which key any given build trusts.

Both values are embedded into the binary at build time. Neither can be changed
remotely for an app that is already installed.

### Trigger points

| Path | Location | Behavior |
|---|---|---|
| Automatic | `core/frontend/shell/AppShell.tsx:180` | Fires 3s after startup; shows an "Update available" toast |
| Command palette | `core/frontend/shell/AppShell.tsx:551` | `check_updates` action |
| Settings | `core/frontend/shell/SettingsPanel.tsx:581` | Manual button |

All three route through `useUpdateStore` (`core/frontend/shell/useUpdateStore.ts`),
which wraps `check()` / `downloadAndInstall()` / `relaunch()`.

### Release production

There is **no CI** — no `.github/` directory exists. Releases are built locally
on macOS:

1. `scripts/bump-version.sh <v>` — syncs `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, commits.
2. `scripts/release-build.sh` — loads `.env`, verifies the Developer ID cert is
   in Keychain, loads `TAURI_SIGNING_PRIVATE_KEY` from
   `TAURI_SIGNING_PRIVATE_KEY_PATH`, verifies the three version files agree,
   then runs `pnpm tauri build`, `post-build-dmg.sh`, and
   `generate-update-json.sh`.
3. `scripts/generate-update-json.sh` — writes `latest.json` embedding the
   signature and a hardcoded upstream download URL.
4. Manual `gh release create` with the DMG, tarball, `.sig`, and `latest.json`.

`bundle.createUpdaterArtifacts` is `true` (`tauri.conf.json:159`), so the
updater tarball and signature are produced by the normal build.

## Every reference to upstream

Live code and scripts:

| Location | Reference |
|---|---|
| `src-tauri/tauri.conf.json:174` | updater endpoint |
| `src-tauri/tauri.conf.json:175` | upstream `pubkey` |
| `scripts/generate-update-json.sh:24` | `DOWNLOAD_URL` |
| `core/frontend/shell/useUpdateStore.ts:44` | `releaseNotesUrl` |
| `README.md:32` | download link |

Documentation that must **not** change — these describe the upstream remote on
purpose, as part of the merge-integration workflow:

- `research/integrate-upstream-changes/00-problem-and-design.md:8`
- `research/integrate-upstream-changes/01-ledger-format.md:103`
- `research/integrate-upstream-changes/02-review-runbook.md:11`

## The trust asymmetry

`pubkey` is not a label. It is the sole authority the updater consults before
executing downloaded code. The current configuration means:

- **We cannot ship.** Any artifact signed with a key we generate fails
  validation on every installed build. There is no override.
- **Upstream can ship.** Any artifact upstream signs validates and installs.

Repointing `endpoints` alone does **not** fix this. It changes where the app
looks while leaving upstream as the only party able to produce something the app
accepts — the result is an app that can no longer update at all. Endpoint and
key must move together.

### Present exposure

- Upstream released **v0.6.0** on 2026-08-07.
- `/Applications/shep.app` reports version **0.5.0**.
- Both carry identifier `com.shep.terminal` and install to the same path.
- The startup check will offer 0.6.0, and its signature will validate.

## No signing capability at all

There is **no `.env`** in the working tree. `release-build.sh` requires
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, and
`TAURI_SIGNING_PRIVATE_KEY_PATH`, and aborts at step 2 without them. No signed
release can currently be produced from this repository by any path. Restoring
this is a prerequisite, not a side task.

## Where "shep" is bound

### Product and install identity

| Field | Value | Location |
|---|---|---|
| `identifier` | `com.shep.terminal` | `tauri.conf.json:5` — **only live occurrence in the repo** |
| `productName` | `shep` | `tauri.conf.json` |
| Window title | `Shep` | `tauri.conf.json` app.windows[0] |
| Page title | `Shep` | `index.html:6` |

### Artifact paths derived from `productName`

- `scripts/release-build.sh:155-157` — DMG, updater tarball, signature
- `scripts/generate-update-json.sh:14` — `SIG_FILE`
- `scripts/build-local.sh:70,71,100,105,131,139` — app source, DMG name,
  archive path, `shasum` of `Contents/MacOS/shep`, manifest fields
- `scripts/post-build-dmg.sh:48` — AppleScript icon position for `"shep.app"`

### User-visible copy

`core/frontend/terminal/notifications.ts:45` (native notification title),
`core/frontend/shell/AppShell.tsx:490` (quit confirmation),
`core/frontend/host/panelPersistence.ts:109`,
`modules/assistants/frontend/src/runtime.ts:110,328`,
`modules/todos/frontend/src/TodosPanel.tsx:426`,
`modules/todos/frontend/src/TodoSettingsSection.tsx:58`.

Comments in `modules/git/frontend/src/shikiHighlighter.ts` refer to "Shep
themes" as a concept; these are internal prose, low priority.

### Internal namespaces (out of scope — see README)

`shep-core` / `shep_core`, `tauri-plugin-shep-{usage,todos,skills,git,ports,assistants,fixture}`,
`shep-module-api`, the `@shep/*` npm workspace scope, and the Rust binary name
`shep`.

### On-disk data (frozen — see README)

| Path | Written by |
|---|---|
| `~/.shep/usage.sqlite3` (43 MB) | `modules/usage/backend/src/usage/db.rs:48` |
| `~/.shep/assistant-sessions.json` | `modules/assistants/backend/src/lib.rs:907` |
| `~/.shep/config.yml`, `session-recovery/` | `core/backend/src/workspace/loader.rs:19` |
| `<repo>/.shep/workspace.yml` | `core/backend/src/workspace/loader.rs:33` |
| `<parent>/.shep-worktrees/` | `modules/git/backend/src/lib.rs:412` |

Every one derives from `dirs::home_dir()` or a repo path — none from the bundle
identifier. Changing the identifier does not touch them.

`scripts/tests/assistantProvidersCharacterization.test.ts:126` asserts the
literal path `.shep/assistant-sessions.json`, which pins this contract in tests.

## Constraints on the fix

1. **`pubkey` replacement is irreversible.** Builds carrying the old key can
   never be updated by us. The first release after the change is a manual
   install for every existing user.
2. **The private key must never be committed.** `.env` and the key file stay
   outside version control.
3. **CSP already permits the new endpoint.** `connect-src` at
   `tauri.conf.json:136` (and `:146` for dev) allows `https://github.com` and
   `https://objects.githubusercontent.com`. Hosting on `ddebowczyk/shep`
   requires no CSP change.
4. **The fork repository must stay public.** The updater sends no credentials;
   a private repo's release assets would 404.
5. **Only one platform is published.** `generate-update-json.sh` emits a single
   `darwin-aarch64` entry. Preserve that scope; do not widen it here.
6. **The refactor is in flight.** Changes must be confined to configuration,
   scripts, and string constants — no structural edits that collide with the
   modular-monolith work.
