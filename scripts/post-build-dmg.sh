#!/usr/bin/env bash
set -euo pipefail

# Post-build script: repositions .VolumeIcon.icns off-screen in the DMG
# so it doesn't appear in Finder, and lays out the app + Applications nicely.

DMG_DIR="target/release/bundle/dmg"
DMG=$(ls "$DMG_DIR"/*.dmg 2>/dev/null | grep -v rw_temp | head -1)

if [[ -z "$DMG" ]]; then
  echo "No DMG found in $DMG_DIR"
  exit 1
fi

echo "Patching DMG: $DMG"

DMG_RW="${DMG_DIR}/rw_temp.dmg"
rm -f "$DMG_RW"

# Convert to read-write format
hdiutil convert "$DMG" -format UDRW -o "$DMG_RW" -quiet

# Mount read-write
ATTACH_OUTPUT=$(hdiutil attach "$DMG_RW" -readwrite -noverify -noautoopen -nobrowse)
DEV_NAME=$(echo "$ATTACH_OUTPUT" | grep -E '^/dev/' | head -1 | awk '{print $1}')
MOUNT_DIR=$(echo "$ATTACH_OUTPUT" | grep '/Volumes/' | sed 's|.*\(/Volumes/.*\)|\1|')
VOLUME_NAME=$(basename "$MOUNT_DIR")

echo "Device: $DEV_NAME"
echo "Mount:  $MOUNT_DIR"

# Delete old DS_Store so Finder rebuilds layout
rm -f "$MOUNT_DIR/.DS_Store"

# Use AppleScript to position icons and move hidden files off-screen
osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOLUME_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {100, 100, 640, 480}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 128
    set position of item ".VolumeIcon.icns" of container window to {800, 800}
    set position of item "shep.app" of container window to {180, 170}
    set position of item "Applications" of container window to {380, 170}
    close
  end tell
end tell
APPLESCRIPT

echo "AppleScript layout applied"
sleep 2

# Unmount
hdiutil detach "$DEV_NAME" -quiet

# Convert back to compressed read-only, replacing the original
rm "$DMG"
hdiutil convert "$DMG_RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" -quiet
rm "$DMG_RW"

# Re-sign the DMG
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "Re-signing DMG..."
  codesign -s "$APPLE_SIGNING_IDENTITY" "$DMG"
fi

echo "Done: $DMG"
