#!/usr/bin/env bash
set -euo pipefail

APP_VERSION="${1:-}"
[ -n "$APP_VERSION" ] || { echo "Usage: scripts/notarize-dmg.sh X.Y.Z"; exit 1; }
RELEASE_DIR="${NARRA_RELEASE_DIR:-release}"
DMG="$RELEASE_DIR/Narra-${APP_VERSION}-universal.dmg"
[ -s "$DMG" ] || { echo "Missing exact universal DMG: $DMG"; exit 1; }

if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  args=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
  [ -z "${APPLE_KEYCHAIN:-}" ] || args+=(--keychain "$APPLE_KEYCHAIN")
  xcrun notarytool submit "$DMG" "${args[@]}" --wait
elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  [ -f "$APPLE_API_KEY" ] || { echo "APPLE_API_KEY must point to a .p8 file"; exit 1; }
  xcrun notarytool submit "$DMG" \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
else
  echo "Missing Apple notarization credentials"
  exit 1
fi

xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
node scripts/finalize-update-feed.mjs --version "$APP_VERSION"
echo "Notarized and stapled: $DMG"
