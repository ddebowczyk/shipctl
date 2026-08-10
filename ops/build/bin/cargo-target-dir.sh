#!/usr/bin/env bash
# Print Cargo's effective, absolute target directory for this workspace.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd -- "$repo_root"

command -v cargo >/dev/null 2>&1 || {
  printf 'error: cargo is not on PATH\n' >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'error: jq is not on PATH\n' >&2
  exit 1
}

cargo metadata \
  --manifest-path "$repo_root/Cargo.toml" \
  --no-deps \
  --format-version 1 \
  | jq -er '.target_directory | select(type == "string" and length > 0)'
