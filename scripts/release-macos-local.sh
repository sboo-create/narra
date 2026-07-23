#!/usr/bin/env bash
set -euo pipefail

RELEASE_VERSION="${1:-}"
[ -n "$RELEASE_VERSION" ] || {
  echo "Usage: scripts/release-macos-local.sh vX.Y.Z"
  exit 1
}
[ "$(uname -s)" = "Darwin" ] || {
  echo "Local signed release requires macOS"
  exit 1
}

export NODE_ENV=production
export NARRA_LOCAL_RELEASE=1
export CSC_NAME="${CSC_NAME:-Developer ID Application: Evgeny Tsapnikov (LTS79DWRGJ)}"

if [ -n "$(git status --porcelain=v1 --untracked-files=all)" ]; then
  echo "Release requires a completely clean worktree, including untracked files"
  git status --short
  exit 1
fi

node scripts/verify-release-tag.mjs "$RELEASE_VERSION"
node scripts/verify-release-env.mjs

APP_VERSION="${RELEASE_VERSION#v}"
export NARRA_RELEASE_DIR="release/$RELEASE_VERSION"
[ ! -e "$NARRA_RELEASE_DIR" ] || {
  echo "Refusing to reuse existing release output: $NARRA_RELEASE_DIR"
  exit 1
}

npm ci
npm ci --prefix server
npm audit --audit-level=moderate
npm audit --prefix server --audit-level=moderate
python3 -m venv stats/.venv
stats/.venv/bin/pip install -r stats/requirements.txt
npm run typecheck
npm run test:gateway
npm run test:release
npm run test:stats
npm run dist -- --config.directories.output="$NARRA_RELEASE_DIR"
bash scripts/notarize-dmg.sh "$APP_VERSION"
npm run smoke:pdf-worker -- "$NARRA_RELEASE_DIR/mac-universal/Narra.app/Contents/Resources/app.asar/out/main/pdf-worker.js"
npm run release:verify -- "$APP_VERSION"

DMG="$NARRA_RELEASE_DIR/Narra-${APP_VERSION}-universal.dmg"
ZIP="$NARRA_RELEASE_DIR/Narra-${APP_VERSION}-universal.zip"
UPDATE_YML="$NARRA_RELEASE_DIR/latest-mac.yml"
ZIP_BLOCKMAP="$ZIP.blockmap"
DMG_SHA256="$DMG.sha256"
ZIP_SHA256="$ZIP.sha256"
SBOM="$NARRA_RELEASE_DIR/Narra-${APP_VERSION}.cdx.json"
npm sbom --sbom-format cyclonedx > "$SBOM"

assets=(
  "$DMG"
  "$ZIP"
  "$UPDATE_YML"
  "$ZIP_BLOCKMAP"
  "$DMG_SHA256"
  "$ZIP_SHA256"
  "$SBOM"
)
for asset in "${assets[@]}"; do
  [ -s "$asset" ] || {
    echo "Missing exact release artifact: $asset"
    exit 1
  }
done

asset_is_expected() {
  local candidate="$1"
  local asset
  for asset in "${assets[@]}"; do
    [ "$(basename "$asset")" = "$candidate" ] && return 0
  done
  return 1
}

assert_no_unexpected_remote_assets() {
  local remote_asset
  while IFS= read -r remote_asset; do
    [ -z "$remote_asset" ] && continue
    asset_is_expected "$remote_asset" || {
      echo "Draft contains unexpected asset; remove it manually before retrying: $remote_asset"
      exit 1
    }
  done < <(gh release view "$RELEASE_VERSION" --json assets --jq '.assets[].name')
}

gh auth status >/dev/null
if gh release view "$RELEASE_VERSION" >/dev/null 2>&1; then
  test "$(gh release view "$RELEASE_VERSION" --json isDraft --jq .isDraft)" = true
  assert_no_unexpected_remote_assets
else
  gh release create "$RELEASE_VERSION" \
    --verify-tag \
    --draft \
    --title "Narra ${RELEASE_VERSION}" \
    --notes "Signed universal macOS release candidate. Do not publish until every documented release gate passes."
fi

gh release upload "$RELEASE_VERSION" "${assets[@]}" --clobber
expected_asset_names="$(
  for asset in "${assets[@]}"; do basename "$asset"; done | LC_ALL=C sort
)"
actual_asset_names="$(
  gh release view "$RELEASE_VERSION" --json assets --jq '.assets[].name' | LC_ALL=C sort
)"
[ "$actual_asset_names" = "$expected_asset_names" ] || {
  echo "Draft asset set does not exactly match this release"
  exit 1
}
echo "Verified artifacts uploaded to draft release $RELEASE_VERSION"
