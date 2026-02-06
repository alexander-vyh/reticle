# Meeting Alert System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build un-missable meeting alerts with countdown timer and one-click join that work even during Zoom calls.

**Architecture:** Electron-based always-on-top popup spawned by a Node.js calendar polling service. The monitor polls Google Calendar every 2 minutes, caches 24 hours ahead, and spawns Electron popups at 10min/5min/start thresholds. Platform-specific launchers open Zoom app, Chrome for Meet, or Teams app.

**Tech Stack:** Node.js, Electron (always-on-top windows), Google Calendar API (googleapis), macOS `open -a` for app launching, JSON files for state.

**Design Doc:** `docs/plans/2026-02-05-meeting-alerts-design.md`

---

### Task 1: Install Electron and Create Project Structure

**Files:**
- Modify: `package.json`
- Create: `sounds/.gitkeep`

**Step 1: Add Electron dependency**

Run: `cd ~/.openclaw/workspace/.worktrees/meeting-alerts && npm install electron --save`
Expected: `added N packages` - electron appears in package.json dependencies

**Step 2: Create sounds directory**

Run: `mkdir -p ~/.openclaw/workspace/.worktrees/meeting-alerts/sounds`

**Step 3: Generate sound files using system audio**

macOS has built-in alert sounds we can use instead of shipping mp3s. Create a small utility:

Create file `sounds/generate-sounds.sh`:
```bash
#!/bin/bash
# Use macOS afplay-compatible system sounds as placeholders
# These are built-in .aiff files at /System/Library/Sounds/
# We'll reference them directly in code rather than copying
echo "System sounds will be used directly:"
echo "  5min alert:  /System/Library/Sounds/Blow.aiff"
echo "  1min alert:  /System/Library/Sounds/Sosumi.aiff"
echo "  start alert: /System/Library/Sounds/Hero.aiff"
```

Run: `chmod +x ~/.openclaw/workspace/.worktrees/meeting-alerts/sounds/generate-sounds.sh`

**Step 4: Verify Electron works**

Run: `cd ~/.openclaw/workspace/.worktrees/meeting-alerts && npx electron --version`
Expected: `v28.x.x` or similar version string

**Step 5: Commit**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
git add package.json package-lock.json sounds/
git commit -m "chore: add electron dependency and sounds directory"
```

---

### Task 2: Meeting Link Parser Module

**Files:**
- Create: `meeting-link-parser.js`
- Create: `test-meeting-link-parser.js`

**Step 1: Write the failing test**

Create file `test-meeting-link-parser.js`:
```javascript
#!/usr/bin/env node
'use strict';

const parser = require('./meeting-link-parser');

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('meeting-link-parser tests\n');

// Test 1: Zoom link in description
console.log('Zoom detection:');
assert('finds zoom link in description',
  parser.extractMeetingLink({
    description: 'Join our meeting: https://zoom.us/j/123456789?pwd=abc123',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=123'
  }),
  { platform: 'zoom', url: 'https://zoom.us/j/123456789?pwd=abc123' }
);

assert('finds zoom link with subdomain',
  parser.extractMeetingLink({
    description: 'https://simpli-fi.zoom.us/j/987654321',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=456'
  }),
  { platform: 'zoom', url: 'https://simpli-fi.zoom.us/j/987654321' }
);

// Test 2: Google Meet link
console.log('\nGoogle Meet detection:');
assert('finds meet link in location',
  parser.extractMeetingLink({
    description: '',
    location: 'https://meet.google.com/abc-defg-hij',
    htmlLink: 'https://calendar.google.com/event?eid=789'
  }),
  { platform: 'meet', url: 'https://meet.google.com/abc-defg-hij' }
);

assert('finds meet link in description',
  parser.extractMeetingLink({
    description: 'Video call: https://meet.google.com/xyz-abcd-efg\nAgenda: ...',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=101'
  }),
  { platform: 'meet', url: 'https://meet.google.com/xyz-abcd-efg' }
);

// Test 3: Teams link
console.log('\nTeams detection:');
assert('finds teams link',
  parser.extractMeetingLink({
    description: 'Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=202'
  }),
  { platform: 'teams', url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc' }
);

// Test 4: Fallback to calendar
console.log('\nFallback behavior:');
assert('falls back to calendar URL when no meeting link',
  parser.extractMeetingLink({
    description: 'Lunch with the team',
    location: 'Conference Room B',
    htmlLink: 'https://calendar.google.com/event?eid=303'
  }),
  { platform: 'calendar', url: 'https://calendar.google.com/event?eid=303' }
);

assert('handles missing description and location',
  parser.extractMeetingLink({
    htmlLink: 'https://calendar.google.com/event?eid=404'
  }),
  { platform: 'calendar', url: 'https://calendar.google.com/event?eid=404' }
);

// Test 5: Priority - location takes precedence if both have links
console.log('\nPriority:');
assert('location link takes precedence over description',
  parser.extractMeetingLink({
    description: 'Notes about the call https://meet.google.com/old-link-xyz',
    location: 'https://zoom.us/j/111222333',
    htmlLink: 'https://calendar.google.com/event?eid=505'
  }),
  { platform: 'zoom', url: 'https://zoom.us/j/111222333' }
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

**Step 2: Run test to verify it fails**

Run: `cd ~/.openclaw/workspace/.worktrees/meeting-alerts && node test-meeting-link-parser.js`
Expected: FAIL with `Cannot find module './meeting-link-parser'`

**Step 3: Write implementation**

Create file `meeting-link-parser.js`:
```javascript
#!/usr/bin/env node
'use strict';

// Patterns ordered by specificity - check location first (more reliable),
// then description. Within each field, order: zoom > meet > teams.
const PATTERNS = {
  zoom: /https?:\/\/[a-z0-9.-]*zoom\.us\/[^\s<>"')]+/i,
  meet: /https?:\/\/meet\.google\.com\/[^\s<>"')]+/i,
  teams: /https?:\/\/teams\.microsoft\.com\/[^\s<>"')]+/i
};

/**
 * Extract meeting link from a Google Calendar event.
 * Checks location first (more reliable), then description.
 * Falls back to calendar event URL if no meeting link found.
 *
 * @param {Object} event - Calendar event with description, location, htmlLink
 * @returns {{ platform: string, url: string }}
 */
function extractMeetingLink(event) {
  const location = event.location || '';
  const description = event.description || '';

  // Check location first (usually more reliable/intentional)
  for (const [platform, pattern] of Object.entries(PATTERNS)) {
    const match = location.match(pattern);
    if (match) return { platform, url: match[0] };
  }

  // Then check description
  for (const [platform, pattern] of Object.entries(PATTERNS)) {
    const match = description.match(pattern);
    if (match) return { platform, url: match[0] };
  }

  // Fallback to calendar event URL
  return { platform: 'calendar', url: event.htmlLink };
}

module.exports = { extractMeetingLink, PATTERNS };
```

**Step 4: Run test to verify it passes**

Run: `cd ~/.openclaw/workspace/.worktrees/meeting-alerts && node test-meeting-link-parser.js`
Expected: `7 passed, 0 failed`

**Step 5: Commit**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
git add meeting-link-parser.js test-meeting-link-parser.js
git commit -m "feat: add meeting link parser with Zoom/Meet/Teams detection"
```

---

### Task 3: Platform Launcher Module

**Files:**
- Create: `platform-launcher.js`
- Create: `test-platform-launcher.js`

**Step 1: Write the failing test**

Create file `test-platform-launcher.js`:
```javascript
#!/usr/bin/env node
'use strict';

const launcher = require('./platform-launcher');

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    console.log(`    expected: ${expected}`);
    console.log(`    actual:   ${actual}`);
    failed++;
  }
}

console.log('platform-launcher tests\n');

// Test command generation (dry-run mode) - doesn't actually launch apps
console.log('Command generation:');

assert('zoom generates open -a command',
  launcher.getLaunchCommand('zoom', 'https://zoom.us/j/123'),
  'open -a "zoom.us.app" "https://zoom.us/j/123"'
);

assert('meet opens in Chrome',
  launcher.getLaunchCommand('meet', 'https://meet.google.com/abc-def'),
  'open -a "Google Chrome" "https://meet.google.com/abc-def"'
);

assert('teams opens Teams app',
  launcher.getLaunchCommand('teams', 'https://teams.microsoft.com/l/meetup'),
  'open -a "Microsoft Teams" "https://teams.microsoft.com/l/meetup"'
);

assert('calendar opens in default browser',
  launcher.getLaunchCommand('calendar', 'https://calendar.google.com/event?eid=123'),
  'open "https://calendar.google.com/event?eid=123"'
);

assert('unknown platform opens in default browser',
  launcher.getLaunchCommand('unknown', 'https://example.com/meeting'),
  'open "https://example.com/meeting"'
);

// Test button label generation
console.log('\nButton labels:');
assert('zoom label', launcher.getJoinLabel('zoom'), 'Join Zoom');
assert('meet label', launcher.getJoinLabel('meet'), 'Join Meet');
assert('teams label', launcher.getJoinLabel('teams'), 'Join Teams');
assert('calendar label', launcher.getJoinLabel('calendar'), 'Open in Calendar');
assert('unknown label', launcher.getJoinLabel('unknown'), 'Join Meeting');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

**Step 2: Run test to verify it fails**

Run: `cd ~/.openclaw/workspace/.worktrees/meeting-alerts && node test-platform-launcher.js`
Expected: FAIL with `Cannot find module './platform-launcher'`

**Step 3: Write implementation**

Create file `platform-launcher.js`:
```javascript
#!/usr/bin/env node
'use strict';

const { exec } = require('child_process');

// macOS app names for platform-specific launching
const PLATFORM_APPS = {
  zoom: 'zoom.us.app',
  meet: 'Google Chrome',
  teams: 'Microsoft Teams'
};

const JOIN_LABELS = {
  zoom: 'Join Zoom',
  meet: 'Join Meet',
  teams: 'Join Teams',
  calendar: 'Open in Calendar'
};

/**
 * Get the shell command to launch a meeting (without executing it).
 * Useful for testing and logging.
 *
 * @param {string} platform - 'zoom', 'meet', 'teams', 'calendar', or other
 * @param {string} url - Meeting URL
 * @returns {string} Shell command
 */
function getLaunchCommand(platform, url) {
  const app = PLATFORM_APPS[platform];
  if (app) {
    return `open -a "${app}" "${url}"`;
  }
  return `open "${url}"`;
}

/**
 * Launch a meeting in the appropriate app.
 *
 * @param {string} platform - 'zoom', 'meet', 'teams', 'calendar', or other
 * @param {string} url - Meeting URL
 * @returns {Promise<void>}
 */
function launchMeeting(platform, url) {
  return new Promise((resolve, reject) => {
    const command = getLaunchCommand(platform, url);
    console.log(`Launching: ${command}`);
    exec(command, (error) => {
      if (error) {
        console.error(`Launch failed: ${error.message}`);
        // Fallback: try default browser
        exec(`open "${url}"`, (fallbackError) => {
          if (fallbackError) reject(fallbackError);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

/**
 * Get the label for the Join button based on platform.
 *
 * @param {string} platform
 * @returns {string}
 */
function getJoinLabel(platform) {
  return JOIN_LABELS[platform] || 'Join Meeting';
}

module.exports = { getLaunchCommand, launchMeeting, getJoinLabel, PLATFORM_APPS };
```

**Step 4: Run test to verify it passes**

Run: `cd ~/.openclaw/workspace/.worktrees/meeting-alerts && node test-platform-launcher.js`
Expected: `10 passed, 0 failed`

**Step 5: Commit**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
git add platform-launcher.js test-platform-launcher.js
git commit -m "feat: add platform launcher for Zoom/Meet/Teams"
```

---

### Task 4: Google Calendar Auth and Meeting Cache

**Files:**
- Create: `calendar-auth.js`
- Create: `meeting-cache.js`
- Create: `test-meeting-cache.js`

This task sets up calendar authorization (reusing the existing Google OAuth pattern from `gmail-auth.js`) and the 24-hour meeting cache.

**Step 1: Write calendar-auth.js**

Reference: `gmail-auth.js` (lines 1-78) uses the same OAuth2 pattern. We replicate it with `calendar.readonly` scope.

Create file `calendar-auth.js`:
```javascript
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CREDENTIALS_PATH = process.env.HOME + '/.openclaw/gmail-credentials.json';
const TOKEN_PATH = process.env.HOME + '/.openclaw/calendar-token.json';
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

/**
 * Get an authorized Google Calendar client.
 * Reuses existing gmail-credentials.json OAuth app.
 * Stores a separate token for calendar scope.
 *
 * @returns {Promise<import('googleapis').calendar_v3.Calendar>}
 */
async function getCalendarClient() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Try existing token
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);

    // Check if token needs refresh
    if (token.expiry_date && token.expiry_date < Date.now()) {
      try {
        const { credentials: refreshed } = await oAuth2Client.refreshAccessToken();
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(refreshed, null, 2));
        oAuth2Client.setCredentials(refreshed);
      } catch (err) {
        console.error('Token refresh failed, re-authorizing...');
        await getNewToken(oAuth2Client);
      }
    }

    return google.calendar({ version: 'v3', auth: oAuth2Client });
  }

  // No token - need to authorize
  await getNewToken(oAuth2Client);
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

/**
 * Interactive OAuth2 flow - opens browser for user consent.
 * Runs a temporary HTTP server to capture the callback.
 */
function getNewToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });

    console.log('\n📅 Calendar authorization required.');
    console.log('Opening browser for Google Calendar access...\n');

    const server = http.createServer(async (req, res) => {
      const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
      const code = qs.get('code');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Calendar authorized! You can close this tab.</h1>');

        try {
          const { tokens } = await oAuth2Client.getToken(code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          console.log('✓ Calendar token saved to', TOKEN_PATH);
          server.close();
          resolve();
        } catch (err) {
          server.close();
          reject(err);
        }
      }
    });

    server.listen(3000, () => {
      const { exec } = require('child_process');
      exec(`open "${authUrl}"`);
    });
  });
}

module.exports = { getCalendarClient, CREDENTIALS_PATH, TOKEN_PATH };
```

**Step 2: Write the failing cache test**

Create file `test-meeting-cache.js`:
```javascript
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cache = require('./meeting-cache');

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertTruthy(name, actual) {
  if (actual) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name} (expected truthy, got ${actual})`);
    failed++;
  }
}

// Use temp file for testing
const TEST_CACHE_PATH = '/tmp/test-meeting-cache.json';
const TEST_STATE_PATH = '/tmp/test-alert-state.json';

// Clean up before tests
try { fs.unlinkSync(TEST_CACHE_PATH); } catch (e) {}
try { fs.unlinkSync(TEST_STATE_PATH); } catch (e) {}

console.log('meeting-cache tests\n');

// Test 1: Save and load cache
console.log('Cache persistence:');
const testEvents = [
  {
    id: 'event1',
    summary: 'Team Standup',
    start: { dateTime: new Date(Date.now() + 30 * 60000).toISOString() },
    end: { dateTime: new Date(Date.now() + 60 * 60000).toISOString() },
    description: 'https://zoom.us/j/123',
    location: '',
    htmlLink: 'https://calendar.google.com/event?eid=1'
  },
  {
    id: 'event2',
    summary: 'Client Call',
    start: { dateTime: new Date(Date.now() + 120 * 60000).toISOString() },
    end: { dateTime: new Date(Date.now() + 150 * 60000).toISOString() },
    description: '',
    location: 'https://meet.google.com/abc-def',
    htmlLink: 'https://calendar.google.com/event?eid=2'
  }
];

cache.saveCache(testEvents, TEST_CACHE_PATH);
const loaded = cache.loadCache(TEST_CACHE_PATH);
assert('saves and loads events', loaded.events.length, 2);
assertTruthy('cache has timestamp', loaded.timestamp > 0);
assert('first event summary', loaded.events[0].summary, 'Team Standup');

// Test 2: Cache validity
console.log('\nCache validity:');
assertTruthy('fresh cache is valid', cache.isCacheValid(loaded));

const staleCache = { timestamp: Date.now() - 25 * 60 * 60 * 1000, events: [] };
assert('stale cache (25h) is invalid', cache.isCacheValid(staleCache), false);

const recentCache = { timestamp: Date.now() - 23 * 60 * 60 * 1000, events: [] };
assertTruthy('recent cache (23h) is valid', cache.isCacheValid(recentCache));

// Test 3: Alert state tracking
console.log('\nAlert state:');
cache.recordAlert('event1', 'tenMin', TEST_STATE_PATH);
assertTruthy('records tenMin alert', cache.hasAlerted('event1', 'tenMin', TEST_STATE_PATH));
assert('has not alerted fiveMin', cache.hasAlerted('event1', 'fiveMin', TEST_STATE_PATH), false);

cache.recordAlert('event1', 'fiveMin', TEST_STATE_PATH);
assertTruthy('records fiveMin alert', cache.hasAlerted('event1', 'fiveMin', TEST_STATE_PATH));

assert('event2 has no alerts', cache.hasAlerted('event2', 'tenMin', TEST_STATE_PATH), false);

// Test 4: Get upcoming meetings
console.log('\nUpcoming meetings:');
const upcoming = cache.getUpcomingMeetings(loaded.events, 180);
assert('both events within 3 hours', upcoming.length, 2);

const soon = cache.getUpcomingMeetings(loaded.events, 60);
assert('one event within 1 hour', soon.length, 1);
assert('soon event is Team Standup', soon[0].summary, 'Team Standup');

// Test 5: Group overlapping meetings
console.log('\nOverlapping meetings:');
const overlapping = [
  { id: 'a', summary: 'Meeting A', start: { dateTime: new Date(Date.now() + 5 * 60000).toISOString() } },
  { id: 'b', summary: 'Meeting B', start: { dateTime: new Date(Date.now() + 5.5 * 60000).toISOString() } },
  { id: 'c', summary: 'Meeting C', start: { dateTime: new Date(Date.now() + 60 * 60000).toISOString() } }
];
const groups = cache.groupOverlappingMeetings(overlapping);
assert('groups A+B together', groups.length, 2);
assert('first group has 2 meetings', groups[0].meetings.length, 2);
assert('second group has 1 meeting', groups[1].meetings.length, 1);

// Clean up
try { fs.unlinkSync(TEST_CACHE_PATH); } catch (e) {}
try { fs.unlinkSync(TEST_STATE_PATH); } catch (e) {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

**Step 3: Run test to verify it fails**

Run: `cd ~/.openclaw/workspace/.worktrees/meeting-alerts && node test-meeting-cache.js`
Expected: FAIL with `Cannot find module './meeting-cache'`

**Step 4: Write meeting-cache.js implementation**

Create file `meeting-cache.js`:
```javascript
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE_PATH = path.join(process.env.HOME, '.openclaw/workspace/meeting-cache.json');
const DEFAULT_STATE_PATH = path.join(process.env.HOME, '.openclaw/workspace/alert-state.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const OVERLAP_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes - meetings starting within this window are "overlapping"

/**
 * Save calendar events to cache file.
 */
function saveCache(events, cachePath) {
  cachePath = cachePath || DEFAULT_CACHE_PATH;
  const data = {
    timestamp: Date.now(),
    events: events
  };
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
  return data;
}

/**
 * Load cached events. Returns { timestamp, events } or null if no cache.
 */
function loadCache(cachePath) {
  cachePath = cachePath || DEFAULT_CACHE_PATH;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Check if cached data is still valid (less than 24h old).
 */
function isCacheValid(cacheData) {
  if (!cacheData || !cacheData.timestamp) return false;
  return (Date.now() - cacheData.timestamp) < CACHE_MAX_AGE_MS;
}

/**
 * Record that we've sent an alert for an event at a given level.
 * Levels: 'tenMin', 'fiveMin', 'start'
 */
function recordAlert(eventId, level, statePath) {
  statePath = statePath || DEFAULT_STATE_PATH;
  const state = loadAlertState(statePath);
  if (!state[eventId]) state[eventId] = {};
  state[eventId][level] = Date.now();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Check if we've already alerted for this event at this level.
 */
function hasAlerted(eventId, level, statePath) {
  statePath = statePath || DEFAULT_STATE_PATH;
  const state = loadAlertState(statePath);
  return !!(state[eventId] && state[eventId][level]);
}

/**
 * Load alert state from disk.
 */
function loadAlertState(statePath) {
  statePath = statePath || DEFAULT_STATE_PATH;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return {};
  }
}

/**
 * Get meetings starting within the next `minutesAhead` minutes.
 * Returns events sorted by start time (earliest first).
 */
function getUpcomingMeetings(events, minutesAhead) {
  const now = Date.now();
  const cutoff = now + minutesAhead * 60 * 1000;

  return events
    .filter(event => {
      const start = new Date(event.start.dateTime || event.start.date).getTime();
      return start > now && start <= cutoff;
    })
    .sort((a, b) => {
      const aStart = new Date(a.start.dateTime || a.start.date).getTime();
      const bStart = new Date(b.start.dateTime || b.start.date).getTime();
      return aStart - bStart;
    });
}

/**
 * Group meetings that start within OVERLAP_THRESHOLD_MS of each other.
 * Returns array of { startTime, meetings: [...] }.
 */
function groupOverlappingMeetings(events) {
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => {
    const aStart = new Date(a.start.dateTime || a.start.date).getTime();
    const bStart = new Date(b.start.dateTime || b.start.date).getTime();
    return aStart - bStart;
  });

  const groups = [];
  let currentGroup = {
    startTime: new Date(sorted[0].start.dateTime || sorted[0].start.date).getTime(),
    meetings: [sorted[0]]
  };

  for (let i = 1; i < sorted.length; i++) {
    const eventStart = new Date(sorted[i].start.dateTime || sorted[i].start.date).getTime();

    if (eventStart - currentGroup.startTime <= OVERLAP_THRESHOLD_MS) {
      currentGroup.meetings.push(sorted[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = {
        startTime: eventStart,
        meetings: [sorted[i]]
      };
    }
  }
  groups.push(currentGroup);

  return groups;
}

/**
 * Clean up alert state for events that have passed (> 2 hours ago).
 * Prevents unbounded state growth.
 */
function cleanupAlertState(events, statePath) {
  statePath = statePath || DEFAULT_STATE_PATH;
  const state = loadAlertState(statePath);
  const activeEventIds = new Set(events.map(e => e.id));
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago

  for (const eventId of Object.keys(state)) {
    if (!activeEventIds.has(eventId)) {
      // Check if all alerts are old
      const alerts = state[eventId];
      const allOld = Object.values(alerts).every(ts => ts < cutoff);
      if (allOld) delete state[eventId];
    }
  }

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

module.exports = {
  saveCache,
  loadCache,
  isCacheValid,
  recordAlert,
  hasAlerted,
  loadAlertState,
  getUpcomingMeetings,
  groupOverlappingMeetings,
  cleanupAlertState,
  DEFAULT_CACHE_PATH,
  DEFAULT_STATE_PATH,
  CACHE_MAX_AGE_MS,
  OVERLAP_THRESHOLD_MS
};
```

**Step 5: Run test to verify it passes**

Run: `cd ~/.openclaw/workspace/.worktrees/meeting-alerts && node test-meeting-cache.js`
Expected: `12 passed, 0 failed`

**Step 6: Commit**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
git add calendar-auth.js meeting-cache.js test-meeting-cache.js
git commit -m "feat: add calendar auth and meeting cache with 24h persistence"
```

---

### Task 5: Electron Popup Window

**Files:**
- Create: `meeting-popup.html`
- Create: `meeting-popup-window.js`

This is the visual component. The Electron process receives meeting data as command-line args, renders the countdown timer, and communicates back to the monitor via IPC/stdout.

**Step 1: Create the popup HTML template**

Create file `meeting-popup.html`:
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
      background: transparent;
      overflow: hidden;
      -webkit-app-region: drag;
      user-select: none;
    }

    .container {
      background: rgba(30, 30, 30, 0.95);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      padding: 16px;
      min-height: 100px;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    .header {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 12px;
      padding: 4px 8px;
      border-radius: 4px;
      display: inline-block;
    }

    .header.red { background: #dc3545; color: white; }
    .header.yellow { background: #ffc107; color: #333; }
    .header.white { background: rgba(255, 255, 255, 0.2); color: #ccc; }

    .meeting-group {
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .meeting-group:last-child {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }

    .countdown {
      font-size: 36px;
      font-weight: 200;
      color: white;
      font-variant-numeric: tabular-nums;
      margin-bottom: 4px;
    }

    .countdown.urgent { color: #ffc107; }
    .countdown.now { color: #dc3545; animation: pulse 1s infinite; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-4px); }
      75% { transform: translateX(4px); }
    }

    .shake { animation: shake 0.3s ease-in-out 3; }

    .title {
      font-size: 14px;
      font-weight: 600;
      color: white;
      margin-bottom: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .attendees {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.5);
      margin-bottom: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .join-btn {
      -webkit-app-region: no-drag;
      background: #4CAF50;
      color: white;
      border: none;
      padding: 8px 20px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: background 0.15s;
    }

    .join-btn:hover { background: #45a049; }
    .join-btn:active { background: #3d8b40; }

    .dismiss-btn {
      -webkit-app-region: no-drag;
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.4);
      font-size: 11px;
      cursor: pointer;
      margin-top: 8px;
      width: 100%;
      padding: 4px;
    }

    .dismiss-btn:hover { color: rgba(255, 255, 255, 0.7); }
    .dismiss-btn.hidden { display: none; }
  </style>
</head>
<body>
  <div class="container" id="container">
    <div class="header white" id="header">UPCOMING MEETING</div>
    <div id="meetings"></div>
    <button class="dismiss-btn" id="dismissBtn" onclick="dismiss()">Dismiss</button>
  </div>

  <script>
    const { ipcRenderer } = require('electron');

    let meetings = [];
    let alertLevel = 'tenMin';
    let reexpandInterval = null;

    // Receive meeting data from main process
    ipcRenderer.on('meeting-data', (event, data) => {
      meetings = data.meetings;
      alertLevel = data.alertLevel;
      renderMeetings();
      startCountdowns();
      configureAlertBehavior();
    });

    function renderMeetings() {
      const container = document.getElementById('meetings');
      container.innerHTML = '';

      meetings.forEach((meeting, idx) => {
        const div = document.createElement('div');
        div.className = 'meeting-group';
        div.innerHTML = `
          <div class="countdown" id="countdown-${idx}">--:--</div>
          <div class="title">${escapeHtml(meeting.summary || 'Untitled Meeting')}</div>
          <div class="attendees">${formatAttendees(meeting.attendees)}</div>
          <button class="join-btn" onclick="joinMeeting(${idx})">${escapeHtml(meeting.joinLabel || 'Join Meeting')}</button>
        `;
        container.appendChild(div);
      });
    }

    function startCountdowns() {
      updateCountdowns();
      setInterval(updateCountdowns, 1000);
    }

    function updateCountdowns() {
      const now = Date.now();
      let mostUrgent = Infinity;

      meetings.forEach((meeting, idx) => {
        const start = new Date(meeting.startTime).getTime();
        const diffMs = start - now;
        const diffMin = diffMs / 60000;
        mostUrgent = Math.min(mostUrgent, diffMin);

        const el = document.getElementById(`countdown-${idx}`);
        if (!el) return;

        if (diffMs <= 0) {
          const overMin = Math.floor(Math.abs(diffMs) / 60000);
          const overSec = Math.floor((Math.abs(diffMs) % 60000) / 1000);
          el.textContent = `-${overMin}:${String(overSec).padStart(2, '0')}`;
          el.className = 'countdown now';
        } else {
          const min = Math.floor(diffMs / 60000);
          const sec = Math.floor((diffMs % 60000) / 1000);
          el.textContent = `${min}:${String(sec).padStart(2, '0')}`;
          el.className = diffMin <= 5 ? 'countdown urgent' : 'countdown';
        }
      });

      // Update header
      const header = document.getElementById('header');
      if (mostUrgent <= 0) {
        header.textContent = 'MEETING NOW';
        header.className = 'header red';
      } else if (mostUrgent <= 5) {
        header.textContent = `MEETING IN ${Math.ceil(mostUrgent)} MIN`;
        header.className = 'header yellow';
      } else {
        header.textContent = `MEETING IN ${Math.ceil(mostUrgent)} MIN`;
        header.className = 'header white';
      }

      // Trigger shake at 1 minute and start time
      if (mostUrgent <= 1 && mostUrgent > 0.98) {
        document.getElementById('container').classList.add('shake');
        setTimeout(() => document.getElementById('container').classList.remove('shake'), 1000);
      }
      if (mostUrgent <= 0 && mostUrgent > -0.02) {
        document.getElementById('container').classList.add('shake');
        setTimeout(() => document.getElementById('container').classList.remove('shake'), 1000);
      }
    }

    function configureAlertBehavior() {
      const dismissBtn = document.getElementById('dismissBtn');

      if (alertLevel === 'start') {
        // Cannot dismiss at start time
        dismissBtn.classList.add('hidden');
      } else if (alertLevel === 'fiveMin') {
        // Can minimize but it re-expands
        dismissBtn.textContent = 'Minimize';
      } else {
        // 10min - fully dismissible
        dismissBtn.textContent = 'Dismiss';
      }
    }

    function joinMeeting(idx) {
      const meeting = meetings[idx];
      ipcRenderer.send('join-meeting', {
        platform: meeting.platform,
        url: meeting.url,
        eventId: meeting.id
      });
    }

    function dismiss() {
      ipcRenderer.send('dismiss', { alertLevel });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatAttendees(attendees) {
      if (!attendees || attendees.length === 0) return '';
      const names = attendees
        .filter(a => !a.self)
        .map(a => a.displayName || a.email.split('@')[0])
        .slice(0, 3);
      if (names.length === 0) return '';
      const suffix = attendees.length > 4 ? ` +${attendees.length - 3} more` : '';
      return `with ${names.join(', ')}${suffix}`;
    }

    // Play sound alerts
    ipcRenderer.on('play-sound', (event, soundPath) => {
      // We use the main process to play sounds via afplay
      ipcRenderer.send('play-sound-request', soundPath);
    });
  </script>
</body>
</html>
```

**Step 2: Create the Electron main process**

Create file `meeting-popup-window.js`:
```javascript
#!/usr/bin/env node
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const launcher = require('./platform-launcher');

// Parse meeting data from command line args
// Usage: electron meeting-popup-window.js <base64-encoded-json>
const meetingDataB64 = process.argv.find(a => !a.startsWith('-') && a !== '.' && !a.includes('electron') && !a.includes('meeting-popup'));
let meetingData;

try {
  meetingData = JSON.parse(Buffer.from(meetingDataB64 || '', 'base64').toString('utf8'));
} catch (e) {
  // Also try reading from stdin or direct JSON arg
  try {
    meetingData = JSON.parse(process.argv[process.argv.length - 1]);
  } catch (e2) {
    console.error('No meeting data provided');
    process.exit(1);
  }
}

const SOUNDS = {
  fiveMin: '/System/Library/Sounds/Blow.aiff',
  oneMin: '/System/Library/Sounds/Sosumi.aiff',
  start: '/System/Library/Sounds/Hero.aiff'
};

let mainWindow = null;
let reexpandInterval = null;

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth } = display.workAreaSize;

  const windowWidth = 300;
  const windowHeight = 60 + (meetingData.meetings.length * 120);

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: Math.min(windowHeight, 500),
    x: screenWidth - windowWidth - 20,
    y: 20,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // macOS-specific: float above everything including fullscreen
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.loadFile(path.join(__dirname, 'meeting-popup.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('meeting-data', meetingData);
  });

  // Set up re-expansion behavior for 5min and start alerts
  setupReexpand(meetingData.alertLevel);

  // Play initial sound based on alert level
  if (meetingData.alertLevel === 'fiveMin') {
    playSound(SOUNDS.fiveMin);
  } else if (meetingData.alertLevel === 'start') {
    playSound(SOUNDS.start);
  }
}

function setupReexpand(alertLevel) {
  if (alertLevel === 'fiveMin') {
    // Re-expand every 30 seconds if minimized
    reexpandInterval = setInterval(() => {
      if (mainWindow && mainWindow.isMinimized()) {
        mainWindow.restore();
        mainWindow.focus();
      }
    }, 30 * 1000);
  } else if (alertLevel === 'start') {
    // Re-expand every 5 seconds - cannot minimize
    reexpandInterval = setInterval(() => {
      if (mainWindow) {
        mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    }, 5 * 1000);
  }
}

function playSound(soundPath) {
  exec(`afplay "${soundPath}"`, (error) => {
    if (error) console.error('Sound play failed:', error.message);
  });
}

// IPC: Join meeting
ipcMain.on('join-meeting', (event, data) => {
  console.log(JSON.stringify({ action: 'join', ...data }));
  launcher.launchMeeting(data.platform, data.url);
});

// IPC: Dismiss
ipcMain.on('dismiss', (event, data) => {
  if (data.alertLevel === 'start') {
    // Cannot dismiss at start time - re-show
    return;
  }

  if (data.alertLevel === 'fiveMin') {
    // Minimize (will re-expand)
    mainWindow.minimize();
  } else {
    // tenMin - fully dismiss
    console.log(JSON.stringify({ action: 'dismiss' }));
    if (reexpandInterval) clearInterval(reexpandInterval);
    app.quit();
  }
});

// IPC: Play sound from renderer
ipcMain.on('play-sound-request', (event, soundPath) => {
  playSound(soundPath);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (reexpandInterval) clearInterval(reexpandInterval);
  app.quit();
});
```

**Step 3: Quick manual test of Electron popup**

Run:
```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
echo '{"alertLevel":"fiveMin","meetings":[{"id":"test1","summary":"Test Standup","startTime":"'$(date -v+5M -u +%Y-%m-%dT%H:%M:%SZ)'","platform":"zoom","url":"https://zoom.us/j/123","joinLabel":"Join Zoom","attendees":[]}]}' | base64 | xargs -I{} npx electron meeting-popup-window.js {}
```

Expected: An always-on-top popup appears in top-right corner with "MEETING IN 5 MIN", countdown timer, and "Join Zoom" button.

Close the popup window to continue.

**Step 4: Commit**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
git add meeting-popup.html meeting-popup-window.js
git commit -m "feat: add Electron popup window with countdown timer and join button"
```

---

### Task 6: Meeting Alert Monitor (Main Service)

**Files:**
- Create: `meeting-alert-monitor.js`

This is the main service that ties everything together: polls Calendar API, manages cache, calculates alert thresholds, and spawns popup windows.

**Step 1: Write meeting-alert-monitor.js**

Create file `meeting-alert-monitor.js`:
```javascript
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { fork, execFile } = require('child_process');
const calendarAuth = require('./calendar-auth');
const meetingCache = require('./meeting-cache');
const linkParser = require('./meeting-link-parser');
const platformLauncher = require('./platform-launcher');

const CONFIG = {
  pollInterval: 2 * 60 * 1000,     // 2 minutes
  alertThresholds: {
    tenMin: 10 * 60 * 1000,         // 10 minutes
    fiveMin: 5 * 60 * 1000,         // 5 minutes
    start: 0                         // At start time
  },
  alertCheckInterval: 15 * 1000,    // Check every 15 seconds
  lookAheadHours: 24,
  electronPath: path.join(__dirname, 'node_modules', '.bin', 'electron'),
  popupScript: path.join(__dirname, 'meeting-popup-window.js')
};

let calendar = null;
let activePopups = {};  // eventId -> child process

const SOUNDS = {
  fiveMin: '/System/Library/Sounds/Blow.aiff',
  oneMin: '/System/Library/Sounds/Sosumi.aiff',
  start: '/System/Library/Sounds/Hero.aiff'
};

/**
 * Fetch upcoming events from Google Calendar API.
 * Saves to cache file for offline resilience.
 */
async function syncCalendar() {
  if (!calendar) {
    console.log('  Calendar not authorized yet, skipping sync');
    return null;
  }

  const now = new Date();
  const timeMax = new Date(now.getTime() + CONFIG.lookAheadHours * 60 * 60 * 1000);

  try {
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50
    });

    const events = (res.data.items || []).filter(event => {
      // Skip all-day events (no dateTime, only date)
      if (!event.start.dateTime) return false;
      // Skip declined events
      const myAttendee = (event.attendees || []).find(a => a.self);
      if (myAttendee && myAttendee.responseStatus === 'declined') return false;
      return true;
    });

    meetingCache.saveCache(events);
    console.log(`  ✓ Synced ${events.length} meetings (next ${CONFIG.lookAheadHours}h)`);
    return events;
  } catch (error) {
    console.error(`  ✗ Calendar sync failed: ${error.message}`);

    // Fall back to cache
    const cached = meetingCache.loadCache();
    if (cached && meetingCache.isCacheValid(cached)) {
      console.log(`  ↳ Using cached data (${cached.events.length} events, ${Math.round((Date.now() - cached.timestamp) / 60000)}min old)`);
      return cached.events;
    }

    console.log('  ↳ No valid cache available');
    return null;
  }
}

/**
 * Check all upcoming meetings and trigger alerts as needed.
 */
function checkAlerts(events) {
  if (!events || events.length === 0) return;

  const now = Date.now();

  for (const event of events) {
    const startTime = new Date(event.start.dateTime).getTime();
    const timeUntil = startTime - now;

    // Skip events that started more than 5 minutes ago
    if (timeUntil < -5 * 60 * 1000) continue;

    // Check each threshold
    for (const [level, threshold] of Object.entries(CONFIG.alertThresholds)) {
      if (timeUntil <= threshold && !meetingCache.hasAlerted(event.id, level)) {
        triggerAlert(event, level);
      }
    }
  }
}

/**
 * Trigger an alert popup for a meeting.
 */
function triggerAlert(event, level) {
  const link = linkParser.extractMeetingLink(event);
  const startTime = event.start.dateTime;
  const minutesUntil = Math.round((new Date(startTime).getTime() - Date.now()) / 60000);

  console.log(`  🔔 Alert [${level}]: "${event.summary}" in ${minutesUntil}min`);

  // Record that we've alerted at this level
  meetingCache.recordAlert(event.id, level);

  // Check if there's already an active popup for overlapping meetings
  // Group meetings starting within 2 minutes of each other
  const cached = meetingCache.loadCache();
  const upcomingEvents = cached ? cached.events : [event];
  const groups = meetingCache.groupOverlappingMeetings(
    upcomingEvents.filter(e => {
      const t = new Date(e.start.dateTime).getTime() - Date.now();
      return t > -5 * 60 * 1000 && t <= CONFIG.alertThresholds.tenMin;
    })
  );

  // Find the group containing our event
  const group = groups.find(g => g.meetings.some(m => m.id === event.id));
  const meetingsToShow = group ? group.meetings : [event];

  // Build popup data
  const popupData = {
    alertLevel: level,
    meetings: meetingsToShow.map(m => {
      const mLink = linkParser.extractMeetingLink(m);
      return {
        id: m.id,
        summary: m.summary,
        startTime: m.start.dateTime,
        platform: mLink.platform,
        url: mLink.url,
        joinLabel: platformLauncher.getJoinLabel(mLink.platform),
        attendees: m.attendees || []
      };
    })
  };

  // Kill existing popup for this event group if upgrading alert level
  const groupKey = meetingsToShow.map(m => m.id).sort().join(',');
  if (activePopups[groupKey]) {
    try { activePopups[groupKey].kill(); } catch (e) {}
    delete activePopups[groupKey];
  }

  // Spawn Electron popup
  spawnPopup(groupKey, popupData);
}

/**
 * Spawn an Electron popup process.
 */
function spawnPopup(groupKey, popupData) {
  const dataB64 = Buffer.from(JSON.stringify(popupData)).toString('base64');

  const child = execFile(CONFIG.electronPath, [CONFIG.popupScript, dataB64], {
    cwd: __dirname,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  });

  child.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.action === 'join') {
          console.log(`  ✓ Joined ${msg.platform} meeting (${msg.eventId})`);
        } else if (msg.action === 'dismiss') {
          console.log(`  ↳ Alert dismissed`);
        }
      } catch (e) {
        // Not JSON, ignore
      }
    }
  });

  child.stderr.on('data', (data) => {
    // Electron outputs GPU warnings to stderr - ignore unless debugging
    const msg = data.toString().trim();
    if (msg && !msg.includes('GPU') && !msg.includes('WARNING')) {
      console.error(`  Popup error: ${msg}`);
    }
  });

  child.on('close', (code) => {
    delete activePopups[groupKey];
  });

  activePopups[groupKey] = child;
}

/**
 * Play a sound using macOS afplay.
 */
function playSound(soundFile) {
  execFile('afplay', [soundFile], (error) => {
    if (error) console.error(`Sound failed: ${error.message}`);
  });
}

/**
 * Format timestamp for logging.
 */
function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Main entry point.
 */
async function main() {
  console.log('📅 Meeting Alert Monitor');
  console.log(`   Poll interval: ${CONFIG.pollInterval / 1000}s`);
  console.log(`   Alert check: ${CONFIG.alertCheckInterval / 1000}s`);
  console.log(`   Look ahead: ${CONFIG.lookAheadHours}h\n`);

  // Authorize Google Calendar
  try {
    calendar = await calendarAuth.getCalendarClient();
    console.log('   ✓ Google Calendar authorized\n');
  } catch (error) {
    console.error(`   ✗ Calendar auth failed: ${error.message}`);
    console.error('   Run manually to complete OAuth flow\n');
  }

  // Initial sync
  let events = await syncCalendar();
  if (events) {
    const nextMeeting = events[0];
    if (nextMeeting) {
      const mins = Math.round((new Date(nextMeeting.start.dateTime).getTime() - Date.now()) / 60000);
      console.log(`   → Next: "${nextMeeting.summary}" in ${mins}min\n`);
    } else {
      console.log('   → No upcoming meetings\n');
    }
  }

  // Calendar sync loop (every 2 minutes)
  setInterval(async () => {
    console.log(`[${timestamp()}] Syncing calendar...`);
    events = await syncCalendar();
    // Clean up old alert state
    if (events) meetingCache.cleanupAlertState(events);
  }, CONFIG.pollInterval);

  // Alert check loop (every 15 seconds for precision)
  setInterval(() => {
    // Use latest cached data
    const cached = meetingCache.loadCache();
    if (cached && cached.events) {
      checkAlerts(cached.events);
    }
  }, CONFIG.alertCheckInterval);

  // Also check immediately
  if (events) checkAlerts(events);
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);

  // Kill all popup windows
  for (const [key, child] of Object.entries(activePopups)) {
    try { child.kill(); } catch (e) {}
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

**Step 2: Manual integration test**

Run:
```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
node meeting-alert-monitor.js
```

Expected output:
```
📅 Meeting Alert Monitor
   Poll interval: 120s
   Alert check: 15s
   Look ahead: 24h

   ✓ Google Calendar authorized

   ✓ Synced N meetings (next 24h)
   → Next: "Meeting Name" in Xmin
```

If calendar auth is needed, browser will open for OAuth. After auth, verify:
- Meetings are cached in `meeting-cache.json`
- Token saved to `~/.openclaw/calendar-token.json`

Press Ctrl+C to stop.

**Step 3: Commit**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
git add meeting-alert-monitor.js
git commit -m "feat: add meeting alert monitor with calendar sync and alert scheduling"
```

---

### Task 7: Startup Scripts and Integration

**Files:**
- Create: `start-meeting-alerts.sh`
- Create: `stop-meeting-alerts.sh`
- Modify: `.gitignore` (add meeting alert state files)

**Step 1: Create start script**

Create file `start-meeting-alerts.sh`:
```bash
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
```

**Step 2: Create stop script**

Create file `stop-meeting-alerts.sh`:
```bash
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
```

**Step 3: Make scripts executable**

Run:
```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
chmod +x start-meeting-alerts.sh stop-meeting-alerts.sh
```

**Step 4: Update .gitignore for meeting alert state files**

Add to `.gitignore`:
```
# Meeting alerts
meeting-cache.json
alert-state.json
meeting-alerts.log
meeting-alerts-error.log
meeting-alerts.pid
```

**Step 5: Full integration test**

Run:
```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
./start-meeting-alerts.sh
sleep 5
cat meeting-alerts.log
```

Expected: Log shows startup, calendar sync, and meeting count.

Then stop:
```bash
./stop-meeting-alerts.sh
```

**Step 6: Commit**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
git add start-meeting-alerts.sh stop-meeting-alerts.sh .gitignore
git commit -m "feat: add startup/shutdown scripts and gitignore for state files"
```

---

### Task 8: Sound Alerts at Time Thresholds

**Files:**
- Modify: `meeting-alert-monitor.js` (add 1-minute threshold sound)

The 5-minute and start sounds are already triggered when spawning popups (Task 6). We need to add a 1-minute sound that plays without spawning a new popup.

**Step 1: Add 1-minute sound trigger to meeting-alert-monitor.js**

In the `checkAlerts` function, after the threshold loop, add a sound-only check:

```javascript
// In checkAlerts(), after the threshold loop:
// Play 1-minute warning sound (no new popup, just sound)
if (timeUntil <= 60 * 1000 && timeUntil > 45 * 1000) {
  if (!meetingCache.hasAlerted(event.id, 'oneMin')) {
    meetingCache.recordAlert(event.id, 'oneMin');
    console.log(`  🔊 1-minute warning: "${event.summary}"`);
    playSound(SOUNDS.oneMin);
  }
}
```

**Step 2: Test sound plays**

Run: `afplay /System/Library/Sounds/Sosumi.aiff`
Expected: Hear the Sosumi alert sound

**Step 3: Commit**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
git add meeting-alert-monitor.js
git commit -m "feat: add 1-minute warning sound alert"
```

---

### Task 9: End-to-End Smoke Test

This is a manual verification task, not code.

**Step 1: Create a test calendar event**

Open Google Calendar and create a meeting:
- Title: "Test Alert - Delete Me"
- Time: 12 minutes from now
- Add a Zoom link in description: `https://zoom.us/j/123456789`

**Step 2: Start the monitor**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
node meeting-alert-monitor.js
```

**Step 3: Verify 10-minute alert**

Wait ~2 minutes. Expected:
- Console: `🔔 Alert [tenMin]: "Test Alert - Delete Me" in 10min`
- Popup appears in top-right corner
- Countdown timer counting down
- "Join Zoom" button visible
- Click Dismiss → popup closes

**Step 4: Verify 5-minute alert**

Wait until 5 minutes before. Expected:
- Console: `🔔 Alert [fiveMin]: ...`
- New popup with yellow header "MEETING IN 5 MIN"
- Sound plays (Blow.aiff)
- Click Minimize → popup minimizes
- After 30 seconds → popup re-expands

**Step 5: Verify 1-minute sound**

Wait until 1 minute before. Expected:
- Console: `🔊 1-minute warning: ...`
- Sosumi sound plays
- Existing popup shakes

**Step 6: Verify start-time alert**

Wait until meeting start. Expected:
- Console: `🔔 Alert [start]: ...`
- Popup header turns red "MEETING NOW"
- Hero sound plays
- Cannot dismiss (Dismiss button hidden)
- Click "Join Zoom" → Zoom app opens

**Step 7: Clean up**

- Ctrl+C to stop monitor
- Delete test calendar event
- Delete state files: `rm meeting-cache.json alert-state.json`

**Step 8: Final commit (if any fixes needed)**

```bash
cd ~/.openclaw/workspace/.worktrees/meeting-alerts
git add -A
git commit -m "fix: adjustments from end-to-end smoke test"
```

---

## Summary

| Task | Description | Key Files | Est. Steps |
|------|-------------|-----------|------------|
| 1 | Install Electron + project structure | package.json, sounds/ | 5 |
| 2 | Meeting link parser | meeting-link-parser.js + test | 5 |
| 3 | Platform launcher | platform-launcher.js + test | 5 |
| 4 | Calendar auth + meeting cache | calendar-auth.js, meeting-cache.js + test | 6 |
| 5 | Electron popup window | meeting-popup.html, meeting-popup-window.js | 4 |
| 6 | Meeting alert monitor (main) | meeting-alert-monitor.js | 3 |
| 7 | Startup/shutdown scripts | start/stop scripts, .gitignore | 6 |
| 8 | 1-minute sound alert | meeting-alert-monitor.js (modify) | 3 |
| 9 | End-to-end smoke test | Manual verification | 8 |

**Total: 9 tasks, ~45 steps**

After all tasks pass, merge the `feature/meeting-alerts` branch:
```bash
cd ~/.openclaw/workspace
git merge feature/meeting-alerts
git worktree remove .worktrees/meeting-alerts
```
