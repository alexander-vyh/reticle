"""Shared fixtures for meeting-recorder tests."""

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


@pytest.fixture(scope="module")
def daemon():
    """Start a meeting-recorder daemon for integration tests.

    Ensures any stale daemon is killed first, starts a fresh one,
    waits for it to become healthy, and tears it down after tests.
    """
    # Kill any existing daemon on the port
    try:
        resp = requests.get(f"{BASE_URL}/health", timeout=1)
        if resp.ok:
            # Something is already on the port — kill it
            import subprocess as sp

            pids = sp.check_output(
                ["lsof", "-ti:9847"], text=True
            ).strip().split("\n")
            for pid in pids:
                if pid.strip():
                    os.kill(int(pid.strip()), signal.SIGTERM)
            time.sleep(1)
    except (requests.ConnectionError, subprocess.CalledProcessError):
        pass  # Nothing running, good

    proc = subprocess.Popen(
        [BINARY],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Wait for daemon to become healthy
    for _ in range(20):
        try:
            resp = requests.get(f"{BASE_URL}/health", timeout=1)
            if resp.ok:
                break
        except requests.ConnectionError:
            pass
        time.sleep(0.5)
    else:
        proc.kill()
        raise RuntimeError("Daemon failed to start within 10 seconds")

    yield proc

    # Teardown: stop any active recording, then kill
    try:
        requests.post(f"{BASE_URL}/stop", json={"meetingId": "cleanup"}, timeout=2)
    except Exception:
        pass
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
