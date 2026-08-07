# Fork release identity and update channel plan

Status: proposed; review required before implementation. One step (updater key
generation) is a one-way door and must be performed by the repository owner.

Snapshot: 2026-08-07 on `codex/assistant-session-continuity` at `834d78c`.

## Bottom line

This fork has diverged from `stumptowndoug/shep` permanently, but the shipped
app still trusts upstream's release signing key and polls upstream's release
feed. The endpoint is the visible half of the problem; the signing key is the
half that matters. Whoever holds the private key named by `pubkey` in
`src-tauri/tauri.conf.json` can install code on every machine running this app.
Upstream holds it. We do not.

The fix is three changes that must land together:

1. **Own the trust root.** Generate our own minisign keypair and replace
   upstream's `pubkey`. Until this happens we cannot ship an update our own app
   would accept, and upstream can ship one it would.
2. **Own the channel.** Repoint the updater endpoint, the release-notes link,
   and the generated download URL at `ddebowczyk/shep`.
3. **Own the identity.** Take `com.cognesy.shipctl` as bundle identifier and
   `shipctl` as product name, so a fork build and an upstream build can never
   occupy the same install path again.

## This is live, not theoretical

Upstream published **v0.6.0 on 2026-08-07**. The installed app at
`/Applications/shep.app` is **0.5.0**, carries upstream's `pubkey` and endpoint
compiled into the binary, and auto-checks 3 seconds after startup
(`core/frontend/shell/AppShell.tsx:180`). It will find v0.6.0, validate the
signature successfully against the baked-in upstream key, and offer to replace
this fork in place — same bundle identifier, same install path.

Updater configuration is embedded at build time. No remote change can disarm an
already-installed binary. Until a rebuilt app is installed, the only mitigation
is declining the prompt.

## Scope decision

"shep" appears in this repository at six distinct layers. They are not one
rename and must not be treated as one.

| Layer | Examples | Decision |
|---|---|---|
| L1 Update trust | `pubkey`, updater `endpoints`, release URLs | **In scope** — the reason this plan exists |
| L2 Install identity | `identifier: com.shep.terminal` | **In scope** → `com.cognesy.shipctl` |
| L3 Product identity | `productName`, window title, `<title>`, notification title, user-facing copy | **In scope** → `shipctl` / `Shipctl` |
| L4 Artifact paths | `shep.app`, `shep.app.tar.gz`, `shep_${VERSION}_aarch64.dmg` in four scripts | **In scope** — mechanically forced by L3 |
| L5 Internal namespaces | `tauri-plugin-shep-*`, `shep_core`, `@shep/*`, Rust bin `shep` | **Deferred** — see below |
| L6 On-disk data contract | `~/.shep/`, `<repo>/.shep/workspace.yml`, `.shep-worktrees/` | **Frozen** — see below |

### Why L5 is deferred

Internal crate and package names are invisible to users. Renaming them touches
every `Cargo.toml`, every module import, and the `@shep/core` alias contract
documented in `core/frontend/README.md` — while the modular-monolith refactor is
still moving those same files. The churn buys nothing the user can see and
collides directly with in-flight work. Revisit once the module boundaries have
settled; it is a mechanical follow-up, not a prerequisite.

### Why L6 is frozen

This is the most important constraint in the plan. `~/.shep/` currently holds a
**43 MB `usage.sqlite3`**, `assistant-sessions.json`, `config.yml`, and
`session-recovery/`. None of it is derived from the bundle identifier — every
path is `dirs::home_dir().join(".shep")`. Renaming the data directory as part of
a branding change would orphan all of it for zero user-visible benefit.

`<repo>/.shep/workspace.yml` is stronger still: it is written into users'
project repositories and is typically committed. It is a compatibility contract
with existing checkouts, not a local detail. `.shep-worktrees/` likewise appears
in user gitignore files.

**The on-disk contract keeps the `.shep` name. The product is renamed; the data
format is not.** If a future migration is genuinely wanted it must be a separate,
versioned, reversible change with its own plan.

## What the rename actually costs

Nothing, on the data side. `~/Library/Application Support/com.shep.terminal` is
**empty**. The identifier-scoped state is limited to WebView-local storage:
`~/Library/WebKit/com.shep.terminal`, `~/Library/Preferences/com.shep.terminal.plist`,
and `~/Library/Caches/com.shep.terminal`. That is Zustand-persisted UI
preference — theme, panel layout, sidebar state. It is re-set in under a minute
and needs no migration code.

Because the identifier changes, the new build installs *beside* the existing
`shep.app` rather than over it, which also neutralizes the upstream-update
exposure described above without requiring an uninstall first.

## Plan documents

- [Current state and constraints](./01-current-state-and-constraints.md)
- [Target design and trust model](./02-target-design.md)
- [Implementation and verification](./03-implementation-and-verification.md)
- [bd epic body and owner gate](./bd-epic.md)

## Acceptance summary

The work is complete only when all of the following hold:

- A release built from this repo is signed with a key **we** hold, and installs
  successfully via the in-app updater from `ddebowczyk/shep`.
- An artifact signed by **upstream's** key is rejected by signature validation.
  This is the proof that the trust tie is cut, and it must be demonstrated, not
  assumed.
- No live source or script path references `stumptowndoug`. Documentation under
  `research/**` is exempt: it describes the upstream remote deliberately.
- The built bundle reports `CFBundleIdentifier = com.cognesy.shipctl` and
  installs as `shipctl.app` without colliding with an installed `shep.app`.
- The renamed app reads the pre-existing `~/.shep/usage.sqlite3` and
  `config.yml` with no migration step and no data loss.
- `scripts/release-build.sh` completes end to end and emits correctly named
  artifacts; no script references a stale `shep.app` path.
- No user-visible surface still says "Shep".

## Open questions for review

1. **Version line.** The fork is at 0.5.0; upstream has now shipped its own
   0.6.0. Once the endpoint and key are ours, a version collision is
   functionally harmless, but `v0.6.0` would mean two different builds across
   two repositories. Continue the existing line, or reset to mark the identity
   break? This is an owner decision with no technically-correct default.
2. **Apple signing.** There is no `.env` in the working tree, so
   `release-build.sh` currently fails at step 2 and no signed release can be cut
   at all. Confirm the Developer ID credentials are still valid and available.
3. **Existing installs.** The first `shipctl` release is a manual install for
   everyone — new key, new identifier. Confirm that is acceptable rather than
   attempting any bridging release.

## Planning gate

This directory records a design against a fast-moving snapshot on an active
refactor branch. Line numbers are evidence, not instructions.

The updater keypair must be generated by the repository owner, not by an agent
or CI, and its private half must never enter the repository. Every other step is
reversible; that one is not — builds carrying the old `pubkey` can never be
updated by us, only replaced by hand.
