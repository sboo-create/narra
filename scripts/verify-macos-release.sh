#!/usr/bin/env bash
set -euo pipefail

APP_VERSION="${1:-}"
[ -n "$APP_VERSION" ] || { echo "Usage: scripts/verify-macos-release.sh X.Y.Z"; exit 1; }
RELEASE_DIR="${NARRA_RELEASE_DIR:-release}"
APP="$RELEASE_DIR/mac-universal/Narra.app"
DMG="$RELEASE_DIR/Narra-${APP_VERSION}-universal.dmg"
ZIP="$RELEASE_DIR/Narra-${APP_VERSION}-universal.zip"
UPDATE_YML="$RELEASE_DIR/latest-mac.yml"
[ -d "$APP" ] || { echo "Missing universal app: $APP"; exit 1; }
[ -s "$DMG" ] || { echo "Missing exact universal DMG: $DMG"; exit 1; }
[ -s "$ZIP" ] || { echo "Missing exact universal ZIP for macOS auto-update: $ZIP"; exit 1; }
[ -s "$UPDATE_YML" ] || { echo "Missing latest-mac.yml"; exit 1; }
node scripts/finalize-update-feed.mjs --verify --version "$APP_VERSION"

ARCHS="$(lipo -archs "$APP/Contents/MacOS/Narra")"
case " $ARCHS " in *' arm64 '* ) ;; *) echo "arm64 slice missing"; exit 1;; esac
case " $ARCHS " in *' x86_64 '* ) ;; *) echo "x86_64 slice missing"; exit 1;; esac
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose=2 "$APP"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
FUSES="$(node_modules/.bin/electron-fuses read --app "$APP")"
printf '%s\n' "$FUSES"
printf '%s\n' "$FUSES" | grep -q 'RunAsNode is Disabled'
printf '%s\n' "$FUSES" | grep -q 'EnableEmbeddedAsarIntegrityValidation is Enabled'
printf '%s\n' "$FUSES" | grep -q 'OnlyLoadAppFromAsar is Enabled'
shasum -a 256 "$DMG" > "$DMG.sha256"
shasum -a 256 "$ZIP" > "$ZIP.sha256"
echo "Verified signed, notarized universal release: $DMG"
