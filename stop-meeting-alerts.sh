#!/bin/bash
cd ~/.openclaw/workspace

if [ -f meeting-alerts.pid ]; then
  PID=$(cat meeting-alerts.pid)
  if ps -p $PID > /dev/null 2>&1; then
    kill $PID
    echo "Meeting alerts stopped (PID: $PID)"
  else
    echo "Process $PID not running"
  fi
  rm meeting-alerts.pid
else
  echo "No PID file found"
fi

# Also kill any orphaned popup windows
pkill -f "electron.*meeting-popup" 2>/dev/null && echo "Killed orphaned popups" || true
