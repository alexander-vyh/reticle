# Meeting Alert System Design

## Overview

Un-missable meeting alert system with countdown timer and join button that works even during Zoom meetings.

**Goal:** Prevent missed meetings by providing persistent, impossible-to-ignore alerts with one-click join functionality.

**Core Principle:** Respectful but insistent - alerts escalate in urgency as meeting time approaches, ensuring visibility without being obnoxious outside critical windows.

---

## Requirements

### User Needs
- Alert for upcoming meetings before they start
- Visual countdown timer showing time remaining
- One-click join button launching correct platform (Zoom app, Chrome for Meet, Teams app)
- Works even when already in a Zoom meeting
- Handles overlapping meetings gracefully

### Non-Functional Requirements
- Always-on-top popup windows (must override all other windows)
- Low resource usage (runs continuously)
- Graceful handling of network failures
- No missed alerts due to API downtime (24h cache)

---

## Design Decisions

### 1. Alert Timing (Option B - Aggressive)

**Timing Windows:**
- **10 minutes before:** Single dismissible alert
- **5 minutes before:** Persistent alert (re-expands every 30s if minimized)
- **At start time:** Force full-size popup, cannot minimize

**Sound Alerts:**
- 5-minute mark: Gentle chime
- 1-minute mark: More urgent tone
- Start time: Persistent alert sound until acknowledged

**Rationale:** Users want "un-missable" alerts. Aggressive timing ensures no meetings slip through while allowing early dismissal for prepared users.

### 2. Popup Mechanism (Option C - Respectful but Insistent)

**Behavior by Time:**
- **10min:** Normal dismissible popup
- **5min:** Auto-expands every 30 seconds if minimized, gentle chime
- **1min:** More urgent tone, faster re-expansion (every 15s)
- **Start:** Full-size lock, persistent sound until clicked

**Always-on-top:** Yes, overrides all windows including Zoom meetings

**Rationale:** Balances user autonomy (can dismiss early) with reliability (impossible to miss at crunch time).

### 3. Meeting Sources (Option A - Google Calendar Only)

**Data Source:** Google Calendar API only (no Slack/email parsing)

**Authorization:** Reuse existing `~/.openclaw/google-credentials.json` with calendar scope added

**Cache Strategy:**
- Fetch 24 hours ahead
- Refresh every 2 minutes
- Persist to `meeting-cache.json` for offline resilience

**Rationale:** Calendar is single source of truth. Email/Slack invites eventually sync to calendar, so no need to parse multiple sources.

### 4. Join Behavior (Option A - Smart Auto-Detect)

**Platform Detection:**
- **Zoom:** Detect `zoom.us` links → Launch Zoom app with `open -a zoom.us.app [URL]`
- **Google Meet:** Detect `meet.google.com` → Launch Chrome specifically with `open -a "Google Chrome" [URL]`
- **Microsoft Teams:** Detect `teams.microsoft.com` → Launch Teams app
- **Unknown:** Open default calendar event URL in default browser

**Link Extraction:**
- Parse meeting description and location fields
- Regex patterns for Zoom/Meet/Teams URLs
- Fallback to Google Calendar event page if no link found

**Rationale:** Users expect intelligent behavior - Zoom meetings should open native app, Meet should open Chrome (not Safari), etc.

### 5. Already-in-Meeting Handling (Option A - Always Alert)

**Behavior:** Always show alerts for next meeting, even if currently in another meeting

**Detection:** Don't attempt to detect current meeting state - always alert on schedule

**Rationale:** User explicitly wants alerts "even if I'm in a zoom meeting" - no need for smart detection, just always alert.

### 6. Overlapping Meetings (Option B - Combined Popup)

**Display:** Single popup window showing list of overlapping meetings

**Layout:**
```
🔴 MEETINGS STARTING NOW
┌─────────────────────────────────┐
│ ⏱️ 0:00  Team Standup           │
│ [Join Zoom]                     │
├─────────────────────────────────┤
│ ⏱️ 0:00  Client Call            │
│ [Join Meet]                     │
└─────────────────────────────────┘
```

**Behavior:**
- Show most urgent meeting at top
- Individual Join button per meeting
- Clicking Join doesn't dismiss popup (can join multiple)
- Manual dismiss button at bottom

**Rationale:** Combined view prevents screen clutter while maintaining visibility of all conflicts.

---

## Visual Design

### Popup Window Specifications

**Dimensions:**
- Width: 300px
- Height: Dynamic (120px per meeting + 60px header)
- Position: Screen edge (top-right), 20px padding

**Color Coding:**
- 🔴 Red: Meeting started (0:00 or negative)
- 🟡 Yellow: <5 minutes until start
- ⚪ White: >5 minutes until start

**Layout Components:**
```
┌─────────────────────────────────┐
│ 🟡 MEETING IN 3 MINUTES         │ ← Header (color-coded)
├─────────────────────────────────┤
│ ⏱️ 3:24                          │ ← Countdown timer (large)
│                                 │
│ Team Standup                    │ ← Meeting title
│ with @john, @sarah              │ ← Attendees (truncated)
│                                 │
│        [Join Zoom]              │ ← Join button (centered)
└─────────────────────────────────┘
      [Dismiss]                      ← Dismiss (5min+ only)
```

**Always-on-Top:** Use Electron's `alwaysOnTop: true` + macOS window level manipulation

**Animation:** Fade-in (200ms), shake animation at 1min and start time

---

## Implementation Architecture

### Core Components

#### 1. meeting-alert-monitor.js
**Purpose:** Main service process managing calendar sync and alert scheduling

**Responsibilities:**
- Poll Google Calendar API every 2 minutes
- Maintain `meeting-cache.json` (24-hour window)
- Calculate next alert times (10min, 5min, start)
- Spawn popup windows when thresholds hit
- Track alert state (which meetings already alerted)

**Key Functions:**
```javascript
async function fetchUpcomingMeetings(calendar) {
  // Fetch next 24 hours from Calendar API
  // Save to meeting-cache.json
}

function calculateNextAlerts(meetings) {
  // For each meeting, compute 10min/5min/start times
  // Return list of pending alerts sorted by time
}

function shouldAlert(meeting, currentTime, alertState) {
  // Check if we've already alerted for this threshold
  // Return alert level: 10min, 5min, or start
}

function spawnPopup(meeting, alertLevel) {
  // Fork meeting-popup-window.js with meeting data
  // Track popup process reference
}
```

**State Files:**
- `meeting-cache.json` - Raw calendar events (24h ahead)
- `alert-state.json` - Which meetings alerted at which levels
- `meeting-alerts.log` - Service log
- `meeting-alerts.pid` - Process ID

#### 2. meeting-popup-window.js
**Purpose:** Electron-based always-on-top popup window

**Responsibilities:**
- Create always-on-top window at screen edge
- Render countdown timer (updates every second)
- Handle Join button clicks (launch platform)
- Handle Dismiss button (if allowed by alert level)
- Auto-expand if minimized (5min/1min/start behavior)
- Play sound alerts at thresholds

**Electron Configuration:**
```javascript
const window = new BrowserWindow({
  width: 300,
  height: 180,
  alwaysOnTop: true,
  frame: false,
  transparent: true,
  skipTaskbar: true,
  resizable: false,
  x: screen.width - 320,
  y: 20
});

// macOS-specific always-on-top enforcement
window.setAlwaysOnTop(true, 'floating');
window.setVisibleOnAllWorkspaces(true);
```

**IPC Communication:**
- Monitor → Popup: Meeting data, alert level
- Popup → Monitor: Join clicked, Dismiss clicked
- Timer updates: Local (no IPC needed)

**Sound Assets:**
- `sounds/5min-alert.mp3` - Gentle chime
- `sounds/1min-alert.mp3` - More urgent
- `sounds/start-alert.mp3` - Persistent tone

#### 3. meeting-link-parser.js
**Purpose:** Extract and classify meeting links

**Responsibilities:**
- Parse Calendar event description and location
- Detect Zoom/Meet/Teams/generic links
- Return platform type and URL

**Detection Patterns:**
```javascript
const PATTERNS = {
  zoom: /https?:\/\/[a-z0-9.]*zoom\.us\/[^\s]*/i,
  meet: /https?:\/\/meet\.google\.com\/[^\s]*/i,
  teams: /https?:\/\/teams\.microsoft\.com\/[^\s]*/i
};

function extractMeetingLink(event) {
  const text = `${event.description || ''} ${event.location || ''}`;

  for (const [platform, pattern] of Object.entries(PATTERNS)) {
    const match = text.match(pattern);
    if (match) return { platform, url: match[0] };
  }

  // Fallback to calendar event URL
  return { platform: 'calendar', url: event.htmlLink };
}
```

#### 4. platform-launcher.js
**Purpose:** Launch meeting platform with correct application

**Platform-Specific Commands:**
```javascript
function launchMeeting(platform, url) {
  switch (platform) {
    case 'zoom':
      exec(`open -a zoom.us.app "${url}"`);
      break;
    case 'meet':
      exec(`open -a "Google Chrome" "${url}"`);
      break;
    case 'teams':
      exec(`open -a "Microsoft Teams" "${url}"`);
      break;
    default:
      exec(`open "${url}"`); // Default browser
  }
}
```

### Data Flow

```
Google Calendar API (every 2min)
          ↓
meeting-alert-monitor.js
          ↓
   meeting-cache.json (persist)
          ↓
Calculate alert times (10min/5min/start)
          ↓
Check alert-state.json (already alerted?)
          ↓ (threshold hit)
Spawn meeting-popup-window.js (Electron)
          ↓ (render)
Popup Window (always-on-top, countdown timer)
          ↓ (user clicks Join)
meeting-link-parser.js (detect platform)
          ↓
platform-launcher.js (open -a ...)
          ↓
Zoom app / Chrome / Teams app launches
```

---

## Error Handling & Edge Cases

### Calendar API Failures

**Scenario:** Google Calendar API becomes unreachable

**Handling:**
- Continue using cached data (valid for 24 hours)
- Show small warning icon in popup: "⚠️ Calendar sync paused"
- Log errors to `meeting-alerts-error.log`
- Retry connection every 5 minutes in background
- Never block alerts - cache is the fallback

**Code:**
```javascript
async function syncCalendar() {
  try {
    const events = await calendar.events.list({...});
    fs.writeFileSync('meeting-cache.json', JSON.stringify(events));
    lastSuccessfulSync = Date.now();
  } catch (error) {
    console.error('Calendar sync failed:', error);
    if (Date.now() - lastSuccessfulSync > 24 * 60 * 60 * 1000) {
      // Cache expired - show critical warning
      notifyUser('Calendar cache expired - alerts may be stale');
    }
  }
}
```

### Meeting Link Extraction Failures

**Scenario:** No Zoom/Meet/Teams link found in event

**Handling:**
- Join button still appears (never hide it)
- Opens Google Calendar event page as fallback
- Button text changes: "Open in Calendar"

**Rationale:** Always provide an action - user can find link manually in calendar if needed.

### Process Crashes

**Scenario:** meeting-alert-monitor.js crashes unexpectedly

**Handling:**
- Use systemd-style startup script (like `start-followup-checker.sh`)
- Auto-restart with exponential backoff (1s, 2s, 4s, 8s, max 60s)
- Preserve state across restarts (alert-state.json survives)
- Log crash dumps for debugging

**Startup Script:**
```bash
#!/bin/bash
cd ~/.openclaw/workspace
while true; do
  nohup node meeting-alert-monitor.js > meeting-alerts.log 2> meeting-alerts-error.log &
  echo $! > meeting-alerts.pid
  wait $!
  echo "Process crashed, restarting in 5s..."
  sleep 5
done
```

### User Dismisses Too Early

**Scenario:** User dismisses 10-minute alert but then forgets

**Handling:**
- 10min alert: Dismissible, no re-trigger
- 5min alert: Will re-trigger even if 10min was dismissed
- Start alert: Will re-trigger even if all previous dismissed

**Rationale:** Each threshold is independent - dismissing early alerts doesn't prevent later urgent ones.

### Timezone Changes

**Scenario:** User travels to different timezone or calendar event has different timezone

**Handling:**
- Calendar API returns events in UTC
- Convert to system local timezone for display
- Comparisons use UTC internally to avoid DST bugs
- Countdown timer always shows time until meeting in user's current timezone

**Code:**
```javascript
// Store meeting time as UTC timestamp
const meetingTime = new Date(event.start.dateTime).getTime();

// Display in local timezone
const localTime = new Date(meetingTime).toLocaleTimeString();

// Calculate countdown using UTC
const minutesUntil = (meetingTime - Date.now()) / 60000;
```

### Overlapping Meetings

**Scenario:** Two meetings start at same time or within 1 minute

**Handling:**
- Single popup with both meetings listed
- Most urgent (earliest start) at top
- Individual Join buttons (can join both)
- Popup persists until manually dismissed or both meetings pass

### Electron Installation Failures

**Scenario:** `npm install electron` fails due to network/platform issues

**Handling:**
- Installation script checks for electron availability
- If missing, provides manual installation instructions
- Fallback to AppleScript-based popup (lower quality but functional)

---

## Testing Strategy

### Unit Tests (test-meeting-alert.js)

**Link Parser Tests:**
```javascript
describe('meeting-link-parser', () => {
  it('extracts Zoom links from description', () => {
    const event = { description: 'Join: https://zoom.us/j/123456789' };
    const result = extractMeetingLink(event);
    expect(result.platform).toBe('zoom');
    expect(result.url).toContain('zoom.us');
  });

  it('extracts Meet links from location', () => {
    const event = { location: 'https://meet.google.com/abc-defg-hij' };
    const result = extractMeetingLink(event);
    expect(result.platform).toBe('meet');
  });

  it('falls back to calendar URL when no link found', () => {
    const event = { description: 'No link here', htmlLink: 'https://calendar.google.com/event?eid=123' };
    const result = extractMeetingLink(event);
    expect(result.platform).toBe('calendar');
  });
});
```

**Alert Timing Tests:**
```javascript
describe('alert timing calculations', () => {
  it('calculates 10min threshold correctly', () => {
    const meetingTime = Date.now() + 11 * 60 * 1000; // 11 minutes from now
    const shouldAlert = checkAlertThreshold(meetingTime, 'tenMin');
    expect(shouldAlert).toBe(false);

    const meetingTime2 = Date.now() + 9 * 60 * 1000; // 9 minutes from now
    const shouldAlert2 = checkAlertThreshold(meetingTime2, 'tenMin');
    expect(shouldAlert2).toBe(true);
  });
});
```

**Cache Expiry Tests:**
```javascript
describe('cache validation', () => {
  it('uses cache when less than 24h old', () => {
    const cache = { timestamp: Date.now() - 1000, events: [...] };
    expect(isCacheValid(cache)).toBe(true);
  });

  it('rejects cache when more than 24h old', () => {
    const cache = { timestamp: Date.now() - 25 * 60 * 60 * 1000, events: [...] };
    expect(isCacheValid(cache)).toBe(false);
  });
});
```

### Integration Tests

**Mock Calendar API:**
```javascript
describe('calendar sync integration', () => {
  it('fetches and caches upcoming meetings', async () => {
    const mockCalendar = {
      events: {
        list: jest.fn().mockResolvedValue({
          data: { items: [mockEvent1, mockEvent2] }
        })
      }
    };

    await syncCalendar(mockCalendar);

    const cache = JSON.parse(fs.readFileSync('meeting-cache.json'));
    expect(cache.events).toHaveLength(2);
  });
});
```

**Popup Spawning:**
```javascript
describe('popup spawning', () => {
  it('spawns popup when threshold hit', () => {
    const meeting = { start: { dateTime: new Date(Date.now() + 5 * 60 * 1000) } };
    const popupProcess = spawnPopup(meeting, 'fiveMin');
    expect(popupProcess).toBeDefined();
    expect(popupProcess.pid).toBeGreaterThan(0);
  });
});
```

**Overlapping Meetings:**
```javascript
describe('overlapping meetings', () => {
  it('combines two meetings starting within 1 minute', () => {
    const meeting1 = { start: { dateTime: '2026-02-05T10:00:00Z' } };
    const meeting2 = { start: { dateTime: '2026-02-05T10:00:30Z' } };

    const combined = groupOverlappingMeetings([meeting1, meeting2]);
    expect(combined).toHaveLength(1);
    expect(combined[0].meetings).toHaveLength(2);
  });
});
```

### Manual Testing Checklist

**Basic Flow:**
- [ ] Create test meeting in 15 minutes
- [ ] Wait for 10-minute alert to appear
- [ ] Verify countdown timer is accurate
- [ ] Click Dismiss - popup should close
- [ ] Wait for 5-minute alert to re-appear
- [ ] Verify 5min alert cannot be fully dismissed (minimizes only)
- [ ] Wait for start-time alert
- [ ] Click Join - verify Zoom/Meet/Teams launches correctly
- [ ] Verify alert is dismissed after joining

**Edge Cases:**
- [ ] Create overlapping meetings (same start time)
- [ ] Verify combined popup shows both meetings
- [ ] Click Join on one meeting, verify popup remains with second meeting
- [ ] Create meeting with no Zoom/Meet link
- [ ] Verify Join button shows "Open in Calendar"
- [ ] Stop Calendar API (simulate network failure)
- [ ] Verify alerts continue from cache
- [ ] Verify warning icon appears in popup
- [ ] Create meeting while already in another Zoom call
- [ ] Verify alert still appears (always-on-top)

**Platform Testing:**
- [ ] Zoom link: Verify opens Zoom app (not browser)
- [ ] Meet link: Verify opens Chrome specifically (not Safari)
- [ ] Teams link: Verify opens Teams app
- [ ] Generic link: Verify opens default browser

**Persistence Testing:**
- [ ] Kill meeting-alert-monitor.js process
- [ ] Verify auto-restart from startup script
- [ ] Verify alert-state.json preserved (no duplicate alerts)
- [ ] Restart computer
- [ ] Verify service starts on login (if configured)

---

## Deployment

### Installation

**Dependencies:**
```json
{
  "dependencies": {
    "googleapis": "^118.0.0",  // Already installed
    "electron": "^28.0.0",      // New
    "better-sqlite3": "^9.2.2"  // Already installed
  }
}
```

**Install Command:**
```bash
cd ~/.openclaw/workspace
npm install electron
```

**File Structure:**
```
~/.openclaw/workspace/
├── meeting-alert-monitor.js       # Main service
├── meeting-popup-window.js        # Electron popup
├── meeting-link-parser.js         # URL extraction
├── platform-launcher.js           # App launching
├── start-meeting-alerts.sh        # Startup script
├── meeting-cache.json             # Calendar cache (generated)
├── alert-state.json               # Alert tracking (generated)
├── meeting-alerts.log             # Service log
├── meeting-alerts-error.log       # Error log
├── meeting-alerts.pid             # Process ID
└── sounds/
    ├── 5min-alert.mp3
    ├── 1min-alert.mp3
    └── start-alert.mp3
```

### Startup Script

**start-meeting-alerts.sh:**
```bash
#!/bin/bash
cd ~/.openclaw/workspace

# Check if already running
if [ -f meeting-alerts.pid ]; then
  OLD_PID=$(cat meeting-alerts.pid)
  if ps -p $OLD_PID > /dev/null; then
    echo "Meeting alerts already running (PID: $OLD_PID)"
    exit 0
  fi
fi

# Start service
nohup node meeting-alert-monitor.js > meeting-alerts.log 2> meeting-alerts-error.log &
echo $! > meeting-alerts.pid
echo "Meeting alerts started (PID: $(cat meeting-alerts.pid))"
```

**Make executable:**
```bash
chmod +x start-meeting-alerts.sh
```

**Stop script (stop-meeting-alerts.sh):**
```bash
#!/bin/bash
if [ -f meeting-alerts.pid ]; then
  PID=$(cat meeting-alerts.pid)
  kill $PID
  rm meeting-alerts.pid
  echo "Meeting alerts stopped"
else
  echo "No PID file found"
fi
```

### Google Calendar Authorization

**Add calendar scope to existing credentials:**
```javascript
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',      // Existing
  'https://www.googleapis.com/auth/calendar.readonly'  // New
];
```

**Re-authorize:**
```bash
# Delete existing token to trigger re-auth with new scope
rm ~/.openclaw/google-token.json
node meeting-alert-monitor.js  # Will prompt for authorization
```

### Initial Testing

**Step 1: Create test meeting**
```bash
# Create meeting in Google Calendar for 10 minutes from now
```

**Step 2: Start service**
```bash
./start-meeting-alerts.sh
```

**Step 3: Monitor logs**
```bash
tail -f meeting-alerts.log
```

**Expected output:**
```
Meeting Alert Monitor started
✓ Google Calendar authorized
✓ Cached 3 meetings for next 24 hours
→ Next alert: Team Standup in 9m (10min threshold)
```

**Step 4: Wait for alerts**
- 10min alert should appear
- Dismiss and verify 5min re-trigger
- Test Join button

**Step 5: Verify state files**
```bash
cat meeting-cache.json  # Should show cached events
cat alert-state.json    # Should show alerted meetings
```

---

## Future Enhancements

### Phase 2 Features (Post-MVP)

1. **Snooze Functionality**
   - "Remind me in 2 minutes" button
   - Temporary dismissal with re-trigger
   - Snooze tracking in alert-state.json

2. **Meeting Preparation Checklist**
   - Show linked documents (Google Docs, Notion)
   - Pre-meeting reminders (e.g., "Bring quarterly report")
   - Integration with task systems

3. **Smart Meeting Detection**
   - Detect if already in Zoom call
   - Suppress alerts if already joined this meeting
   - Show "Already in meeting" status in popup

4. **Calendar Conflict Detection**
   - Warn about double-bookings
   - Suggest meeting rejection/reschedule
   - Integration with calendar editing

5. **Custom Alert Rules**
   - Different timing per calendar/organizer
   - VIP meetings: Extra-early alerts
   - Recurring meetings: Reduced urgency

6. **Slack Integration**
   - Send backup alerts to Slack DM
   - Post to personal channel as fallback
   - Link to meeting-alert-monitor status

7. **Meeting Analytics**
   - Track meetings attended vs missed
   - Alert effectiveness metrics
   - Optimal alert timing recommendations

---

## Success Metrics

**Primary Metrics:**
- Zero missed meetings after deployment
- User reports "impossible to miss" alerts
- Join button success rate >95%

**Performance Metrics:**
- API sync latency <2 seconds
- Popup spawn time <500ms
- CPU usage <1% idle, <5% during alert
- Memory usage <100MB

**Reliability Metrics:**
- Uptime >99.9% (excluding intentional restarts)
- Cache hit rate >95% (API failures are rare)
- Zero alert duplicates or missing alerts

---

## Rollback Plan

**If system causes issues:**

1. **Stop service:**
```bash
./stop-meeting-alerts.sh
pkill -f meeting-alert-monitor
pkill -f meeting-popup-window
```

2. **Remove from startup:**
```bash
# If added to login items
# System Preferences → Users & Groups → Login Items → Remove
```

3. **Restore previous state:**
```bash
git log --oneline -10
git checkout <commit-before-meeting-alerts>
```

4. **Remove generated files:**
```bash
rm meeting-cache.json alert-state.json meeting-alerts.pid
rm meeting-alerts.log meeting-alerts-error.log
```

**Gradual rollout option:**
- Test with single test calendar first
- Run for 1 week before production calendar
- Monitor logs daily for first week
- Adjust timing thresholds based on feedback
