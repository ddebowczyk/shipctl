#!/usr/bin/env bash
# Build and archive a machine-local, unsigned macOS release bundle.
set -euo pipefail

usage() {
  printf '%s\n' \
    'usage: just build local [--target <triple>]' \
    '' \
    'Builds an unsigned macOS app and DMG. Every successful invocation creates' \
    'a unique builds/<build-id>/ directory with build.yaml and version.yaml.' \
    '' \
    'options:' \
    '  --target TRIPLE  Rust target triple (default: aarch64-apple-darwin).' \
    '  -h, --help       Show this help.'
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit "${2:-1}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

if [ "${1:-}" = '--' ]; then
  shift
fi

target='aarch64-apple-darwin'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive-only)
      fail '--archive-only cannot prove which source produced existing target output; run a full build' 2
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
      printf 'error: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! printf '%s' "$target" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  fail "target contains characters that are unsafe in a build identifier: $target" 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
cd "$repo_root"

for tool in ditto git jq node pnpm rustc shasum yamllint yq ys; do
  require_command "$tool"
done

just version check || fail 'product version is invalid or its packaging projection has drifted'
ys -f ops/version/schema/current.v1.schema.yaml ops/version/current.yaml \
  || fail 'authoritative version record failed schema validation'

version="$(yq -r '.product_version' ops/version/current.yaml)"
source_start="$(node ops/build/bin/source-identity.mjs)" \
  || fail 'could not capture source identity before the build'
git_commit="$(jq -r '.commit' <<<"$source_start")"
git_short="${git_commit:0:12}"
source_dirty="$(jq -r '.dirty' <<<"$source_start")"
source_fingerprint="$(jq -r '.fingerprint' <<<"$source_start")"
source_token="${source_fingerprint:0:12}"
source_prefix='t'
if [ "$source_dirty" = true ]; then
  source_prefix='w'
fi

mkdir -p "$repo_root/builds"
while true; do
  clock="$(node -e 'const value = new Date().toISOString(); process.stdout.write(JSON.stringify({ createdAt: value, token: value.replace(/[-:]/g, "") }))')"
  created_at="$(jq -r '.createdAt' <<<"$clock")"
  timestamp="$(jq -r '.token' <<<"$clock")"
  build_id="b${timestamp}-g${git_short}-${source_prefix}${source_token}-${target}"
  archive_dir="${repo_root}/builds/${build_id}"
  if mkdir "$archive_dir" 2>/dev/null; then
    break
  fi
done

staging_dir=''
completed=false
cleanup() {
  if [ "$completed" != true ]; then
    if [ -n "$staging_dir" ] && [ -d "$staging_dir" ]; then
      rm -rf -- "$staging_dir"
    fi
    rmdir "$archive_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT

build_command=(pnpm tauri build --target "$target" --bundles app,dmg --no-sign)
printf 'build_id: %s\n' "$build_id" >&2
printf 'build: %s\n' "${build_command[*]}" >&2
SHIPCTL_BUILD_ID="$build_id" "${build_command[@]}"

source_end="$(node ops/build/bin/source-identity.mjs)" \
  || fail 'could not capture source identity after the build'
if [ "$source_start" != "$source_end" ]; then
  fail 'source state changed during the build; refusing to issue a false build record'
fi
if [ "$(yq -r '.product_version' ops/version/current.yaml)" != "$version" ]; then
  fail 'product version changed during the build'
fi

cargo_target_dir="$(bash "$script_dir/cargo-target-dir.sh")" \
  || fail 'could not determine Cargo target directory'
bundle_root="${cargo_target_dir}/${target}/release/bundle"
app_source="${bundle_root}/macos/shipctl.app"
[ -d "$app_source" ] || fail "app artifact not found: $app_source"
shopt -s nullglob
dmg_matches=("${bundle_root}/dmg/shipctl_${version}_"*.dmg)
shopt -u nullglob
[ "${#dmg_matches[@]}" -eq 1 ] \
  || fail "expected exactly one DMG for version ${version}; found ${#dmg_matches[@]}"
dmg_source="${dmg_matches[0]}"
dmg_name="$(basename "$dmg_source")"

staging_dir="$(mktemp -d "${repo_root}/builds/.${build_id}.XXXXXX")"
ditto "$app_source" "${staging_dir}/shipctl.app" \
  || fail 'could not copy the app bundle into the build directory'
cp -p "$dmg_source" "${staging_dir}/${dmg_name}" \
  || fail 'could not copy the DMG into the build directory'
cp -p ops/version/current.yaml "${staging_dir}/version.yaml" \
  || fail 'could not copy the authoritative version record'

ui_path='shipctl.app/Contents/MacOS/shipctl-ui'
cli_path='shipctl.app/Contents/MacOS/shipctl'
bash "$script_dir/verify-app-bundle.sh" \
  --app "${staging_dir}/shipctl.app" \
  --target "$target" \
  --version "$version" \
  || fail 'final app bundle verification failed'
app_sha256="$(node ops/build/bin/hash-tree.mjs "${staging_dir}/shipctl.app")"
ui_sha256="$(shasum -a 256 "${staging_dir}/${ui_path}" | awk '{print $1}')"
cli_sha256="$(shasum -a 256 "${staging_dir}/${cli_path}" | awk '{print $1}')"
dmg_sha256="$(shasum -a 256 "${staging_dir}/${dmg_name}" | awk '{print $1}')"
version_sha256="$(shasum -a 256 "${staging_dir}/version.yaml" | awk '{print $1}')"
ui_size="$(wc -c < "${staging_dir}/${ui_path}" | tr -d ' ')"
cli_size="$(wc -c < "${staging_dir}/${cli_path}" | tr -d ' ')"
dmg_size="$(wc -c < "${staging_dir}/${dmg_name}" | tr -d ' ')"
rustc_version="$(rustc --version)"
pnpm_version="$(pnpm --version)"
tauri_version="$(pnpm exec tauri --version)"

printf '%s\n' '---' > "${staging_dir}/build.yaml" \
  || fail 'could not start the build record'
jq -n \
  --arg build_id "$build_id" \
  --arg created_at "$created_at" \
  --arg product_version "$version" \
  --arg version_sha256 "$version_sha256" \
  --arg target "$target" \
  --argjson source "$source_start" \
  --arg rustc "$rustc_version" \
  --arg pnpm "$pnpm_version" \
  --arg tauri_cli "$tauri_version" \
  --arg app_sha256 "$app_sha256" \
  --arg ui_path "$ui_path" \
  --arg ui_sha256 "$ui_sha256" \
  --argjson ui_size "$ui_size" \
  --arg cli_path "$cli_path" \
  --arg cli_sha256 "$cli_sha256" \
  --argjson cli_size "$cli_size" \
  --arg dmg_name "$dmg_name" \
  --arg dmg_sha256 "$dmg_sha256" \
  --argjson dmg_size "$dmg_size" \
  '{
    schema_version: 2,
    build_id: $build_id,
    created_at: $created_at,
    product_version: $product_version,
    version_record: { path: "version.yaml", sha256: $version_sha256 },
    target: $target,
    mode: "build",
    source: $source,
    command: ["pnpm", "tauri", "build", "--target", $target, "--bundles", "app,dmg", "--no-sign"],
    toolchain: { rustc: $rustc, pnpm: $pnpm, tauri_cli: $tauri_cli },
    artifacts: [
      { kind: "app-bundle", path: "shipctl.app", digest: { algorithm: "sha256", scope: "tree", value: $app_sha256 } },
      { kind: "ui-executable", path: $ui_path, size_bytes: $ui_size, digest: { algorithm: "sha256", scope: "file", value: $ui_sha256 } },
      { kind: "cli-executable", path: $cli_path, size_bytes: $cli_size, digest: { algorithm: "sha256", scope: "file", value: $cli_sha256 } },
      { kind: "dmg", path: $dmg_name, size_bytes: $dmg_size, digest: { algorithm: "sha256", scope: "file", value: $dmg_sha256 } }
    ],
    provenance: { status: "verified", source_unchanged_during_build: true }
  }' | yq -P -p=json -o=yaml '.' >> "${staging_dir}/build.yaml" \
  || fail 'could not write the build record'

ys -f ops/build/schema/build-record.v2.schema.yaml "${staging_dir}/build.yaml" \
  || fail 'build record failed schema validation'
yamllint "${staging_dir}/build.yaml" "${staging_dir}/version.yaml" \
  || fail 'build metadata failed YAML linting'

rmdir "$archive_dir" || fail 'could not finalize reserved build directory'
mv "$staging_dir" "$archive_dir" || fail 'could not publish the complete build directory'
staging_dir=''
completed=true

printf '%s\n' \
  "build_id: ${build_id}" \
  "build: ${archive_dir}" \
  "app: ${archive_dir}/shipctl.app" \
  "dmg: ${archive_dir}/${dmg_name}" \
  "record: ${archive_dir}/build.yaml" \
  "version_record: ${archive_dir}/version.yaml" \
  "product_version: ${version}" \
  "source_fingerprint: ${source_fingerprint}"
