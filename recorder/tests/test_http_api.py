"""Integration tests for the meeting-recorder HTTP API.

Tests Bug 1 (stale process detection) and Bug 3 (attendees optional).
"""

import glob
import json
import os
import signal
import subprocess
import threading
import time

import pytest
import requests

BINARY = os.path.join(
    os.path.dirname(__file__), "..", ".build", "debug", "meeting-recorder"
)
BASE_URL = "http://localhost:9847"


class TestAttendeesOptional:
    """Bug 3: POST /start should accept requests without the attendees field."""

    def test_start_without_attendees(self, daemon):
        """Omitting attendees entirely should succeed."""
        resp = requests.post(
            f"{BASE_URL}/start",
            json={"meetingId": "test-no-attendees", "title": "Test"},
        )
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        data = resp.json()
        assert data.get("started") is True

        # Cleanup
        requests.post(
            f"{BASE_URL}/stop",
            json={"meetingId": "test-no-attendees"},
            timeout=10,
        )
        time.sleep(1)

    def test_start_with_empty_attendees_still_works(self, daemon):
        """Explicit empty attendees should still work (regression check)."""
        resp = requests.post(
            f"{BASE_URL}/start",
            json={
                "meetingId": "test-empty-attendees",
                "title": "Test",
                "attendees": [],
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("started") is True

        # Cleanup
        requests.post(
            f"{BASE_URL}/stop",
            json={"meetingId": "test-empty-attendees"},
            timeout=10,
        )
        time.sleep(1)


class TestStaleProcessDetection:
    """Bug 1: Starting a second daemon should fail fast, not hang."""

    def test_second_daemon_exits_nonzero(self, daemon):
        """A second daemon on the same port should exit with a non-zero code."""
        proc2 = subprocess.Popen(
            [BINARY],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            proc2.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc2.kill()
            proc2.wait()
            pytest.fail("Second daemon hung instead of exiting")

        assert proc2.returncode != 0, (
            f"Second daemon should exit non-zero, got {proc2.returncode}"
        )

    def test_original_daemon_still_healthy(self, daemon):
        """After a second daemon fails to start, the original should still work."""
        resp = requests.get(f"{BASE_URL}/health", timeout=2)
        assert resp.ok
        assert resp.json().get("ok") is True


class TestSSELiveEndpoint:
    """GET /live should stream Server-Sent Events."""

    def test_live_returns_sse_headers(self, daemon):
        """GET /live should return text/event-stream content type."""
        resp = requests.get(f"{BASE_URL}/live", stream=True, timeout=5)
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("Content-Type", "")
        resp.close()

    def test_live_idle_when_not_recording(self, daemon):
        """When not recording, /live should send a status:idle event."""
        resp = requests.get(f"{BASE_URL}/live", stream=True, timeout=5)
        # Read first event
        first_line = b""
        for chunk in resp.iter_content(chunk_size=1):
            first_line += chunk
            if b"\n\n" in first_line:
                break
        resp.close()

        text = first_line.decode("utf-8")
        assert "event: status" in text
        assert '"idle"' in text

    def test_live_streams_segments_during_recording(self, daemon):
        """Start a recording, connect to /live, verify segment events arrive."""
        # Start recording
        start_resp = requests.post(
            f"{BASE_URL}/start",
            json={"meetingId": "sse-test", "title": "SSE Test"},
        )
        assert start_resp.status_code == 200

        events = []
        stop_flag = threading.Event()

        def collect_events():
            try:
                resp = requests.get(f"{BASE_URL}/live", stream=True, timeout=15)
                for line in resp.iter_lines():
                    if stop_flag.is_set():
                        break
                    if line:
                        events.append(line.decode("utf-8"))
                resp.close()
            except Exception:
                pass

        # Collect SSE events in background
        t = threading.Thread(target=collect_events, daemon=True)
        t.start()

        # Wait a bit for events to accumulate, then stop
        time.sleep(8)
        requests.post(f"{BASE_URL}/stop", json={"meetingId": "sse-test"}, timeout=10)
        time.sleep(2)
        stop_flag.set()
        t.join(timeout=5)

        # Should have received at least a status event
        event_text = "\n".join(events)
        assert "event: status" in event_text, f"Expected status event, got: {event_text}"

    def test_live_persists_on_stop(self, daemon):
        """After stop, a -live.json file should be written."""
        recordings_dir = os.path.expanduser("~/.config/claudia/recordings")

        # Clean up any stale files from previous runs
        for f in glob.glob(f"{recordings_dir}/meeting-persist-test-*-live.json"):
            os.remove(f)

        # Start and stop a recording
        start_resp = requests.post(
            f"{BASE_URL}/start",
            json={"meetingId": "persist-test", "title": "Persist Test"},
        )
        assert start_resp.status_code == 200, f"Start failed: {start_resp.text}"
        time.sleep(3)
        requests.post(f"{BASE_URL}/stop", json={"meetingId": "persist-test"}, timeout=10)
        time.sleep(2)

        # Check for live JSON file
        live_files = glob.glob(f"{recordings_dir}/meeting-persist-test-*-live.json")
        assert len(live_files) >= 1, f"Expected live JSON file, found: {live_files}"

        # Verify contents
        with open(live_files[0]) as f:
            data = json.load(f)
        assert data["meetingId"] == "persist-test"
        assert "finalMetrics" in data
        assert "segments" in data
