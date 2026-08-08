#!/usr/bin/env bash
#
# Verify the updater signing key matches the public key compiled into the app.
#
# Tauri embeds `plugins.updater.pubkey` into every build, and installed clients
# reject any update not signed by its counterpart. Nothing in the build itself
# checks the two agree, so a stale TAURI_SIGNING_PRIVATE_KEY_PATH produces a
# release that builds, notarizes, and publishes cleanly — and that every client
# then refuses. This catches that before the build rather than after the ship.
#
# Both a minisign public key and any signature made by its private counterpart
# carry the same 8-byte key ID, so signing a scratch file and comparing IDs
# proves the pair without ever needing the private key's own public half.
#
# Usage: just build verify-key
#
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd "$repo_root"

step()  { printf -- "\n── %s\n" "$1"; }
ok()    { printf -- "   OK: %s\n" "$1"; }
fail()  { printf -- "\nERROR: %s\n" "$1" >&2; exit 1; }

# Allow standalone use: release-build.sh has already sourced .env when it calls
# this, but `just build verify-key` on its own has not.
if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

step "Verifying updater key matches the configured public key"

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY"
elif [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  [ -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ] || fail "Updater key file not found at: $TAURI_SIGNING_PRIVATE_KEY_PATH"
  PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
else
  fail "Set TAURI_SIGNING_PRIVATE_KEY_PATH (or TAURI_SIGNING_PRIVATE_KEY), in .env or the environment."
fi

[ -n "$PRIVATE_KEY" ] || fail "The updater private key is empty."

CONFIGURED_PUBKEY=$(jq -r '.plugins.updater.pubkey // empty' src-tauri/tauri.conf.json)
[ -n "$CONFIGURED_PUBKEY" ] || fail "src-tauri/tauri.conf.json has no plugins.updater.pubkey"

# A minisign file is a comment line plus a base64 payload; bytes 2..9 of that
# payload are the key ID. Public keys and signatures share the same layout.
key_id() {
  printf '%s' "$1" \
    | base64 -d 2>/dev/null \
    | sed -n 2p \
    | base64 -d 2>/dev/null \
    | dd bs=1 skip=2 count=8 2>/dev/null \
    | od -An -tx1 \
    | tr -d ' \n'
}

PROBE_DIR=$(mktemp -d)
trap 'rm -rf "$PROBE_DIR"' EXIT
printf 'shipctl updater key probe\n' > "$PROBE_DIR/probe"

# The CLI picks both key forms up from the environment and refuses to take
# them together, so the path form has to be cleared for this call.
if ! env -u TAURI_SIGNING_PRIVATE_KEY_PATH \
       TAURI_SIGNING_PRIVATE_KEY="$PRIVATE_KEY" \
       pnpm tauri signer sign \
         -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
         "$PROBE_DIR/probe" >"$PROBE_DIR/log" 2>&1; then
  sed 's/^/   /' "$PROBE_DIR/log" >&2
  fail "Could not sign with the updater key (wrong TAURI_SIGNING_PRIVATE_KEY_PASSWORD?)"
fi

EXPECTED=$(key_id "$CONFIGURED_PUBKEY")
ACTUAL=$(key_id "$(cat "$PROBE_DIR/probe.sig")")

[ -n "$EXPECTED" ] || fail "Could not read a key ID from plugins.updater.pubkey"
[ -n "$ACTUAL" ] || fail "Could not read a key ID from the test signature"

if [ "$EXPECTED" != "$ACTUAL" ]; then
  printf "\n   tauri.conf.json pubkey: %s\n" "$EXPECTED" >&2
  printf "   signing key:            %s\n" "$ACTUAL" >&2
  fail "The updater key does not match the public key compiled into the app. Every client would reject this release."
fi

ok "updater key $ACTUAL matches plugins.updater.pubkey"
