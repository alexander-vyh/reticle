# O3 Effectiveness System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect 1:1 meetings with direct reports, fire gap-aware prep reminders via Slack, track O3 sessions in SQLite, nudge to log in Lattice post-meeting, produce weekly accountability summary.

**Architecture:** Extends `meeting-alert-monitor.js` with O3 detection and notification logic. Uses existing `followups.db` (via `followups-db.js`) for a new `o3_sessions` table. Extracts shared Slack DM helper to `lib/slack.js` to stop copy-pasting across daemons. All gap-finding uses cached calendar events — no extra API calls.

**Tech Stack:** Node.js, better-sqlite3, Slack Block Kit (via HTTPS), Google Calendar API (existing), pino logging (existing `lib/logger.js`)

---

## Task 1: Extract shared Slack helper to `lib/slack.js`

The `sendSlackDM(message, blocks)` function is duplicated in `gmail-monitor.js`, `followup-checker.js`, and `gmail-monitor-v2.js`. Extract it to a shared module before adding another consumer.

**Files:**
- Create: `workspace/lib/slack.js`
- Modify: `workspace/meeting-alert-monitor.js:1-10` (add require)

**Step 1: Create `lib/slack.js`**

```js
// workspace/lib/slack.js
'use strict';

const https = require('https');

const SLACK_TOKEN = 'REDACTED_SLACK_BOT_TOKEN';
const MY_SLACK_USER_ID = 'REDACTED_SLACK_USER_ID';

/**
 * Send a Slack DM to the configured user.
 * @param {string} message - Fallback text
 * @param {Array|null} blocks - Block Kit blocks (optional)
 * @returns {Promise<object>} Slack API response body
 */
function sendSlackDM(message, blocks = null) {
  return sendSlackMessage(MY_SLACK_USER_ID, message, blocks);
}

/**
 * Send a Slack message to any channel/user.
 * @param {string} channel - Channel or user ID
 * @param {string} message - Fallback text
 * @param {Array|null} blocks - Block Kit blocks (optional)
 * @returns {Promise<object>} Slack API response body
 */
function sendSlackMessage(channel, message, blocks = null) {
  return new Promise((resolve, reject) => {
    const payload = {
      channel,
      text: message,
      unfurl_links: false
    };
    if (blocks) payload.blocks = blocks;

    const data = JSON.stringify(payload);

    const req = https.request({
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.ok) reject(new Error(`Slack API error: ${parsed.error}`));
          else resolve(parsed);
        } catch (e) {
          reject(new Error(`Slack response parse error: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = { sendSlackDM, sendSlackMessage, SLACK_TOKEN, MY_SLACK_USER_ID };
```

**Step 2: Verify the module loads**

Run: `node -e "const s = require('./workspace/lib/slack'); console.log(typeof s.sendSlackDM, typeof s.sendSlackMessage)"`
Expected: `function function`

**Step 3: Commit**

```bash
git add workspace/lib/slack.js
git commit -m "extract: shared Slack helper to lib/slack.js"
```

---

## Task 2: Add `o3_sessions` table to followups-db.js

**Files:**
- Modify: `workspace/followups-db.js:15-55` (add table + index in `initDatabase()`)
- Modify: `workspace/followups-db.js:227-237` (add new exports)

**Step 1: Add the table creation SQL inside `initDatabase()`**

After the existing `CREATE INDEX ... idx_notif_conversation` block (line 51), add:

```sql
CREATE TABLE IF NOT EXISTS o3_sessions (
  id TEXT PRIMARY KEY,
  report_name TEXT NOT NULL,
  report_email TEXT NOT NULL,
  scheduled_start INTEGER NOT NULL,
  scheduled_end INTEGER NOT NULL,
  verified INTEGER,
  zoom_meeting_id TEXT,
  zoom_summary TEXT,
  prep_sent_afternoon INTEGER,
  prep_sent_before INTEGER,
  post_nudge_sent INTEGER,
  lattice_logged INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_o3_report ON o3_sessions(report_email);
CREATE INDEX IF NOT EXISTS idx_o3_start ON o3_sessions(scheduled_start);
```

**Step 2: Add O3 query helpers**

Add before the `module.exports` block:

```js
/**
 * Upsert an O3 session (idempotent — safe to call every poll cycle)
 */
function upsertO3Session(db, session) {
  const stmt = db.prepare(`
    INSERT INTO o3_sessions (id, report_name, report_email, scheduled_start, scheduled_end, created_at)
    VALUES (@id, @report_name, @report_email, @scheduled_start, @scheduled_end, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      scheduled_start = @scheduled_start,
      scheduled_end = @scheduled_end
  `);
  return stmt.run({
    id: session.id,
    report_name: session.report_name,
    report_email: session.report_email,
    scheduled_start: session.scheduled_start,
    scheduled_end: session.scheduled_end,
    created_at: Math.floor(Date.now() / 1000)
  });
}

/**
 * Mark a notification as sent for an O3 session
 * @param {string} field - 'prep_sent_afternoon', 'prep_sent_before', or 'post_nudge_sent'
 */
function markO3Notified(db, eventId, field) {
  const allowed = ['prep_sent_afternoon', 'prep_sent_before', 'post_nudge_sent'];
  if (!allowed.includes(field)) throw new Error(`Invalid O3 notification field: ${field}`);
  const stmt = db.prepare(`UPDATE o3_sessions SET ${field} = ? WHERE id = ?`);
  return stmt.run(Math.floor(Date.now() / 1000), eventId);
}

/**
 * Mark O3 as logged in Lattice
 */
function markO3LatticeLogged(db, eventId) {
  const stmt = db.prepare(`UPDATE o3_sessions SET lattice_logged = ? WHERE id = ?`);
  return stmt.run(Math.floor(Date.now() / 1000), eventId);
}

/**
 * Get O3 session by event ID
 */
function getO3Session(db, eventId) {
  return db.prepare('SELECT * FROM o3_sessions WHERE id = ?').get(eventId);
}

/**
 * Get all O3 sessions for a report in a date range
 */
function getO3SessionsForReport(db, reportEmail, startTs, endTs) {
  return db.prepare(
    'SELECT * FROM o3_sessions WHERE report_email = ? AND scheduled_start >= ? AND scheduled_start <= ? ORDER BY scheduled_start DESC'
  ).all(reportEmail, startTs, endTs);
}

/**
 * Get the most recent O3 session for a report (before a given timestamp)
 */
function getLastO3ForReport(db, reportEmail, beforeTs) {
  return db.prepare(
    'SELECT * FROM o3_sessions WHERE report_email = ? AND scheduled_start < ? ORDER BY scheduled_start DESC LIMIT 1'
  ).get(reportEmail, beforeTs || Math.floor(Date.now() / 1000));
}

/**
 * Get O3 sessions in a week range for weekly summary
 */
function getWeeklyO3Summary(db, weekStartTs, weekEndTs) {
  return db.prepare(
    'SELECT * FROM o3_sessions WHERE scheduled_start >= ? AND scheduled_start <= ? ORDER BY report_name, scheduled_start'
  ).all(weekStartTs, weekEndTs);
}
```

**Step 3: Update module.exports**

```js
module.exports = {
  initDatabase,
  trackConversation,
  resolveConversation,
  getPendingResponses,
  getAwaitingReplies,
  logNotification,
  markNotified,
  getStats,
  // O3 helpers
  upsertO3Session,
  markO3Notified,
  markO3LatticeLogged,
  getO3Session,
  getO3SessionsForReport,
  getLastO3ForReport,
  getWeeklyO3Summary,
  DB_PATH
};
```

**Step 4: Verify the table creates without error**

Run: `node -e "const db = require('./workspace/followups-db'); const conn = db.initDatabase(); const tables = conn.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all(); console.log(tables.map(t => t.name)); conn.close()"`
Expected: output includes `o3_sessions`

**Step 5: Commit**

```bash
git add workspace/followups-db.js
git commit -m "feat: add o3_sessions table and query helpers to followups-db"
```

---

## Task 3: Add O3 config and detection to meeting-alert-monitor.js

**Files:**
- Modify: `workspace/meeting-alert-monitor.js:1-11` (add requires)
- Modify: `workspace/meeting-alert-monitor.js:12-24` (add O3_CONFIG after CONFIG)

**Step 1: Add requires at top of file**

After line 4 (`const { execFile, spawn } = require('child_process');`), add:

```js
const https = require('https');
const followupsDb = require('./followups-db');
const slack = require('./lib/slack');
```

**Step 2: Add O3_CONFIG after CONFIG block (after line 24)**

```js
const O3_CONFIG = {
  myEmail: 'user@example.com',
  directReports: [
    { name: 'Report One', email: 'report1@example.com', slackId: 'REDACTED_REPORT1_SLACK_ID' },
    { name: 'Report Two', email: 'report2@example.com', slackId: 'REDACTED_REPORT2_SLACK_ID' },
    { name: 'Report Three', email: 'report3@example.com', slackId: 'REDACTED_REPORT3_SLACK_ID' },
    { name: 'Report Four', email: 'report4@example.com', slackId: 'REDACTED_REPORT4_SLACK_ID' },
    { name: 'Report Five', email: 'report5@example.com', slackId: 'REDACTED_REPORT5_SLACK_ID' },
    { name: 'Report Six', email: 'report6@example.com', slackId: 'REDACTED_REPORT6_SLACK_ID' }
  ],
  afternoonPrepWindow: { startHour: 14, endHour: 15 },  // 2-3pm
  minGapMinutes: 10,
  maxPostDeferHours: 4,
  weeklySummaryDay: 0,   // Sunday
  weeklySummaryHour: 18  // 6pm
};
```

**Step 3: Add `detectO3()` function**

Place after the `O3_CONFIG` block:

```js
/**
 * Detect whether a calendar event is a 1:1 with a direct report.
 * Returns the matching report config object, or null.
 */
function detectO3(event) {
  const attendees = event.attendees || [];
  // Must have exactly 2 attendees (self + 1 other)
  if (attendees.length !== 2) return null;

  const other = attendees.find(a => !a.self);
  if (!other) return null;

  // Other must not have declined
  if (other.responseStatus === 'declined') return null;

  // Self must not have declined
  const self = attendees.find(a => a.self);
  if (self && self.responseStatus === 'declined') return null;

  // Match against direct reports
  const email = (other.email || '').toLowerCase();
  return O3_CONFIG.directReports.find(r => r.email.toLowerCase() === email) || null;
}
```

**Step 4: Verify detection works with mock data**

Run:
```bash
node -e "
const { detectO3 } = require('./workspace/meeting-alert-monitor');
// Should fail - can't require private function yet
console.log('Need to test after wiring');
"
```

Note: `detectO3` won't be exported (it's internal). We'll test it via integration in Task 6. For now, visually verify correctness.

**Step 5: Commit**

```bash
git add workspace/meeting-alert-monitor.js workspace/lib/slack.js
git commit -m "feat: add O3 config and detection logic to meeting-alert-monitor"
```

---

## Task 4: Add FreeBusy gap-finder

Uses the Google Calendar FreeBusy API to find free gaps. More accurate than scanning cached events because it sees all calendars (shared, subscribed, PTO). No new auth needed — `calendar.readonly` scope already includes FreeBusy access.

**Files:**
- Modify: `workspace/meeting-alert-monitor.js` (add `findGaps()` and `findBestGap()`)

**Step 1: Add `findGaps()` after `detectO3()`**

```js
/**
 * Find free gaps in the calendar within a time window using Google FreeBusy API.
 * More accurate than cached events — sees all calendars (shared, subscribed, PTO).
 * @param {number} windowStart - Window start (epoch ms)
 * @param {number} windowEnd - Window end (epoch ms)
 * @param {number} minMinutes - Minimum gap duration in minutes
 * @returns {Promise<Array<{start: number, end: number}>>} Free gaps (epoch ms)
 */
async function findGaps(windowStart, windowEnd, minMinutes) {
  if (!calendar) return [];

  try {
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(windowStart).toISOString(),
        timeMax: new Date(windowEnd).toISOString(),
        items: [{ id: 'primary' }]
      }
    });

    const busyPeriods = (response.data.calendars.primary.busy || [])
      .map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
      .sort((a, b) => a.start - b.start);

    // Invert busy periods to get free gaps
    const gaps = [];
    let cursor = windowStart;

    for (const busy of busyPeriods) {
      if (busy.start > cursor) {
        const gapMs = busy.start - cursor;
        if (gapMs >= minMinutes * 60 * 1000) {
          gaps.push({ start: cursor, end: busy.start });
        }
      }
      cursor = Math.max(cursor, busy.end);
    }

    // Trailing gap after last busy period
    if (cursor < windowEnd) {
      const gapMs = windowEnd - cursor;
      if (gapMs >= minMinutes * 60 * 1000) {
        gaps.push({ start: cursor, end: windowEnd });
      }
    }

    return gaps;
  } catch (err) {
    console.error(`[${timestamp()}] FreeBusy query failed: ${err.message}`);
    return [];
  }
}

/**
 * Find the best gap for a notification in a time window.
 * For "before" notifications: returns the LAST gap (closest to the meeting).
 * For "after" notifications: returns the FIRST gap.
 * @param {'before'|'after'} preference
 */
async function findBestGap(windowStart, windowEnd, minMinutes, preference) {
  const gaps = await findGaps(windowStart, windowEnd, minMinutes);
  if (gaps.length === 0) return null;
  return preference === 'before' ? gaps[gaps.length - 1] : gaps[0];
}
```

**Step 2: Verify FreeBusy API works with existing credentials**

Run:
```bash
node -e "
const calendarAuth = require('./workspace/calendar-auth');
(async () => {
  const cal = await calendarAuth.getCalendarClient();
  const now = new Date();
  const later = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: later.toISOString(),
      items: [{ id: 'primary' }]
    }
  });
  const busy = res.data.calendars.primary.busy;
  console.log('Busy periods (next 4h):', busy.length);
  busy.forEach(b => console.log('  ', b.start, '->', b.end));
})();
"
```
Expected: list of busy periods (or 0 if calendar is empty).

**Step 3: Commit**

```bash
git add workspace/meeting-alert-monitor.js
git commit -m "feat: add FreeBusy-based gap-finder for O3 notifications"
```

---

## Task 5: Add O3 notification check loop

This is the main orchestration — runs on every poll cycle, scans for O3s in the upcoming 24h + tomorrow, and fires notifications at the right times.

**Files:**
- Modify: `workspace/meeting-alert-monitor.js` (add `checkO3Notifications()`, `sendAfternoonPrep()`, `sendPreMeetingPrep()`, `sendPostMeetingNudge()`)

**Step 1: Initialize database connection in `main()`**

In the `main()` function (around line 284), after `calendar = await calendarAuth.getCalendarClient();`, add:

```js
  // Initialize followups database (for O3 tracking)
  let o3Db;
  try {
    o3Db = followupsDb.initDatabase();
    console.log(`[${timestamp()}] O3 database initialized`);
  } catch (err) {
    console.error(`[${timestamp()}] O3 database init failed: ${err.message}`);
    // Non-fatal — O3 features will be disabled
  }
```

**Step 2: Add `checkO3Notifications()` function**

Place after `findBestGap()`:

```js
/**
 * Main O3 notification loop — called on each poll cycle.
 * Scans cached events, detects O3s, upserts to DB, fires gap-aware notifications.
 * Uses FreeBusy API for gap-finding (async).
 */
async function checkO3Notifications(events, db) {
  if (!db) return;
  const now = Date.now();

  for (const event of events) {
    const report = detectO3(event);
    if (!report) continue;

    const startMs = new Date(event.start.dateTime).getTime();
    const endMs = new Date(event.end.dateTime).getTime();

    // Upsert the O3 session
    followupsDb.upsertO3Session(db, {
      id: event.id,
      report_name: report.name,
      report_email: report.email,
      scheduled_start: Math.floor(startMs / 1000),
      scheduled_end: Math.floor(endMs / 1000)
    });

    const session = followupsDb.getO3Session(db, event.id);

    // --- Afternoon-before prep ---
    // If the O3 is tomorrow and we haven't sent afternoon prep yet
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const o3Date = new Date(startMs);
    const isTomorrow = o3Date.getDate() === tomorrow.getDate()
      && o3Date.getMonth() === tomorrow.getMonth()
      && o3Date.getFullYear() === tomorrow.getFullYear();

    if (isTomorrow && !session.prep_sent_afternoon) {
      const today = new Date(now);
      const windowStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(),
        O3_CONFIG.afternoonPrepWindow.startHour).getTime();
      const windowEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(),
        O3_CONFIG.afternoonPrepWindow.endHour).getTime();

      if (now >= windowStart && now <= windowEnd) {
        const gap = await findBestGap(now, windowEnd, O3_CONFIG.minGapMinutes, 'after');
        if (gap && now >= gap.start) {
          await sendAfternoonPrep(db, event, report);
        }
      }
    }

    // --- Pre-meeting prep ---
    // Within 3 hours before the O3
    const threeHoursBefore = startMs - 3 * 60 * 60 * 1000;
    if (!session.prep_sent_before && now >= threeHoursBefore && now < startMs) {
      const gap = await findBestGap(now, startMs, O3_CONFIG.minGapMinutes, 'before');
      if (gap && now >= gap.start) {
        await sendPreMeetingPrep(db, event, report);
      }
    }

    // --- Post-meeting nudge ---
    // After the O3 ends, within 4 hours
    const maxDefer = endMs + O3_CONFIG.maxPostDeferHours * 60 * 60 * 1000;
    if (!session.post_nudge_sent && now >= endMs && now <= maxDefer) {
      const gap = await findBestGap(now, maxDefer, O3_CONFIG.minGapMinutes, 'after');
      if (gap && now >= gap.start) {
        await sendPostMeetingNudge(db, event, report);
      } else if (now >= maxDefer) {
        // Max defer exceeded — fire anyway
        await sendPostMeetingNudge(db, event, report);
      }
    }
  }
}
```

**Step 3: Wire `checkO3Notifications()` into the existing poll intervals**

In `main()`, update the calendar sync interval (around line 312):

```js
  // Set up polling interval for calendar sync
  setInterval(async () => {
    const syncedEvents = await syncCalendar();
    meetingCache.cleanupAlertState(syncedEvents);
    await checkO3Notifications(syncedEvents, o3Db);
  }, CONFIG.pollInterval);
```

And the initial sync call (around line 326):

```js
  // Immediate alert check
  checkAlerts(events);
  await checkO3Notifications(events, o3Db);
```

**Step 4: Commit**

```bash
git add workspace/meeting-alert-monitor.js
git commit -m "feat: add O3 notification check loop with gap-aware scheduling"
```

---

## Task 6: Implement Slack notification content (afternoon prep, pre-meeting prep, post-meeting nudge)

**Files:**
- Modify: `workspace/meeting-alert-monitor.js` (add `sendAfternoonPrep()`, `sendPreMeetingPrep()`, `sendPostMeetingNudge()`)

**Step 1: Add `sendAfternoonPrep()`**

```js
/**
 * Send afternoon-before prep notification.
 * Content: list of tomorrow's O3s + open follow-up count per person + days since last O3
 */
async function sendAfternoonPrep(db, event, report) {
  const startMs = new Date(event.start.dateTime).getTime();
  const startTime = new Date(startMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Days since last O3
  const lastO3 = followupsDb.getLastO3ForReport(db, report.email, Math.floor(startMs / 1000));
  const daysSinceLast = lastO3
    ? Math.round((startMs / 1000 - lastO3.scheduled_start) / 86400)
    : null;

  // Open follow-ups for this person
  const pendingFollowups = followupsDb.getPendingResponses(db, { type: null })
    .filter(c => c.from_user && c.from_user.toLowerCase().includes(report.email.split('@')[0]));

  const daysSinceText = daysSinceLast !== null ? `${daysSinceLast} days since last O3` : 'First tracked O3';
  const followupText = pendingFollowups.length > 0
    ? `${pendingFollowups.length} open follow-up(s)`
    : 'No open follow-ups';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Tomorrow's O3: ${report.name}*\n:clock1: ${startTime}\n:memo: ${daysSinceText}\n:pushpin: ${followupText}`
      }
    }
  ];

  try {
    await slack.sendSlackDM(`Tomorrow's O3 prep: ${report.name} at ${startTime}`, blocks);
    followupsDb.markO3Notified(db, event.id, 'prep_sent_afternoon');
    console.log(`[${timestamp()}] O3 afternoon prep sent for ${report.name}`);
  } catch (err) {
    console.error(`[${timestamp()}] O3 afternoon prep failed: ${err.message}`);
  }
}
```

**Step 2: Add `sendPreMeetingPrep()`**

```js
/**
 * Send pre-meeting prep notification (nearest gap before O3, within 3 hours).
 * Content: open follow-ups, last O3 date, join link
 */
async function sendPreMeetingPrep(db, event, report) {
  const startMs = new Date(event.start.dateTime).getTime();
  const startTime = new Date(startMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const minutesUntil = Math.round((startMs - Date.now()) / 60000);

  // Last O3
  const lastO3 = followupsDb.getLastO3ForReport(db, report.email, Math.floor(startMs / 1000));
  const lastO3Text = lastO3
    ? new Date(lastO3.scheduled_start * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'None tracked';

  // Open follow-ups
  const pendingFollowups = followupsDb.getPendingResponses(db, { type: null })
    .filter(c => c.from_user && c.from_user.toLowerCase().includes(report.email.split('@')[0]));

  // Meeting link
  const linkParser = require('./meeting-link-parser');
  const linkInfo = linkParser.extractMeetingLink(event);

  let followupSection = '';
  if (pendingFollowups.length > 0) {
    followupSection = '\n\n*Open follow-ups:*\n' + pendingFollowups
      .slice(0, 5)
      .map(f => `• ${f.subject || 'Untitled'}`)
      .join('\n');
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*O3 with ${report.name} in ~${minutesUntil}min*\n:calendar: Last O3: ${lastO3Text}\n:link: ${linkInfo.url ? `<${linkInfo.url}|Join ${linkInfo.platform}>` : 'No meeting link found'}${followupSection}`
      }
    }
  ];

  try {
    await slack.sendSlackDM(`O3 with ${report.name} in ~${minutesUntil}min`, blocks);
    followupsDb.markO3Notified(db, event.id, 'prep_sent_before');
    console.log(`[${timestamp()}] O3 pre-meeting prep sent for ${report.name}`);
  } catch (err) {
    console.error(`[${timestamp()}] O3 pre-meeting prep failed: ${err.message}`);
  }
}
```

**Step 3: Add `sendPostMeetingNudge()`**

```js
/**
 * Send post-meeting Lattice nudge (first gap after O3 ends).
 * Content: "Log in Lattice" prompt with action buttons
 */
async function sendPostMeetingNudge(db, event, report) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*O3 with ${report.name} complete* :white_check_mark:\n\nDon't forget to log your notes in Lattice:\n• Action items\n• Feedback given/received\n• Career discussion topics`
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Logged in Lattice' },
          style: 'primary',
          action_id: `o3_lattice_logged_${event.id}`
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Snooze 30m' },
          action_id: `o3_snooze_${event.id}`
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip' },
          action_id: `o3_skip_${event.id}`
        }
      ]
    }
  ];

  try {
    await slack.sendSlackDM(`O3 with ${report.name} — log in Lattice`, blocks);
    followupsDb.markO3Notified(db, event.id, 'post_nudge_sent');
    console.log(`[${timestamp()}] O3 post-meeting nudge sent for ${report.name}`);
  } catch (err) {
    console.error(`[${timestamp()}] O3 post-meeting nudge failed: ${err.message}`);
  }
}
```

**Step 4: Test with a manual Slack DM**

Run:
```bash
node -e "
const slack = require('./workspace/lib/slack');
slack.sendSlackDM('O3 system test — ignore this message').then(r => console.log('OK:', r.ok)).catch(e => console.error('Error:', e.message));
"
```
Expected: `OK: true` and a test DM appears in Slack.

**Step 5: Commit**

```bash
git add workspace/meeting-alert-monitor.js
git commit -m "feat: add O3 Slack notification content (afternoon prep, pre-meeting, post-nudge)"
```

---

## Task 7: Add weekly summary

**Files:**
- Modify: `workspace/meeting-alert-monitor.js` (add `checkWeeklySummary()` + `sendWeeklySummary()`)

**Step 1: Add `checkWeeklySummary()` and `sendWeeklySummary()`**

```js
let lastWeeklySummaryDate = null;

/**
 * Check whether it's time to send the weekly summary.
 * Fires once on Sunday at 6pm (or the next poll after 6pm).
 */
function checkWeeklySummary(db) {
  if (!db) return;
  const now = new Date();
  if (now.getDay() !== O3_CONFIG.weeklySummaryDay) return;
  if (now.getHours() < O3_CONFIG.weeklySummaryHour) return;

  const todayKey = now.toISOString().split('T')[0];
  if (lastWeeklySummaryDate === todayKey) return;

  lastWeeklySummaryDate = todayKey;
  sendWeeklySummary(db);
}

/**
 * Build and send weekly O3 accountability summary.
 */
async function sendWeeklySummary(db) {
  const now = new Date();
  // Monday 00:00 of this week
  const monday = new Date(now);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const weekStart = Math.floor(monday.getTime() / 1000);

  // Sunday 23:59 (end of week)
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23, 59, 59, 0);
  const weekEnd = Math.floor(sunday.getTime() / 1000);

  const sessions = followupsDb.getWeeklyO3Summary(db, weekStart, weekEnd);

  // Group by report
  const byReport = {};
  for (const report of O3_CONFIG.directReports) {
    byReport[report.email] = { name: report.name, held: 0, logged: 0 };
  }
  for (const s of sessions) {
    if (!byReport[s.report_email]) continue;
    byReport[s.report_email].held++;
    if (s.lattice_logged) byReport[s.report_email].logged++;
  }

  // Build summary
  const lines = Object.values(byReport).map(r => {
    const latticeIcon = r.held > 0
      ? (r.logged >= r.held ? ':white_check_mark:' : `:warning: ${r.logged}/${r.held} logged`)
      : ':no_entry_sign: No O3';
    return `• *${r.name}*: ${r.held} O3(s) ${latticeIcon}`;
  });

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Weekly O3 Summary*\n_${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}_\n\n${lines.join('\n')}`
      }
    }
  ];

  try {
    await slack.sendSlackDM(`Weekly O3 Summary`, blocks);
    console.log(`[${timestamp()}] Weekly O3 summary sent`);
  } catch (err) {
    console.error(`[${timestamp()}] Weekly O3 summary failed: ${err.message}`);
  }
}
```

**Step 2: Wire into the poll interval**

In `main()`, inside the calendar sync `setInterval`, add after `checkO3Notifications(syncedEvents, o3Db);`:

```js
    checkWeeklySummary(o3Db);
```

**Step 3: Commit**

```bash
git add workspace/meeting-alert-monitor.js
git commit -m "feat: add weekly O3 accountability summary (Sunday 6pm)"
```

---

## Task 8: Integration test — end-to-end dry run

**Files:**
- No file changes — just verification commands

**Step 1: Start the monitor and check for O3 detection in logs**

Run:
```bash
cd ~/.openclaw/workspace && timeout 30 node meeting-alert-monitor.js 2>&1 | head -30
```

Expected output should include:
- `Calendar authorized successfully`
- `Calendar sync: N upcoming events`
- `O3 database initialized`
- No crash

**Step 2: Check the database has the O3 table**

Run:
```bash
sqlite3 ~/.openclaw/workspace/followups.db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected: includes `o3_sessions`

**Step 3: Check if any O3s were detected by inspecting the database**

Run:
```bash
sqlite3 ~/.openclaw/workspace/followups.db "SELECT id, report_name, datetime(scheduled_start, 'unixepoch', 'localtime') as start FROM o3_sessions ORDER BY scheduled_start LIMIT 10;"
```

Expected: O3 rows if there are upcoming 1:1s with direct reports on the calendar.

**Step 4: Commit (final)**

```bash
git add -A
git commit -m "feat: O3 effectiveness system — detection, gap-aware notifications, weekly summary"
```

---

## Deferred Work (not in this plan)

- **Zoom OAuth + meeting verification** — `zoom-auth.js`, participant check, AI Companion summary pull
- **Slack interactivity handling** — "Logged in Lattice" / "Snooze" button actions via Socket Mode in slack-events-monitor
- **Migrate meeting-alert-monitor to pino** — use shared `lib/logger.js`
- **Refactor other daemons to use `lib/slack.js`** — replace duplicated sendSlackDM in gmail-monitor, followup-checker
