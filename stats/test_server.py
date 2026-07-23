import base64
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

os.environ["STATS_DB"] = os.path.join(tempfile.mkdtemp(prefix="narra-stats-"), "events.db")
os.environ["STATS_ALLOW_UNAUTHENTICATED_INGEST"] = "1"
os.environ["STATS_ENVIRONMENT"] = "test"

import server  # noqa: E402
from starlette.requests import Request  # noqa: E402


ACTOR_A = "a" * 64
ACTOR_B = "b" * 64


def add(name, actor=ACTOR_A, session=None, properties=None, ts=None, event_id=None):
    with server.DB_LOCK:
        server._db.execute(
            "INSERT OR IGNORE INTO events(event_id,ts,device_id,session_id,name,properties,ingested_at) VALUES(?,?,?,?,?,?,?)",
            (
                event_id or str(uuid.uuid4()), ts or time.time(), actor, session, name,
                __import__("json").dumps(properties or {}), time.time(),
            ),
        )
        server._db.commit()


def request_for(path, authorization=None):
    headers = []
    if authorization:
        headers.append((b"authorization", authorization.encode()))
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
    })


class NarraStatsTest(unittest.TestCase):
    def setUp(self):
        with server.DB_LOCK:
            server._db.execute("DELETE FROM events")
            server._db.commit()

    def test_railway_config_pins_launcher_healthcheck_and_restart_policy(self):
        config = json.loads((Path(__file__).with_name("railway.json")).read_text())
        self.assertEqual(config["build"]["builder"], "RAILPACK")
        self.assertEqual(config["deploy"]["startCommand"], "python server.py")
        self.assertEqual(config["deploy"]["healthcheckPath"], "/health")
        self.assertEqual(config["deploy"]["healthcheckTimeout"], 30)
        self.assertEqual(config["deploy"]["restartPolicyType"], "ON_FAILURE")
        self.assertEqual(config["deploy"]["restartPolicyMaxRetries"], 10)
        readme = Path(__file__).with_name("README.md").read_text()
        self.assertIn("railway up stats --path-as-root", readme)
        self.assertIn("/stats/railway.json", readme)

    def test_i167_deploy_restarts_an_existing_service_after_code_update(self):
        deploy = Path(__file__).with_name("deploy.sh").read_text()
        create_index = deploy.index("sudo install -d -o root -g root -m 0755")
        rsync_index = deploy.index('rsync "${FLAGS[@]}"')
        self.assertLess(create_index, rsync_index)
        version_write_index = deploy.index("printf '%s\\n' \"$VERSION\"")
        version_mode_index = deploy.index('chmod 0644 "$TMP_VERSION"')
        version_rsync_index = deploy.index(
            'rsync -az --rsync-path="sudo rsync" "$TMP_VERSION"'
        )
        self.assertLess(version_write_index, version_mode_index)
        self.assertLess(version_mode_index, version_rsync_index)
        self.assertIn("systemctl enable stats-narra", deploy)
        self.assertIn("systemctl restart stats-narra", deploy)
        self.assertNotIn("systemctl enable --now stats-narra", deploy)

    def test_railway_port_takes_precedence_over_local_stats_port(self):
        with patch.dict(os.environ, {"PORT": "43123", "STATS_PORT": "9905"}):
            self.assertEqual(server._listen_port(), 43123)
        with patch.dict(os.environ, {"STATS_PORT": "9905"}, clear=True):
            self.assertEqual(server._listen_port(), 9905)

    def test_analytics_reads_require_valid_basic_auth_when_configured(self):
        encoded = base64.b64encode(b"narra-staging:correct-password").decode()
        wrong = base64.b64encode(b"narra-staging:wrong-password").decode()
        with patch.object(server, "READ_USERNAME", "narra-staging"), patch.object(
            server, "READ_PASSWORD", "correct-password"
        ):
            self.assertFalse(server._read_authorized(""))
            self.assertFalse(server._read_authorized("Bearer something"))
            self.assertFalse(server._read_authorized("Basic malformed"))
            self.assertFalse(server._read_authorized(f"Basic {wrong}"))
            self.assertTrue(server._read_authorized(f"Basic {encoded}"))

    def test_trusted_proxy_mode_is_explicit_and_loopback_only(self):
        with patch.object(server, "TRUST_LOOPBACK_PROXY", True):
            self.assertTrue(server._read_authorized(""))
        self.assertTrue(server._trusted_proxy_host_allowed("127.0.0.1"))
        self.assertTrue(server._trusted_proxy_host_allowed("::1"))
        self.assertFalse(server._trusted_proxy_host_allowed("0.0.0.0"))

    def test_read_routes_enforce_basic_auth_while_health_stays_public(self):
        encoded = base64.b64encode(b"narra-staging:correct-password").decode()
        with patch.object(server, "READ_USERNAME", "narra-staging"), patch.object(
            server, "READ_PASSWORD", "correct-password"
        ):
            self.assertEqual(server.dashboard(request_for("/")).status_code, 401)
            self.assertEqual(
                server.summary(request_for("/summary")).status_code, 401
            )
            self.assertEqual(
                server.dashboard_data(request_for("/dashboard")).status_code, 401
            )
            self.assertEqual(
                server.summary(
                    request_for("/summary", f"Basic {encoded}")
                ).status_code,
                200,
            )
            self.assertEqual(server.health().status_code, 200)

    def test_canonical_six_count_value_not_app_open_and_dedupe_requests(self):
        session_one = str(uuid.uuid4())
        session_two = str(uuid.uuid4())
        request_id = str(uuid.uuid4())
        add("app_opened", session=session_one, properties={"channel": "production"})
        add("book_opened", session=session_one, properties={"book_kind": "builtin"})
        add("chapter_changed", session=session_one, properties={"navigation_type": "reader", "chapter_position_bucket": "1-3"})
        add("book_opened", session=session_two, properties={"book_kind": "builtin"})
        add("ai_request_started", properties={"request_id": request_id, "purpose": "summary"})
        add("ai_request_started", properties={"request_id": request_id, "purpose": "summary"})
        add("provider_attempt_failed", properties={"request_id": request_id, "purpose": "summary", "provider": "giga", "model": "giga", "error_code": "RATE"})
        add("app_opened", actor=ACTOR_B, session=str(uuid.uuid4()), properties={"channel": "production"})
        data = server.compute_dashboard(1)
        self.assertEqual(data["installs"], 2)
        self.assertEqual(data["overview"]["ever_used"], 1)
        self.assertEqual(data["overview"]["dau"], 1)
        self.assertEqual(data["overview"]["sessions_per_dau"], 1.0)
        self.assertEqual(data["overview"]["tools_per_dau"], 1.0)
        self.assertEqual(data["ai"]["requests"], 1)
        self.assertEqual(data["ai"]["attempts"], 1)

    def test_ever_used_requires_book_open_and_ratios_omit_without_dau(self):
        empty = server.compute_dashboard(1)["overview"]
        self.assertNotIn("sessions_per_dau", empty)
        self.assertNotIn("tools_per_dau", empty)
        add("book_import_started", session=str(uuid.uuid4()), properties={"format": "epub", "source_class": "file"})
        imported = server.compute_dashboard(1)["overview"]
        self.assertEqual(imported["ever_used"], 0)
        add("book_opened", session=str(uuid.uuid4()), properties={"book_kind": "imported"})
        self.assertEqual(server.compute_dashboard(1)["overview"]["ever_used"], 1)

    def test_server_owned_ai_request_is_active_and_has_tools_denominator(self):
        add("ai_request_started", properties={"request_id": str(uuid.uuid4()), "purpose": "summary"})
        overview = server.compute_dashboard(1)["overview"]
        self.assertEqual(overview["dau"], 1)
        self.assertEqual(overview["ever_used"], 0)
        self.assertEqual(overview["tools_per_dau"], 1.0)

    def test_no_zero_fill_before_collection_start(self):
        add("book_opened", session=str(uuid.uuid4()), properties={"book_kind": "imported"})
        data = server.compute_dashboard(30)
        self.assertEqual(data["quality"]["available_days"], 1)
        self.assertEqual(len(data["series"]), 1)
        self.assertTrue(data["quality"]["warnings"])

    def test_canonical_ratios_use_today_msk_not_selected_dashboard_window(self):
        recent_session = str(uuid.uuid4())
        recent_request = str(uuid.uuid4())
        add("book_opened", session=recent_session, properties={"book_kind": "builtin"})
        add("reading_session_qualified", session=recent_session, properties={"book_kind": "builtin", "duration_seconds": 60, "duration_bucket": "1-4m"})
        add("ai_request_started", properties={"request_id": recent_request, "purpose": "summary"})
        old = time.time() - 5 * 86400
        add("book_opened", session=str(uuid.uuid4()), properties={"book_kind": "builtin"}, ts=old)
        add("ai_request_started", properties={"request_id": str(uuid.uuid4()), "purpose": "summary"}, ts=old)
        day = server.compute_dashboard(1)["overview"]
        week = server.compute_dashboard(7)["overview"]
        self.assertEqual(day["sessions_per_dau"], 1.0)
        self.assertEqual(day["tools_per_dau"], 1.0)
        self.assertEqual(week["sessions_per_dau"], day["sessions_per_dau"])
        self.assertEqual(week["tools_per_dau"], day["tools_per_dau"])

    def test_overview_uses_moscow_day_iso_week_and_calendar_month(self):
        now = datetime(2026, 7, 8, 12, 0, tzinfo=timezone.utc).timestamp()
        add(
            "book_opened",
            actor=ACTOR_A,
            session=str(uuid.uuid4()),
            properties={"book_kind": "builtin"},
            ts=datetime(2026, 7, 7, 21, 1, tzinfo=timezone.utc).timestamp(),
        )
        add(
            "ai_request_started",
            actor=ACTOR_A,
            properties={"request_id": str(uuid.uuid4()), "purpose": "summary"},
            ts=datetime(2026, 7, 8, 8, 0, tzinfo=timezone.utc).timestamp(),
        )
        add(
            "book_opened",
            actor=ACTOR_B,
            session=str(uuid.uuid4()),
            properties={"book_kind": "builtin"},
            ts=datetime(2026, 7, 6, 8, 0, tzinfo=timezone.utc).timestamp(),
        )
        add(
            "book_opened",
            actor="c" * 64,
            session=str(uuid.uuid4()),
            properties={"book_kind": "builtin"},
            ts=datetime(2026, 7, 5, 8, 0, tzinfo=timezone.utc).timestamp(),
        )
        add(
            "book_opened",
            actor="d" * 64,
            session=str(uuid.uuid4()),
            properties={"book_kind": "builtin"},
            ts=datetime(2026, 6, 30, 20, 59, tzinfo=timezone.utc).timestamp(),
        )

        with patch("server.time.time", return_value=now):
            overview = server.compute_dashboard(1)["overview"]

        self.assertEqual(overview["dau"], 1)
        self.assertEqual(overview["wau"], 2)
        self.assertEqual(overview["mau"], 3)
        self.assertEqual(overview["sessions_per_dau"], 1)
        self.assertEqual(overview["tools_per_dau"], 1)

    def test_privacy_schema_is_event_scoped(self):
        with self.assertRaises(ValueError):
            server._safe_properties("book_opened", {"route": "covert-content"})
        with self.assertRaises(ValueError):
            server._safe_properties("book_opened", {"book_kind": "my-private-title"})
        self.assertEqual(server._safe_properties("book_opened", {"book_kind": "builtin"}), {"book_kind": "builtin"})
        self.assertEqual(server._safe_properties("ai_request_completed", {
            "request_id": str(uuid.uuid4()),
            "purpose": "summary",
            "exact_cost": 0.01,
            "cost_currency": "USD",
            "cost_source": "openrouter_usage",
        })["cost_source"], "openrouter_usage")
        with self.assertRaises(ValueError):
            server._safe_properties("ai_request_completed", {
                "cost_currency": "RUB", "cost_source": "estimated",
            })

    def test_event_id_is_idempotent(self):
        event_id = str(uuid.uuid4())
        add("book_opened", session=str(uuid.uuid4()), properties={"book_kind": "builtin"}, event_id=event_id)
        add("book_opened", session=str(uuid.uuid4()), properties={"book_kind": "builtin"}, event_id=event_id)
        with server.DB_LOCK:
            count = server._db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        self.assertEqual(count, 1)

    def test_product_dashboard_exposes_latency_cost_feedback_reading_and_update_funnel(self):
        first = str(uuid.uuid4())
        second = str(uuid.uuid4())
        add("ai_request_started", properties={"request_id": first, "purpose": "summary"})
        add("ai_request_completed", properties={
            "request_id": first, "purpose": "summary", "route": "giga:model",
            "latency_ms": 100, "success": True, "exact_cost": 0.2,
            "cost_currency": "USD", "cost_source": "litellm_response_header",
            "input_tokens": 100, "output_tokens": 20, "total_tokens": 120,
        })
        add("provider_attempt_failed", properties={
            "request_id": first, "purpose": "summary", "provider": "openrouter",
            "model": "vendor/model", "latency_ms": 50, "http_status": 429,
            "error_code": "RATE", "retry_index": 0,
        })
        add("provider_attempt_completed", properties={
            "request_id": first, "purpose": "summary", "provider": "giga",
            "model": "giga-model", "latency_ms": 50, "http_status": 200,
            "retry_index": 1,
        })
        add("ai_request_started", properties={"request_id": second, "purpose": "summary"})
        add("ai_request_completed", properties={
            "request_id": second, "purpose": "summary", "route": "openrouter:model",
            "latency_ms": 900, "success": True, "exact_cost": 0.3,
            "cost_currency": "USD", "cost_source": "openrouter_usage",
            "input_tokens": 200, "output_tokens": 40, "total_tokens": 240,
        })
        add("provider_attempt_completed", properties={
            "request_id": second, "purpose": "summary", "provider": "openrouter",
            "model": "vendor/model", "latency_ms": 900, "http_status": 200,
            "retry_index": 0,
        })
        add("answer_feedback_submitted", properties={"rating": "helpful"})
        add("answer_feedback_submitted", properties={"rating": "unhelpful"})
        add("reading_session_ended", session=str(uuid.uuid4()), properties={"duration_seconds": 120})
        add("update_offered", properties={"version": "0.7.8"})
        add("update_downloaded", properties={"version": "0.7.8"})
        add("update_verified", properties={"version": "0.7.8", "success": True})
        add("update_installed", properties={"version": "0.7.8"})
        data = server.compute_dashboard(1)
        self.assertEqual(data["ai"]["latency_p50_ms"], 100.0)
        self.assertEqual(data["ai"]["latency_p95_ms"], 900.0)
        self.assertEqual(data["ai"]["known_cost"], 0.5)
        self.assertEqual(data["ai"]["cost_currency"], "USD")
        self.assertEqual(data["ai"]["cost_coverage"], 100.0)
        self.assertEqual(data["ai"]["cost_sources"], {
            "litellm_response_header": 1, "openrouter_usage": 1,
        })
        self.assertEqual(data["ai"]["token_coverage"], 100.0)
        self.assertEqual(data["ai"]["input_tokens"], 300)
        self.assertEqual(data["ai"]["output_tokens"], 60)
        self.assertEqual(data["ai"]["attempt_error_rate"], 33.3)
        self.assertEqual(data["ai"]["fallback_rate"], 50.0)
        self.assertEqual(data["ai"]["providers"][0]["name"], "openrouter")
        self.assertEqual(
            {row["name"] for row in data["ai"]["models"]},
            {"giga:giga-model", "openrouter:vendor/model"},
        )
        self.assertEqual(data["ai"]["helpful_rate"], 50.0)
        self.assertEqual(data["engagement"]["reading_minutes"], 2.0)
        update_steps = {row["label"]: row["rate"] for row in data["funnels"] if row["label"].startswith("Update")}
        self.assertEqual(update_steps, {
            "Update downloaded": 100.0, "Update verified": 100.0, "Update installed": 100.0,
        })

    def test_tool_candidates_and_diagnostics_make_overview_choice_explicit(self):
        session_id = str(uuid.uuid4())
        request_id = str(uuid.uuid4())
        add("book_opened", session=session_id, properties={"book_kind": "builtin"})
        add("reading_session_qualified", session=session_id, properties={
            "book_kind": "builtin", "duration_seconds": 90, "duration_bucket": "1-4m",
        })
        add("chapter_completed", session=session_id, properties={"chapter_position_bucket": "1-3"})
        add("bookmark_added", session=session_id, properties={"feature": "bookmark"})
        add("ai_request_started", properties={"request_id": request_id, "purpose": "summary"})
        add("provider_attempt_failed", properties={
            "request_id": request_id, "purpose": "summary", "provider": "openrouter",
            "model": "vendor/model", "error_code": "RATE", "retry_index": 0,
        })
        add("provider_attempt_completed", properties={
            "request_id": request_id, "purpose": "summary", "provider": "giga",
            "model": "giga-model", "http_status": 200, "retry_index": 1,
        })
        add("ai_request_completed", properties={
            "request_id": request_id, "purpose": "summary", "route": "giga:giga-model",
            "latency_ms": 200, "success": True, "input_tokens": 10,
            "output_tokens": 4, "total_tokens": 14,
        })
        data = server.compute_dashboard(1)
        tools = {row["id"]: row for row in data["tool_definitions"]}
        selected = [row for row in data["tool_definitions"] if row["selected_for_overview"]]
        self.assertEqual(len(data["tool_definitions"]), 6)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["id"], "logical_ai_requests_calendar_day_dau")
        self.assertEqual(selected[0]["value"], data["overview"]["tools_per_dau"])
        self.assertEqual(tools["provider_attempts_calendar_day_dau"]["value"], 2.0)
        self.assertEqual(tools["logical_ai_requests_calendar_day_dau"]["value"], 1.0)
        self.assertEqual(len(data["diagnostics"]), 10)
        self.assertEqual(data["quality"]["token_coverage"], 100.0)
        feature_names = {row["name"] for row in data["features"]}
        self.assertIn("AI tools", feature_names)
        classification = next(
            row for row in data["diagnostics"] if row["label"] == "Feature classification"
        )
        self.assertEqual(classification["value"], 100.0)

    def test_fallback_rate_excludes_orphan_attempts_and_tokens_are_consistent(self):
        request_id = str(uuid.uuid4())
        orphan_id = str(uuid.uuid4())
        add("ai_request_started", properties={"request_id": request_id, "purpose": "summary"})
        add("provider_attempt_completed", properties={
            "request_id": request_id, "purpose": "summary", "provider": "giga",
            "model": "same-model", "http_status": 200, "retry_index": 0,
        })
        add("provider_attempt_completed", properties={
            "request_id": orphan_id, "purpose": "summary", "provider": "openrouter",
            "model": "same-model", "http_status": 200, "retry_index": 1,
        })
        add("ai_request_completed", properties={
            "request_id": request_id, "purpose": "summary", "route": "giga:same-model",
            "latency_ms": 10, "success": True, "input_tokens": 7,
            "output_tokens": 3, "total_tokens": 999,
        })
        data = server.compute_dashboard(1)
        self.assertEqual(data["ai"]["fallback_rate"], 0.0)
        self.assertEqual(data["ai"]["total_tokens"], 10)
        self.assertEqual(
            {row["name"] for row in data["ai"]["models"]},
            {"giga:same-model", "openrouter:same-model"},
        )

    def test_dashboard_copy_explains_tools_and_observed_only_quality(self):
        html = (server.HERE / "index.html").read_text()
        self.assertIn("What should count as “Tools”?", html)
        self.assertIn("Overview KPI", html)
        self.assertIn("Product and data diagnostics", html)
        self.assertIn("Only directly observed events", html)
        self.assertIn("Total tokens", html)
        self.assertIn("diagnosticValue", html)
        self.assertIn("outcome coverage", html)

    def test_request_success_counts_overdue_pending_and_excludes_orphans(self):
        old = time.time() - server.AI_OUTCOME_GRACE_SECONDS - 10
        request_ids = [str(uuid.uuid4()) for _ in range(10)]
        for request_id in request_ids:
            add("ai_request_started", properties={
                "request_id": request_id, "purpose": "summary",
            }, ts=old)
        add("ai_request_completed", properties={
            "request_id": request_ids[0], "purpose": "summary",
            "route": "giga:model", "latency_ms": 100, "success": True,
        })
        orphan_id = str(uuid.uuid4())
        add("ai_request_completed", properties={
            "request_id": orphan_id, "purpose": "summary",
            "route": "giga:model", "latency_ms": 100, "success": True,
        })
        data = server.compute_dashboard(1)
        self.assertEqual(data["ai"]["requests"], 10)
        self.assertEqual(data["ai"]["success_rate"], 10.0)
        self.assertEqual(data["ai"]["pending"], 9)
        self.assertEqual(data["ai"]["pending_overdue"], 9)
        self.assertEqual(data["ai"]["outcome_coverage"], 10.0)
        self.assertEqual(data["ai"]["orphan_terminal_ids"], 1)
        self.assertTrue(any("no matching start" in warning for warning in data["quality"]["warnings"]))

    def test_fresh_pending_request_waits_for_outcome_grace_window(self):
        pending = str(uuid.uuid4())
        completed = str(uuid.uuid4())
        add("ai_request_started", properties={"request_id": pending, "purpose": "summary"})
        add("ai_request_started", properties={"request_id": completed, "purpose": "summary"})
        add("ai_request_completed", properties={
            "request_id": completed, "purpose": "summary", "route": "giga:model",
            "latency_ms": 10, "success": True,
        })
        data = server.compute_dashboard(1)
        self.assertEqual(data["ai"]["success_rate"], 100.0)
        self.assertEqual(data["ai"]["outcome_eligible"], 1)
        self.assertEqual(data["ai"]["pending"], 1)
        self.assertEqual(data["ai"]["pending_overdue"], 0)

    def test_terminal_for_request_started_before_window_is_not_an_orphan(self):
        request_id = str(uuid.uuid4())
        current_request_id = str(uuid.uuid4())
        add("ai_request_started", properties={
            "request_id": request_id, "purpose": "summary",
        }, ts=time.time() - 2 * 86400)
        add("provider_attempt_completed", properties={
            "request_id": request_id, "purpose": "summary", "provider": "giga",
            "model": "giga-model", "http_status": 200, "retry_index": 0,
        })
        add("ai_request_completed", properties={
            "request_id": request_id, "purpose": "summary", "route": "giga:model",
            "latency_ms": 10, "success": True,
        })
        add("ai_request_started", properties={
            "request_id": current_request_id, "purpose": "summary",
        })
        add("provider_attempt_completed", properties={
            "request_id": current_request_id, "purpose": "summary", "provider": "giga",
            "model": "giga-model", "http_status": 200, "retry_index": 0,
        })
        data = server.compute_dashboard(1)
        self.assertEqual(data["ai"]["requests"], 1)
        self.assertEqual(data["ai"]["orphan_terminal_ids"], 0)
        self.assertEqual(data["ai"]["attempts"], 2)
        self.assertEqual(data["ai"]["matched_attempts"], 1)
        self.assertEqual(data["ai"]["unmatched_attempts"], 1)
        self.assertEqual(data["ai"]["attempts_per_request"], 1.0)

    def test_cost_without_accepted_source_and_currency_is_missing(self):
        request_id = str(uuid.uuid4())
        add("ai_request_started", properties={"request_id": request_id, "purpose": "summary"})
        add("ai_request_completed", properties={
            "request_id": request_id, "purpose": "summary", "route": "giga:model",
            "latency_ms": 10, "success": True, "exact_cost": 0.25,
        })
        data = server.compute_dashboard(1)
        self.assertIsNone(data["ai"]["known_cost"])
        self.assertEqual(data["ai"]["cost_coverage"], 0.0)
        self.assertTrue(any("accepted source/currency" in warning for warning in data["quality"]["warnings"]))

    def test_retention_is_rolling_after_first_qualified_reading(self):
        now = time.time()
        day = 86400
        first = now - 31 * day
        add("reading_session_qualified", properties={"book_kind": "builtin", "duration_seconds": 60, "duration_bucket": "1-4m"}, ts=first)
        add("book_opened", properties={"book_kind": "builtin"}, ts=first + 30 * day)
        retention = server.compute_dashboard(365)["retention"]
        self.assertEqual(retention["d1"]["returned"], 1)
        self.assertEqual(retention["d7"]["returned"], 1)
        self.assertEqual(retention["d30"]["returned"], 1)

    def test_update_funnel_does_not_join_different_versions(self):
        add("update_offered", properties={"version": "0.7.8"})
        add("update_downloaded", properties={"version": "0.7.9"})
        steps = {row["label"]: row for row in server.compute_dashboard(1)["funnels"]}
        self.assertEqual(steps["Update downloaded"]["completed"], 0)

    def test_numeric_transport_bound_matches_gateway(self):
        self.assertEqual(server._safe_properties("app_closed", {"duration_seconds": 700000}), {"duration_seconds": 700000})


if __name__ == "__main__":
    unittest.main()
