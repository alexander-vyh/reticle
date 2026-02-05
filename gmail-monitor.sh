#!/bin/bash
# OpenClaw Gmail Monitor - Polling-based email assistant
# Checks Gmail every 5 minutes and sends notifications to Slack

set -euo pipefail

GMAIL_ACCOUNT="user@example.com"
SLACK_WEBHOOK_URL="" # TODO: Get from Slack
CHECK_INTERVAL=300 # 5 minutes in seconds
HISTORY_FILE="$HOME/.openclaw/workspace/gmail-history-id.txt"

# Initialize history ID if not exists
if [[ ! -f "$HISTORY_FILE" ]]; then
    gog gmail history --account "$GMAIL_ACCOUNT" --start-now --json 2>/dev/null | \
        jq -r '.historyId' > "$HISTORY_FILE" || echo "0" > "$HISTORY_FILE"
fi

echo "🦞 OpenClaw Gmail Monitor started"
echo "Monitoring: $GMAIL_ACCOUNT"
echo "Check interval: ${CHECK_INTERVAL}s"
echo ""

while true; do
    LAST_HISTORY_ID=$(cat "$HISTORY_FILE")
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Checking for new emails (history_id: $LAST_HISTORY_ID)..."

    # Get new messages since last check
    NEW_MESSAGES=$(gog gmail messages search "newer_than:10m" \
        --account "$GMAIL_ACCOUNT" \
        --max 50 \
        --json 2>/dev/null || echo "[]")

    MESSAGE_COUNT=$(echo "$NEW_MESSAGES" | jq 'length')

    if [[ "$MESSAGE_COUNT" -gt 0 ]]; then
        echo "  ✓ Found $MESSAGE_COUNT new message(s)"

        # Process each message
        echo "$NEW_MESSAGES" | jq -c '.[]' | while read -r message; do
            SUBJECT=$(echo "$message" | jq -r '.subject')
            FROM=$(echo "$message" | jq -r '.from')
            SNIPPET=$(echo "$message" | jq -r '.snippet')
            MESSAGE_ID=$(echo "$message" | jq -r '.id')

            echo "    - From: $FROM"
            echo "      Subject: $SUBJECT"

            # TODO: Apply urgency filtering logic here
            # For now, just log

        done
    else
        echo "  No new messages"
    fi

    # Update history ID
    CURRENT_HISTORY=$(gog gmail history --account "$GMAIL_ACCOUNT" --start-now --json 2>/dev/null | \
        jq -r '.historyId' || echo "$LAST_HISTORY_ID")
    echo "$CURRENT_HISTORY" > "$HISTORY_FILE"

    echo "  Sleeping for ${CHECK_INTERVAL}s..."
    echo ""
    sleep "$CHECK_INTERVAL"
done
