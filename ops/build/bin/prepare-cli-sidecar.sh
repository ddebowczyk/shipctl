#!/usr/bin/env bash
# Build the CLI and place it where Tauri's sidecar bundler expects it.
set -euo pipefail

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd "$repo_root"

target="${1:-${TAURI_ENV_TARGET_TRIPLE:-}}"
if [ -z "$target" ]; then
  target="$(rustc -vV | awk '/^host: / { print $2 }')"
fi
[ -n "$target" ] || fail 'could not determine the Rust target triple'

profile='release'
if [ "${TAURI_ENV_DEBUG:-false}" = 'true' ]; then
  profile='debug'
fi

extension=''
case "$target" in
  *-windows-*) extension='.exe' ;;
esac

if [ "$profile" = 'release' ]; then
  cargo build -p shipctl-cli --bin shipctl --target "$target" --release
else
  cargo build -p shipctl-cli --bin shipctl --target "$target"
fi

cargo_target_dir="$(bash "$script_dir/cargo-target-dir.sh")"
source_path="${cargo_target_dir}/${target}/${profile}/shipctl${extension}"
destination="src-tauri/binaries/shipctl-${target}${extension}"
[ -x "$source_path" ] || fail "CLI sidecar was not built at ${source_path}"
install -m 0755 "$source_path" "$destination"

printf '%s\n' \
  "cli-sidecar: ${destination}" \
  "target: ${target}" \
  "profile: ${profile}"
