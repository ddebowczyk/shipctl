#!/usr/bin/env bash
#
# Bump the app version across all three version files and commit the change.
#
# Usage: just build bump <new-version>
# Example: just build bump 0.2.4
#
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd "$repo_root"

step()  { printf -- "\n── %s\n" "$1"; }
ok()    { printf -- "   OK: %s\n" "$1"; }
fail()  { printf -- "\nERROR: %s\n" "$1" >&2; exit 1; }

# ── Args ────────────────────────────────────────────────────────────

NEW_VERSION="${1:-}"
AUTO_YES="${2:-}"

if [ -z "$NEW_VERSION" ]; then
  fail "Usage: $0 <new-version> [-y]  (e.g. $0 0.2.4)"
fi

# Basic semver shape check
if ! printf "%s" "$NEW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  fail "Version must be semver (e.g. 0.2.4), got: $NEW_VERSION"
fi

# ── Read current versions ────────────────────────────────────────────

step "Reading current versions"

PKG_VERSION=$(jq -r .version package.json)
TAURI_VERSION=$(jq -r .version src-tauri/tauri.conf.json)
CARGO_VERSION=$(grep -E '^version\s*=' src-tauri/Cargo.toml | head -1 | sed -E 's/version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/')

ok "package.json:          $PKG_VERSION"
ok "src-tauri/tauri.conf.json: $TAURI_VERSION"
ok "src-tauri/Cargo.toml:  $CARGO_VERSION"

if [ "$PKG_VERSION" != "$TAURI_VERSION" ] || [ "$PKG_VERSION" != "$CARGO_VERSION" ]; then
  printf "\n   WARNING: version files are already out of sync. Proceeding anyway.\n"
fi

CURRENT="$PKG_VERSION"

if [ "$NEW_VERSION" = "$CURRENT" ]; then
  fail "New version ($NEW_VERSION) is the same as the current version."
fi

# ── Confirm ──────────────────────────────────────────────────────────

printf "\n   Bumping: %s → %s\n" "$CURRENT" "$NEW_VERSION"
printf "   Files:   package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml\n\n"
if [[ "$AUTO_YES" != "-y" ]]; then
  read -r -p "   Continue? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    printf "Aborted.\n"
    exit 0
  fi
fi

# ── Update files ─────────────────────────────────────────────────────

step "Updating package.json"
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
ok "package.json → $NEW_VERSION"

step "Updating src-tauri/tauri.conf.json"
jq --arg v "$NEW_VERSION" '.version = $v' src-tauri/tauri.conf.json > src-tauri/tauri.conf.json.tmp && mv src-tauri/tauri.conf.json.tmp src-tauri/tauri.conf.json
ok "tauri.conf.json → $NEW_VERSION"

step "Updating src-tauri/Cargo.toml"
awk -v new="$NEW_VERSION" 'done || !/^version[[:space:]]*=/ { print; next } { sub(/"[^"]+"/, "\"" new "\""); print; done=1 }' src-tauri/Cargo.toml > src-tauri/Cargo.toml.tmp && mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml
ok "Cargo.toml → $NEW_VERSION"

# ── Verify ───────────────────────────────────────────────────────────

step "Verifying all three files agree"

PKG_VERSION=$(jq -r .version package.json)
TAURI_VERSION=$(jq -r .version src-tauri/tauri.conf.json)
CARGO_VERSION=$(grep -E '^version\s*=' src-tauri/Cargo.toml | head -1 | sed -E 's/version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/')

if [ "$PKG_VERSION" != "$NEW_VERSION" ] || [ "$TAURI_VERSION" != "$NEW_VERSION" ] || [ "$CARGO_VERSION" != "$NEW_VERSION" ]; then
  fail "Version mismatch after update: package.json=$PKG_VERSION tauri.conf.json=$TAURI_VERSION Cargo.toml=$CARGO_VERSION"
fi

ok "all three files agree on v$NEW_VERSION"

# ── Commit ───────────────────────────────────────────────────────────

step "Committing version bump"

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "Bump version to $NEW_VERSION for release"

ok "committed version bump"

# ── Done ─────────────────────────────────────────────────────────────

printf "\n── Version bumped to v%s\n\n" "$NEW_VERSION"
printf "Next steps:\n"
printf "   1. Review changes and run the build:\n"
printf "      just build release\n"
printf "   2. Smoke test the built app\n"
printf "   3. Push and tag:\n"
printf "      git push origin main\n"
printf "      git tag v%s && git push origin v%s\n" "$NEW_VERSION" "$NEW_VERSION"
printf "   4. Create the GitHub release (see docs/RELEASING.md)\n"
printf "\n"
