#!/usr/bin/env bash
# Remove competing Shipctl release-identity entries from LaunchServices.
set -euo pipefail

usage() {
  printf '%s\n' \
    'usage: just build unregister-legacy [--apply]' \
    '' \
    'Lists every LaunchServices registration with Shipctl’s release identity' \
    'except /Applications/shipctl.app. With --apply, unregisters exactly those' \
    'paths. It does not delete app bundles or affect /Applications/shipctl.app.'
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit "${2:-1}"
}

apply=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) apply=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" 2 ;;
  esac
done

lsregister='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
installed_app='/Applications/shipctl.app'

[ -x "$lsregister" ] || fail "macOS LaunchServices utility is not available: $lsregister"

registered_competitors() {
  "$lsregister" -dump | awk '
    /^path:[[:space:]]+/ {
      path = $0
      sub(/^[^:]*:[[:space:]]*/, "", path)
      sub(/[[:space:]]+\(0x[[:xdigit:]]+\)$/, "", path)
    }
    /^name:[[:space:]]+/ {
      name = $0
      sub(/^[^:]*:[[:space:]]*/, "", name)
    }
    /^identifier:[[:space:]]+/ {
      identifier = $0
      sub(/^[^:]*:[[:space:]]*/, "", identifier)
      if (name == "shipctl" && identifier == "com.cognesy.shipctl") print path
    }
  ' | sort -u
}

legacy_apps=()
while IFS= read -r app; do
  [ "$app" = "$installed_app" ] || legacy_apps+=("$app")
done < <(registered_competitors)

if [ "${#legacy_apps[@]}" -eq 0 ]; then
  printf '%s\n' 'No competing Shipctl release-identity registrations were found.'
  exit 0
fi

printf '%s\n' 'Competing Shipctl release-identity registrations:'
for app in "${legacy_apps[@]}"; do
  printf '  %s\n' "$app"
done

running_legacy="$(ps -axo pid=,command= | awk -v installed="$installed_app/Contents/MacOS/shipctl-ui" '
  index($0, "/shipctl.app/Contents/MacOS/shipctl-ui") && index($0, installed) == 0 { print }
')"
if [ -n "$running_legacy" ]; then
  printf '%s\n%s\n' \
    'A competing Shipctl app is still running:' \
    "$running_legacy"
fi

if [ "$apply" != true ]; then
  printf '%s\n' \
    'Dry run only. Quit every listed running app, then run:' \
    '  just build unregister-legacy --apply'
  exit 0
fi

[ -z "$running_legacy" ] \
  || fail 'quit the running archived Shipctl app before unregistering it' 2

for app in "${legacy_apps[@]}"; do
  "$lsregister" -u "$app" \
    || fail "could not unregister competing app: $app"
  printf 'unregistered: %s\n' "$app"
done

printf '%s\n' \
  'LaunchServices cleanup: OK' \
  'The installed release remains available as /Applications/shipctl.app.'
