#!/usr/bin/env bash
set -Eeuo pipefail

# Run on i46 as root after copying the reviewed fragment to:
# /tmp/narra-video.multitool.works.caddy
readonly main='/opt/bizzy-radio/Caddyfile'
readonly fragment='/tmp/narra-video.multitool.works.caddy'
readonly container='bizzy-radio-caddy-1'
readonly compose='/opt/bizzy-radio/docker-compose.yml'
readonly expected_main='6f8d81643408fc06053323785bbd4f7d1ee583622152af2a9f29a1be502f2d0d'
readonly expected_mounted='6f8d81643408fc06053323785bbd4f7d1ee583622152af2a9f29a1be502f2d0d'
readonly expected_fragment='ff2e7009f8487d4c34715f33535650b1c4e9c2512481238d55cbd9fa356419ab'
readonly stamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup="${main}.before-narra-video-${stamp}"
readonly candidate="/tmp/Caddyfile.narra-video-${stamp}"
readonly probe_dir="$(mktemp -d)"
changed=0
backup_sha=''
pre_http=''
pre_gigagochi=''

wait_status() {
  local url="$1" expected="$2"
  for _attempt in $(seq 1 15); do
    if [ "$(curl -sS -o /dev/null -w '%{http_code}' "$url" || true)" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  readonly exit_code="$1"
  trap - ERR
  set +e
  rollback_failed=0
  if (( changed )); then
    cp "$backup" "$main" || rollback_failed=1
    test "$(sha256sum "$main" | awk '{print $1}')" = "$backup_sha" ||
      rollback_failed=1
    docker compose -f "$compose" up -d --force-recreate --no-deps caddy ||
      rollback_failed=1
    test "$(docker inspect -f '{{.State.Running}}' "$container")" = 'true' ||
      rollback_failed=1
    test "$(docker exec "$container" sha256sum /etc/caddy/Caddyfile |
      awk '{print $1}')" = "$backup_sha" || rollback_failed=1
    docker exec "$container" caddy validate \
      --config /etc/caddy/Caddyfile --adapter caddyfile || rollback_failed=1
    wait_status http://127.0.0.1/ "$pre_http" || rollback_failed=1
    wait_status https://gigagochi.serega.works/health "$pre_gigagochi" ||
      rollback_failed=1
  fi
  rm -f -- "$candidate"
  rm -rf -- "$probe_dir"
  if (( rollback_failed )); then
    echo 'CRITICAL: Caddy rollback verification failed; manual recovery required' >&2
    exit 97
  fi
  exit "$exit_code"
}
trap 'rollback "$?"' ERR

test "$(id -u)" = '0'
test -s "$main"
test -s "$fragment"
test "$(sha256sum "$main" | awk '{print $1}')" = "$expected_main"
test "$(sha256sum "$fragment" | awk '{print $1}')" = "$expected_fragment"
test "$(docker exec "$container" sha256sum /etc/caddy/Caddyfile | awk '{print $1}')" = \
  "$expected_mounted"
! grep -Fq 'narra-video.multitool.works' "$main"
test "$(docker inspect -f '{{.State.Running}}' "$container")" = 'true'

pre_http="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/)"
pre_gigagochi="$(curl -sS -o /dev/null -w '%{http_code}' https://gigagochi.serega.works/health)"

cp "$main" "$backup"
backup_sha="$(sha256sum "$backup" | awk '{print $1}')"
test "$backup_sha" = "$expected_main"
cp "$main" "$candidate"
printf '\n' >> "$candidate"
cat "$fragment" >> "$candidate"

docker run --rm \
  --env-file /opt/bizzy-radio/.env \
  -v "${candidate}:/etc/caddy/Caddyfile:ro" \
  caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Compare-and-swap again immediately before the shared-file mutation.
test "$(sha256sum "$main" | awk '{print $1}')" = "$expected_main"
cp "$candidate" "$main"
changed=1

# Recreate only Caddy (no dependencies) after changing the host file. This
# keeps the single-file bind mount and its inode deterministic; a reload cannot
# repair an already stale file bind, while the rollback path can.
docker compose -f "$compose" up -d --force-recreate --no-deps caddy
test "$(docker inspect -f '{{.State.Running}}' "$container")" = 'true'
test "$(docker exec "$container" sha256sum /etc/caddy/Caddyfile | awk '{print $1}')" = \
  "$(sha256sum "$main" | awk '{print $1}')"
docker exec "$container" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

wait_status http://127.0.0.1/ "$pre_http"
wait_status https://gigagochi.serega.works/health "$pre_gigagochi"

ready=0
for _attempt in $(seq 1 30); do
  status="$(curl -sS -o "${probe_dir}/health.body" \
    -D "${probe_dir}/health.headers" \
    -w '%{http_code}' \
    https://narra-video.multitool.works/health || true)"
  if [ "$status" = '503' ]; then
    ready=1
    break
  fi
  sleep 2
done
test "$ready" = '1'
test "$(cat "${probe_dir}/health.body")" = \
  '{"ok":false,"status":"waiting_for_secure_origin","service":"narra-video"}'
grep -Eiq \
  '^content-type:[[:space:]]*application/json([[:space:]]*;.*)?[[:space:]]*$' \
  "${probe_dir}/health.headers"
grep -Eiq '^cache-control:[[:space:]]*no-store[[:space:]]*$' \
  "${probe_dir}/health.headers"
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff[[:space:]]*$' \
  "${probe_dir}/health.headers"
test "$(curl -sS -o "${probe_dir}/root.body" -w '%{http_code}' \
  https://narra-video.multitool.works/)" = '503'
test "$(cat "${probe_dir}/root.body")" = \
  '{"error":"Narra video relay is waiting for HTTPS or a private origin tunnel"}'

changed=0
trap - ERR
rm -f -- "$candidate"
rm -rf -- "$probe_dir"
echo "narra-video fail-closed placeholder applied; backup: $backup"
