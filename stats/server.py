#!/usr/bin/env python3
"""Privacy-safe Narra analytics module for Traction.

The Railway gateway is the only writer. This service stores HMAC-pseudonymous
actors, opaque session/request identifiers and a closed set of coarse product
properties. Book text, titles, prompts, responses, filenames, URLs and media
are rejected at ingestion.
"""
from __future__ import annotations

import base64
import hmac
import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
from collections import Counter, defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from monitoring import (
    MonitorRunner,
    default_targets,
    ensure_schema as ensure_monitor_schema,
    monitor_report,
    validate_targets,
)


HERE = Path(__file__).resolve().parent
HOST = os.environ.get("STATS_HOST", "127.0.0.1").strip()


def _listen_port() -> int:
    """Use Railway's assigned port, with STATS_PORT for non-Railway hosts."""
    return int(os.environ.get("PORT", os.environ.get("STATS_PORT", "9905")))


def _trusted_proxy_host_allowed(host: str) -> bool:
    return host in {"127.0.0.1", "::1", "localhost"}


PORT = _listen_port()
DB_PATH = Path(os.environ.get("STATS_DB", HERE / "data" / "events.db"))
INGEST_TOKEN = os.environ.get("STATS_INGEST_TOKEN", "")
READ_USERNAME = os.environ.get("STATS_READ_USERNAME", "").strip()
READ_PASSWORD = os.environ.get("STATS_READ_PASSWORD", "")
TRUST_LOOPBACK_PROXY = os.environ.get("STATS_TRUST_LOOPBACK_PROXY", "0") == "1"
ALLOW_OPEN = os.environ.get("STATS_ALLOW_UNAUTHENTICATED_INGEST", "0") == "1"
CONTRACT_TEST_MODE = os.environ.get("STATS_CONTRACT_TEST_MODE", "0") == "1"
ENVIRONMENT = os.environ.get("STATS_ENVIRONMENT", "production").strip()
COST_CURRENCY = os.environ.get("STATS_COST_CURRENCY", "USD").strip().upper()
AI_OUTCOME_GRACE_SECONDS = max(
    60, min(int(os.environ.get("STATS_AI_OUTCOME_GRACE_SECONDS", "420")), 3600)
)
MONITOR_ENABLED = os.environ.get(
    "STATS_MONITOR_ENABLED",
    "1" if ENVIRONMENT == "production" else "0",
) == "1"
MONITOR_INTERVAL_SECONDS = max(
    30, min(int(os.environ.get("STATS_MONITOR_INTERVAL_SECONDS", "60")), 3600)
)
MONITOR_TIMEOUT_SECONDS = max(
    1.0, min(float(os.environ.get("STATS_MONITOR_TIMEOUT_SECONDS", "5")), 15.0)
)
MONITOR_STALE_AFTER_SECONDS = max(
    90,
    min(
        int(os.environ.get(
            "STATS_MONITOR_STALE_AFTER_SECONDS",
            str(MONITOR_INTERVAL_SECONDS * 3),
        )),
        10_800,
    ),
)
MONITOR_RETENTION_DAYS = max(
    1, min(int(os.environ.get("STATS_MONITOR_RETENTION_DAYS", "30")), 90)
)
VERSION_FILE = HERE / "VERSION"
VERSION = VERSION_FILE.read_text().strip() if VERSION_FILE.exists() else "dev"
REPORTING_TZ = ZoneInfo("Europe/Moscow")
MAX_BODY = 512 * 1024
MAX_BATCH = 500
INGEST_RATE_PER_MINUTE = max(1, min(int(os.environ.get("STATS_INGEST_RATE_PER_MINUTE", "600")), 100_000))
if ENVIRONMENT not in {"production", "staging", "development", "test"}:
    raise RuntimeError("STATS_ENVIRONMENT must be production, staging, development or test")
if ALLOW_OPEN and ENVIRONMENT not in {"development", "test"}:
    raise RuntimeError("STATS_ALLOW_UNAUTHENTICATED_INGEST is forbidden outside development/test")
if CONTRACT_TEST_MODE and ENVIRONMENT != "test":
    raise RuntimeError("STATS_CONTRACT_TEST_MODE requires STATS_ENVIRONMENT=test")
if not re.fullmatch(r"[A-Z]{3}", COST_CURRENCY):
    raise RuntimeError("STATS_COST_CURRENCY must be a three-letter currency code")
if not HOST:
    raise RuntimeError("STATS_HOST must not be empty")
if not 1 <= PORT <= 65535:
    raise RuntimeError("PORT/STATS_PORT must be between 1 and 65535")
if not ALLOW_OPEN and not CONTRACT_TEST_MODE and len(INGEST_TOKEN) < 32:
    raise RuntimeError("STATS_INGEST_TOKEN must contain at least 32 characters")
if bool(READ_USERNAME) != bool(READ_PASSWORD):
    raise RuntimeError("STATS_READ_USERNAME and STATS_READ_PASSWORD must be configured together")
if TRUST_LOOPBACK_PROXY and not _trusted_proxy_host_allowed(HOST):
    raise RuntimeError("STATS_TRUST_LOOPBACK_PROXY requires a loopback-only STATS_HOST")
if ENVIRONMENT in {"production", "staging"} and not TRUST_LOOPBACK_PROXY and (
    not READ_USERNAME or len(READ_PASSWORD) < 32
):
    raise RuntimeError("analytics reads require a username and a password of at least 32 characters")

EVENT_NAMES = {
    "app_opened", "app_closed", "book_import_started", "book_import_completed",
    "book_import_failed", "book_analysis_started", "book_analysis_completed",
    "book_analysis_failed", "book_opened", "reading_session_started",
    "reading_session_qualified", "reading_session_ended", "chapter_changed",
    "chapter_completed", "bookmark_added", "note_added", "character_opened",
    "chat_opened", "ai_request_started", "ai_request_completed", "ai_request_failed",
    "media_job_enqueued", "media_job_started", "media_job_completed",
    "media_job_failed", "media_job_cancelled", "tts_first_audio_ready",
    "tts_playback_started", "tts_playback_abandoned",
    "answer_feedback_submitted", "update_offered", "update_downloaded",
    "update_verified", "update_installed", "app_version_seen",
    "provider_attempt_started", "provider_attempt_completed", "provider_attempt_failed",
    "provider_attempt_not_configured",
}

SAFE_PROPERTIES = {
    "app_version", "os_major", "arch", "channel", "status", "duration_seconds",
    "duration_bucket", "book_kind", "format", "source_class", "size_bucket",
    "chapter_count_bucket", "error_code", "chapter_position_bucket",
    "navigation_type", "feature", "success", "request_id", "purpose", "route",
    "latency_ms", "rating", "version", "provider", "model", "http_status",
    "input_tokens", "output_tokens", "total_tokens", "exact_cost", "retry_index",
    "cost_currency", "cost_source", "analysis_version", "character_count_bucket",
    "pov", "confidence_bucket", "origin", "stage", "safe_error_code",
    "job_type", "quality", "queue_depth_bucket", "queue_wait_bucket",
    "job_latency_bucket", "cache_hit", "result_size_bucket",
    "retry_count_bucket", "queue_or_running", "sample_rate",
    "first_audio_latency_bucket", "source", "listened_fraction_bucket",
}
EVENT_PROPERTIES = {
    "app_opened": {"app_version", "os_major", "arch", "channel"},
    "app_closed": {"duration_seconds"},
    "book_import_started": {"format", "source_class", "size_bucket"},
    "book_import_completed": {"format", "source_class", "size_bucket", "chapter_count_bucket", "duration_bucket"},
    "book_import_failed": {"format", "source_class", "size_bucket", "error_code"},
    "book_analysis_started": {"analysis_version", "origin"},
    "book_analysis_completed": {
        "analysis_version", "character_count_bucket", "duration_bucket", "pov",
        "confidence_bucket", "origin",
    },
    "book_analysis_failed": {"analysis_version", "stage", "safe_error_code", "origin"},
    "book_opened": {"book_kind"},
    "reading_session_started": {"book_kind"},
    "reading_session_qualified": {"book_kind", "duration_seconds", "duration_bucket"},
    "reading_session_ended": {"book_kind", "duration_seconds", "duration_bucket"},
    "chapter_changed": {"chapter_position_bucket", "navigation_type"},
    "chapter_completed": {"chapter_position_bucket"},
    "bookmark_added": {"feature"}, "note_added": {"feature"},
    "character_opened": {"feature"}, "chat_opened": {"feature"},
    "ai_request_started": {"request_id", "purpose", "origin"},
    "ai_request_completed": {
        "request_id", "purpose", "route", "latency_ms", "success",
        "input_tokens", "output_tokens", "total_tokens", "exact_cost",
        "cost_currency", "cost_source", "origin",
    },
    "ai_request_failed": {
        "request_id", "purpose", "route", "latency_ms", "success", "error_code", "origin",
    },
    "media_job_enqueued": {"job_type", "provider", "model", "quality", "queue_depth_bucket", "origin"},
    "media_job_started": {"job_type", "queue_wait_bucket", "origin"},
    "media_job_completed": {
        "job_type", "job_latency_bucket", "cache_hit", "result_size_bucket", "origin",
    },
    "media_job_failed": {"job_type", "stage", "safe_error_code", "retry_count_bucket", "origin"},
    "media_job_cancelled": {"job_type", "queue_or_running", "origin"},
    "tts_first_audio_ready": {"sample_rate", "first_audio_latency_bucket", "origin"},
    "tts_playback_started": {"source", "cache_hit", "origin"},
    "tts_playback_abandoned": {"source", "listened_fraction_bucket", "origin"},
    "answer_feedback_submitted": {"rating"},
    "update_offered": {"version"}, "update_downloaded": {"version"},
    "update_verified": {"version", "success", "error_code"}, "update_installed": {"version"},
    "app_version_seen": {"version"},
    "provider_attempt_started": {"request_id", "purpose", "provider", "model", "retry_index"},
    "provider_attempt_completed": {"request_id", "purpose", "provider", "model", "latency_ms", "http_status", "retry_index"},
    "provider_attempt_failed": {"request_id", "purpose", "provider", "model", "latency_ms", "http_status", "error_code", "retry_index"},
    "provider_attempt_not_configured": {"request_id", "purpose", "provider", "model", "error_code", "retry_index"},
}
NUMERIC_PROPERTIES = {
    "duration_seconds", "latency_ms", "http_status", "input_tokens", "output_tokens",
    "total_tokens", "exact_cost", "retry_index", "sample_rate",
}
PROPERTY_ENUMS = {
    "book_kind": {"builtin", "imported"},
    "format": {"epub", "fb2", "txt", "pdf", "html", "unknown"},
    "source_class": {"file", "url", "builtin"},
    "rating": {"helpful", "unhelpful"},
    "channel": {"production", "development", "staging"},
    "purpose": {"character_chat", "structured_task", "summary", "scenario", "memory"},
    "feature": {"bookmark", "note", "character", "chat"},
    "navigation_type": {"reader", "toc", "next", "previous"},
    "duration_bucket": {"<1s", "1-4s", "5-14s", "15-59s", "<1m", "1-4m", "5-14m", "15m+", "5m+"},
    "size_bucket": {"<1mb", "1-9mb", "10-39mb"},
    "chapter_count_bucket": {"1-3", "4-10", "11-25", "26+"},
    "chapter_position_bucket": {"1-3", "4-10", "11-25", "26+"},
    "arch": {"arm64", "x64"},
    "error_code": {"UNKNOWN", "VALIDATION", "NETWORK", "AUTH", "TIMEOUT", "RATE", "NO_KEY", "NO_PROXY", "PARSE", "CENSOR", "CANCELLED"},
    "cost_currency": {"USD"},
    "cost_source": {"openrouter_usage", "litellm_usage", "litellm_response_header"},
    "analysis_version": {"v1"},
    "character_count_bucket": {"0", "1-3", "4-8", "9+"},
    "pov": {"first_person", "third_person", "unknown"},
    "confidence_bucket": {"low", "medium", "high", "unknown"},
    "origin": {"user", "background"},
    "stage": {"import", "character_markup", "chapter_markup", "character_or_chapter_markup", "provider", "cache", "playback"},
    "safe_error_code": {"UNKNOWN", "VALIDATION", "NETWORK", "AUTH", "TIMEOUT", "RATE", "NO_KEY", "NO_PROXY", "PARSE", "CENSOR", "CANCELLED"},
    "job_type": {"image", "tts", "avatar", "portrait_animation", "chapter_markup"},
    "quality": {"standard", "lite", "hd", "24000", "48000", "unknown"},
    "queue_depth_bucket": {"0", "1-4", "5-9", "10+"},
    "queue_wait_bucket": {"<1s", "1-4s", "5-14s", "15s+"},
    "job_latency_bucket": {"<1s", "1-4s", "5-14s", "15-59s", "1-4m", "5m+"},
    "result_size_bucket": {"<256kb", "256kb-1mb", "1-9mb", "10mb+"},
    "retry_count_bucket": {"0", "1", "2+"},
    "queue_or_running": {"queue", "running"},
    "first_audio_latency_bucket": {"<1s", "1-4s", "5-14s", "15s+"},
    "source": {"reader", "character", "chat"},
    "listened_fraction_bucket": {"<10%", "10-49%", "50-89%", "90%+"},
}
ACTIVE_EVENTS = {
    "book_import_started", "book_import_completed", "book_opened",
    "reading_session_qualified", "chapter_changed", "chapter_completed",
    "bookmark_added", "note_added", "character_opened", "chat_opened",
    "answer_feedback_submitted", "ai_request_started",
}
EVER_USED_EVENTS = {"book_opened"}
# A product session is qualified reading (>=60 focused seconds) or an explicit
# AI tool request. Merely opening/importing a book is activity, not a session.
SESSION_EVENTS = {"reading_session_qualified", "ai_request_started"}
FEATURE_BY_EVENT = {
    "book_opened": "Reading", "reading_session_qualified": "Reading",
    "chapter_changed": "Reading", "chapter_completed": "Reading",
    "bookmark_added": "Bookmarks", "note_added": "Notes",
    "character_opened": "Characters", "chat_opened": "Character chat",
    "book_import_started": "Book import", "book_import_completed": "Book import",
    "ai_request_started": "AI tools",
    "answer_feedback_submitted": "Answer feedback",
}
PRODUCT_ACTION_EVENTS = {
    "book_import_completed", "book_opened", "reading_session_qualified",
    "chapter_changed", "chapter_completed", "bookmark_added", "note_added",
    "character_opened", "chat_opened", "answer_feedback_submitted",
}
VALUE_ACTION_EVENTS = {
    "book_import_completed", "reading_session_qualified", "chapter_completed",
    "bookmark_added", "note_added", "ai_request_completed",
}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
ACTOR_RE = re.compile(r"^[0-9a-f]{64}$", re.I)

app = FastAPI()
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
_db = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
_db.execute("PRAGMA journal_mode=WAL")
_db.execute("PRAGMA synchronous=NORMAL")
_db.execute(
    "CREATE TABLE IF NOT EXISTS events("
    "event_id TEXT PRIMARY KEY, ts REAL NOT NULL, device_id TEXT NOT NULL, "
    "session_id TEXT, name TEXT NOT NULL, properties TEXT NOT NULL DEFAULT '{}', "
    "ingested_at REAL NOT NULL)"
)
_db.execute("CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts)")
_db.execute("CREATE INDEX IF NOT EXISTS ix_events_device_ts ON events(device_id,ts)")
_db.execute("CREATE INDEX IF NOT EXISTS ix_events_name_ts ON events(name,ts)")
_db.commit()
DB_LOCK = threading.RLock()
MONITOR_TARGETS = default_targets()
validate_targets(MONITOR_TARGETS)
ensure_monitor_schema(_db, DB_LOCK)
MONITOR_RUNNER = MonitorRunner(
    _db,
    DB_LOCK,
    MONITOR_TARGETS,
    interval_seconds=MONITOR_INTERVAL_SECONDS,
    timeout_seconds=MONITOR_TIMEOUT_SECONDS,
    retention_days=MONITOR_RETENTION_DAYS,
)
RATE_LOCK = threading.Lock()
RATE: dict[str, deque[float]] = defaultdict(deque)


def _response(value: object, status: int = 200) -> JSONResponse:
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})


def _read_authorized(header: str) -> bool:
    if TRUST_LOOPBACK_PROXY:
        return True
    if not READ_USERNAME and ENVIRONMENT in {"development", "test"}:
        return True
    if not READ_USERNAME or not header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(header[6:], validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return False
    username, separator, password = decoded.partition(":")
    return bool(separator) and hmac.compare_digest(
        username.encode(), READ_USERNAME.encode()
    ) and hmac.compare_digest(password.encode(), READ_PASSWORD.encode())


def _read_auth_error(request: Request) -> JSONResponse | None:
    if _read_authorized(request.headers.get("Authorization", "")):
        return None
    return JSONResponse(
        {"error": "unauthorized"},
        status_code=401,
        headers={
            "Cache-Control": "no-store",
            "WWW-Authenticate": 'Basic realm="Narra analytics", charset="UTF-8"',
        },
    )


def _percent(numerator: float, denominator: float) -> float:
    return round(numerator * 100 / denominator, 1) if denominator else 0.0


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(percentile * len(ordered)) - 1))
    return round(ordered[index], 1)


def _parse_ts(raw: Any) -> float:
    if isinstance(raw, (int, float)) and math.isfinite(float(raw)):
        value = float(raw)
        return value / 1000 if value > 10_000_000_000 else value
    if isinstance(raw, str) and len(raw) <= 40:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    raise ValueError("invalid ts")


def _safe_properties(event_name: str, raw: Any) -> dict[str, Any]:
    allowed = EVENT_PROPERTIES[event_name]
    if not isinstance(raw, dict) or any(key not in SAFE_PROPERTIES or key not in allowed for key in raw):
        raise ValueError("invalid properties")
    result: dict[str, Any] = {}
    for key, value in raw.items():
        if value is None:
            continue
        if key in NUMERIC_PROPERTIES:
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
                raise ValueError(f"invalid numeric property: {key}")
            numeric = float(value)
            # Keep this transport bound identical to server/events.mjs so one
            # accepted event cannot poison a durable downstream batch.
            maximum = 1_000_000_000
            if numeric < 0 or numeric > maximum:
                raise ValueError(f"out-of-range property: {key}")
            if key == "sample_rate" and value not in {24000, 48000}:
                raise ValueError("invalid sample_rate")
            result[key] = value
            continue
        if not isinstance(value, (str, bool)):
            raise ValueError(f"invalid property: {key}")
        if isinstance(value, str) and (len(value) > 120 or "\n" in value):
            raise ValueError(f"oversized property: {key}")
        if key in PROPERTY_ENUMS and value not in PROPERTY_ENUMS[key]:
            raise ValueError(f"invalid enum property: {key}")
        if key == "request_id" and not UUID_RE.fullmatch(value):
            raise ValueError("invalid request_id")
        if key in {"route", "provider", "model", "error_code", "safe_error_code", "version", "app_version"} and not re.fullmatch(r"[A-Za-z0-9_./:+-]{1,80}", value):
            raise ValueError(f"invalid identifier property: {key}")
        result[key] = value
    return result


def _rate_allowed(key: str, now: float) -> bool:
    with RATE_LOCK:
        bucket = RATE[key]
        while bucket and bucket[0] <= now - 60:
            bucket.popleft()
        if len(bucket) >= INGEST_RATE_PER_MINUTE:
            return False
        bucket.append(now)
        return True


def _rows() -> list[dict[str, Any]]:
    with DB_LOCK:
        rows = _db.execute(
            "SELECT event_id,ts,device_id,session_id,name,properties,ingested_at "
            "FROM events ORDER BY ts,event_id"
        ).fetchall()
    result = []
    for event_id, ts, device_id, session_id, name, properties, ingested_at in rows:
        try:
            props = json.loads(properties)
        except (TypeError, ValueError):
            props = {}
        result.append({
            "event_id": event_id, "ts": float(ts), "device_id": device_id,
            "session_id": session_id, "name": name, "properties": props,
            "ingested_at": float(ingested_at),
        })
    return result


def _reporting_date(timestamp: float):
    return datetime.fromtimestamp(timestamp, REPORTING_TZ).date()


def _period_starts(now: float, days: float) -> tuple[float, dict[str, float]]:
    selected_days = max(1, min(int(math.ceil(float(days))), 365))
    current = datetime.fromtimestamp(now, REPORTING_TZ)
    day_start = current.replace(hour=0, minute=0, second=0, microsecond=0)
    return float(selected_days), {
        "selected": (day_start - timedelta(days=selected_days - 1)).timestamp(),
        "dau": day_start.timestamp(),
        "wau": (day_start - timedelta(days=day_start.weekday())).timestamp(),
        "mau": day_start.replace(day=1).timestamp(),
    }


def _active_ids(
    rows: list[dict[str, Any]], cutoff: float, until: float
) -> set[str]:
    return {
        row["device_id"]
        for row in rows
        if cutoff <= row["ts"] <= until and _is_active_event(row)
    }


def _is_background_ai(row: dict[str, Any]) -> bool:
    return (
        row["name"].startswith("ai_request_")
        and row["properties"].get("origin") == "background"
    )


def _is_active_event(row: dict[str, Any]) -> bool:
    return row["name"] in ACTIVE_EVENTS and not _is_background_ai(row)


def _is_session_event(row: dict[str, Any]) -> bool:
    return row["name"] in SESSION_EVENTS and not _is_background_ai(row)


def _active_user_days(rows: list[dict[str, Any]]) -> int:
    return len({
        (row["device_id"], _reporting_date(row["ts"]))
        for row in rows if _is_active_event(row)
    })


def _sessions(rows: list[dict[str, Any]]) -> int:
    explicit = {
        (row["device_id"], row["session_id"])
        for row in rows if _is_session_event(row) and row["session_id"]
    }
    missing: dict[str, list[float]] = defaultdict(list)
    explicit_times: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        if _is_session_event(row):
            if row["session_id"]:
                explicit_times[row["device_id"]].append(row["ts"])
            else:
                missing[row["device_id"]].append(row["ts"])
    inferred = 0
    for actor, timestamps in missing.items():
        previous = None
        for timestamp in sorted(timestamps):
            if any(abs(timestamp - known) <= 1800 for known in explicit_times[actor]):
                continue
            if previous is None or timestamp - previous > 1800:
                inferred += 1
            previous = timestamp
    return len(explicit) + inferred


def _retention(rows: list[dict[str, Any]], now: float) -> dict[str, Any]:
    qualified_days: dict[str, set] = defaultdict(set)
    active_days: dict[str, set] = defaultdict(set)
    for row in rows:
        if _is_active_event(row):
            active_days[row["device_id"]].add(_reporting_date(row["ts"]))
        if row["name"] == "reading_session_qualified":
            qualified_days[row["device_id"]].add(_reporting_date(row["ts"]))
    today = _reporting_date(now)
    result = {}
    for horizon in (1, 7, 30):
        eligible = returned = 0
        for actor, cohort_days in qualified_days.items():
            cohort = min(cohort_days)
            if (today - cohort).days < horizon:
                continue
            eligible += 1
            if any((day - cohort).days >= horizon for day in active_days[actor]):
                returned += 1
        result[f"d{horizon}"] = {
            "rate": _percent(returned, eligible) if eligible else None,
            "eligible": eligible,
            "returned": returned,
        }
    return result


def compute_dashboard(days: float = 1.0) -> dict[str, Any]:
    now = time.time()
    window_days, period_starts = _period_starts(now, days)
    since = period_starts["selected"]
    rows = _rows()
    selected = [row for row in rows if since <= row["ts"] <= now]
    active = [row for row in selected if _is_active_event(row)]
    actors = {row["device_id"] for row in active}
    active_user_days = _active_user_days(selected)
    sessions = _sessions(selected)
    request_rows = [row for row in selected if row["name"] == "ai_request_started"]
    request_started_at: dict[tuple[str, str], float] = {}
    for row in request_rows:
        request_id = row["properties"].get("request_id")
        if not request_id:
            continue
        key = (row["device_id"], str(request_id))
        request_started_at[key] = min(request_started_at.get(key, row["ts"]), row["ts"])
    request_ids = set(request_started_at)
    all_started_ids = {
        (row["device_id"], str(row["properties"].get("request_id")))
        for row in rows
        if row["name"] == "ai_request_started"
        and row["properties"].get("request_id")
    }
    raw_completed_ids = {
        (row["device_id"], str(row["properties"].get("request_id")))
        for row in selected if row["name"] == "ai_request_completed" and row["properties"].get("request_id")
    }
    raw_failed_ids = {
        (row["device_id"], str(row["properties"].get("request_id")))
        for row in selected if row["name"] == "ai_request_failed" and row["properties"].get("request_id")
    }
    completed_ids = raw_completed_ids & request_ids
    failed_ids = raw_failed_ids & request_ids
    failed_only_ids = failed_ids - completed_ids
    resolved_ids = completed_ids | failed_ids
    aged_request_ids = {
        key for key, started_at in request_started_at.items()
        if started_at <= now - AI_OUTCOME_GRACE_SECONDS
    }
    outcome_eligible_ids = resolved_ids | aged_request_ids
    pending_ids = request_ids - resolved_ids
    pending_overdue_ids = pending_ids & aged_request_ids
    orphan_terminal_ids = (raw_completed_ids | raw_failed_ids) - all_started_ids
    attempts = [
        row for row in selected
        if row["name"] in {
            "provider_attempt_completed",
            "provider_attempt_failed",
            "provider_attempt_not_configured",
        }
    ]
    matched_attempts = [
        row for row in attempts
        if (
            row["device_id"],
            str(row["properties"].get("request_id")),
        ) in request_ids
    ]
    completed_requests = [
        row for row in selected
        if row["name"] == "ai_request_completed"
        and (
            row["device_id"],
            str(row["properties"].get("request_id")),
        ) in completed_ids
    ]
    request_latencies = [
        float(row["properties"]["latency_ms"])
        for row in completed_requests
        if isinstance(row["properties"].get("latency_ms"), (int, float))
    ]
    exact_cost_rows = [
        row for row in completed_requests
        if isinstance(row["properties"].get("exact_cost"), (int, float))
        and row["properties"].get("cost_currency") == COST_CURRENCY
        and row["properties"].get("cost_source") in PROPERTY_ENUMS["cost_source"]
    ]
    invalid_cost_rows = [
        row for row in completed_requests
        if isinstance(row["properties"].get("exact_cost"), (int, float))
        and row not in exact_cost_rows
    ]
    exact_costs = [
        float(row["properties"]["exact_cost"]) for row in exact_cost_rows
    ]
    cost_sources = Counter(
        str(row["properties"]["cost_source"]) for row in exact_cost_rows
    )
    token_rows = [
        row for row in completed_requests
        if isinstance(row["properties"].get("input_tokens"), (int, float))
        and isinstance(row["properties"].get("output_tokens"), (int, float))
    ]
    input_tokens = sum(float(row["properties"]["input_tokens"]) for row in token_rows)
    output_tokens = sum(float(row["properties"]["output_tokens"]) for row in token_rows)
    # Input + output is comparable across providers. A conflicting upstream
    # total must not make the aggregate internally inconsistent.
    total_tokens = input_tokens + output_tokens
    terminal_attempt_errors = sum(
        row["name"] in {"provider_attempt_failed", "provider_attempt_not_configured"}
        for row in attempts
    )
    fallback_request_ids = {
        (row["device_id"], str(row["properties"].get("request_id")))
        for row in attempts
        if row["properties"].get("request_id")
        and isinstance(row["properties"].get("retry_index"), (int, float))
        and row["properties"]["retry_index"] > 0
    } & request_ids
    provider_totals: dict[str, Counter] = defaultdict(Counter)
    model_totals: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for row in attempts:
        provider = str(row["properties"].get("provider") or "unreported")
        model = str(row["properties"].get("model") or "unreported")
        provider_totals[provider]["attempts"] += 1
        model_totals[(provider, model)]["attempts"] += 1
        if row["name"] == "provider_attempt_completed":
            provider_totals[provider]["completed"] += 1
            model_totals[(provider, model)]["completed"] += 1
    feedback = [row["properties"].get("rating") for row in selected if row["name"] == "answer_feedback_submitted"]
    helpful = sum(value == "helpful" for value in feedback)
    reading_seconds = sum(
        float(row["properties"].get("duration_seconds", 0))
        for row in selected
        if row["name"] == "reading_session_ended"
        and isinstance(row["properties"].get("duration_seconds"), (int, float))
    )
    feature_users: dict[str, set[str]] = defaultdict(set)
    for row in active:
        feature = FEATURE_BY_EVENT.get(row["name"]) or row["properties"].get("feature")
        if feature:
            feature_users[str(feature)].add(row["device_id"])

    data_start = min((row["ts"] for row in rows), default=None)
    available_start = max(since, data_start) if data_start is not None else None
    requested_days = max(1, math.ceil(window_days))
    available_days = 0 if available_start is None else min(
        requested_days,
        (_reporting_date(now) - _reporting_date(available_start)).days + 1,
    )
    session_eligible = [row for row in active if _is_session_event(row)]
    request_eligible = [row for row in selected if row["name"].startswith("ai_request_")]
    warnings = []
    session_coverage = _percent(sum(bool(row["session_id"]) for row in session_eligible), len(session_eligible))
    request_coverage = _percent(
        sum(bool(row["properties"].get("request_id")) for row in request_eligible),
        len(request_eligible),
    )
    if 0 < available_days < requested_days:
        warnings.append(f"Requested {requested_days} days; source contains {available_days}. Pre-collection zeros are excluded.")
    if session_eligible and session_coverage < 95:
        warnings.append("Session ID coverage is below 95%; Sessions / DAU includes 30-minute fallback inference.")
    if request_eligible and request_coverage < 95:
        warnings.append("Request ID coverage is below 95%; request-level AI reliability is provisional.")
    outcome_coverage = (
        _percent(len(resolved_ids & outcome_eligible_ids), len(outcome_eligible_ids))
        if outcome_eligible_ids else None
    )
    if outcome_eligible_ids and outcome_coverage < 95:
        warnings.append(
            f"AI outcome coverage is {outcome_coverage}% after the "
            f"{AI_OUTCOME_GRACE_SECONDS}-second grace window; overdue pending requests count as unsuccessful."
        )
    if orphan_terminal_ids:
        warnings.append(
            f"{len(orphan_terminal_ids)} terminal AI request IDs have no matching start and are excluded."
        )
    if data_start is None:
        warnings.append("No production events have been collected yet; every metric is unavailable.")
    elif now - max(row["ingested_at"] for row in rows) > 3600:
        warnings.append("No event has been ingested for more than one hour; delivery may be stale.")
    cost_coverage = _percent(len(exact_costs), len(completed_requests)) if completed_requests else None
    if completed_requests and cost_coverage < 100:
        warnings.append(f"Provider cost is known for {cost_coverage}% of completed requests; cost is not a total.")
    if invalid_cost_rows:
        warnings.append(
            f"{len(invalid_cost_rows)} completed requests reported cost without an accepted source/currency and are excluded."
        )
    token_coverage = _percent(len(token_rows), len(completed_requests)) if completed_requests else None
    if completed_requests and token_coverage < 100:
        warnings.append(f"Input/output tokens are available for {token_coverage}% of completed requests.")

    ever_ids = {row["device_id"] for row in rows if row["name"] in EVER_USED_EVENTS}
    calendar_day = [
        row for row in rows if period_starts["dau"] <= row["ts"] <= now
    ]
    dau_ids = {
        row["device_id"] for row in calendar_day if _is_active_event(row)
    }
    canonical_requests = {
        (row["device_id"], str(row["properties"].get("request_id")))
        for row in calendar_day
        if row["name"] == "ai_request_started"
        and not _is_background_ai(row)
        and row["properties"].get("request_id")
    }
    overview = {
        "ever_used": len(ever_ids),
        "dau": len(dau_ids),
        "wau": len(_active_ids(rows, period_starts["wau"], now)),
        "mau": len(_active_ids(rows, period_starts["mau"], now)),
    }
    if dau_ids:
        overview["sessions_per_dau"] = round(_sessions(calendar_day) / len(dau_ids), 2)
        overview["tools_per_dau"] = round(len(canonical_requests) / len(dau_ids), 2)

    product_actions = sum(
        row["name"] in PRODUCT_ACTION_EVENTS and not _is_background_ai(row)
        for row in selected
    )
    value_actions = sum(
        row["name"] in VALUE_ACTION_EVENTS and not _is_background_ai(row)
        for row in selected
    )
    feature_breadth = len({
        (
            row["device_id"],
            _reporting_date(row["ts"]),
            FEATURE_BY_EVENT.get(row["name"]) or row["properties"].get("feature"),
        )
        for row in active
        if FEATURE_BY_EVENT.get(row["name"]) or row["properties"].get("feature")
    })

    def per_user_day(value: int) -> float | None:
        return round(value / active_user_days, 2) if active_user_days else None

    def tool_definition(
        identifier: str,
        label: str,
        numerator: int,
        numerator_label: str,
        help_text: str,
        *,
        selected_for_overview: bool = False,
        denominator: int | None = None,
        denominator_label: str = "active user-days",
        status: str | None = None,
    ) -> dict[str, Any]:
        actual_denominator = active_user_days if denominator is None else denominator
        actual_status = status or ("no_active_users" if actual_denominator == 0 else "ok")
        return {
            "id": identifier,
            "label": label,
            "value": round(numerator / actual_denominator, 2) if actual_denominator else None,
            "numerator": numerator,
            "numerator_label": numerator_label,
            "denominator": actual_denominator,
            "denominator_label": denominator_label,
            "status": actual_status,
            "selected_for_overview": selected_for_overview,
            "help": help_text,
        }

    calendar_day_attempts = [
        row for row in rows
        if period_starts["dau"] <= row["ts"] <= now
        and row["name"] in {
            "provider_attempt_completed",
            "provider_attempt_failed",
            "provider_attempt_not_configured",
        }
    ]
    tool_definitions = [
        tool_definition(
            "logical_ai_requests_calendar_day_dau",
            "Logical AI requests / DAU",
            len(canonical_requests),
            "logical requests since 00:00 MSK",
            "The canonical Overview formula. Retry and provider fallback share one request_id and count once.",
            selected_for_overview=True,
            denominator=len(dau_ids),
            denominator_label="DAU of the same Moscow date",
        ),
        tool_definition(
            "provider_attempts_calendar_day_dau",
            "Provider attempts / DAU",
            len(calendar_day_attempts),
            "provider attempts since 00:00 MSK",
            "Technical load, including retry and fallback. Useful for reliability and cost, not as the product KPI.",
            denominator=len(dau_ids),
            denominator_label="DAU of the same Moscow date",
        ),
        tool_definition(
            "logical_ai_requests_user_day",
            "Logical AI requests / user-day",
            len(request_ids),
            "logical AI requests",
            "Selected-window AI usage normalized by active user-days, so repeated active days remain visible.",
        ),
        tool_definition(
            "product_actions_user_day",
            "Product actions / user-day",
            product_actions,
            "explicit product actions",
            "Reading, importing, navigation, notes, bookmarks, character/chat and feedback actions; technical provider attempts are excluded.",
        ),
        tool_definition(
            "feature_breadth_user_day",
            "Distinct features / user-day",
            feature_breadth,
            "distinct actor-day-feature uses",
            "Breadth of use: repeating the same feature on the same active day does not increase the numerator.",
        ),
        tool_definition(
            "value_actions_user_day",
            "Completed value proxies / user-day",
            value_actions,
            "completed value proxies",
            "Completed import, qualified reading, chapter completion, saved note/bookmark or delivered AI answer. This is a proxy, not direct user-rated value.",
        ),
    ]

    series = []
    daily_active_counts: list[int] = []
    if available_start is not None:
        day = _reporting_date(available_start)
        last = _reporting_date(now)
        while day <= last:
            lo = datetime.combine(day, datetime.min.time(), REPORTING_TZ).timestamp()
            hi = datetime.combine(
                day + timedelta(days=1), datetime.min.time(), REPORTING_TZ
            ).timestamp()
            chunk = [row for row in rows if lo <= row["ts"] < hi]
            daily_active = len({row["device_id"] for row in chunk if _is_active_event(row)})
            daily_active_counts.append(daily_active)
            series.append({
                "label": day.strftime("%d.%m"),
                "active": daily_active,
                "sessions": _sessions(chunk),
                "tools": len({
                    (row["device_id"], row["properties"].get("request_id"))
                    for row in chunk
                    if row["name"] == "ai_request_started"
                    and not _is_background_ai(row)
                    and row["properties"].get("request_id")
                }),
            })
            day += timedelta(days=1)

    classified_active = sum(
        bool(FEATURE_BY_EVENT.get(row["name"]) or row["properties"].get("feature"))
        for row in active
    )
    ingest_lags = [max(0.0, row["ingested_at"] - row["ts"]) for row in selected]
    latest_event_ts = max((row["ts"] for row in rows), default=None)
    explicit_errors = len(failed_only_ids) + sum(row["name"] == "book_import_failed" for row in selected)
    diagnostics = [
        {
            "label": "Average DAU",
            "value": round(sum(daily_active_counts) / len(daily_active_counts), 2)
            if daily_active_counts else None,
            "unit": "actors",
            "note": f"{len(daily_active_counts)} available calendar days",
            "help": "Average daily active actors only across days after collection started; pre-collection days are never inserted as zeros.",
        },
        {
            "label": "Sessions / user-day", "value": per_user_day(sessions), "unit": "ratio",
            "note": f"{sessions} sessions / {active_user_days} active user-days",
            "help": "Selected-window usage depth. Unlike Overview, the denominator keeps each actor's separate active days.",
        },
        {
            "label": "Events / user-day", "value": per_user_day(len(active)), "unit": "ratio",
            "note": f"{len(active)} active events",
            "help": "All product-active events per active user-day. A jump can mean engagement or duplicate instrumentation.",
        },
        {
            "label": "AI requests / user-day", "value": per_user_day(len(request_ids)), "unit": "ratio",
            "note": f"{len(request_ids)} logical requests",
            "help": "Logical requests after retry and fallback are deduplicated by request_id.",
        },
        {
            "label": "Value proxies / user-day", "value": per_user_day(value_actions), "unit": "ratio",
            "note": f"{value_actions} completed outcomes",
            "help": "Completed reading, creation or AI outcomes. It is intentionally separate from raw clicks and technical calls.",
        },
        {
            "label": "Feature classification", "value": _percent(classified_active, len(active)) if active else None,
            "unit": "%", "note": f"{classified_active} of {len(active)} active events",
            "help": "Share of active events assigned to a product area. Low coverage reveals missing or ambiguous instrumentation.",
        },
        {
            "label": "Event freshness", "value": max(0.0, now - latest_event_ts) if latest_event_ts else None,
            "unit": "seconds", "note": "time since the newest event",
            "help": "Large values while the product is in use indicate a delivery or gateway queue problem.",
        },
        {
            "label": "Ingest lag p50 / p95",
            "value": _percentile(ingest_lags, 0.50),
            "secondary": _percentile(ingest_lags, 0.95),
            "unit": "seconds_pair", "note": f"{len(ingest_lags)} ingested events",
            "help": "Time between occurrence and Traction ingestion. p95 surfaces queueing and retry delays.",
        },
        {
            "label": "Errors / 100 user-days",
            "value": round(explicit_errors * 100 / active_user_days, 2) if active_user_days else None,
            "unit": "ratio", "note": f"{explicit_errors} explicit request/import errors",
            "help": "Final user-visible AI/import failures. Individual provider-attempt failures remain in the AI block.",
        },
        {
            "label": "Request ID coverage", "value": request_coverage, "unit": "%",
            "note": f"{sum(bool(row['properties'].get('request_id')) for row in request_eligible)} of {len(request_eligible)} AI request events",
            "help": "Below 95%, request reliability and retry/fallback deduplication should be treated as provisional.",
        },
    ]

    import_started = {row["device_id"] for row in selected if row["name"] == "book_import_started"}
    import_completed = {row["device_id"] for row in selected if row["name"] == "book_import_completed"}
    qualified = {row["device_id"] for row in selected if row["name"] == "reading_session_qualified"}
    opened = {row["device_id"] for row in selected if row["name"] == "book_opened"}
    def update_keys(name: str, successful: bool = False) -> set[tuple[str, str]]:
        return {
            (row["device_id"], str(row["properties"].get("version")))
            for row in selected
            if row["name"] == name and row["properties"].get("version")
            and (not successful or row["properties"].get("success") is True)
        }
    update_offered = update_keys("update_offered")
    update_downloaded = update_keys("update_downloaded")
    update_verified = update_keys("update_verified", successful=True)
    update_installed = update_keys("update_installed")
    return {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_days": window_days,
        "installs": len({row["device_id"] for row in rows}),
        "dau": len(actors),
        "events": len(selected),
        "errors": len(failed_only_ids) + sum(row["name"] == "book_import_failed" for row in selected),
        "overview": overview,
        "metrics": [
            {"label": label, "value": str(overview[key])}
            for label, key in (
                ("Ever used", "ever_used"), ("DAU", "dau"), ("WAU", "wau"), ("MAU", "mau"),
                ("Sessions / DAU", "sessions_per_dau"), ("Tools / DAU", "tools_per_dau"),
            ) if key in overview
        ],
        "primary": [
            {"label": label, "value": overview[key], "note": note}
            for label, key, note in (
                ("Ever used", "ever_used", "opened a book at least once"),
                ("DAU", "dau", "active today in Moscow time"),
                ("WAU", "wau", "active in the current Moscow ISO week"),
                ("MAU", "mau", "active in the current Moscow month"),
                ("Sessions / DAU", "sessions_per_dau", "today MSK / DAU today"),
                ("Tools / DAU", "tools_per_dau", "AI requests today MSK, retries excluded"),
            ) if key in overview
        ],
        "tool_definitions": tool_definitions,
        "diagnostics": diagnostics,
        "funnels": [
            {"label": "Import completed", "unit": "actors", "started": len(import_started), "completed": len(import_completed & import_started), "rate": _percent(len(import_completed & import_started), len(import_started)) if import_started else None},
            {"label": "Qualified reading", "unit": "actors", "started": len(opened), "completed": len(qualified & opened), "rate": _percent(len(qualified & opened), len(opened)) if opened else None},
            {"label": "Update downloaded", "unit": "actor/version pairs", "started": len(update_offered), "completed": len(update_downloaded & update_offered), "rate": _percent(len(update_downloaded & update_offered), len(update_offered)) if update_offered else None},
            {"label": "Update verified", "unit": "actor/version pairs", "started": len(update_downloaded), "completed": len(update_verified & update_downloaded), "rate": _percent(len(update_verified & update_downloaded), len(update_downloaded)) if update_downloaded else None},
            {"label": "Update installed", "unit": "actor/version pairs", "started": len(update_verified), "completed": len(update_installed & update_verified), "rate": _percent(len(update_installed & update_verified), len(update_verified)) if update_verified else None},
        ],
        "features": [
            {"name": name, "users": len(users), "adoption": _percent(len(users), len(actors)) if actors else 0.0}
            for name, users in sorted(feature_users.items(), key=lambda item: (-len(item[1]), item[0]))
        ],
        "ai": {
            "requests": len(request_ids),
            "completed": len(completed_ids),
            "failed": len(failed_only_ids),
            "pending": len(pending_ids),
            "pending_overdue": len(pending_overdue_ids),
            "outcome_eligible": len(outcome_eligible_ids),
            "outcome_coverage": outcome_coverage,
            "outcome_grace_seconds": AI_OUTCOME_GRACE_SECONDS,
            "orphan_terminal_ids": len(orphan_terminal_ids),
            "success_rate": (
                _percent(len(completed_ids & outcome_eligible_ids), len(outcome_eligible_ids))
                if outcome_eligible_ids else None
            ),
            "attempts": len(attempts),
            "matched_attempts": len(matched_attempts),
            "unmatched_attempts": len(attempts) - len(matched_attempts),
            "attempt_errors": terminal_attempt_errors,
            "attempt_error_rate": _percent(terminal_attempt_errors, len(attempts)) if attempts else None,
            "attempts_per_request": (
                round(len(matched_attempts) / len(request_ids), 2)
                if request_ids else None
            ),
            "fallback_requests": len(fallback_request_ids),
            "fallback_rate": _percent(len(fallback_request_ids), len(request_ids)) if request_ids else None,
            "latency_p50_ms": _percentile(request_latencies, 0.50),
            "latency_p95_ms": _percentile(request_latencies, 0.95),
            "input_tokens": int(input_tokens),
            "output_tokens": int(output_tokens),
            "total_tokens": int(total_tokens),
            "token_coverage": token_coverage,
            "known_cost": round(sum(exact_costs), 6) if exact_costs else None,
            "cost_currency": COST_CURRENCY,
            "cost_known_requests": len(exact_costs),
            "cost_eligible_requests": len(completed_requests),
            "cost_coverage": _percent(len(exact_costs), len(completed_requests)) if completed_requests else None,
            "cost_sources": dict(sorted(cost_sources.items())),
            "helpful_rate": _percent(helpful, len(feedback)) if feedback else None,
            "feedback_count": len(feedback),
            "providers": [
                {
                    "name": name,
                    "attempts": counts["attempts"],
                    "completed": counts["completed"],
                    "success_rate": _percent(counts["completed"], counts["attempts"]),
                }
                for name, counts in sorted(provider_totals.items(), key=lambda item: (-item[1]["attempts"], item[0]))
            ],
            "models": [
                {
                    "name": f"{provider}:{model}",
                    "attempts": counts["attempts"],
                    "completed": counts["completed"],
                    "success_rate": _percent(counts["completed"], counts["attempts"]),
                }
                for (provider, model), counts in sorted(
                    model_totals.items(),
                    key=lambda item: (-item[1]["attempts"], item[0]),
                )
            ],
        },
        "engagement": {"reading_minutes": round(reading_seconds / 60, 1), "sessions": sessions},
        "retention": _retention(rows, now),
        "series": series,
        "quality": {
            "data_start": datetime.fromtimestamp(data_start, timezone.utc).isoformat(timespec="seconds") if data_start else None,
            "requested_days": requested_days, "available_days": available_days,
            "session_id_coverage": session_coverage, "request_id_coverage": request_coverage,
            "outcome_coverage": outcome_coverage,
            "token_coverage": token_coverage, "cost_coverage": cost_coverage,
            "warnings": warnings,
        },
        "monitoring": monitor_report(
            _db,
            DB_LOCK,
            MONITOR_TARGETS,
            now=now,
            stale_after_seconds=MONITOR_STALE_AFTER_SECONDS,
            interval_seconds=MONITOR_INTERVAL_SECONDS,
        ),
    }


@app.get("/health")
def health() -> JSONResponse:
    with DB_LOCK:
        _db.execute("SELECT 1").fetchone()
    ingest_ready = bool(INGEST_TOKEN) or ALLOW_OPEN
    reads_ready = (
        TRUST_LOOPBACK_PROXY
        or bool(READ_USERNAME and READ_PASSWORD)
        or ENVIRONMENT in {"development", "test"}
    )
    ready = ingest_ready and reads_ready
    monitoring = monitor_report(
        _db,
        DB_LOCK,
        MONITOR_TARGETS,
        stale_after_seconds=MONITOR_STALE_AFTER_SECONDS,
        interval_seconds=MONITOR_INTERVAL_SECONDS,
    )
    return _response(
        {
            "ok": ready,
            "version": VERSION,
            "ingest_configured": ingest_ready,
            "read_auth_configured": reads_ready,
            "environment": ENVIRONMENT,
            "monitoring_enabled": MONITOR_ENABLED,
            "monitoring_state": monitoring["overall"],
            "monitoring_fresh": monitoring["fresh"],
            "monitoring_oldest_sample_age_seconds": monitoring["oldest_sample_age_seconds"],
        },
        200 if ready else 503,
    )


@app.post("/events")
async def ingest(request: Request) -> JSONResponse:
    now = time.time()
    expected = INGEST_TOKEN.encode()
    provided = request.headers.get("X-Ingest-Token", "").encode()
    if not ALLOW_OPEN and (not expected or not hmac.compare_digest(provided, expected)):
        return _response({"error": "unauthorized"}, 401)
    supplied_environment = request.headers.get("X-Analytics-Environment", "")
    if not CONTRACT_TEST_MODE and supplied_environment != ENVIRONMENT:
        return _response({"error": "analytics environment mismatch"}, 409)
    key = hashlib.sha256(provided or (request.client.host if request.client else "dev").encode()).hexdigest()
    if not _rate_allowed(key, now):
        return _response({"error": "rate limit"}, 429)
    try:
        content_length = int(request.headers.get("content-length", "0") or 0)
    except ValueError:
        return _response({"error": "invalid content length"}, 400)
    if content_length > MAX_BODY:
        return _response({"error": "payload too large"}, 413)
    raw = await request.body()
    if len(raw) > MAX_BODY:
        return _response({"error": "payload too large"}, 413)
    try:
        payload = json.loads(raw)
        contract_fixture = CONTRACT_TEST_MODE and isinstance(payload, dict) and isinstance(payload.get("device_id"), str)
        if contract_fixture:
            fixture_events = []
            for fixture in payload.get("events", []):
                if not isinstance(fixture, dict) or fixture.get("name") not in {"app.launched", "error"}:
                    raise ValueError("invalid contract fixture")
                source_id = str(fixture.get("device_id") or payload["device_id"])
                fixture_events.append({
                    "event_id": str(__import__("uuid").uuid4()),
                    "ts": fixture.get("ts"),
                    "device_id": hashlib.sha256(("contract:" + source_id).encode()).hexdigest(),
                    "name": "book_opened" if fixture["name"] == "app.launched" else "book_import_failed",
                    "session_id": str(__import__("uuid").uuid4()),
                    "schema_version": 1,
                    "properties": ({"book_kind": "builtin"} if fixture["name"] == "app.launched" else {"error_code": "UNKNOWN"}),
                })
            payload = {"events": fixture_events}
        events = payload.get("events") if isinstance(payload, dict) else None
        if not isinstance(events, list) or not 1 <= len(events) <= MAX_BATCH:
            raise ValueError("invalid batch")
        records = []
        for item in events:
            if not isinstance(item, dict) or set(item) - {"event_id", "ts", "device_id", "name", "session_id", "schema_version", "properties"}:
                raise ValueError("invalid event")
            event_id = item.get("event_id")
            device_id = item.get("device_id")
            name = item.get("name")
            session_id = item.get("session_id")
            if not isinstance(event_id, str) or not UUID_RE.fullmatch(event_id):
                raise ValueError("invalid event_id")
            if not isinstance(device_id, str) or not ACTOR_RE.fullmatch(device_id):
                raise ValueError("invalid device_id")
            if name not in EVENT_NAMES:
                raise ValueError("invalid name")
            if session_id is not None and (not isinstance(session_id, str) or not UUID_RE.fullmatch(session_id)):
                raise ValueError("invalid session_id")
            ts = _parse_ts(item.get("ts"))
            # Gateway accepts clients only within 31 days, but a durable outbox
            # may deliver later after a prolonged Traction outage.
            if ts > now + 300 or ts < now - 366 * 86400:
                raise ValueError("timestamp outside accepted window")
            properties = _safe_properties(name, item.get("properties", {}))
            records.append((event_id, ts, device_id, session_id, name, json.dumps(properties, separators=(",", ":")), now))
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        return _response({"error": str(error)}, 400)
    with DB_LOCK:
        before = _db.total_changes
        _db.executemany(
            "INSERT OR IGNORE INTO events(event_id,ts,device_id,session_id,name,properties,ingested_at) VALUES(?,?,?,?,?,?,?)",
            records,
        )
        _db.commit()
        accepted = _db.total_changes - before
    if contract_fixture:
        return _response({"ingested": len(records)}, 200)
    return _response({"accepted": accepted, "duplicates": len(records) - accepted}, 202)


@app.get("/summary")
def summary(request: Request, days: float = 1.0) -> JSONResponse:
    if error := _read_auth_error(request):
        return error
    data = compute_dashboard(days)
    return _response({key: data[key] for key in ("updated_at", "window_days", "installs", "dau", "events", "errors", "overview", "metrics")})


@app.get("/dashboard")
def dashboard_data(request: Request, days: float = 1.0) -> JSONResponse:
    if error := _read_auth_error(request):
        return error
    return _response(compute_dashboard(days))


@app.get("/monitors")
def monitors(request: Request) -> JSONResponse:
    if error := _read_auth_error(request):
        return error
    return _response(
        monitor_report(
            _db,
            DB_LOCK,
            MONITOR_TARGETS,
            stale_after_seconds=MONITOR_STALE_AFTER_SECONDS,
            interval_seconds=MONITOR_INTERVAL_SECONDS,
        )
    )


@app.get("/")
def dashboard(request: Request) -> Response:
    if error := _read_auth_error(request):
        return error
    return FileResponse(HERE / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/logo.svg")
def logo() -> FileResponse:
    return FileResponse(HERE / "logo.svg")


if __name__ == "__main__":
    if MONITOR_ENABLED:
        MONITOR_RUNNER.start()
    try:
        uvicorn.run(app, host=HOST, port=PORT)
    finally:
        MONITOR_RUNNER.stop()
