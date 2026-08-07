# Implementation and verification

Re-run discovery before executing. The branch is under active refactor and the
line numbers below are snapshot evidence from `834d78c`, not addresses.

```
rg -n "stumptowndoug|com\.shep\.terminal" --glob '!node_modules' --glob '!target' \
   --glob '!builds' --glob '!dist' --glob '!research'
rg -n "shep\.app|shep_\$\{VERSION\}|shep_\$\{version\}" scripts/
```

## Ordering

W1 → W2 → W3 must be sequential: the build in W3 needs the key from W1 and the
paths from W2. W4 is independent and may run in parallel. W5 requires all of
them.

---

## W1 — Own the trust root (owner only)

**Not delegable.** The private key must not enter the repository, a transcript,
or CI.

```
pnpm tauri signer generate -w ~/.tauri/shipctl-updater.key
```

Create `.env` at the repository root (already gitignored — confirm before
writing):

```
TAURI_SIGNING_PRIVATE_KEY_PATH=/Users/<owner>/.tauri/shipctl-updater.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<if set at generation>
APPLE_SIGNING_IDENTITY=<Developer ID Application: ...>
APPLE_ID=<...>
APPLE_PASSWORD=<app-specific password>
APPLE_TEAM_ID=<...>
```

Copy `~/.tauri/shipctl-updater.key.pub` into `tauri.conf.json` `pubkey`.

Back the private key up off-machine. Losing it means every user reinstalls by
hand, permanently.

**Done when:** `bash scripts/release-build.sh` passes steps 1–5 (env loaded,
Keychain identity found, key file read, tools present) without reaching a build.

---

## W2 — Configuration and script changes

### W2.1 `src-tauri/tauri.conf.json`

| Field | From | To |
|---|---|---|
| `identifier` | `com.shep.terminal` | `com.cognesy.shipctl` |
| `productName` | `shep` | `shipctl` |
| `app.windows[0].title` | `Shep` | `Shipctl` |
| `plugins.updater.endpoints[0]` | `stumptowndoug` URL | `ddebowczyk` URL |
| `plugins.updater.pubkey` | upstream key | W1 key |

Leave `csp` and `devCsp` alone — `github.com` and `objects.githubusercontent.com`
are already permitted.

### W2.2 Artifact paths

Confirm the actual bundle output name from a real build before editing; do not
assume `productName` propagates identically to the `.app`, the DMG, and the
executable inside `Contents/MacOS/`.

- `scripts/generate-update-json.sh:14` — `SIG_FILE`
- `scripts/generate-update-json.sh:24` — `DOWNLOAD_URL` → `ddebowczyk`
- `scripts/release-build.sh:155-157` — DMG, tarball, signature
- `scripts/build-local.sh:70,71,100,105,131,139` — note `:105` hashes
  `Contents/MacOS/shep`; verify against the built binary
- `scripts/post-build-dmg.sh:48` — AppleScript item name

Prefer deriving the name from `productName` via `jq` over hardcoding a second
literal, so this class of drift cannot recur.

### W2.3 User-visible strings

- `index.html:6` — `<title>`
- `core/frontend/shell/useUpdateStore.ts:44` — `releaseNotesUrl` → `ddebowczyk`
- `core/frontend/terminal/notifications.ts:45` — notification title
- `core/frontend/shell/AppShell.tsx:490` — quit confirmation
- `core/frontend/host/panelPersistence.ts:109`
- `modules/assistants/frontend/src/runtime.ts:110,328`
- `modules/todos/frontend/src/TodosPanel.tsx:426`
- `modules/todos/frontend/src/TodoSettingsSection.tsx:58`
- `README.md:32` — download link → `ddebowczyk`

### W2.4 Record the data-path decision

Add a brief comment near `core/backend/src/workspace/loader.rs:19` and
`modules/usage/backend/src/usage/db.rs:48` noting that `.shep` is a deliberate
stability contract, not missed branding, and pointing at this plan. Without it
the next rename sweep will "fix" it.

**Done when:** the discovery greps return only `research/**` hits, and
`pnpm check:module-boundaries && tsc` passes.

---

## W3 — Cut the first release

1. `./scripts/bump-version.sh <version>` — see open question 1 in the README;
   the version line is unresolved and must be decided before this step.
2. `./scripts/release-build.sh`
3. `gh release create` against **`ddebowczyk/shep`** with the DMG, updater
   tarball, `.sig`, and `latest.json`.

Publish the release as `latest`, since the endpoint resolves
`/releases/latest/download/latest.json`.

---

## W4 — Retire the exposed install

Independent of W1–W3 and can start immediately.

`/Applications/shep.app` (0.5.0) trusts upstream's key and will offer upstream's
0.6.0. Until it is removed, decline that prompt. The configuration is compiled
in; no remote action disarms it.

Once W3 ships, install `shipctl.app` — the new identifier means it lands beside
the old app — confirm it works against `~/.shep/`, then delete `shep.app` and
its `~/Library/{WebKit,Caches,Preferences}/com.shep.terminal` residue.

---

## W5 — Verification

Each item states what would falsify it. V2 is the one that proves the plan's
purpose; the others are hygiene.

### V1 — No live upstream references

Discovery greps return only `research/**`. **Falsified by:** any hit in
`src-tauri/`, `core/`, `modules/`, `scripts/`, or `README.md`.

### V2 — Upstream can no longer install code (the decisive test)

Fetch upstream's published v0.6.0 `latest.json` and its signed tarball. Serve
them to a `shipctl` build — a local `latest.json` with a bumped version and
upstream's real signature is sufficient. The updater must **reject** it on
signature validation.

**Falsified by:** the upstream-signed artifact validating, or the check failing
for any reason other than signature validation (a 404 or parse error proves
nothing and must be re-run until the failure is genuinely at the signature
gate).

Do not skip this on the grounds that the key was obviously replaced. An
unverified trust boundary is the failure mode this entire plan exists to
correct.

### V3 — We can install code

From a `shipctl` build one version behind the W3 release, run the in-app check.
It must find, download, verify, install, and relaunch into the new version.
**Falsified by:** any signature error, or `check()` returning nothing.

### V4 — Release metadata is coherent

`latest.json`'s `url` resolves to a real asset; its `version` matches the
release tag; its `signature` matches the published `.sig`.
**Falsified by:** a download 404 or a version/tag mismatch.

### V5 — Install identity

`plutil -p /Applications/shipctl.app/Contents/Info.plist` reports
`CFBundleIdentifier = com.cognesy.shipctl`. Both apps can be installed at once
without collision. **Falsified by:** either app overwriting the other.

### V6 — Data continuity

The renamed app reads the pre-existing `~/.shep/usage.sqlite3`,
`config.yml`, and `assistant-sessions.json`, and an existing project's
`.shep/workspace.yml`, with no migration prompt.
**Falsified by:** an empty usage history, a lost project list, or any write to a
`.shipctl` path. Confirm `~/.shep/usage.sqlite3` size is unchanged and no
`~/.shipctl` directory is created.

### V7 — Suite and build

```
pnpm check:module-boundaries && tsc
pnpm test:usage-characterization
pnpm test:assistant-providers-characterization
```

`assistantProvidersCharacterization.test.ts:126` asserts the literal
`.shep/assistant-sessions.json` path. **It must still pass unchanged** — if it
fails, the data contract was broken and D4 was violated.

### V8 — No user-visible "Shep"

Walk the app: window title, About, quit dialog, native notifications, settings,
to-dos empty state, assistant recovery notices.
**Falsified by:** any "Shep" on screen.

---

## Rollback

W2 is a normal revert. W1 is **not**: once a build carrying the new `pubkey` is
distributed and installed, reverting to upstream's key strands those installs —
they trust only the new key. Rolling back after distribution means a manual
reinstall for every user, which is the same cost as rolling forward. Decide
before W3, not after.

## Risks

| Risk | Handling |
|---|---|
| Fork private key lost | Off-machine backup at W1 |
| Apple credentials stale | W1 fails fast at the Keychain check |
| Hardcoded `shep.app` path missed | V7 build + W2.2 `jq` derivation |
| Data path renamed by mistake | V6 + W2.4 comment + the pinning test |
| Fork repo made private later | Documented in 02 as an accepted constraint |
| Refactor conflict | Changes confined to config, scripts, strings |
