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

## Overview and tool semantics

The Traction Overview keeps the canonical six-field contract:
`ever_used`, `dau`, `wau`, `mau`, `sessions_per_dau` and `tools_per_dau`.
Both ratios use a trailing 24-hour numerator and rolling DAU regardless of the
period selected in the detailed dashboard.

For Narra, the selected `Tools / DAU` definition is **logical AI requests per
rolling DAU**. Retry and cross-provider fallback share a `request_id` and count
once. The detailed dashboard deliberately shows five alternatives alongside
the selected formula:

- provider attempts per rolling DAU;
- logical AI requests per active user-day;
- explicit product actions per active user-day;
- distinct feature breadth per active user-day;
- completed value proxies per active user-day.

This keeps the Overview stable while making the product choice visible. A
technical attempt metric must not silently replace a product-usage KPI.

The diagnostic section is separate from Overview. It includes average DAU over
available days, depth per user-day, feature-classification coverage, freshness,
ingest lag p50/p95, explicit errors and request-ID coverage. Input/output tokens,
total tokens, fallback, provider/model attempts and exact cost coverage live in the AI
section. They are guardrails and debugging measures, not headline adoption
KPIs.

Request success uses matched `ai_request_started` identities. Completed or
failed outcomes enter immediately; a start without a terminal outcome enters
the denominator after a configurable grace window (420 seconds by default,
covering two sequential 180-second streaming attempts) as overdue pending. Orphan
terminal events are excluded and reported, while outcome coverage remains
visible. Provider attempts become successful only after the response body has
been fully consumed and parsed.

`Attempts / request` uses only terminal attempts matched to request starts in
the selected request cohort. Provider/model tables and attempt error rate keep
the separate technical event-window view; terminal attempts whose starts lie
outside the window are shown as boundary/unmatched and do not inflate the
cohort ratio.

Cost is observed-only. OpenRouter usage and LiteLLM usage/response headers are
accepted only with an explicit source and USD currency; missing or ambiguous
cost remains missing and lowers coverage instead of becoming zero.

All Narra events are directly observed. There is no `mixed` or `reconstructed`
history mode because the product was not released before instrumentation.
Days before collection starts are never rendered as artificial zeroes.

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
