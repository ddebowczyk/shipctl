---
name: releasing
description: Cut a signed, notarized Shipctl release and publish its Homebrew cask update.
---

# Releasing

Shipctl distributes signed macOS DMGs through GitHub Releases on
`ddebowczyk/shipctl`. The `ddebowczyk/homebrew-shipctl` tap contains
`Casks/shipctl.rb`; Homebrew addresses that tap as `ddebowczyk/shipctl`.
The cask installs the app and exposes its bundled `shipctl` command on the
shell path. Homebrew owns installation and updates. Shipctl has no self-updater.

## Prerequisites

A gitignored `.env` at the repository root must contain:

```text
APPLE_SIGNING_IDENTITY=Developer ID Application: <name> (<team id>)
APPLE_ID=<apple developer account email>
APPLE_PASSWORD=<app-specific password, not the account password>
APPLE_TEAM_ID=<team id>
```

The Developer ID certificate must be in the login Keychain. Confirm it with:

```bash
security find-identity -v -p codesigning
```

## Version

`ops/version/current.yaml > product_version` is the product-version authority.
Tauri's JSON version is a required packaging projection. Internal npm and Cargo
manifests use `0.0.0` placeholders. Use:

```bash
just version set <new-version>
just version check
```

The version command changes local files only. It does not stage, commit, tag,
push, or publish.

## Build and publish

Build only from a committed source tree. A release artifact must be reproducible
from its Git tag.

```bash
just check all
just test full
just build release
```

`just build release` installs dependencies, builds, signs, notarizes, verifies
the app bundle, checks it with Gatekeeper, and patches the DMG. Smoke test the
built app before publishing: launch it, confirm its version, and confirm that
the bundled `shipctl` command reports the same version.

```bash
git push origin main
git tag v<version>
git push origin v<version>
target_dir="$(bash ops/build/bin/cargo-target-dir.sh)"
target="$(rustc -vV | awk '/^host: / { print $2 }')"
dmg="$target_dir/$target/release/bundle/dmg/shipctl_<version>_aarch64.dmg"
gh release create v<version> "$dmg" --title "Shipctl v<version>" --generate-notes
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

Use a disposable Homebrew prefix or a test machine:

```bash
brew tap ddebowczyk/shipctl
brew install --cask shipctl
shipctl version
brew upgrade --cask shipctl
shipctl version
```

The cask must install `shipctl.app` and create a `shipctl` shell command that
resolves to `shipctl.app/Contents/MacOS/shipctl`. The app owns its UI process;
the lean command starts it through that bundled executable.
