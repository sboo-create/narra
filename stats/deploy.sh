#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:?set REMOTE=user@host (canonical: max@158.160.163.167)}"
REMOTE_DIR="${REMOTE_DIR:-/srv/stats/narra/app}"
DRY_RUN="${DRY_RUN:-0}"
HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)-$(date -u +%Y%m%d%H%M)"
FLAGS=(-az --exclude=.venv --exclude=__pycache__ --exclude='*.pyc' --exclude=data --exclude=deploy.sh --exclude=.DS_Store)
[ "$DRY_RUN" = "1" ] && FLAGS+=(--dry-run -v)

echo "[deploy] $HERE -> $REMOTE:$REMOTE_DIR (v$VERSION)"
[ "$DRY_RUN" = "1" ] || ssh "$REMOTE" \
  "sudo install -d -o root -g root -m 0755 '$REMOTE_DIR'"
rsync "${FLAGS[@]}" --rsync-path="sudo rsync" "$HERE/" "$REMOTE:$REMOTE_DIR/"
[ "$DRY_RUN" = "1" ] && exit 0

TMP_VERSION="$(mktemp)"
trap 'rm -f "$TMP_VERSION"' EXIT
printf '%s\n' "$VERSION" > "$TMP_VERSION"
chmod 0644 "$TMP_VERSION"
rsync -az --rsync-path="sudo rsync" "$TMP_VERSION" "$REMOTE:$REMOTE_DIR/VERSION"
ssh "$REMOTE" "cd '$REMOTE_DIR' \
  && { [ -x .venv/bin/python ] || sudo python3 -m venv .venv; } \
  && sudo .venv/bin/pip install -q -r requirements.txt \
  && sudo install -d -o gigatool -g gigatool -m 0700 /srv/stats/narra/data \
  && sudo chown -R root:root '$REMOTE_DIR' \
  && sudo chmod -R go-w '$REMOTE_DIR' \
  && sudo find /srv/stats/narra/data -maxdepth 1 -type f -exec chmod 0600 {} + \
  && sudo install -m 0644 stats-narra.service /etc/systemd/system/stats-narra.service \
  && sudo systemctl daemon-reload \
  && sudo systemctl enable stats-narra \
  && sudo systemctl restart stats-narra && sleep 2 \
  && systemctl is-active stats-narra \
  && curl -sf http://127.0.0.1:9905/health \
  && curl -sf 'http://127.0.0.1:9905/summary?days=1' >/dev/null"
