#!/usr/bin/env bash
#
# Bump the app version and commit the change.
#
# src-tauri/tauri.conf.json is the single source of the app version; every other
# manifest carries a 0.0.0 placeholder. `just check version` enforces that, and
# this script runs it before and after so a bump cannot introduce a second copy.
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

# ── Read current version ─────────────────────────────────────────────

step "Reading current version"

just check version || fail "app version is not single-sourced; fix the drift above before bumping"

CURRENT=$(jq -r .version src-tauri/tauri.conf.json)

if [ "$NEW_VERSION" = "$CURRENT" ]; then
  fail "New version ($NEW_VERSION) is the same as the current version."
fi

# ── Confirm ──────────────────────────────────────────────────────────

printf "\n   Bumping: %s → %s\n" "$CURRENT" "$NEW_VERSION"
printf "   File:    src-tauri/tauri.conf.json\n\n"
if [[ "$AUTO_YES" != "-y" ]]; then
  read -r -p "   Continue? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    printf "Aborted.\n"
    exit 0
  fi
fi

# ── Update the single source ─────────────────────────────────────────

step "Updating src-tauri/tauri.conf.json"
jq --arg v "$NEW_VERSION" '.version = $v' src-tauri/tauri.conf.json > src-tauri/tauri.conf.json.tmp && mv src-tauri/tauri.conf.json.tmp src-tauri/tauri.conf.json
ok "tauri.conf.json → $NEW_VERSION"

# ── Verify ───────────────────────────────────────────────────────────

step "Verifying the version is still single-sourced"

just check version || fail "bump introduced version drift"

TAURI_VERSION=$(jq -r .version src-tauri/tauri.conf.json)
if [ "$TAURI_VERSION" != "$NEW_VERSION" ]; then
  fail "tauri.conf.json reads $TAURI_VERSION after the bump, expected $NEW_VERSION"
fi

# ── Commit ───────────────────────────────────────────────────────────

step "Committing version bump"

git add src-tauri/tauri.conf.json
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
printf "   4. Create the GitHub release (see ops/build/skills/releasing/SKILL.md)\n"
printf "\n"
