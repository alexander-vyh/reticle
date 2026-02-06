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

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Sync calendar events from Google Calendar API.
 * Falls back to cached data on API failure.
 */
async function syncCalendar() {
  const now = new Date();
  const timeMax = new Date(now.getTime() + CONFIG.lookAheadHours * 60 * 60 * 1000);

  if (!calendar) {
    console.error(`[${timestamp()}] Calendar client not initialized`);
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
    console.log(`[${timestamp()}] Calendar sync: ${events.length} upcoming events`);
    return events;
  } catch (err) {
    console.error(`[${timestamp()}] Calendar sync failed: ${err.message}`);

    // Fall back to cached data
    const cached = meetingCache.loadCache();
    if (cached && meetingCache.isCacheValid(cached)) {
      console.log(`[${timestamp()}] Using cached data (${cached.events.length} events)`);
      return cached.events;
    }

    console.error(`[${timestamp()}] No valid cache available`);
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

  console.log(`[${timestamp()}] Alert [${level}]: ${event.summary}`);

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
    return {
      id: m.id,
      summary: m.summary || 'Untitled Meeting',
      startTime: m.start.dateTime,
      platform: link.platform,
      url: link.url,
      joinLabel: platformLauncher.getJoinLabel(link.platform),
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
    console.log(`[${timestamp()}] Escalated popup ${groupKey} to ${popupData.alertLevel}`);
    return true;
  } catch (e) {
    console.error(`[${timestamp()}] Escalation write failed for ${groupKey}: ${e.message}`);
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
          console.log(`[${timestamp()}] Popup action: ${JSON.stringify(action)}`);
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
        console.error(`[${timestamp()}] Popup stderr: ${msg.trim()}`);
      }
    });
  }

  child.on('close', (code) => {
    delete activePopups[groupKey];
    if (code && code !== 0) {
      console.error(`[${timestamp()}] Popup exited with code ${code}`);
    }
  });

  child.on('error', (err) => {
    console.error(`[${timestamp()}] Failed to spawn popup: ${err.message}`);
    delete activePopups[groupKey];
  });
}

/**
 * Play a system sound using afplay.
 */
function playSound(soundFile) {
  execFile('afplay', [soundFile], (err) => {
    if (err) {
      console.error(`[${timestamp()}] Sound play failed: ${err.message}`);
    }
  });
}

/**
 * Main entry point - authorize calendar, start sync and alert loops.
 */
async function main() {
  console.log(`[${timestamp()}] Meeting Alert Monitor starting...`);
  console.log(`[${timestamp()}] Poll interval: ${CONFIG.pollInterval / 1000}s`);
  console.log(`[${timestamp()}] Alert check interval: ${CONFIG.alertCheckInterval / 1000}s`);
  console.log(`[${timestamp()}] Look-ahead: ${CONFIG.lookAheadHours} hours`);

  try {
    calendar = await calendarAuth.getCalendarClient();
    console.log(`[${timestamp()}] Calendar authorized successfully`);
  } catch (err) {
    console.error(`[${timestamp()}] Calendar authorization failed: ${err.message}`);
    process.exit(1);
  }

  // Initial sync
  const events = await syncCalendar();

  // Log next upcoming meeting
  if (events.length > 0) {
    const next = events[0];
    const startTime = new Date(next.start.dateTime);
    const minutesUntil = Math.round((startTime.getTime() - Date.now()) / 60000);
    console.log(`[${timestamp()}] Next meeting: "${next.summary}" in ${minutesUntil} minutes`);
  } else {
    console.log(`[${timestamp()}] No upcoming meetings`);
  }

  // Set up polling interval for calendar sync
  setInterval(async () => {
    const syncedEvents = await syncCalendar();
    meetingCache.cleanupAlertState(syncedEvents);
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
}

// Graceful shutdown - kill all popup children
function shutdown(signal) {
  console.log(`\n[${timestamp()}] Received ${signal}, shutting down...`);

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
  console.error(`[${timestamp()}] Fatal error: ${err.message}`);
  process.exit(1);
});
