#!/usr/bin/env bash
# Build and archive a machine-local, unsigned macOS release bundle.
set -euo pipefail

usage() {
  printf '%s\n' \
    'usage: just build local [--target <triple>] [--archive-only]' \
    '' \
    'Builds an unsigned macOS app and DMG, then archives both under builds/.' \
    '' \
    'options:' \
    '  --target TRIPLE  Rust target triple (default: aarch64-apple-darwin).' \
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
target='aarch64-apple-darwin'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive-only)
      mode='archive-only'
      shift
      ;;
    --target)
      [ "$#" -ge 2 ] || fail '--target requires a target triple' 2
      target="$2"
      shift 2
      ;;
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
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd "$repo_root"

require_command git
require_command jq
require_command ditto
require_command shasum
require_command ys
if [ "$mode" = 'build' ]; then
  require_command pnpm
fi

# src-tauri/tauri.conf.json is the single source of the app version, and it is
# what Tauri names the bundle from. Every other manifest carries a 0.0.0
# placeholder, so reading one of those finds no matching artifact.
version="$(jq -er '.version | strings | select(length > 0)' src-tauri/tauri.conf.json)" \
  || fail 'could not read a non-empty version from src-tauri/tauri.conf.json'
bundle_root="target/${target}/release/bundle"
app_source="${bundle_root}/macos/shipctl.app"

if [ "$mode" = 'build' ]; then
  printf 'build: pnpm tauri build --target %s --bundles app,dmg --no-sign\n' "$target" >&2
  pnpm tauri build --target "$target" --bundles app,dmg --no-sign
fi

[ -d "$app_source" ] || fail "app artifact not found: $app_source"
shopt -s nullglob
dmg_matches=("${bundle_root}/dmg/shipctl_${version}_"*.dmg)
shopt -u nullglob
[ "${#dmg_matches[@]}" -eq 1 ] \
  || fail "expected exactly one DMG artifact under ${bundle_root}/dmg for version ${version}; found ${#dmg_matches[@]}"
dmg_source="${dmg_matches[0]}"
dmg_name="$(basename "$dmg_source")"

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
ditto "$app_source" "${archive_dir}/shipctl.app" \
  || fail 'could not copy the app bundle into the archive'
cp -p "$dmg_source" "${archive_dir}/${dmg_name}" \
  || fail 'could not copy the DMG into the archive'

ui_sha256="$(shasum -a 256 "${archive_dir}/shipctl.app/Contents/MacOS/shipctl-ui" | awk '{print $1}')" \
  || fail 'could not checksum the archived UI executable'
cli_sha256="$(shasum -a 256 "${archive_dir}/shipctl.app/Contents/MacOS/shipctl" | awk '{print $1}')" \
  || fail 'could not checksum the archived CLI executable'
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
  --arg ui_sha256 "$ui_sha256" \
  --arg cli_sha256 "$cli_sha256" \
  --arg dmg_name "$dmg_name" \
  --arg dmg_sha256 "$dmg_sha256" \
  --arg build_command "pnpm tauri build --target ${target} --bundles app,dmg --no-sign" \
  '{
    schema_version: 1,
    created_at: $created_at,
    archive_mode: $mode,
    version: $version,
    target: $target,
    git_commit: $git_commit,
    git_dirty: $git_dirty,
    build_command: $build_command,
    artifacts: {
      app: {
        path: "shipctl.app",
        ui_executable: "Contents/MacOS/shipctl-ui",
        ui_executable_sha256: $ui_sha256,
        cli_executable: "Contents/MacOS/shipctl",
        cli_executable_sha256: $cli_sha256
      },
      dmg: { path: $dmg_name, sha256: $dmg_sha256 }
    }
  }' > "${archive_dir}/build.json" \
  || fail 'could not write the archive manifest'

ys -f ops/build/schema/build-manifest.schema.yaml "${archive_dir}/build.json" \
  || fail 'archive manifest failed schema validation'

printf '%s\n' \
  "archive: ${archive_dir}" \
  "app: ${archive_dir}/shipctl.app" \
  "dmg: ${archive_dir}/${dmg_name}" \
  "manifest: ${archive_dir}/build.json" \
  "git_commit: ${git_commit}" \
  "git_dirty: ${git_dirty}"
