#!/usr/bin/env bash
# Smoke test: verify MeetingPopup.app creates a visible window when launched.
# Runs the popup with test data, checks for a window via osascript, then kills it.
# Exit 0 = popup appeared. Exit 1 = no window detected.
set -euo pipefail

POPUP_BIN="${1:-$HOME/.reticle/MeetingPopup.app/Contents/MacOS/MeetingPopup}"

if [ ! -x "$POPUP_BIN" ]; then
  echo "FAIL: popup binary not found at $POPUP_BIN"
  exit 1
fi

TEST_DATA=$(echo '{"alertLevel":"fiveMin","meetings":[{"id":"smoke-test","summary":"Smoke Test","startTime":"2099-01-01T00:00:00Z","hasVideoLink":false,"calendarLink":null,"attendees":["Test"]}]}' | base64)

# Launch popup in background
"$POPUP_BIN" "$TEST_DATA" &
PID=$!

# Wait for window to appear (up to 5 seconds)
FOUND=false
for i in $(seq 1 10); do
  sleep 0.5
  # Check if the process has a window via AppleScript
  WINDOW_COUNT=$(osascript -e "tell application \"System Events\" to tell (first process whose unix id is $PID) to count of windows" 2>/dev/null || echo "0")
  if [ "$WINDOW_COUNT" -gt 0 ]; then
    FOUND=true
    break
  fi
done

kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null || true

if [ "$FOUND" = true ]; then
  echo "PASS: MeetingPopup created $WINDOW_COUNT window(s)"
  exit 0
else
  echo "FAIL: MeetingPopup ran (PID $PID) but no window appeared after 5 seconds"
  exit 1
fi
