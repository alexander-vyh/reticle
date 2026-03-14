# Settings UI & Distributed Configuration Design

**Date:** 2026-03-13
**Status:** Draft
**Branch:** feature/ui-improvements

## Problem Statement

Reticle has no settings UI. All configuration requires hand-editing JSON files
(`secrets.json`, `team.json`) or modifying hardcoded constants in service source
files. This creates friction at two critical moments:

1. **In-the-moment reconfiguration** — adding a direct report mid-meeting, adjusting
   a notification threshold after a frustrating alert
2. **Initial setup** — pasting tokens with no validation, no connection status feedback

The system's observable behavior is scattered across three storage mechanisms
(JSON files, hardcoded constants, UserDefaults) with no single place to understand
or adjust what Reticle does.

## Non-Goals

1. **Multi-user settings** — Reticle is a single-user local app. No sync, no
   permissions, no conflict resolution.
2. **Notification mode profiles** — Focus/Normal/Meeting Day profiles are deferred
   to future work. Build individual settings first, add profiles when patterns
   emerge from actual usage.
3. **Onboarding wizard** — First-run setup is not in scope. Settings UI assumes
   the user has already configured `secrets.json` manually.
4. **Credential rotation UI** — OAuth re-auth flows stay manual. The UI shows
   connection status and allows token editing, but does not manage OAuth lifecycles.
5. **Per-notification-type tier configuration** — The 3-tier notification hierarchy
   (Ambient/Glanceable/Interruptive) is a future concern. This design covers
   escalation tiers only.

## Guiding Principles

Reticle is an instrument, not an agent. Settings UI follows the reticle metaphor:

- **Reference, not command.** Defaults provide a reference point (the crosshair).
  The user decides what to do about deviation.
- **Show deviation.** Override indicators (● dots) show where the user has diverged
  from role defaults. The instrument doesn't judge — it shows.
- **Silence is success.** Settings that are working correctly should be invisible.
  Only surface configuration when it governs something the user is actively looking at.
- **Dismissal always possible.** Every setting can be changed. No hard locks.
  Friction (navigation depth, override dots) protects deliberate choices from
  impulsive changes, but never prevents them.

## Architecture: Distributed Settings

Settings are distributed across domain views. Domain-specific configuration lives
where the user encounters its effects. System configuration lives in Settings.

### Distribution Map

| Setting | View | Rationale |
|---------|------|-----------|
| VIPs (email, title, role) | People | A VIP is a person with a role |
| Direct reports (name, email, slackId) | People | Same — people, not system config |
| Monitored people (email, name, identities) | People | Already implemented here |
| Team directory (name, team, email) | People | People with team affiliation |
| Email filter patterns (domain, group) | People | Defines "who is a known person vs. noise" |
| Per-person escalation tier override | People | Decision made while looking at a person |
| Feedback weekly target | Feedback | Behavioral goal visible in context |
| Feedback scan window | Feedback | Governs what appears in the candidate list |
| Stale commitment threshold | Commitments | Controls the red "stale" indicator on rows |
| Slack/Gmail/Jira credentials | Settings > Accounts | Prerequisite — nothing works without them |
| Polling intervals (all services) | Settings > Notifications | System timing, not domain tuning |
| Meeting alert thresholds | Settings > Notifications | Notification behavior |
| Follow-up escalation defaults | Settings > Notifications | System-level timing defaults |
| O3 prep window/timing | Settings > Notifications | Timing, not people |
| Gmail batch delivery hours | Settings > Notifications | Scheduling preference |
| Digest timing | Settings > Notifications | Scheduling preference |
| Launch at login | Settings > System | OS integration |
| Hotkeys (dictation, notes) | Settings > System | OS-level key bindings |
| Gateway/recorder ports | Settings > System | Infrastructure |
| Service start/stop | Settings > System | Operational controls |

### The Test

"Would a new user need to visit this setting before the feature works?"
- **Yes** → Settings (prerequisite)
- **No** → Domain view (tuning)

## View Designs

### 1. People View — Segmented Tabs

The People view gains VIPs, direct reports, and team directory alongside the
existing monitored people list.

**Layout:** Segmented control tab bar at the top of the detail pane. Each tab
shows one category with its own list and add affordance. Only one category
visible at a time.

```
People                                       [+ Add ▾]
─────────────────────────────────────────────────────────

┌────────────────────────────────────────────────────────┐
│ Monitored │ Direct Reports │  VIPs  │   Team           │
│═══════════│                │        │                  │
└────────────────────────────────────────────────────────┘

Monitored People (6)

┌────────────────────────────────────────────────────────┐
│  Omar Hassan    omar@acme.com     [Slack ✓] [Jira ✓]   │
│  Nina Volkov    nina@acme.com     [Slack ✓] [Jira ✗]   │
│  Raj Gupta      raj@acme.com      [Slack ✓] [Jira ✓]   │
│  Amy Liu        amy@acme.com      [Slack ✗] [Jira ✓]   │
└────────────────────────────────────────────────────────┘

                                      [+ Add Person]
```

**Per-tab field differences:**

| Tab | Fields per row | Add form fields |
|-----|---------------|-----------------|
| Monitored | Name, email, [Slack ✓/✗] [Jira ✓/✗] identity badges | email (required), name |
| Direct Reports | Name, email · @slackHandle, escalation tier | name, email, slackId |
| VIPs | Name, title, email, escalation tier | email, title |
| Team | Name, team, email | name, team, email |

**Escalation tier (Direct Reports and VIPs tabs):**

Each person row shows their current escalation tier. Role sets the default
(VIP → Immediate, Direct Report → Within 4h). Users can override per-person.
Overridden values display a ● dot indicator showing deviation from the role
default:

```
▼ Direct Reports  (default: Within 4h)
┌────────────────────────────────────────────────────────┐
│  Jake Morrison jake@acme.com            Within 4h      │
│  Priya Patel   priya@acme.com      ● [Immediate ▾]    │ ← override
│  Tom Nguyen    tom@acme.com             Within 4h      │
└────────────────────────────────────────────────────────┘
```

The ● dot is the instrument showing deviation from reference — the reticle
metaphor applied to escalation configuration.

**Escalation tier options:** Immediate, Within 4h, Daily digest, Weekly digest.

**Add flow:** Single [+ Add] button in the toolbar. Opens a popover with fields
appropriate to the currently selected tab. Popover for 2-field forms (VIPs:
email + title). Sheet for 3+ field forms (Direct Reports: name, email, slackId).

**Delete flow:** Swipe-to-delete with inline "Removed — Undo" notice that
auto-dismisses after 5 seconds. No confirmation dialog.

**Identity badges:** Keep [Slack ✓/✗] and [Jira ✓/✗] on Monitored tab only.
Remove the Gmail badge (always green = meaningless). VIPs and Direct Reports
do not show identity badges — they are reference data, not pipeline entities.

**Team tab is the UI for `dwTeamEmails`.** The team directory currently lives
in `team.json` as `dwTeamEmails` and is used by `lib/seed-data.js` for
identity seeding. After Phase 2, these are seeded into `monitored_people`
with `role = 'peer'` and a non-null `team` field.

**Email filter patterns:** Collapsible `DisclosureGroup` at the bottom of the
People view (below the tab content), labeled "Monitoring Filters." Contains
company domain and group email text fields. Collapsed by default.

### 2. Feedback View — Settings Strip

A 36px bar between the navigation title and the candidate list, using
`.background(.bar)` system chrome.

```
Feedback
───────────────────────────────────────────────────────
┌─────────────────────────────────────────────────────┐
│ Your standard: [- 3 +]/wk  ·  Scan: [24h ▾]        │ ← settings strip
└─────────────────────────────────────────────────────┘

┌──────────────────┬──────────────────────────────────┐
│ Candidates (7)   │  Detail panel                    │
│ ...              │  ...                             │
└──────────────────┴──────────────────────────────────┘
```

**Behavioral framing:**

The target displays as "Your standard: 3/wk" — identity framing, not a score.
Current progress shows as "This week: 2" — approach framing, not deficit.

Rules:
- Never show deficit ("1 remaining")
- Never show progress bars or completion percentages
- Never reset to 0/3 on Monday morning
- Show previous week as anchor until Wednesday EOD ("Last week: 3/3")

**Controls:**
- Weekly target: `Stepper` with range 1-20
- Scan window: `Picker` with `.segmented` style, options: 24h, 48h, 72h, 14d

**Auto-save:** Changes write through to the database immediately via
`PATCH /feedback/settings`.

### 3. Commitments View — Stale Threshold

The stale days threshold (currently hardcoded at 7) becomes a toolbar control
or inline control in the existing `SummaryBar`.

```
Summary: 12 total · 3 stale        Stale after: [7 ▾] days
```

`Picker` with options: 3, 5, 7, 14, 30 days. Auto-save. Persisted in
`settings.json` under `commitments.staleDays`. SwiftUI view passes the value
as a query parameter to `GET /api/commitments?staleDays=N`.

### 4. Settings View

Settings occupies a sidebar item pinned to the bottom, separated from the
data views. Triggered by clicking the sidebar item or Cmd+,.

```
Sidebar                          Detail Pane
┌─────────────────┐    ┌──────────────────────────────┐
│ Commitments     │    │                              │
│ People          │    │  Form(.grouped)              │
│ Feedback        │    │                              │
│                 │    │  Section: Accounts           │
│ Messages     ░  │    │  Section: Notifications      │
│ To-dos       ░  │    │  Section: System             │
│ Goals        ░  │    │                              │
│─────────────────│    │                              │
│ ⚙ Settings      │    │                              │
└─────────────────┘    └──────────────────────────────┘
```

`░` = disabled, non-selectable (fix current selection bug).

**Form structure:** `Form { }.formStyle(.grouped)` with `LabeledContent` for
every configurable row.

#### 4a. Accounts Section

Editable credential fields with `SecureField` + inline reveal toggle per field.
Grouped by service.

```
Section("Slack") {
    SecureField + reveal: Bot Token
    SecureField + reveal: App Token
    SecureField + reveal: Signing Secret
    TextField: User ID
    TextField: Username
    SecureField + reveal: User Token
}
Section("Gmail") {
    TextField: Account email
}
Section("Jira") {
    TextField: Base URL
    TextField: User Email
    SecureField + reveal: API Token
}
```

**Token field design:**
- `SecureField` masked by default
- Inline eye icon (`eye` / `eye.slash`) at trailing edge to toggle reveal
- `.font(.system(.body, design: .monospaced))` for token values
- `.textFieldStyle(.roundedBorder)`
- Clear button (xmark.circle.fill) on hover when field has content

**Changes to credentials require service restart.** Display inline note in
`.caption` below the section: "Changes take effect after service restart."

#### 4b. Notifications Section

Grouped by service, not by abstract property.

```
Section("Gmail") {
    Picker: Check interval (1min, 5min, 15min, 30min) — segmented
    // Batch delivery hours — advanced/future
}
Section("Meetings") {
    Picker: Alert at (multi-select: 10min, 5min, 1min, start)
    // Poll interval — advanced/future
}
Section("Follow-ups") {
    Picker: Check interval (5min, 15min, 30min) — segmented
    Stepper: Email escalation (hours)
    Stepper: Slack DM escalation (hours)
    Stepper: Slack mention escalation (hours)
}
Section("O3 Meetings") {
    Picker: Prep window start (hour picker)
    Picker: Prep window end (hour picker)
    Stepper: Min gap between O3s (minutes)
}
Section("Digest") {
    Picker: Daily digest hour
    Picker: Weekly digest day + hour
}
```

**Control types:**
- `.pickerStyle(.segmented)` for small discrete sets (2-4 options)
- `.pickerStyle(.menu)` for longer lists (5+ options like hours)
- `Stepper` where truly arbitrary numeric input is valid

#### 4c. System Section

```
Section("General") {
    Toggle: Launch at login
    TextField: Gateway port (validated, default 3001)
}
Section("Hotkeys") {
    HotkeyField: Dictation (default Option+D)
    HotkeyField: Notes (default Option+N)
}
Section("Meeting Recorder") {
    Stepper: Recording grace period (minutes, default 2)
    TextField: Recorder port (validated, default 9847)
}
Section("Services") {
    ForEach service:
        ServiceRow: name, status dot (🟢/🔴/⚪), [Start/Stop] button
}
```

**Service status dots:** Green = running, red = error/failed, gray = stopped.
Buttons use `.bordered` `.controlSize(.small)`. No `.borderedProminent`.
Start/stop calls `ServiceManager.startService()`/`stopService()` directly
from Swift via `launchctl` (existing implementation). No gateway endpoint
needed — these are OS-level process controls, not data operations.

**Hotkey recording:** Click-to-record pattern (click field, press desired
combo, done). Backed by `CaptureManager.saveHotkeyConfig()` which already
persists to UserDefaults.

### 5. Sidebar Changes

- **Add Settings** to `SidebarSection` enum with icon `gearshape`, pinned to
  bottom with visual separator
- **Fix Coming Soon bug:** Make Messages, Todos, Goals non-selectable
  (`.disabled(true)` or remove `.tag()`) so clicking them does nothing.
  Keep them visible but inert — grayed out with `.tertiary` foreground.
- **Cmd+, shortcut** via `CommandGroup` in `ReticleApp.swift` to navigate
  to Settings

## Data Architecture

### Storage Changes

**1. Add `role` column to `monitored_people`:**

```sql
ALTER TABLE monitored_people ADD COLUMN role TEXT DEFAULT 'peer';
-- Values: 'vip', 'direct_report', 'peer'
```

**2. Add `escalation_tier` column to `monitored_people`:**

```sql
ALTER TABLE monitored_people ADD COLUMN escalation_tier TEXT;
-- NULL = use role default. Values: 'immediate', '4h', 'daily', 'weekly'
```

**3. Add `title` and `team` columns to `monitored_people`:**

```sql
ALTER TABLE monitored_people ADD COLUMN title TEXT;
-- VIP title (e.g., "VP Engineering"). NULL for non-VIPs.

ALTER TABLE monitored_people ADD COLUMN team TEXT;
-- Team affiliation (e.g., "Platform", "Frontend"). NULL unless imported from dwTeamEmails.
```

**Tab-to-query mapping:**

| Tab | Query predicate |
|-----|----------------|
| Monitored | `WHERE role = 'peer' AND team IS NULL` |
| Direct Reports | `WHERE role = 'direct_report'` |
| VIPs | `WHERE role = 'vip'` |
| Team | `WHERE team IS NOT NULL AND role = 'peer'` |

**4. New `feedback_settings` table:**

```sql
CREATE TABLE IF NOT EXISTS feedback_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

Initial rows: `weeklyTarget` = `3`, `scanWindowHours` = `24`.

**5. New `~/.reticle/config/settings.json`:**

```json
{
  "polling": {
    "gmailIntervalMinutes": 5,
    "slackResponseTimeoutMinutes": 10,
    "followupCheckIntervalMinutes": 15,
    "meetingAlertPollIntervalSeconds": 120
  },
  "notifications": {
    "meetingAlertThresholds": [10, 5, 1, 0],
    "batchTimes": [9, 12, 15, 18],
    "healthCheckHour": 8,
    "lookAheadHours": 24
  },
  "thresholds": {
    "followupEscalationEmailHours": 48,
    "followupEscalationSlackDmHours": 72,
    "followupEscalationSlackMentionHours": 168
  },
  "o3": {
    "prepWindowStartHour": 14,
    "prepWindowEndHour": 15,
    "minGapMinutes": 10
  },
  "digest": {
    "dailyHour": 18,
    "weeklyWeekday": 5,
    "weeklyHour": 16
  }
}
```

Optional file. Missing keys fall back to hardcoded defaults via `??` operator.

**6. `team.json` after migration:**

```json
{
  "filterPatterns": {
    "companyDomain": "example.com",
    "dwGroupEmail": "it-group@example.com"
  },
  "dwTeamEmails": [
    {"name": "Jane Doe", "team": "CSE", "email": "jane@example.com"}
  ]
}
```

VIPs, directReports, and feedback sections removed.

### API Changes

**New/modified gateway endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/people` | Returns monitored_people with role + escalation_tier (modify existing) |
| PATCH | `/people/:email` | Update role, escalation_tier, name, slackId |
| GET | `/feedback/settings` | Read feedback_settings from DB |
| PATCH | `/feedback/settings` | Write weeklyTarget, scanWindowHours to DB |
| GET | `/settings` | Read settings.json, return parsed JSON |
| PATCH | `/settings` | Validate + write settings.json atomically, SIGHUP affected services |
| GET | `/config/accounts` | Read secrets.json (return identifiers + connection health, never raw tokens for GET) |
| PATCH | `/config/accounts` | Write specific fields to secrets.json atomically. Gateway re-reads secrets into memory after write. Other services require restart (inline caption in UI). |

### Write Path

```
SwiftUI view
  → GatewayClient HTTP call
  → gateway.js handler
  → validates input
  → writes to storage (DB or file, atomic rename for files)
  → for settings.json changes: sends SIGHUP to affected service PIDs
  → returns success + confirmation data

Service pickup:
  People/feedback (SQLite): read per-cycle, no restart needed
  Settings.json (polling/thresholds): SIGHUP triggers re-read
  Secrets (credentials): requires service restart
```

### Settings.json SIGHUP Reload

Services catch SIGHUP and re-read settings.json:

```javascript
process.on('SIGHUP', () => {
  logger.info('Received SIGHUP, reloading settings');
  Object.assign(CONFIG, loadSettings());
});
```

Gateway looks up service PIDs from heartbeat files to send signals.
Atomic file write (tmp + rename) prevents partial-read races.

**SIGHUP targeting:** The gateway maintains a mapping from settings.json key
prefixes to affected service heartbeat names:

| Settings key prefix | Service heartbeat |
|---------------------|-------------------|
| `polling.gmailIntervalMinutes` | `gmail-monitor` |
| `polling.slackResponseTimeoutMinutes` | `slack-events` |
| `polling.followupCheckIntervalMinutes` | `followup-checker` |
| `polling.meetingAlertPollIntervalSeconds` | `meeting-alerts` |
| `notifications.*` | `meeting-alerts` |
| `thresholds.*` | `followup-checker` |
| `o3.*` | `meeting-alerts` |
| `digest.*` | No SIGHUP (launchd-scheduled, reads on next run) |

**Stale PID protection:** Before sending SIGHUP, verify the PID from the
heartbeat file is still alive via `process.kill(pid, 0)` (existence check).
If the PID is stale, skip the signal — launchd will restart the service and
it will read the current settings.json on startup.

### Failure Modes

| Scenario | Behavior |
|----------|----------|
| Gateway down | GatewayClient throws; view shows inline error |
| Service crashed | launchd restarts; reads current settings.json fresh |
| Settings.json corrupt | Service falls back to hardcoded defaults; logs warning |
| SIGHUP not received | Next launchd restart applies settings; tray can show "pending" |
| Stale PID in heartbeat | `process.kill(pid, 0)` check fails; skip signal; service picks up on next launchd restart |
| Concurrent DB access | SQLite WAL mode handles atomically |

## Migration Plan

Incremental, each phase independently deployable:

**Phase 1: Schema + API** — Add role and escalation_tier columns. Add
PATCH /people/:email endpoint. No behavior change. Services still read from
team.json.

**Phase 2: Seed from team.json** — Gateway seeds monitored_people from
team.json on startup (idempotent, only if relevant roles are empty). PeopleView
gains segmented tabs and role display.

**Phase 3: Switch service reads** — Services read VIPs and direct reports from
DB per-cycle instead of config at startup. No restart needed for people changes.

**Phase 4: Feedback settings migration** — Add feedback_settings table +
endpoints. Build FeedbackView settings strip. Switch `digest-daily.js` and
`feedback-collector.js` to read from DB instead of `config.feedback`. Update
`lib/config.js` to stop exporting `feedback` (now DB-backed).

**Phase 5: Strip team.json** — Remove vips, directReports, and feedback
sections from team.json. Update remaining lib/config.js exports. Update
config/team.example.json. `dwTeamEmails` stays in team.json (one-shot
seeding data, not runtime-queried).

**Phase 6: Settings view + settings.json** — Create settings.json with
defaults. Build Settings view (Accounts, Notifications, System). Wire services
to read from settings.json with fallback defaults. Add SIGHUP reload handlers.

**Note on `gatewayPort`:** Stays in `secrets.json` (not moved to
`settings.json`). It is a bootstrap value needed before the gateway can serve
settings endpoints. Changing it requires gateway restart, which is appropriate
for an infrastructure value.

## SwiftUI Implementation Notes

**Auto-save everywhere.** No Save/Cancel buttons. `.onChange` writes immediately.
Transient checkmark confirmation (opacity fade over 1.5s) for non-obvious saves.

**Credential fields that require restart** get inline `.caption` note:
"Restart required to take effect."

**Form density:** Compact, power-user layout. `.formStyle(.grouped)` on macOS
13+. Default `Form` insets, no extra padding. System font at standard sizes.

**List style:** `.listStyle(.inset)` for People tabs. Not `.sidebar` (wrong
chrome) and not `.plain` (no separators).

**Segmented pickers** for small discrete sets (2-4 options).
**Menu pickers** for longer lists (hours, days).
**Steppers** for arbitrary numeric input with clear bounds.

## Open Questions

1. **Hotkey recording widget:** Use `KeyboardShortcuts` package or build a
   minimal NSTextField-based key capture? The UserDefaults persistence already
   exists in CaptureManager.
2. **Batch delivery hours UI:** How to present a multi-select hour picker
   (currently [9,12,15,18])? Defer to advanced settings?
3. **Connection health probing:** Should the Accounts section actively test
   connections (make a Slack API call, check Gmail OAuth) or just display
   status from heartbeat files?
