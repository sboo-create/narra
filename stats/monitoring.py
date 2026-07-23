"""Fixed-target operational monitoring for the Narra Traction module.

Targets are server-owned configuration. No request parameter can select a URL,
which keeps the monitor from becoming an SSRF proxy. Probe bodies are bounded
and never persisted; SQLite stores only state, status, latency and coarse error
codes.
"""
from __future__ import annotations

import json
import http.client
import ipaddress
import math
import os
import socket
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from urllib.error import URLError
from urllib.parse import urlsplit


MAX_RESPONSE_BYTES = 64 * 1024
HEALTHY_STATES = {"up", "degraded", "standby"}
STATE_PRIORITY = {"unknown": 0, "up": 1, "standby": 2, "degraded": 3, "down": 4}
PROBE_WORKER_FLAG = "--probe-worker"


@dataclass(frozen=True)
class MonitorTarget:
    identifier: str
    label: str
    url: str
    classifier: str


def default_targets(env: Mapping[str, str] = os.environ) -> tuple[MonitorTarget, ...]:
    return (
        MonitorTarget(
            "production_gateway",
            "Production gateway",
            env.get("STATS_MONITOR_PRODUCTION_GATEWAY_URL", "https://narra.multitool.works/health"),
            "production_gateway",
        ),
        MonitorTarget(
            "staging_gateway",
            "Staging gateway readiness",
            env.get("STATS_MONITOR_STAGING_GATEWAY_URL", "https://narra-staging.multitool.works/ready"),
            "gateway_ready",
        ),
        MonitorTarget(
            "production_analytics",
            "Production analytics",
            env.get(
                "STATS_MONITOR_PRODUCTION_ANALYTICS_URL",
                "https://stats.multitool.works/p/narra/health",
            ),
            "health",
        ),
        MonitorTarget(
            "staging_analytics",
            "Staging analytics",
            env.get(
                "STATS_MONITOR_STAGING_ANALYTICS_URL",
                "https://stats-narra-staging-staging.up.railway.app/health",
            ),
            "health",
        ),
    )


def validate_targets(targets: tuple[MonitorTarget, ...]) -> None:
    identifiers: set[str] = set()
    for target in targets:
        parsed = urlsplit(target.url)
        if target.identifier in identifiers:
            raise RuntimeError(f"duplicate monitor target: {target.identifier}")
        identifiers.add(target.identifier)
        if not target.identifier.replace("_", "").isalnum():
            raise RuntimeError(f"invalid monitor target id: {target.identifier}")
        try:
            port = parsed.port
        except ValueError as error:
            raise RuntimeError(f"invalid monitor target URL: {target.identifier}") from error
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise RuntimeError(f"monitor target must be a credential-free HTTPS URL: {target.identifier}")
        if parsed.query or parsed.fragment or port not in {None, 443} or len(target.url) > 300:
            raise RuntimeError(f"invalid monitor target URL: {target.identifier}")
        hostname = parsed.hostname.rstrip(".").lower()
        if hostname == "localhost" or hostname.endswith(".localhost"):
            raise RuntimeError(f"monitor target must be public: {target.identifier}")
        try:
            address = ipaddress.ip_address(hostname)
        except ValueError:
            address = None
        if address and (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            raise RuntimeError(f"monitor target must be public: {target.identifier}")
        if target.classifier not in {"production_gateway", "gateway_ready", "health"}:
            raise RuntimeError(f"invalid monitor classifier: {target.identifier}")


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("monitor deadline exceeded")
    return remaining


def _public_addresses(hostname: str, port: int) -> tuple[str, ...]:
    addresses: list[str] = []
    for family, _kind, _protocol, _canonical, sockaddr in socket.getaddrinfo(
        hostname,
        port,
        type=socket.SOCK_STREAM,
    ):
        if family not in {socket.AF_INET, socket.AF_INET6}:
            continue
        address = str(sockaddr[0])
        parsed = ipaddress.ip_address(address)
        if (
            parsed.is_private
            or parsed.is_loopback
            or parsed.is_link_local
            or parsed.is_reserved
            or parsed.is_multicast
            or parsed.is_unspecified
        ):
            raise ValueError("monitor target resolved to a non-public address")
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise OSError("monitor target did not resolve")
    return tuple(addresses)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection pinned to a pre-validated public address.

    Certificate verification and SNI still use the original hostname.
    """

    def __init__(self, hostname: str, address: str, port: int, timeout: float):
        super().__init__(
            hostname,
            port,
            timeout=timeout,
            context=ssl.create_default_context(),
        )
        self._public_address = address

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._public_address, self.port),
            self.timeout,
            self.source_address,
        )
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


def _request(url: str, timeout: float) -> tuple[int, bytes]:
    parsed = urlsplit(url)
    if not parsed.hostname:
        raise ValueError("monitor target has no hostname")
    deadline = time.monotonic() + timeout
    port = parsed.port or 443
    addresses = _public_addresses(parsed.hostname, port)
    connection = _PinnedHTTPSConnection(
        parsed.hostname,
        addresses[0],
        port,
        _remaining(deadline),
    )
    try:
        connection.request(
            "GET",
            parsed.path or "/",
            headers={
                "User-Agent": "Narra-Traction-Monitor/1.0",
                "Accept": "application/json",
            },
        )
        response = connection.getresponse()
        body = bytearray()
        while len(body) <= MAX_RESPONSE_BYTES:
            if connection.sock is not None:
                connection.sock.settimeout(_remaining(deadline))
            chunk = response.read(min(8192, MAX_RESPONSE_BYTES + 1 - len(body)))
            if not chunk:
                break
            body.extend(chunk)
        return int(response.status), bytes(body)
    finally:
        connection.close()


def _tls_days_remaining(url: str, timeout: float) -> int | None:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        return None
    address = _public_addresses(parsed.hostname, parsed.port or 443)[0]
    context = ssl.create_default_context()
    with socket.create_connection((address, parsed.port or 443), timeout=timeout) as raw:
        with context.wrap_socket(raw, server_hostname=parsed.hostname) as wrapped:
            certificate = wrapped.getpeercert()
    not_after = certificate.get("notAfter")
    if not isinstance(not_after, str):
        return None
    return max(0, math.floor((ssl.cert_time_to_seconds(not_after) - time.time()) / 86400))


def classify_response(
    target: MonitorTarget,
    status: int,
    body: bytes,
) -> tuple[str, str | None]:
    if len(body) > MAX_RESPONSE_BYTES:
        return "down", "OVERSIZED_BODY"
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return "down", "INVALID_BODY"
    if not isinstance(payload, dict):
        return "down", "INVALID_BODY"

    if target.classifier == "production_gateway":
        if status == 200 and payload.get("ok") is True:
            return "up", None
        if status == 503 and payload == {
            "ok": False,
            "status": "not_ready",
            "service": "narra-production",
        }:
            return "standby", None
        return "down", f"HTTP_{status}"

    if status != 200 or payload.get("ok") is not True:
        return "down", f"HTTP_{status}"
    if target.classifier == "gateway_ready" and payload.get("degraded"):
        return "degraded", "UPSTREAM_DEGRADED"
    return "up", None


def probe_target(
    target: MonitorTarget,
    *,
    timeout: float = 5.0,
    request_fn: Callable[[str, float], tuple[int, bytes]] = _request,
    tls_fn: Callable[[str, float], int | None] = _tls_days_remaining,
    now: Callable[[], float] = time.time,
) -> dict[str, Any]:
    started = time.perf_counter()
    checked_at = now()
    try:
        deadline = time.perf_counter() + timeout
        status, body = request_fn(target.url, timeout)
        state, error_code = classify_response(target, status, body)
        tls_days = tls_fn(target.url, max(0.001, deadline - time.perf_counter()))
        if time.perf_counter() > deadline:
            raise TimeoutError("monitor deadline exceeded")
        if tls_days is not None and tls_days < 14 and state != "down":
            state, error_code = "degraded", "TLS_EXPIRING"
        return {
            "target_id": target.identifier,
            "checked_at": checked_at,
            "state": state,
            "http_status": status,
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
            "tls_days_remaining": tls_days,
            "error_code": error_code,
        }
    except (socket.timeout, TimeoutError):
        error_code = "TIMEOUT"
    except ssl.SSLError:
        error_code = "TLS"
    except URLError as error:
        error_code = (
            "TLS" if isinstance(error.reason, ssl.SSLError)
            else "TIMEOUT" if isinstance(error.reason, (socket.timeout, TimeoutError))
            else "NETWORK"
        )
    except (OSError, ValueError):
        error_code = "NETWORK"
    return {
        "target_id": target.identifier,
        "checked_at": checked_at,
        "state": "down",
        "http_status": None,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        "tls_days_remaining": None,
        "error_code": error_code,
    }


def probe_target_isolated(
    target: MonitorTarget,
    *,
    timeout: float = 5.0,
    command: list[str] | None = None,
) -> dict[str, Any]:
    """Run one network probe in a disposable process with an absolute timeout."""
    started = time.perf_counter()
    checked_at = time.time()
    worker = command or [sys.executable, str(os.path.abspath(__file__)), PROBE_WORKER_FLAG]
    payload = json.dumps({
        "identifier": target.identifier,
        "label": target.label,
        "url": target.url,
        "classifier": target.classifier,
        "timeout": max(0.1, timeout - 0.2),
    })
    try:
        completed = subprocess.run(
            worker,
            input=payload,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        if completed.returncode != 0 or len(completed.stdout) > 16_384:
            raise OSError("monitor worker failed")
        result = json.loads(completed.stdout)
        if not isinstance(result, dict) or result.get("target_id") != target.identifier:
            raise ValueError("invalid monitor worker result")
        return result
    except subprocess.TimeoutExpired:
        error_code = "TIMEOUT"
    except (OSError, ValueError, json.JSONDecodeError):
        error_code = "NETWORK"
    return {
        "target_id": target.identifier,
        "checked_at": checked_at,
        "state": "down",
        "http_status": None,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        "tls_days_remaining": None,
        "error_code": error_code,
    }


def ensure_schema(connection: sqlite3.Connection, lock: threading.RLock) -> None:
    with lock:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS monitor_samples("
            "target_id TEXT NOT NULL, checked_at REAL NOT NULL, state TEXT NOT NULL, "
            "http_status INTEGER, latency_ms REAL NOT NULL, tls_days_remaining INTEGER, "
            "error_code TEXT)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS ix_monitor_samples_target_time "
            "ON monitor_samples(target_id,checked_at)"
        )
        connection.commit()


def store_samples(
    connection: sqlite3.Connection,
    lock: threading.RLock,
    samples: list[dict[str, Any]],
    *,
    retention_days: int = 30,
) -> None:
    with lock, connection:
        connection.executemany(
            "INSERT INTO monitor_samples("
            "target_id,checked_at,state,http_status,latency_ms,tls_days_remaining,error_code"
            ") VALUES(?,?,?,?,?,?,?)",
            [
                (
                    sample["target_id"],
                    sample["checked_at"],
                    sample["state"],
                    sample["http_status"],
                    sample["latency_ms"],
                    sample["tls_days_remaining"],
                    sample["error_code"],
                )
                for sample in samples
            ],
        )
        connection.execute(
            "DELETE FROM monitor_samples WHERE checked_at < ?",
            (time.time() - retention_days * 86400,),
        )


def monitor_report(
    connection: sqlite3.Connection,
    lock: threading.RLock,
    targets: tuple[MonitorTarget, ...],
    *,
    now: float | None = None,
    stale_after_seconds: int = 180,
    interval_seconds: int = 60,
) -> dict[str, Any]:
    current_time = time.time() if now is None else now
    sample_interval = max(30, min(int(interval_seconds), 3600))
    with lock:
        rows = connection.execute(
            "SELECT target_id,checked_at,state,http_status,latency_ms,tls_days_remaining,error_code "
            "FROM monitor_samples WHERE checked_at >= ? AND checked_at <= ? "
            "ORDER BY target_id,checked_at",
            (current_time - 7 * 86400, current_time),
        ).fetchall()
        first_rows = connection.execute(
            "SELECT target_id,MIN(checked_at) FROM monitor_samples "
            "WHERE checked_at <= ? GROUP BY target_id",
            (current_time,),
        ).fetchall()
    first_sample_at = {str(row[0]): float(row[1]) for row in first_rows}
    by_target: dict[str, list[tuple[Any, ...]]] = {}
    for row in rows:
        by_target.setdefault(str(row[0]), []).append(row)

    result = []
    for target in targets:
        samples = by_target.get(target.identifier, [])
        latest = samples[-1] if samples else None
        windows: dict[str, Any] = {}
        for label, seconds in (("1h", 3600), ("24h", 86400), ("7d", 7 * 86400)):
            selected = [row for row in samples if float(row[1]) >= current_time - seconds]
            healthy = sum(str(row[2]) in HEALTHY_STATES for row in selected)
            latencies = [float(row[4]) for row in selected if str(row[2]) in HEALTHY_STATES]
            first_observed = first_sample_at.get(target.identifier)
            observation_start = (
                max(current_time - seconds, first_observed)
                if first_observed is not None
                else None
            )
            expected = (
                math.floor((current_time - observation_start) / sample_interval) + 1
                if observation_start is not None
                else 0
            )
            observed = min(len(selected), expected) if expected else 0
            windows[label] = {
                # A missed scheduled probe is unknown/unavailable, never an
                # implicit success after the monitor comes back.
                "availability": (
                    round(min(healthy, expected) * 100 / expected, 2)
                    if expected else None
                ),
                "coverage": (
                    round(observed * 100 / expected, 2)
                    if expected else None
                ),
                "samples": len(selected),
                "expected_samples": expected,
                "latency_p95_ms": _percentile(latencies, 0.95),
            }
        latest_state = str(latest[2]) if latest else "unknown"
        latest_error = latest[6] if latest else None
        latest_age = max(0.0, current_time - float(latest[1])) if latest else None
        if latest_age is not None and latest_age > stale_after_seconds:
            latest_state = "down"
            latest_error = "STALE"
        result.append({
            "id": target.identifier,
            "label": target.label,
            "url": target.url,
            "state": latest_state,
            "checked_at": (
                datetime.fromtimestamp(float(latest[1]), timezone.utc).isoformat(timespec="seconds")
                if latest else None
            ),
            "http_status": latest[3] if latest else None,
            "latency_ms": latest[4] if latest else None,
            "tls_days_remaining": latest[5] if latest else None,
            "error_code": latest_error,
            "sample_age_seconds": round(latest_age, 1) if latest_age is not None else None,
            "windows": windows,
        })
    overall = max((row["state"] for row in result), key=lambda state: STATE_PRIORITY[state], default="unknown")
    ages = [
        float(row["sample_age_seconds"])
        for row in result
        if row["sample_age_seconds"] is not None
    ]
    return {
        "updated_at": datetime.fromtimestamp(current_time, timezone.utc).isoformat(timespec="seconds"),
        "overall": overall,
        "fresh": (
            len(ages) == len(targets)
            and all(age <= stale_after_seconds for age in ages)
        ),
        "oldest_sample_age_seconds": max(ages) if ages else None,
        "targets": result,
    }


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(percentile * len(ordered)) - 1))
    return round(ordered[index], 1)


class MonitorRunner:
    def __init__(
        self,
        connection: sqlite3.Connection,
        lock: threading.RLock,
        targets: tuple[MonitorTarget, ...],
        *,
        interval_seconds: int = 60,
        timeout_seconds: float = 5.0,
        retention_days: int = 30,
    ):
        validate_targets(targets)
        self.connection = connection
        self.lock = lock
        self.targets = targets
        self.interval_seconds = max(30, min(int(interval_seconds), 3600))
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 15.0))
        self.retention_days = max(1, min(int(retention_days), 90))
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def run_once(self) -> None:
        # The targets are independent. A bounded pool keeps one slow domain from
        # stretching a nominal 60-second cycle by N × timeout.
        with ThreadPoolExecutor(
            max_workers=min(4, len(self.targets)),
            thread_name_prefix="narra-monitor-probe",
        ) as pool:
            samples = list(
                pool.map(
                    lambda target: probe_target_isolated(
                        target,
                        timeout=self.timeout_seconds,
                    ),
                    self.targets,
                )
            )
        store_samples(
            self.connection,
            self.lock,
            samples,
            retention_days=self.retention_days,
        )

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        ensure_schema(self.connection, self.lock)

        def loop() -> None:
            while not self.stop_event.is_set():
                started = time.monotonic()
                try:
                    self.run_once()
                except Exception as error:  # pragma: no cover - defensive service boundary
                    print(f"[monitor] cycle failed: {type(error).__name__}", flush=True)
                elapsed = time.monotonic() - started
                self.stop_event.wait(max(1.0, self.interval_seconds - elapsed))

        self.thread = threading.Thread(target=loop, name="narra-endpoint-monitor", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=self.timeout_seconds + 1)


def _run_probe_worker() -> int:
    try:
        payload = json.loads(sys.stdin.read(MAX_RESPONSE_BYTES))
        target = MonitorTarget(
            str(payload["identifier"]),
            str(payload["label"]),
            str(payload["url"]),
            str(payload["classifier"]),
        )
        validate_targets((target,))
        timeout = max(0.1, min(float(payload["timeout"]), 15.0))
        print(json.dumps(probe_target(target, timeout=timeout), separators=(",", ":")))
        return 0
    except Exception:
        return 1


if __name__ == "__main__" and sys.argv[1:] == [PROBE_WORKER_FLAG]:
    raise SystemExit(_run_probe_worker())
