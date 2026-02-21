"""Integration tests for the meeting-recorder HTTP API.

Tests Bug 1 (stale process detection) and Bug 3 (attendees optional).
"""

import os
import signal
import subprocess
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
