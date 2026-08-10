#!/usr/bin/env bash
#
# Generates latest.json for the Tauri updater plugin.
# Run after `pnpm tauri build` with TAURI_SIGNING_PRIVATE_KEY set.
#
# Usage: just build update-json
#
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd "$repo_root"

just version check
VERSION=$(yq -r '.product_version' ops/version/current.yaml)

# Locate the signed update artifact under Cargo's effective target directory.
cargo_target_dir="$(bash "$script_dir/cargo-target-dir.sh")"
BUNDLE_DIR="${cargo_target_dir}/release/bundle/macos"
SIG_FILE="${BUNDLE_DIR}/shipctl.app.tar.gz.sig"

if [ ! -f "$SIG_FILE" ]; then
  echo "Error: Signature file not found at ${SIG_FILE}"
  echo "Make sure TAURI_SIGNING_PRIVATE_KEY is set before building."
  exit 1
fi

SIGNATURE=$(cat "$SIG_FILE")
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DOWNLOAD_URL="https://github.com/ddebowczyk/shipctl/releases/download/v${VERSION}/shipctl.app.tar.gz"

cat > latest.json <<EOF
{
  "version": "${VERSION}",
  "notes": "See release notes on GitHub",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "${DOWNLOAD_URL}"
    }
  }
}
EOF

echo "Generated latest.json for v${VERSION}"
