#!/usr/bin/env bash
# Build frontend assets and the target-specific Shipctl CLI sidecar for Tauri.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd "$repo_root"

frontend_recipe="${1:-app}"
just --justfile ops/build/justfile "$frontend_recipe"
bash ops/build/bin/prepare-cli-sidecar.sh
