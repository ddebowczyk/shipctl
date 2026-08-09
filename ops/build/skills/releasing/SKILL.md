---
name: releasing
description: Cut a signed, notarized Shipctl release and publish an update clients will accept.
---

# Releasing

The repeatable procedure for shipping a Shipctl version. Written to be executed
without further context.

Shipctl distributes through GitHub Releases on `ddebowczyk/shipctl` and updates
through `tauri-plugin-updater`. Two independent signing systems are involved and
they fail in different ways:

- **Apple Developer ID** signing and notarization decide whether macOS will
  *open* the app at all. A failure here is loud and local.
- **minisign** updater signing decides whether an already-installed Shipctl will
  *accept* an update. A failure here is silent: the build succeeds, the release
  publishes, and only users see it, as a rejected update. `just build verify-key`
  exists to catch that before the build.

The updater public key is compiled into every binary. It cannot be changed
remotely — a client only ever trusts the key it shipped with. Never rotate the
signing key without shipping a build carrying the new public key first.

## Prerequisites

A `.env` at the repository root, gitignored, holding:

```text
APPLE_SIGNING_IDENTITY=Developer ID Application: <name> (<team id>)
APPLE_ID=<apple developer account email>
APPLE_PASSWORD=<app-specific password, not the account password>
APPLE_TEAM_ID=<team id>
TAURI_SIGNING_PRIVATE_KEY_PATH=<absolute path to the minisign private key>
```

Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only if the key has a passphrase.

The Developer ID certificate must be installed in the login Keychain, not merely
named in `.env`. `security find-identity -v -p codesigning` must list it.

The updater private key is the root of trust for every installed client. If it
is lost, no future release can be signed for the clients already in the field
and they are permanently cut off from updates — there is no recovery path short
of a new bundle identifier and a manual reinstall. Keep a backup off this
machine.

## Version

`ops/version/current.yaml > product_version` is the product-version authority.
Tauri's JSON version is a required packaging projection, while internal npm and
Cargo manifests carry `0.0.0` placeholders. `just version check` enforces the
boundary and `just version set` updates the authority and projection together.

```bash
just version set <new-version>
```

That changes local files only; it never stages, commits, tags, pushes, or
publishes. Do not edit package or Cargo versions by hand: they are deliberately
not the product-version source.

## Cutting the release

```bash
just check all
just test full
just build verify-key
just build release
```

`just build release` re-runs the key and version checks itself, then installs,
builds, signs, notarizes, patches the DMG layout, and writes `latest.json`. It
warns on a dirty working tree rather than blocking — heed the warning; artifacts
built from uncommitted changes are not reproducible from the tag.

Then smoke test the built `.app` before publishing anything. Launch it, confirm
the version in Settings, and confirm existing sessions and usage data load.

## Publishing

```bash
git push origin main
git tag v<version> && git push origin v<version>
gh release create v<version> \
  target/release/bundle/dmg/shipctl_<version>_aarch64.dmg \
  target/release/bundle/macos/shipctl.app.tar.gz \
  target/release/bundle/macos/shipctl.app.tar.gz.sig \
  latest.json
```

`latest.json` must be attached to the release, and that release must be the
*latest* one: clients fetch
`https://github.com/ddebowczyk/shipctl/releases/latest/download/latest.json`.
A release marked pre-release or draft will not serve it, and until the first
release exists that URL returns 404 and update checks fail.

## Verifying the update path

Publishing a release that installs cleanly is not proof the update path works —
it only proves the *download* works. To prove the signature chain, install the
previous version and let it update itself to the new one. A key mismatch shows
up here and nowhere earlier.

## Scope limits

`latest.json` declares only `darwin-aarch64`, which matches what
`pnpm tauri build` produces on Apple Silicon. Intel Macs receive no updates.
Changing that requires building for `x86_64-apple-darwin` or
`universal-apple-darwin` and adding the matching platform entry in
`ops/build/bin/generate-update-json.sh`.

Releases are built locally, not in CI. The build depends on this machine's
Keychain and `.env`, so it cannot currently be reproduced by another maintainer
or by a workflow.
