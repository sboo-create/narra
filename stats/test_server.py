import os
import tempfile
import time
import unittest
import uuid

os.environ["STATS_DB"] = os.path.join(tempfile.mkdtemp(prefix="narra-stats-"), "events.db")
os.environ["STATS_ALLOW_UNAUTHENTICATED_INGEST"] = "1"
os.environ["STATS_ENVIRONMENT"] = "test"

import server  # noqa: E402


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


class NarraStatsTest(unittest.TestCase):
    def setUp(self):
        with server.DB_LOCK:
            server._db.execute("DELETE FROM events")
            server._db.commit()

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

    def test_canonical_ratios_are_trailing_24h_not_selected_dashboard_window(self):
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

    def test_privacy_schema_is_event_scoped(self):
        with self.assertRaises(ValueError):
            server._safe_properties("book_opened", {"route": "covert-content"})
        with self.assertRaises(ValueError):
            server._safe_properties("book_opened", {"book_kind": "my-private-title"})
        self.assertEqual(server._safe_properties("book_opened", {"book_kind": "builtin"}), {"book_kind": "builtin"})

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
        })
        add("ai_request_started", properties={"request_id": second, "purpose": "summary"})
        add("ai_request_completed", properties={
            "request_id": second, "purpose": "summary", "route": "openrouter:model",
            "latency_ms": 900, "success": True, "exact_cost": 0.3,
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
        self.assertEqual(data["ai"]["helpful_rate"], 50.0)
        self.assertEqual(data["engagement"]["reading_minutes"], 2.0)
        update_steps = {row["label"]: row["rate"] for row in data["funnels"] if row["label"].startswith("Update")}
        self.assertEqual(update_steps, {
            "Update downloaded": 100.0, "Update verified": 100.0, "Update installed": 100.0,
        })

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
