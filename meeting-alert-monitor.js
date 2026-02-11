#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const https = require('https');
const followupsDb = require('./followups-db');
const slack = require('./lib/slack');
const calendarAuth = require('./calendar-auth');
const meetingCache = require('./meeting-cache');
const linkParser = require('./meeting-link-parser');
const platformLauncher = require('./platform-launcher');
const log = require('./lib/logger')('meeting-alerts');

const CONFIG = {
  pollInterval: 2 * 60 * 1000,       // 2 minutes
  alertThresholds: {
    tenMin: 10 * 60 * 1000,           // 10 minutes
    fiveMin: 5 * 60 * 1000,           // 5 minutes
    oneMin: 60 * 1000,                // 1 minute
    start: 0                           // At start time
  },
  alertCheckInterval: 15 * 1000,      // Check every 15 seconds
  lookAheadHours: 24,
  electronPath: path.join(__dirname, 'node_modules', '.bin', 'electron'),
  popupScript: path.join(__dirname, 'meeting-popup-window.js')
};

let calendar = null;
let activePopups = {};  // groupKey -> child process

const SOUNDS = {
  fiveMin: '/System/Library/Sounds/Blow.aiff',
  oneMin: '/System/Library/Sounds/Sosumi.aiff',
  start: '/System/Library/Sounds/Hero.aiff'
};

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
    log.error({ err }, 'FreeBusy query failed');
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
    log.info({ reportName: report.name, reportEmail: report.email, eventId: event.id }, 'O3 afternoon prep sent');
  } catch (err) {
    log.error({ err, reportName: report.name, eventId: event.id }, 'O3 afternoon prep failed');
  }
}

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
    log.info({ reportName: report.name, reportEmail: report.email, eventId: event.id }, 'O3 pre-meeting prep sent');
  } catch (err) {
    log.error({ err, reportName: report.name, eventId: event.id }, 'O3 pre-meeting prep failed');
  }
}

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
    log.info({ reportName: report.name, reportEmail: report.email, eventId: event.id }, 'O3 post-meeting nudge sent');
  } catch (err) {
    log.error({ err, reportName: report.name, eventId: event.id }, 'O3 post-meeting nudge failed');
  }
}

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
    log.info('Weekly O3 summary sent');
  } catch (err) {
    log.error({ err }, 'Weekly O3 summary failed');
  }
}


/**
 * Sync calendar events from Google Calendar API.
 * Falls back to cached data on API failure.
 */
async function syncCalendar() {
  const now = new Date();
  const timeMax = new Date(now.getTime() + CONFIG.lookAheadHours * 60 * 60 * 1000);

  if (!calendar) {
    log.error('Calendar client not initialized');
    return [];
  }

  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50
    });

    const events = (response.data.items || []).filter(event => {
      // Filter out all-day events (no dateTime means all-day)
      if (!event.start.dateTime) return false;

      // Filter out declined events
      if (event.attendees) {
        const self = event.attendees.find(a => a.self);
        if (self && self.responseStatus === 'declined') return false;
      }

      return true;
    });

    meetingCache.saveCache(events);
    log.info({ count: events.length }, 'Calendar sync completed');
    return events;
  } catch (err) {
    log.error({ err }, 'Calendar sync failed');

    // Fall back to cached data
    const cached = meetingCache.loadCache();
    if (cached && meetingCache.isCacheValid(cached)) {
      log.warn({ count: cached.events.length }, 'Using cached calendar data');
      return cached.events;
    }

    log.error('No valid cache available');
    return [];
  }
}

/**
 * Check all events against alert thresholds and trigger alerts as needed.
 */
function checkAlerts(events) {
  const now = Date.now();

  for (const event of events) {
    const startTime = new Date(event.start.dateTime).getTime();
    const timeUntil = startTime - now;

    // Skip events that started more than 5 minutes ago
    if (timeUntil < -5 * 60 * 1000) continue;

    // Check each threshold level
    for (const [level, threshold] of Object.entries(CONFIG.alertThresholds)) {
      if (timeUntil <= threshold && !meetingCache.hasAlerted(event.id, level)) {
        triggerAlert(event, level);
      }
    }
  }
}

/**
 * Trigger an alert for a specific event and alert level.
 * Groups overlapping meetings into a single popup.
 */
function triggerAlert(event, level) {
  const linkInfo = linkParser.extractMeetingLink(event);
  meetingCache.recordAlert(event.id, level);

  log.info({ alertLevel: level, eventId: event.id, summary: event.summary, startTime: event.start.dateTime }, 'Alert triggered');

  // Load current events from cache to find overlapping meetings
  const cached = meetingCache.loadCache();
  const allEvents = (cached && cached.events) || [];

  // Group overlapping meetings (within threshold)
  const groups = meetingCache.groupOverlappingMeetings(allEvents);

  // Find the group containing this event
  let eventGroup = null;
  for (const group of groups) {
    if (group.meetings.some(m => m.id === event.id)) {
      eventGroup = group;
      break;
    }
  }

  if (!eventGroup) {
    eventGroup = { startTime: new Date(event.start.dateTime).getTime(), meetings: [event] };
  }

  // Build popup data with all meetings in the group
  const meetings = eventGroup.meetings.map(m => {
    const link = linkParser.extractMeetingLink(m);
    const hasVideoLink = link.platform !== 'calendar';
    return {
      id: m.id,
      summary: m.summary || 'Untitled Meeting',
      startTime: m.start.dateTime,
      platform: link.platform,
      url: hasVideoLink ? link.url : null,
      joinLabel: platformLauncher.getJoinLabel(link.platform),
      hasVideoLink,
      calendarLink: m.htmlLink,
      attendees: (m.attendees || [])
        .filter(a => !a.self)
        .map(a => a.displayName || a.email)
    };
  });

  const popupData = {
    alertLevel: level,
    meetings: meetings
  };

  // Use group start time as the group key
  const groupKey = `group-${eventGroup.startTime}`;

  // Escalate existing popup via stdin, or spawn a new one
  if (activePopups[groupKey]) {
    const escalated = escalatePopup(groupKey, popupData);
    if (escalated) {
      // Play sound for escalation level
      if (SOUNDS[level]) playSound(SOUNDS[level]);
      return;
    }
    // Pipe broken — popup crashed; fall through to spawn a new one
    delete activePopups[groupKey];
  }

  spawnPopup(groupKey, popupData);

  // Play sound for initial spawn (except tenMin which is ambient)
  if (SOUNDS[level]) playSound(SOUNDS[level]);
}

/**
 * Escalate an existing popup via stdin IPC.
 * Returns true if the message was written successfully, false if the pipe is broken.
 */
function escalatePopup(groupKey, popupData) {
  const child = activePopups[groupKey];
  if (!child || !child.stdin || !child.stdin.writable) return false;

  const msg = JSON.stringify({ type: 'escalate', ...popupData }) + '\n';
  try {
    child.stdin.write(msg);
    log.info({ groupKey, alertLevel: popupData.alertLevel }, 'Escalated popup');
    return true;
  } catch (e) {
    log.error({ err: e, groupKey }, 'Escalation write failed');
    return false;
  }
}

/**
 * Spawn an Electron popup window for the given meeting data.
 * Uses spawn (not execFile) so child.stdin is a writable pipe for escalation.
 */
function spawnPopup(groupKey, popupData) {
  const dataB64 = Buffer.from(JSON.stringify(popupData)).toString('base64');

  const child = spawn(
    CONFIG.electronPath,
    [CONFIG.popupScript, dataB64],
    {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    }
  );

  activePopups[groupKey] = child;

  // Listen for JSON actions on stdout (join/dismiss)
  if (child.stdout) {
    let buffer = '';
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const action = JSON.parse(line);
          log.info({ action }, 'Popup action received');
        } catch (e) {
          // Not JSON, ignore
        }
      }
    });
  }

  // Filter stderr - only log non-GPU/WARNING messages
  if (child.stderr) {
    child.stderr.on('data', (data) => {
      const msg = data.toString();
      // Suppress common Electron noise
      if (msg.includes('GPU') || msg.includes('WARNING') || msg.includes('Passthrough is not supported')) return;
      if (msg.trim()) {
        log.warn({ stderr: msg.trim() }, 'Popup stderr');
      }
    });
  }

  child.on('close', (code) => {
    delete activePopups[groupKey];
    if (code && code !== 0) {
      log.error({ exitCode: code }, 'Popup exited abnormally');
    }
  });

  child.on('error', (err) => {
    log.error({ err }, 'Failed to spawn popup');
    delete activePopups[groupKey];
  });
}

/**
 * Play a system sound using afplay.
 */
function playSound(soundFile) {
  execFile('afplay', [soundFile], (err) => {
    if (err) {
      log.warn({ err }, 'Sound play failed');
    }
  });
}

/**
 * Main entry point - authorize calendar, start sync and alert loops.
 */
async function main() {
  log.info({
    pollIntervalMs: CONFIG.pollInterval,
    alertCheckIntervalMs: CONFIG.alertCheckInterval,
    lookAheadHours: CONFIG.lookAheadHours
  }, 'Meeting Alert Monitor starting');

  try {
    calendar = await calendarAuth.getCalendarClient();
    log.info('Calendar authorized successfully');
  } catch (err) {
    log.fatal({ err }, 'Calendar authorization failed');
    process.exit(1);
  }

  // Initialize followups database (for O3 tracking)
  let o3Db;
  try {
    o3Db = followupsDb.initDatabase();
    log.info('O3 database initialized');
  } catch (err) {
    log.error({ err }, 'O3 database init failed');
    // Non-fatal — O3 features will be disabled
  }

  // Initial sync
  const events = await syncCalendar();

  // Log next upcoming meeting
  if (events.length > 0) {
    const next = events[0];
    const startTime = new Date(next.start.dateTime);
    const minutesUntil = Math.round((startTime.getTime() - Date.now()) / 60000);
    log.info({ summary: next.summary, minutesUntil }, 'Next meeting');
  } else {
    log.info('No upcoming meetings');
  }

  // Set up polling interval for calendar sync
  setInterval(async () => {
    const syncedEvents = await syncCalendar();
    meetingCache.cleanupAlertState(syncedEvents);
    await checkO3Notifications(syncedEvents, o3Db);
    checkWeeklySummary(o3Db);
  }, CONFIG.pollInterval);

  // Set up alert checking interval
  setInterval(() => {
    const cached = meetingCache.loadCache();
    if (cached && cached.events) {
      checkAlerts(cached.events);
    }
  }, CONFIG.alertCheckInterval);

  // Immediate alert check
  checkAlerts(events);
  await checkO3Notifications(events, o3Db);
}

// Graceful shutdown - kill all popup children
function shutdown(signal) {
  log.info({ signal }, 'Received signal, shutting down');

  for (const [groupKey, child] of Object.entries(activePopups)) {
    try {
      child.kill();
    } catch (e) {
      // Process may have already exited
    }
  }

  activePopups = {};
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Run
main().catch(err => {
  log.fatal({ err }, 'Fatal error');
  process.exit(1);
});
