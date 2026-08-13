#!/usr/bin/env bash
# Verify the distributable Shipctl app bundle before it becomes a build input.
set -euo pipefail

usage() {
  printf '%s\n' \
    'usage: verify-app-bundle.sh --app PATH --target TRIPLE --version VERSION' \
    '' \
    'Checks the two bundled executables, the app metadata, target architecture,' \
    'and the CLI through the symlink shape installed by a Homebrew cask.'
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

app=''
target=''
version=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app)
      [ "$#" -ge 2 ] || fail '--app requires a path'
      app="$2"
      shift 2
      ;;
    --target)
      [ "$#" -ge 2 ] || fail '--target requires a Rust target triple'
      target="$2"
      shift 2
      ;;
    --version)
      [ "$#" -ge 2 ] || fail '--version requires a product version'
      version="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ -n "$app" ] || fail '--app is required'
[ -n "$target" ] || fail '--target is required'
[ -n "$version" ] || fail '--version is required'
[ -d "$app" ] || fail "app bundle does not exist: $app"
app="$(cd -- "$app" && pwd -P)"

case "$target" in
  aarch64-apple-darwin) expected_arch='arm64' ;;
  x86_64-apple-darwin) expected_arch='x86_64' ;;
  *) fail "unsupported macOS target for app bundle verification: $target" ;;
esac

plist="$app/Contents/Info.plist"
macos_dir="$app/Contents/MacOS"
ui="$macos_dir/shipctl-ui"
cli="$macos_dir/shipctl"
[ -f "$plist" ] || fail "app bundle has no Info.plist: $plist"
[ -x "$ui" ] || fail "app bundle has no executable UI: $ui"
[ -x "$cli" ] || fail "app bundle has no executable CLI: $cli"

# A raw Mach-O linker signature does not make a valid macOS application bundle.
# Require a complete bundle signature so that a release cannot pass verification
# and later show macOS's "app is damaged" alert.
codesign --verify --deep --strict --verbose=2 "$app" \
  || fail 'app bundle code signature is invalid'

bundle_executable="$(plutil -extract CFBundleExecutable raw "$plist")" \
  || fail 'could not read CFBundleExecutable from Info.plist'
[ "$bundle_executable" = 'shipctl-ui' ] \
  || fail "CFBundleExecutable must be shipctl-ui, found: $bundle_executable"

bundle_version="$(plutil -extract CFBundleShortVersionString raw "$plist")" \
  || fail 'could not read CFBundleShortVersionString from Info.plist'
[ "$bundle_version" = "$version" ] \
  || fail "Info.plist product version is $bundle_version, expected $version"

for executable in "$ui" "$cli"; do
  architectures="$(lipo -archs "$executable")" \
    || fail "could not read architectures from $executable"
  case " $architectures " in
    *" $expected_arch "*) ;;
    *) fail "$executable does not contain required architecture $expected_arch: $architectures" ;;
  esac
done

cli_version="$($cli version)" || fail 'bundled CLI did not run `version`'
case "$cli_version" in
  "shipctl $version (role cli"*) ;;
  *) fail "bundled CLI reports an unexpected version: $cli_version" ;;
esac

test_root="$(mktemp -d "${TMPDIR:-/tmp}/shipctl-cask-layout.XXXXXX")"
cleanup() {
  rm -rf -- "$test_root"
}
trap cleanup EXIT
mkdir -p "$test_root/bin"
ln -s "$cli" "$test_root/bin/shipctl"
"$test_root/bin/shipctl" --help >/dev/null \
  || fail 'CLI did not run through a Homebrew-style symlink'
linked_version="$($test_root/bin/shipctl version)" \
  || fail 'CLI version did not run through a Homebrew-style symlink'
[ "$linked_version" = "$cli_version" ] \
  || fail 'CLI version changed when invoked through a Homebrew-style symlink'

printf '%s\n' \
  "app bundle: $app" \
  "target architecture: $expected_arch" \
  "product version: $version" \
  'bundle verification: OK'
