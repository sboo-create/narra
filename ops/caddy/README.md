# Narra production hostname

`narra.multitool.works.caddy` reserves the production hostname and lets Caddy
obtain a public TLS certificate before the Narra v2 gateway is cut over.

The placeholder is intentionally fail-closed:

- it does not proxy to the legacy Railway service or to staging;
- `/health` returns an exact JSON `503 not_ready`;
- every other path returns an exact JSON `503`;
- the hostname must not be embedded in a released client while this placeholder
  is active.

The shared Yandex Cloud host also serves other Multitool domains. The reviewed
pre-change SHA-256 on 23 July 2026 was:

```text
5a1158fa762b918c515efddc56729b5f9b613d57a8803c5602ac72888ef12428
```

After importing this exact-host block the main Caddyfile SHA-256 became:

```text
712b94612c66ba04c40cb50a5eaa5db4dd2a53c5b2220f550a350a0fa962e248
```

The reviewed exact-host fragment SHA-256 for this change is:

```text
05a344d96c3a64566409cc18e445222e313fb59e878737214037b86f3053691a
```

These hashes are evidence for this change, not constants for a future update.
A later edit must capture and review both of its own expected SHA values. Any
update must:

1. back up `/etc/caddy/Caddyfile`;
2. compare its SHA-256 with the reviewed value immediately before building the
   candidate and again immediately before installing it;
3. validate the candidate with privileged Caddy access;
4. reload Caddy, never restart it;
5. assert TLS, exact Narra status/body/headers, and unchanged neighbouring
   domains;
6. restore, validate and reload the backup if any assertion fails.

## Exact deployment procedure

Run the following as one Bash script, not as individually copied commands.
Set `expected` to the SHA-256 reviewed for that particular change. The script
is fail-fast, compares the shared file twice, does not add a duplicate import,
and automatically restores both the shared file and the exact-host fragment
after any failed command or probe.

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

readonly expected='REPLACE_WITH_REVIEWED_SHA256'
readonly expected_fragment='REPLACE_WITH_REVIEWED_FRAGMENT_SHA256'
readonly main='/etc/caddy/Caddyfile'
readonly fragment='/etc/caddy/narra.multitool.works.caddy'
readonly candidate='/etc/caddy/Caddyfile.narra-candidate'
readonly utc_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup="${main}.before-narra-${utc_stamp}"
readonly fragment_backup="${fragment}.before-narra-${utc_stamp}"
readonly fragment_candidate="${fragment}.candidate-${utc_stamp}"
readonly source_fragment='/tmp/narra.multitool.works.caddy'
readonly import_line='import /etc/caddy/narra.multitool.works.caddy'
readonly candidate_import_line="import ${fragment_candidate}"
readonly probe_dir="$(mktemp -d)"
fragment_existed=0
changed=0
main_installed=0

rollback() {
  readonly exit_code="$1"
  trap - ERR
  set +e
  if (( changed )); then
    if (( fragment_existed )); then
      sudo cp "$fragment_backup" "$fragment"
    else
      sudo rm -f -- "$fragment"
    fi
  fi
  if (( main_installed )); then
    sudo cp "$backup" "$main"
    sudo caddy validate --config "$main" --adapter caddyfile
    sudo caddy reload --config "$main" --adapter caddyfile
  fi
  sudo rm -f -- "$candidate" "$fragment_candidate"
  rm -rf -- "$probe_dir"
  exit "$exit_code"
}
trap 'rollback "$?"' ERR

[[ "$expected" =~ ^[0-9a-f]{64}$ ]]
[[ "$expected_fragment" =~ ^[0-9a-f]{64}$ ]]
test -s "$source_fragment"
test "$(sha256sum "$source_fragment" | awk '{print $1}')" = "$expected_fragment"
test "$(sudo sha256sum "$main" | awk '{print $1}')" = "$expected"
sudo cp "$main" "$backup"
if sudo test -e "$fragment"; then
  fragment_existed=1
  sudo cp "$fragment" "$fragment_backup"
fi
sudo cp "$main" "$candidate"
if ! sudo grep -Fxq "$import_line" "$candidate"; then
  printf '\n%s\n' "$candidate_import_line" | sudo tee -a "$candidate" >/dev/null
else
  sudo sed -i "s|^${import_line}$|${candidate_import_line}|" "$candidate"
fi
sudo install -o root -g root -m 0644 "$source_fragment" "$fragment_candidate"
test "$(sudo sha256sum "$fragment_candidate" | awk '{print $1}')" = "$expected_fragment"
test "$(sudo stat -c '%U:%G:%a' "$fragment_candidate")" = 'root:root:644'
sudo caddy validate --config "$candidate" --adapter caddyfile
test "$(sha256sum "$source_fragment" | awk '{print $1}')" = "$expected_fragment"
test "$(sudo sha256sum "$main" | awk '{print $1}')" = "$expected"
changed=1
sudo mv "$fragment_candidate" "$fragment"
test "$(sudo sha256sum "$fragment" | awk '{print $1}')" = "$expected_fragment"
test "$(sudo stat -c '%U:%G:%a' "$fragment")" = 'root:root:644'
sudo sed -i "s|^${candidate_import_line}$|${import_line}|" "$candidate"
sudo caddy validate --config "$candidate" --adapter caddyfile
test "$(sudo sha256sum "$main" | awk '{print $1}')" = "$expected"
sudo mv "$candidate" "$main"
main_installed=1
sudo caddy validate --config "$main" --adapter caddyfile
sudo caddy reload --config "$main" --adapter caddyfile

probe_exact() {
  local name="$1" url="$2" status="$3" body="$4"
  local actual
  actual="$(curl -sS -D "${probe_dir}/${name}.headers" \
    -o "${probe_dir}/${name}.body" -w '%{http_code}' "$url")"
  test "$actual" = "$status"
  test "$(cat "${probe_dir}/${name}.body")" = "$body"
}
probe_status() {
  local url="$1" expected_status="$2" actual
  actual="$(curl -sS -o /dev/null -w '%{http_code}' "$url")"
  test "$actual" = "$expected_status"
}

probe_exact health https://narra.multitool.works/health 503 \
  '{"ok":false,"status":"not_ready","service":"narra-production"}'
grep -Eiq '^content-type: application/json([;\r]|$)' "$probe_dir/health.headers"
grep -Eiq '^cache-control: no-store\r?$' "$probe_dir/health.headers"
grep -Eiq '^x-content-type-options: nosniff\r?$' "$probe_dir/health.headers"
probe_exact root https://narra.multitool.works/ 503 \
  '{"error":"Narra production gateway is not cut over"}'
probe_status https://gw.multitool.works/ 404
probe_status https://stats.multitool.works/ 401
probe_status https://stats.multitool.works/health 200
probe_status https://multitool.works/ 200
probe_status https://share.multitool.works/ 200
probe_status https://disrupt.builders/ 200

trap - ERR
rm -rf -- "$probe_dir"
```

`curl` performs certificate and hostname verification because the script never
uses `-k`. Never use `restart`; reload preserves neighbouring listeners. Do
not use `curl -f` for Narra because the expected placeholder response is 503.

## Required probes

Assert TLS verification result `0`, exact status, headers and JSON:

| Probe | Expected |
|---|---|
| `https://narra.multitool.works/health` | `503`, `application/json`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, exact `{"ok":false,"status":"not_ready","service":"narra-production"}` |
| `https://narra.multitool.works/` | `503`, exact `{"error":"Narra production gateway is not cut over"}` |
| `https://gw.multitool.works/` | `404` |
| `https://stats.multitool.works/` | `401` |
| `https://stats.multitool.works/health` | `200` |
| `https://multitool.works/` | `200` |
| `https://share.multitool.works/` | `200` |
| `https://disrupt.builders/` | `200` |

Capture neighbour statuses before the edit and require the same values after
reload.

## Narra video hostname

`narra-video.multitool.works.caddy` is a separate fail-closed reservation for
the DNS record pointing to `i46` (`167.233.103.46`). Until the last hop is
protected, it returns exact JSON `503` and never proxies to the public
`http://87.242.117.37:5051`.

Live i46 facts rechecked on 24 July 2026:

- Docker container: `bizzy-radio-caddy-1`, image `caddy:2`;
- host file: `/opt/bizzy-radio/Caddyfile`, mounted read-only inside the
  container as `/etc/caddy/Caddyfile`;
- reviewed pre-change SHA-256:
  `6f8d81643408fc06053323785bbd4f7d1ee583622152af2a9f29a1be502f2d0d`;
- the initial check found a stale single-file bind-mount inode
  (`5e56eb1d…`), but the verified rollback recreate repaired it; the running
  container now sees the same reviewed `6f8d…2d0d` file as the host;
- applied host Caddyfile SHA-256:
  `5faf7e1455b925cdd739beeae2b89f1904d954b390bae1c58176f999e93eec88`;
- live result: valid TLS, exact JSON `503` on `/health` and `/`; no upstream
  proxy is configured. Radio and Gigagochi regression probes return `200`.

The system-Caddy procedure above belongs to the separate Yandex production
hostname host and **must not** be used on i46. For i46, copy the exact reviewed
fragment and `apply-narra-video-i46.sh` to `/tmp`, verify both hashes, then run
the script as root. It validates a complete candidate in `caddy:2` and compares
the shared file twice. An earlier reload demonstrably read a stale
single-file bind; the verified rollback repaired it, but every shared-file
mutation still recreates **only** the Caddy service with `--no-deps` so the
mounted inode is deterministic. The script verifies the new host/container hashes,
checks Gigagochi and the catch-all listener, verifies exact Narra
TLS/status/body/headers, and restores the retained backup by recreating only
Caddy again on any failure.

Reviewed artifact hashes:

```text
8d30f0199d0be507c44f0fa87fa23ad7bc1d725bc256b26c0cf8268e16dd9449  apply-narra-video-i46.sh
ff2e7009f8487d4c34715f33535650b1c4e9c2512481238d55cbd9fa356419ab  narra-video.multitool.works.caddy
```

On i46, immediately before the privileged apply:

```bash
cd /tmp
printf '%s  %s\n' \
  '8d30f0199d0be507c44f0fa87fa23ad7bc1d725bc256b26c0cf8268e16dd9449' \
  'apply-narra-video-i46.sh' \
  'ff2e7009f8487d4c34715f33535650b1c4e9c2512481238d55cbd9fa356419ab' \
  'narra-video.multitool.works.caddy' | sha256sum -c -
sudo bash /tmp/apply-narra-video-i46.sh
```

After the video owner enables HTTPS or a private WireGuard/SSH tunnel, replace
only this exact-host fragment. An HTTP upstream is permitted only when its host
is loopback or a private tunnel address; `reverse_proxy
http://87.242.117.37:5051` is explicitly forbidden. Apply it with a newly
reviewed hash/CAS, Docker validation, `--force-recreate --no-deps caddy`,
neighbour probes and verified rollback.

## Manual rollback

The script above rolls back automatically on validation, reload or probe
failure. The following is the exact manual rollback for the deployment recorded
in this document, where the fragment did not exist before the change. It uses
explicit backup paths and hashes, validates the previous main file before
mutation, moves the fragment out first, restores the main file second, and only
then reloads:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

readonly main='/etc/caddy/Caddyfile'
readonly fragment='/etc/caddy/narra.multitool.works.caddy'
readonly prior_main='/etc/caddy/Caddyfile.before-narra-20260723T144858Z'
readonly main_candidate='/etc/caddy/Caddyfile.manual-rollback-candidate'
readonly current_main_backup='/etc/caddy/Caddyfile.before-manual-rollback-20260723T144858Z'
readonly fragment_quarantine='/etc/caddy/narra.multitool.works.caddy.rolled-back-20260723T144858Z'
readonly current_main_sha='712b94612c66ba04c40cb50a5eaa5db4dd2a53c5b2220f550a350a0fa962e248'
readonly prior_main_sha='5a1158fa762b918c515efddc56729b5f9b613d57a8803c5602ac72888ef12428'
readonly current_fragment_sha='05a344d96c3a64566409cc18e445222e313fb59e878737214037b86f3053691a'
mutated=0

recover_current() {
  readonly exit_code="$1"
  trap - ERR
  set +e
  if (( mutated )); then
    if sudo test -e "$fragment_quarantine"; then
      sudo mv "$fragment_quarantine" "$fragment"
    fi
    sudo cp "$current_main_backup" "$main"
    sudo caddy validate --config "$main" --adapter caddyfile
    sudo caddy reload --config "$main" --adapter caddyfile
  fi
  sudo rm -f -- "$main_candidate"
  exit "$exit_code"
}
trap 'recover_current "$?"' ERR

test "$(sudo sha256sum "$main" | awk '{print $1}')" = "$current_main_sha"
test "$(sudo sha256sum "$fragment" | awk '{print $1}')" = "$current_fragment_sha"
test "$(sudo sha256sum "$prior_main" | awk '{print $1}')" = "$prior_main_sha"
sudo install -o root -g root -m 0644 "$main" "$current_main_backup"
test "$(sudo sha256sum "$current_main_backup" | awk '{print $1}')" = "$current_main_sha"
sudo install -o root -g root -m 0644 "$prior_main" "$main_candidate"
test "$(sudo sha256sum "$main_candidate" | awk '{print $1}')" = "$prior_main_sha"
sudo caddy validate --config "$main_candidate" --adapter caddyfile
test "$(sudo sha256sum "$main" | awk '{print $1}')" = "$current_main_sha"
test "$(sudo sha256sum "$fragment" | awk '{print $1}')" = "$current_fragment_sha"

mutated=1
sudo mv "$fragment" "$fragment_quarantine"
sudo mv "$main_candidate" "$main"
sudo caddy validate --config "$main" --adapter caddyfile
sudo caddy reload --config "$main" --adapter caddyfile

probe_status() {
  local url="$1" expected_status="$2" actual
  actual="$(curl -sS -o /dev/null -w '%{http_code}' "$url")"
  test "$actual" = "$expected_status"
}
probe_status https://gw.multitool.works/ 404
probe_status https://stats.multitool.works/ 401
probe_status https://stats.multitool.works/health 200
probe_status https://multitool.works/ 200
probe_status https://share.multitool.works/ 200
probe_status https://disrupt.builders/ 200

trap - ERR
```

For a later update where a previous fragment does exist, do not reuse this
absent-fragment recipe: record its explicit backup path and reviewed SHA, stage
and validate both restore candidates, atomically restore the previous fragment
first, restore the previous main file second, then validate, reload and run all
probes. Keep both backups until the reviewed rollback and probes are recorded.

The source-of-truth block in this directory contains no credentials.
