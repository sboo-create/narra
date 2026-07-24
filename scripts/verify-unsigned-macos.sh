#!/usr/bin/env bash
set -euo pipefail

APP="release/mac-universal/Narra.app"
DMG="$(find release -maxdepth 1 -name 'Narra-*-universal.dmg' -print -quit)"
ZIP="$(find release -maxdepth 1 -name 'Narra-*-universal.zip' -print -quit)"
[ -d "$APP" ] || { echo "Missing universal app"; exit 1; }
[ -n "$DMG" ] && [ -s "$DMG" ] || { echo "Missing universal DMG"; exit 1; }
[ -n "$ZIP" ] && [ -s "$ZIP" ] || { echo "Missing universal ZIP"; exit 1; }
[ -s release/latest-mac.yml ] || { echo "Missing latest-mac.yml"; exit 1; }
node scripts/finalize-update-feed.mjs --verify

ARCHS="$(lipo -archs "$APP/Contents/MacOS/Narra")"
case " $ARCHS " in *' arm64 '* ) ;; *) echo "arm64 slice missing"; exit 1;; esac
case " $ARCHS " in *' x86_64 '* ) ;; *) echo "x86_64 slice missing"; exit 1;; esac
FUSES="$(node_modules/.bin/electron-fuses read --app "$APP")"
printf '%s\n' "$FUSES" | grep -q 'RunAsNode.*Disabled'
printf '%s\n' "$FUSES" | grep -q 'EnableEmbeddedAsarIntegrityValidation.*Enabled'
printf '%s\n' "$FUSES" | grep -q 'OnlyLoadAppFromAsar.*Enabled'
if node_modules/.bin/asar list "$APP/Contents/Resources/app.asar" | grep -q '/node_modules/@napi-rs/'; then
  echo "Text-only PDF worker must not package optional native canvas modules"
  exit 1
fi
echo "Verified unsigned universal QA artifact: $DMG"
