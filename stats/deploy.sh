#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:?set REMOTE=user@host (canonical: max@158.160.163.167)}"
REMOTE_DIR="${REMOTE_DIR:-/srv/stats/narra/app}"
REMOTE_DATA="${REMOTE_DATA:-/srv/stats/narra/data}"
EXPECTED_REMOTE_VERSION="${EXPECTED_REMOTE_VERSION:?set exact current remote VERSION}"
EXPECTED_REMOTE_SERVER_SHA256="${EXPECTED_REMOTE_SERVER_SHA256:?set exact current remote server.py SHA-256}"
REVIEWED_COMMIT="${REVIEWED_COMMIT:?set the full commit approved by review}"
DRY_RUN="${DRY_RUN:-0}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
HEAD="$(git -C "$REPO" rev-parse HEAD)"

if [[ ! "$REMOTE" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$ ]]; then
  echo "Invalid REMOTE" >&2
  exit 1
fi
for path in "$REMOTE_DIR" "$REMOTE_DATA"; do
  if [[ ! "$path" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$path" == *"/../"* ]]; then
    echo "Invalid remote path: $path" >&2
    exit 1
  fi
done
if [[ ! "$EXPECTED_REMOTE_VERSION" =~ ^[A-Za-z0-9._-]+$ ]] \
  || [[ ! "$EXPECTED_REMOTE_SERVER_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || [[ ! "$REVIEWED_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Invalid deployment precondition" >&2
  exit 1
fi
if [ "$HEAD" != "$REVIEWED_COMMIT" ]; then
  echo "REVIEWED_COMMIT does not match HEAD" >&2
  exit 1
fi
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=all)" ]; then
  echo "Refusing to deploy a dirty worktree" >&2
  exit 1
fi

VERSION="${HEAD:0:12}-$(date -u +%Y%m%d%H%M)"
REMOTE_BASE="$(dirname "$REMOTE_DIR")"
REMOTE_RELEASES="$REMOTE_BASE/releases"
REMOTE_STAGE="$REMOTE_RELEASES/$VERSION"
REMOTE_ROLLBACK="$REMOTE_RELEASES/rollback-$VERSION"
REMOTE_DB="$REMOTE_DATA/events.db"
REMOTE_DB_BACKUP="$REMOTE_DATA/backups/events-$VERSION.db"
REMOTE_UNIT="/etc/systemd/system/stats-narra.service"
REMOTE_UNIT_BACKUP="$REMOTE_RELEASES/stats-narra-$VERSION.service"
REMOTE_UNIT_MISSING="$REMOTE_RELEASES/stats-narra-$VERSION.service.missing"
FLAGS=(
  -az
  --exclude=.venv
  --exclude=__pycache__
  --exclude='*.pyc'
  --exclude=data
  --exclude=deploy.sh
  --exclude=.DS_Store
)
[ "$DRY_RUN" = "1" ] && FLAGS+=(--dry-run -v)

REMOTE_VERSION="$(
  ssh "$REMOTE" "sudo test -f '$REMOTE_DIR/VERSION' && sudo cat '$REMOTE_DIR/VERSION'"
)"
REMOTE_SERVER_SHA256="$(
  ssh "$REMOTE" "sudo sha256sum '$REMOTE_DIR/server.py' | awk '{print \$1}'"
)"
if [ "$REMOTE_VERSION" != "$EXPECTED_REMOTE_VERSION" ]; then
  echo "Remote VERSION drift: expected $EXPECTED_REMOTE_VERSION, got $REMOTE_VERSION" >&2
  exit 1
fi
if [ "$REMOTE_SERVER_SHA256" != "$EXPECTED_REMOTE_SERVER_SHA256" ]; then
  echo "Remote server.py drift: expected $EXPECTED_REMOTE_SERVER_SHA256, got $REMOTE_SERVER_SHA256" >&2
  exit 1
fi

echo "[deploy] reviewed $HEAD -> $REMOTE:$REMOTE_DIR (v$VERSION)"
if [ "$DRY_RUN" = "1" ]; then
  rsync "${FLAGS[@]}" --rsync-path="sudo rsync" "$HERE/" "$REMOTE:$REMOTE_STAGE/"
  exit 0
fi

ssh "$REMOTE" \
  "sudo test ! -e '$REMOTE_STAGE' \
   && sudo test ! -e '$REMOTE_ROLLBACK' \
   && sudo install -d -o root -g root -m 0755 '$REMOTE_RELEASES' \
   && sudo install -d -o root -g root -m 0755 '$REMOTE_STAGE'"
rsync "${FLAGS[@]}" --rsync-path="sudo rsync" "$HERE/" "$REMOTE:$REMOTE_STAGE/"

TMP_VERSION="$(mktemp)"
trap 'rm -f "$TMP_VERSION"' EXIT
printf '%s\n' "$VERSION" > "$TMP_VERSION"
chmod 0644 "$TMP_VERSION"
rsync -az --rsync-path="sudo rsync" "$TMP_VERSION" "$REMOTE:$REMOTE_STAGE/VERSION"

ssh "$REMOTE" \
  "sudo env \
    REMOTE_DIR='$REMOTE_DIR' \
    REMOTE_DATA='$REMOTE_DATA' \
    REMOTE_STAGE='$REMOTE_STAGE' \
    REMOTE_ROLLBACK='$REMOTE_ROLLBACK' \
    REMOTE_DB='$REMOTE_DB' \
    REMOTE_DB_BACKUP='$REMOTE_DB_BACKUP' \
    REMOTE_UNIT='$REMOTE_UNIT' \
    REMOTE_UNIT_BACKUP='$REMOTE_UNIT_BACKUP' \
    REMOTE_UNIT_MISSING='$REMOTE_UNIT_MISSING' \
    EXPECTED_REMOTE_VERSION='$EXPECTED_REMOTE_VERSION' \
    EXPECTED_REMOTE_SERVER_SHA256='$EXPECTED_REMOTE_SERVER_SHA256' \
    flock -x /run/lock/stats-narra-deploy.lock bash -se" <<'REMOTE_SCRIPT'
set -euo pipefail

python3 -m venv "$REMOTE_STAGE/.venv"
"$REMOTE_STAGE/.venv/bin/pip" install -q -r "$REMOTE_STAGE/requirements.txt"
install -d -o gigatool -g gigatool -m 0700 "$REMOTE_DATA" "$REMOTE_DATA/backups"
if test -f "$REMOTE_DB"; then
  "$REMOTE_DIR/.venv/bin/python" -c "
import sqlite3
source = sqlite3.connect('$REMOTE_DB')
target = sqlite3.connect('$REMOTE_DB_BACKUP')
with target:
    source.backup(target)
target.close()
source.close()
"
  chmod 0600 "$REMOTE_DB_BACKUP"
  chown gigatool:gigatool "$REMOTE_DB_BACKUP"
fi
chown -R root:root "$REMOTE_STAGE"
chmod -R go-w "$REMOTE_STAGE"

old_moved=0
mutating=0
rollback() {
  trap - ERR
  set +e
  systemctl stop stats-narra
  if [ "$old_moved" = "1" ]; then
    if test -e "$REMOTE_DIR"; then
      mv "$REMOTE_DIR" "$REMOTE_STAGE.failed"
    fi
    if test -e "$REMOTE_ROLLBACK"; then
      mv "$REMOTE_ROLLBACK" "$REMOTE_DIR"
    fi
  fi
  if test -f "$REMOTE_UNIT_BACKUP"; then
    install -m 0644 "$REMOTE_UNIT_BACKUP" "$REMOTE_UNIT"
  elif test -f "$REMOTE_UNIT_MISSING"; then
    rm -f "$REMOTE_UNIT"
  fi
  systemctl daemon-reload
  systemctl restart stats-narra
  echo "Deployment failed; application and unit rollback attempted" >&2
}
trap 'if [ "$mutating" = "1" ]; then rollback; fi' ERR

# The lock serializes deploys. Repeat the compare-and-swap immediately before
# the first production mutation so staging work cannot hide remote drift.
test "$(cat "$REMOTE_DIR/VERSION")" = "$EXPECTED_REMOTE_VERSION"
test "$(sha256sum "$REMOTE_DIR/server.py" | awk '{print $1}')" = \
  "$EXPECTED_REMOTE_SERVER_SHA256"

if test -f "$REMOTE_UNIT"; then
  cp "$REMOTE_UNIT" "$REMOTE_UNIT_BACKUP"
  rm -f "$REMOTE_UNIT_MISSING"
else
  : > "$REMOTE_UNIT_MISSING"
fi

mutating=1
install -m 0644 "$REMOTE_STAGE/stats-narra.service" "$REMOTE_UNIT"
systemctl daemon-reload
systemctl enable stats-narra
mv "$REMOTE_DIR" "$REMOTE_ROLLBACK"
old_moved=1
mv "$REMOTE_STAGE" "$REMOTE_DIR"

deploy_started_at="$(date +%s)"
systemctl restart stats-narra
sleep 2
systemctl is-active --quiet stats-narra
curl -fsS http://127.0.0.1:9905/health >/dev/null
curl -fsS 'http://127.0.0.1:9905/summary?days=1' >/dev/null

fresh=0
for _attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:9905/monitors \
    | "$REMOTE_DIR/.venv/bin/python" -c \
      'import datetime,json,sys
data=json.load(sys.stdin)
cutoff=float(sys.argv[1])
checks=[
    datetime.datetime.fromisoformat(row["checked_at"]).timestamp()
    for row in data.get("targets", [])
    if row.get("checked_at")
]
ok=data.get("fresh") is True and len(checks) == 4 and min(checks) >= cutoff
raise SystemExit(0 if ok else 1)' "$deploy_started_at"; then
    fresh=1
    break
  fi
  sleep 1
done
test "$fresh" = "1"

mutating=0
trap - ERR
echo "Deployment probes passed; app, unit and recovery-only DB backups retained"
REMOTE_SCRIPT
