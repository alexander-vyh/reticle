#!/bin/bash
cd ~/.openclaw/workspace

# Check if already running
if [ -f meeting-alerts.pid ]; then
  OLD_PID=$(cat meeting-alerts.pid)
  if ps -p $OLD_PID > /dev/null 2>&1; then
    echo "Meeting alerts already running (PID: $OLD_PID)"
    exit 0
  fi
  rm meeting-alerts.pid
fi

# Start service
nohup node meeting-alert-monitor.js > meeting-alerts.log 2> meeting-alerts-error.log &
echo $! > meeting-alerts.pid
echo "Meeting alerts started (PID: $(cat meeting-alerts.pid))"
echo "Logs: tail -f meeting-alerts.log"
