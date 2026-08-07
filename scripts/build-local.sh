#!/usr/bin/env bash
# Build and archive a machine-local, unsigned macOS release bundle.
set -euo pipefail

usage() {
  printf '%s\n' \
    'usage: pnpm build:local [--archive-only]' \
    '' \
    'Builds an unsigned Apple Silicon app and DMG, then archives both under builds/.' \
    '' \
    'options:' \
    '  --archive-only  Archive the current Tauri output without rebuilding.' \
    '  -h, --help      Show this help.'
}

fail() {
  printf 'error: %s\n' "$1"
  exit "${2:-1}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

if [ "${1:-}" = '--' ]; then
  shift
fi

mode='build'
case "$#" in
  0) ;;
  1) ;;
  *)
    printf 'error: expected at most one option\n'
    usage
    exit 2
    ;;
esac

case "${1:-}" in
  '') ;;
  --archive-only) mode='archive-only' ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    printf 'error: unknown option: %s\n' "$1"
    usage
    exit 2
    ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

require_command git
require_command jq
require_command ditto
require_command shasum
if [ "$mode" = 'build' ]; then
  require_command pnpm
fi

target='aarch64-apple-darwin'
version="$(jq -er '.version | strings | select(length > 0)' package.json)" \
  || fail 'could not read a non-empty version from package.json'
bundle_root="target/${target}/release/bundle"
app_source="${bundle_root}/macos/shep.app"
dmg_name="shep_${version}_aarch64.dmg"
dmg_source="${bundle_root}/dmg/${dmg_name}"

if [ "$mode" = 'build' ]; then
  printf 'build: pnpm tauri build --target %s --bundles app,dmg --no-sign\n' "$target" >&2
  pnpm tauri build --target "$target" --bundles app,dmg --no-sign
fi

[ -d "$app_source" ] || fail "app artifact not found: $app_source"
[ -f "$dmg_source" ] || fail "DMG artifact not found: $dmg_source"

git_commit="$(git rev-parse HEAD)" || fail 'could not determine the current Git commit'
git_short="${git_commit:0:12}"
git_dirty=false
if [ -n "$(git status --porcelain)" ]; then
  git_dirty=true
fi
git_state='clean'
if [ "$git_dirty" = true ]; then
  git_state='dirty'
fi

timestamp="$(date '+%Y%m%d-%H%M%S')"
archive_dir="${repo_root}/builds/${timestamp}-${target}-g${git_short}-${git_state}"
if [ -e "$archive_dir" ]; then
  fail "archive already exists: $archive_dir"
fi

mkdir -p "$archive_dir" || fail "could not create archive directory: $archive_dir"
ditto "$app_source" "${archive_dir}/shep.app" \
  || fail 'could not copy the app bundle into the archive'
cp -p "$dmg_source" "${archive_dir}/${dmg_name}" \
  || fail 'could not copy the DMG into the archive'

app_sha256="$(shasum -a 256 "${archive_dir}/shep.app/Contents/MacOS/shep" | awk '{print $1}')" \
  || fail 'could not checksum the archived app executable'
dmg_sha256="$(shasum -a 256 "${archive_dir}/${dmg_name}" | awk '{print $1}')" \
  || fail 'could not checksum the archived DMG'
created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

jq -n \
  --arg created_at "$created_at" \
  --arg mode "$mode" \
  --arg version "$version" \
  --arg target "$target" \
  --arg git_commit "$git_commit" \
  --argjson git_dirty "$git_dirty" \
  --arg app_sha256 "$app_sha256" \
  --arg dmg_name "$dmg_name" \
  --arg dmg_sha256 "$dmg_sha256" \
  '{
    schema_version: 1,
    created_at: $created_at,
    archive_mode: $mode,
    version: $version,
    target: $target,
    git_commit: $git_commit,
    git_dirty: $git_dirty,
    build_command: "pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg --no-sign",
    artifacts: {
      app: { path: "shep.app", executable_sha256: $app_sha256 },
      dmg: { path: $dmg_name, sha256: $dmg_sha256 }
    }
  }' > "${archive_dir}/build.json" \
  || fail 'could not write the archive manifest'

printf '%s\n' \
  "archive: ${archive_dir}" \
  "app: ${archive_dir}/shep.app" \
  "dmg: ${archive_dir}/${dmg_name}" \
  "manifest: ${archive_dir}/build.json" \
  "git_commit: ${git_commit}" \
  "git_dirty: ${git_dirty}"
