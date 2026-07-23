#!/usr/bin/env bash
set -euo pipefail

APP="release/mac-universal/Narra.app"
DMG="$(find release -maxdepth 1 -name 'Narra-*-universal.dmg' -print -quit)"
ZIP="$(find release -maxdepth 1 -name 'Narra-*-universal.zip' -print -quit)"
UPDATE_YML="release/latest-mac.yml"
[ -d "$APP" ] || { echo "Missing universal app: $APP"; exit 1; }
[ -n "$DMG" ] || { echo "Missing universal DMG"; exit 1; }
[ -n "$ZIP" ] || { echo "Missing universal ZIP for macOS auto-update"; exit 1; }
[ -s "$UPDATE_YML" ] || { echo "Missing latest-mac.yml"; exit 1; }
node scripts/finalize-update-feed.mjs --verify

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
