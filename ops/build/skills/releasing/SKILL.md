---
name: releasing
description: Cut an unsigned Shipctl release and publish its private Homebrew cask update.
---

# Releasing

Shipctl currently distributes unsigned macOS DMGs through GitHub Releases on
`ddebowczyk/shipctl`. The `ddebowczyk/homebrew-shipctl` tap contains
`Casks/shipctl.rb`; Homebrew addresses that tap as `ddebowczyk/shipctl`.
The cask installs the app and exposes its bundled `shipctl` command on the
shell path. Homebrew owns installation and updates. Shipctl has no self-updater.

This is a private, one-user distribution route. The app is not signed or
notarized. macOS Gatekeeper will require a one-time user approval before the
app can open. Do not present this cask as a signed public release.

`just build release` remains the future signed and notarized path. It requires
Apple credentials and is not part of this procedure.

## Version

`ops/version/current.yaml > product_version` is the product-version authority.
Tauri's JSON version is a required packaging projection. Internal npm and Cargo
manifests use `0.0.0` placeholders. Use:

```bash
just version sync
just version next minor
just version set <new-version>
just version check
```

See `ops/version/skills/versioning/SKILL.md` for the full version procedure.
The version command changes local files only. It does not stage, commit, tag,
push, or publish.

## Build and publish

Build only from a committed source tree. A release artifact must be reproducible
from its Git tag.

```bash
just check all
just test full
git add ops/version/current.yaml src-tauri/tauri.conf.json
git commit -m "Release v<version>"
git push origin main
git tag -a v<version> -m "Shipctl v<version>"
git push origin v<version>
just version verify-release
just build local
```

`just build local` builds an unsigned app and DMG, verifies that the app bundle
contains the small `shipctl` command, and creates one immutable directory under
`builds/`. Its `build.yaml` binds the artifacts to the Git commit and source
fingerprint. Use the printed `dmg:` path for the GitHub release.

```bash
gh release create v<version> <printed-dmg-path> --title "Shipctl v<version>" --generate-notes
```

After GitHub publishes the asset, calculate its SHA-256 from the downloaded
asset, not from the local build. In the tap checkout, create
`Casks/shipctl.rb` with the actual values:

```ruby
cask "shipctl" do
  version "<version>"
  sha256 "<sha256-from-downloaded-dmg>"

  url "https://github.com/ddebowczyk/shipctl/releases/download/v#{version}/shipctl_#{version}_aarch64.dmg"
  name "shipctl"
  desc "Desktop and command-line control for Shipctl"
  homepage "https://github.com/ddebowczyk/shipctl"

  depends_on arch: :arm64

  app "shipctl.app"
  binary "#{appdir}/shipctl.app/Contents/MacOS/shipctl"

  caveats <<~EOS
    Shipctl is unsigned. On first launch, approve it in System Settings >
    Privacy & Security, then select Open Anyway.
  EOS
end
```

Use this sequence before committing the cask:

```bash
version="$(yq -r '.product_version' /path/to/shipctl/ops/version/current.yaml)"
asset="shipctl_${version}_aarch64.dmg"
url="https://github.com/ddebowczyk/shipctl/releases/download/v${version}/${asset}"
curl --fail --location --remote-name "$url"
shasum -a 256 "$asset"
brew audit --cask --strict --online Casks/shipctl.rb
```

Run those commands in a clean tap checkout after setting `version` and the
printed checksum in the cask. Verify that the downloaded asset is the
published release asset. Then commit and push the cask change.

## Verify installation and update

Use a disposable application directory or a test machine:

```bash
brew tap ddebowczyk/shipctl
brew install --cask --appdir "$PWD/Shipctl-test-applications" shipctl
shipctl version
```

The cask must install `shipctl.app` and create a `shipctl` shell command that
resolves to `shipctl.app/Contents/MacOS/shipctl`. The app owns its UI process;
the lean command starts it through that bundled executable. Confirm the version
matches the release tag. The first opening needs the Gatekeeper approval stated
above.

Verify an update only when a later real product release exists. Do not overwrite
or re-upload an existing versioned GitHub asset to simulate an upgrade.
