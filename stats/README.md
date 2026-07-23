# Narra module for Traction

Independent FastAPI + SQLite product analytics module for `stats.multitool.works/p/narra/`.

- `GET /health` — liveness and deployed version
- `POST /events` — token-protected gateway ingest with dedupe by `event_id`
- `GET /summary?days=N` — Traction core plus canonical six metrics
- `GET /dashboard?days=N` and `GET /` — Narra product dashboard

The module accepts only HMAC-pseudonymous actors, opaque IDs and a closed
property allow-list. Content, prompts, answers, titles, filenames, URLs and
media are not accepted.

Local run:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
STATS_ENVIRONMENT=development STATS_ALLOW_UNAUTHENTICATED_INGEST=1 .venv/bin/python server.py
```

Production variables:

```text
STATS_PORT=9905
STATS_ENVIRONMENT=production
STATS_DB=/srv/stats/narra/data/events.db
STATS_INGEST_TOKEN=<write-only random token, at least 32 characters>
STATS_COST_CURRENCY=USD
```

On i167 the token belongs in root-owned `/etc/stats/narra.env` (`0600`), not
in the repository or the systemd unit. The deploy script installs/refreshes
the unit but preserves that environment file.

The Railway gateway receives matching `TRACTION_INGEST_URL` and
`TRACTION_INGEST_TOKEN`. There is intentionally no legacy import: Narra was
not released before this instrumentation.

Staging uses a separate endpoint/database/token with
`STATS_ENVIRONMENT=staging`. The gateway sends the matching environment in a
server-controlled header; a mismatch is rejected before storage so staging
cannot silently pollute production metrics.

Current pre-release dashboard reads the bounded analytics history into memory
for rolling retention. Before public/high-volume traffic, replace this with
SQL aggregates plus an explicit raw-event retention/pruning policy; the 512 MiB
service limit is a safety stop, not a scaling design.

The deploy script keeps application code and its virtualenv root-owned; only
`/srv/stats/narra/data` is writable by `gigatool`. Before a high-availability
production rollout, replace in-place rsync with versioned releases plus an
atomic current symlink and rollback.
