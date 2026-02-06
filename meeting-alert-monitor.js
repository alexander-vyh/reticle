#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const calendarAuth = require('./calendar-auth');
const meetingCache = require('./meeting-cache');
const linkParser = require('./meeting-link-parser');
const platformLauncher = require('./platform-launcher');

const CONFIG = {
  pollInterval: 2 * 60 * 1000,       // 2 minutes
  alertThresholds: {
    tenMin: 10 * 60 * 1000,           // 10 minutes
    fiveMin: 5 * 60 * 1000,           // 5 minutes
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

    // Play 1-minute warning sound (no new popup, just sound)
    if (timeUntil <= 60 * 1000 && timeUntil > 45 * 1000) {
      if (!meetingCache.hasAlerted(event.id, 'oneMin')) {
        meetingCache.recordAlert(event.id, 'oneMin');
        console.log(`  🔊 1-minute warning: "${event.summary}"`);
        playSound(SOUNDS.oneMin);
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

  // Kill existing popup for the same group (upgrading alert level)
  if (activePopups[groupKey]) {
    try {
      activePopups[groupKey].kill();
    } catch (e) {
      // Process may have already exited
    }
    delete activePopups[groupKey];
  }

  spawnPopup(groupKey, popupData);
}

/**
 * Spawn an Electron popup window for the given meeting data.
 */
function spawnPopup(groupKey, popupData) {
  const dataB64 = Buffer.from(JSON.stringify(popupData)).toString('base64');

  const child = execFile(
    CONFIG.electronPath,
    [CONFIG.popupScript, dataB64],
    {
      cwd: __dirname,
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
