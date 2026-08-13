#!/usr/bin/env bash
#
# One-shot release build for Shipctl.
#
# - Verifies .env is present and every required signing/notarization var is set
# - Verifies the Developer ID certificate is actually installed in Keychain
# - Verifies the authoritative YAML product version and Tauri projection agree
# - Runs pnpm install, pnpm tauri build, and post-build-dmg.sh
# - Prints a summary of the resulting artifacts
#
# Usage: just build release
#
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd "$repo_root"

# ── Pre-flight output helpers ───────────────────────────────────────
# Plain text, no color, so this is readable in CI logs too.

step()  { printf -- "\n── %s\n" "$1"; }
ok()    { printf -- "   OK: %s\n" "$1"; }
fail()  { printf -- "\nERROR: %s\n" "$1" >&2; exit 1; }

# ── Step 1: verify .env and load signing env vars ───────────────────

step "Loading .env"

if [ ! -f .env ]; then
  fail ".env not found at repo root. See ops/build/skills/releasing/SKILL.md for required variables."
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

ok "sourced .env"

# ── Step 2: verify every required env var is set ────────────────────

step "Verifying signing environment"

require_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "$name is not set in .env"
  fi
  ok "$name is set"
}

require_var APPLE_SIGNING_IDENTITY
require_var APPLE_ID
require_var APPLE_PASSWORD
require_var APPLE_TEAM_ID

# ── Step 3: verify the Developer ID cert is actually in Keychain ────
#
# Catches the common "env vars set but cert was regenerated and never
# reinstalled" failure mode where tauri would otherwise fail partway
# through the build with a cryptic codesign error.

step "Verifying Developer ID certificate in Keychain"

if ! command -v security >/dev/null 2>&1; then
  fail "'security' command not available (expected on macOS)"
fi

KEYCHAIN_IDENTITIES=$(security find-identity -v -p codesigning 2>/dev/null || true)
if ! printf "%s" "$KEYCHAIN_IDENTITIES" | grep -Fq "$APPLE_SIGNING_IDENTITY"; then
  printf "\n%s\n" "$KEYCHAIN_IDENTITIES" >&2
  fail "Signing identity '$APPLE_SIGNING_IDENTITY' not found in Keychain. Recreate it in Xcode → Settings → Accounts → Manage Certificates."
fi

ok "$APPLE_SIGNING_IDENTITY"

# ── Step 4: verify required tools are on PATH ───────────────────────

step "Verifying build tools"

for tool in pnpm jq yq hdiutil codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "$tool is not on PATH"
  fi
  ok "$tool"
done

# ── Step 5: verify the app version is single-sourced ────────────────

step "Verifying app version"

just version check || fail "product version is invalid or its packaging projection has drifted"

VERSION=$(yq -r '.product_version' ops/version/current.yaml)
cargo_target_dir="$(bash "$script_dir/cargo-target-dir.sh")" \
  || fail "could not determine Cargo target directory"
target="$(rustc -vV | awk '/^host: / { print $2 }')"
case "$target" in
  aarch64-apple-darwin)
    dmg_arch='aarch64'
    ;;
  *)
    fail "release build supports only aarch64-apple-darwin; current host is $target"
    ;;
esac
bundle_root="${cargo_target_dir}/${target}/release/bundle"
ok "building v$VERSION"

# ── Step 6: require a reproducible source tree ──────────────────────

step "Checking working tree"

if [ -n "$(git status --porcelain)" ]; then
  git status --short | sed 's/^/            /'
  fail "release build requires a clean working tree"
else
  ok "working tree is clean"
fi

# ── Step 7: remove obsolete generated updater payloads ─────────────

step "Removing obsolete updater artifacts"

for artifact in \
  "${bundle_root}/macos/shipctl.app.tar.gz" \
  "${bundle_root}/macos/shipctl.app.tar.gz.sig"; do
  if [ -e "$artifact" ]; then
    rm -f -- "$artifact"
    ok "removed $(basename "$artifact")"
  fi
done

# ── Step 8: install deps + build + post-build ───────────────────────

step "pnpm install"
pnpm install

step "pnpm tauri build (signs + notarizes — can take several minutes)"
pnpm tauri build

step "Verifying signed app bundle"
app_path="${bundle_root}/macos/shipctl.app"
bash "$script_dir/verify-app-bundle.sh" \
  --app "$app_path" \
  --target "$target" \
  --version "$VERSION"
codesign --verify --deep --strict --verbose=2 "$app_path"
spctl --assess --type execute --verbose "$app_path"
ok 'signed app bundle passed executable and Gatekeeper verification'

step "Patching DMG (post-build-dmg.sh)"
bash ops/build/bin/post-build-dmg.sh

# ── Step 8: summary ─────────────────────────────────────────────────

DMG_PATH="${bundle_root}/dmg/shipctl_${VERSION}_${dmg_arch}.dmg"

printf "\n"
printf "── Release build complete: v%s\n" "$VERSION"
printf "\n"
printf "   DMG:          %s\n" "$DMG_PATH"
printf "\n"
printf "Next steps:\n"
printf "   1. Smoke test the built .app (or install from the .dmg)\n"
printf "   2. git tag v%s && git push origin main && git push origin v%s\n" "$VERSION" "$VERSION"
printf "   3. gh release create v%s %s\n" "$VERSION" "$DMG_PATH"
printf "\n"
