# O3 Effectiveness System — Design

## Overview

Detects 1:1 meetings with direct reports from Google Calendar, fires gap-aware prep reminders, verifies meetings via Zoom API, nudges to log in Lattice post-meeting, produces weekly accountability summary.

Integrated into `meeting-alert-monitor.js` — no new daemon.

## Direct Reports

| Name | Email | Slack ID |
|---|---|---|
| Report One | report1@example.com | REDACTED_REPORT1_SLACK_ID |
| Report Two | report2@example.com | REDACTED_REPORT2_SLACK_ID |
| Report Three | report3@example.com | REDACTED_REPORT3_SLACK_ID |
| Report Four | report4@example.com | REDACTED_REPORT4_SLACK_ID |
| Report Five | report5@example.com | REDACTED_REPORT5_SLACK_ID |
| Report Six | report6@example.com | REDACTED_REPORT6_SLACK_ID |

## O3 Detection

An event is an O3 if:
- Exactly 2 attendees (self + 1 other)
- Other attendee email matches a direct report
- Neither party declined

## Notification Timing (Gap-Aware)

All notifications land in free calendar gaps, computed from cached event data (no extra API calls).

### Afternoon-before prep (~2-3pm day before)
- Scan tomorrow's events for O3s
- Fire in a gap ≥10min during 2-3pm window
- Content: list of tomorrow's O3s + open follow-up count per person + days since last O3

### Pre-meeting prep (nearest gap before O3)
- Find most recent gap ≥10min within 3 hours before the O3
- Fallback: bundle into meeting alert pill at T-5min
- Content: open follow-ups with this person (from followups.db), last O3 date, join link, Lattice prompt

### Post-meeting nudge (first gap after O3)
- Find first gap ≥10min after O3 end time
- If next meeting is immediate, defer until that meeting ends (max 4h defer, then fire anyway)
- Content: "Log in Lattice" with action items / feedback / career discussion checkboxes
- Buttons: [Logged in Lattice] [Snooze 30m] [Skip]

### Weekly summary (Sunday 6pm)
- Per-report: O3s held, O3s logged in Lattice
- Week-over-week trend

## Meeting Verification (Zoom)

- User-level OAuth (same pattern as Google)
- After O3 scheduled end, query `GET /report/meetings/{meetingId}/participants`
- Confirm both attendees joined
- Pull AI Companion summary if available
- Fallback: if Zoom auth not configured, treat event-not-cancelled + end-time-passed as verified

## Data Model

New table in followups.db:

```sql
CREATE TABLE IF NOT EXISTS o3_sessions (
  id TEXT PRIMARY KEY,             -- calendar event ID
  report_name TEXT NOT NULL,
  report_email TEXT NOT NULL,
  scheduled_start INTEGER NOT NULL,
  scheduled_end INTEGER NOT NULL,
  verified INTEGER,                -- null=unknown, 1=confirmed, 0=no-show
  zoom_meeting_id TEXT,
  zoom_summary TEXT,
  prep_sent_afternoon INTEGER,     -- timestamp
  prep_sent_before INTEGER,        -- timestamp
  post_nudge_sent INTEGER,         -- timestamp
  lattice_logged INTEGER,          -- timestamp user clicked "Logged"
  created_at INTEGER NOT NULL
);
```

## Slack Integration

- Uses existing `sendSlackDM(message, blocks)` pattern from gmail-monitor
- Block Kit with mrkdwn sections + action buttons
- "Logged in Lattice" button requires Slack interactivity endpoint (or use slack-events-monitor's existing Socket Mode to handle block_actions)

## Files Modified

| File | Changes |
|---|---|
| `meeting-alert-monitor.js` | Add O3_CONFIG, detectO3(), checkO3Notifications(), gap-finder, Slack notification functions |
| `followups-db.js` | Add o3_sessions table creation in initDatabase(), add query helpers |
| `calendar-auth.js` | Already fixed: port derived from redirect_uri |

## New Files

| File | Purpose |
|---|---|
| `zoom-auth.js` | User-level Zoom OAuth (optional, deferred) |
