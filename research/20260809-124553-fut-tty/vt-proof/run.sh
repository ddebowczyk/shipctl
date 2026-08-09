#!/bin/sh
set -eu

proof_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(git -C "$proof_dir" rev-parse --show-toplevel)
zig_version=$(zig version)
case "$zig_version" in
  0.16.*) ;;
  *)
    printf 'VT proof requires Zig 0.16.x; found %s\n' "$zig_version" >&2
    exit 2
    ;;
esac

result_path="$repository_root/target/vt-replay-proof/fixtures.tsv"
mkdir -p "$(dirname -- "$result_path")"
CARGO_TARGET_DIR="$repository_root/target/vt-replay-proof/cargo" \
  cargo run --quiet --manifest-path "$proof_dir/Cargo.toml" >"$result_path"
node "$proof_dir/compare.mjs" "$result_path"

