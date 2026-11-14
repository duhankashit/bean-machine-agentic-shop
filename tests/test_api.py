import asyncio
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import FRONTEND_DIST_DIR, app, orders


class FakeGraph:
    async def astream(self, state, stream_mode):
        self.stream_mode = stream_mode
        self.speech_enabled = state["speech_enabled"]
        yield {
            "owner": {
                "events": [
                    {"type": "agent", "agent": "owner", "state": "working", "station": "Pass"},
                    {"type": "message", "from": "owner", "to": "barista", "text": "Ticket received."},
                ]
            }
        }


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_menu_is_served_by_python_backend(self):
        response = self.client.get("/api/menu")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["drinks"]), 4)

    def test_order_requires_a_groq_api_key(self):
        order = {
            "name": "Sam",
            "drink": "latte",
            "milk": "oat",
            "size": "medium",
            "extraShot": False,
            "note": "",
        }
        with patch.dict(os.environ, {"GROK_API_KEY": ""}):
            response = self.client.post("/api/orders", json=order)
        self.assertEqual(response.status_code, 503)
        self.assertIn("GROK_API_KEY", response.json()["detail"])

    def test_frontend_is_served_by_python_backend(self):
        if not FRONTEND_DIST_DIR.is_dir():
            self.skipTest("Run npm run build in frontend before testing the production frontend.")
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Bean &amp; Machine", response.text)

    def test_order_streams_graph_events_and_completion(self):
        order = {
            "name": "Sam",
            "drink": "latte",
            "milk": "oat",
            "size": "medium",
            "extraShot": False,
            "note": "",
        }
        fake_graph = FakeGraph()
        with (
            patch.dict(os.environ, {"GROK_API_KEY": "test-key"}),
            patch("backend.main._get_graph", return_value=fake_graph),
        ):
            created = self.client.post("/api/orders", json=order)
            self.assertEqual(created.status_code, 201)
            order_id = created.json()["id"]
            with self.client.stream("GET", f"/api/orders/{order_id}/events") as response:
                body = "".join(response.iter_text())

        self.assertIn("text/event-stream", response.headers["content-type"])
        self.assertIn('"type": "message"', body)
        self.assertIn('"type": "complete"', body)
        self.assertEqual(fake_graph.stream_mode, "updates")
        self.assertTrue(fake_graph.speech_enabled)

    def test_speech_acknowledgement_unblocks_only_the_current_message(self):
        order_id = "speech-ack-test"
        speech_gate = asyncio.Event()
        orders[order_id] = {
            "voice_enabled": True,
            "done": False,
            "awaiting_speech_event_id": 7,
            "speech_gate": speech_gate,
        }
        try:
            stale_ack = self.client.post(
                f"/api/orders/{order_id}/speech",
                json={"event_id": 6},
            )
            self.assertFalse(stale_ack.json()["acknowledged"])
            self.assertFalse(speech_gate.is_set())

            matching_ack = self.client.post(
                f"/api/orders/{order_id}/speech",
                json={"event_id": 7},
            )
            self.assertTrue(matching_ack.json()["acknowledged"])
            self.assertTrue(speech_gate.is_set())
        finally:
            orders.pop(order_id, None)


if __name__ == "__main__":
    unittest.main()
