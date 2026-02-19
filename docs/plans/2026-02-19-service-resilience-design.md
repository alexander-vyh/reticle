# Service Resilience — Design Document

**Date:** 2026-02-19
**Status:** Approved

## Problem

Claudia's 5 launchd-managed services can fail silently for days. The followup-checker crashed with SQLITE_CORRUPT on every 15-minute cycle with no alert. Gmail sent-mail detection broke (missing credential file) — 275 conversations piled up as "awaiting my response" with no notification. The slack-events-monitor runs with no visible logging. launchd restarts crashed services, but nobody knows.

## Root Causes

1. **No watchdog** — LaunchAgent restarts processes but doesn't notify anyone
2. **No error escalation** — Errors are logged and swallowed; persistent failures never reach the user
3. **No startup validation** — Services start broken and run in degraded mode silently
4. **No staleness detection** — System can't tell "running" from "running but producing nothing"

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Heartbeat files + enhanced tray app | Simple, file-based, leverages existing patterns. Sockets addable later. |
| Alert channel | macOS notifications via tray app | Tray app is already the watchdog — enhance it, don't add another process |
| Health depth | Process + heartbeat (extensible to outcome metrics later) | Catches all observed failure modes. JSON format allows adding fields without protocol changes. |
| Startup failures | Fail fast + notify | Write "startup-failed" heartbeat with error details before exiting. Tray surfaces the reason. |
| Check interval | 10s for PID (existing), 30s for heartbeat reads | Heartbeat files are tiny but 30s is responsive enough for health monitoring. |

## Components

### 1. Standardized Heartbeat Protocol

**Path:** `~/.config/claudia/heartbeats/<service-name>.json`

**Format:**
```json
{
  "service": "gmail-monitor",
  "pid": 5390,
  "startedAt": 1739900000,
  "lastCheck": 1739918400,
  "uptime": 18400,
  "status": "ok",
  "checkInterval": 60000,
  "errors": {
    "lastError": null,
    "lastErrorAt": null,
    "countSinceStart": 0
  },
  "metrics": {}
}
```

**Status values:** `"ok"`, `"degraded"`, `"error"`, `"startup-failed"`, `"shutting-down"`

**Staleness:** If `now - lastCheck > checkInterval * 3`, the service is "unresponsive."

**Write strategy:** Atomic write via `fs.writeFileSync` to `.tmp` file, then `fs.renameSync`.

### 2. Startup Validation

Each service validates prerequisites before entering main loop:

| Service | Validates |
|---------|-----------|
| gmail-monitor | gmail-credentials.json, gmail-token.json, DB quick_check |
| slack-monitor | SLACK_BOT_TOKEN, SLACK_USER_TOKEN in config |
| slack-events | SLACK_APP_TOKEN, bot token in config |
| meeting-alerts | Calendar token, DB quick_check |
| followup-checker | DB quick_check |

On failure: write heartbeat with `status: "startup-failed"` + error list, then `process.exit(1)`.

### 3. Graceful Shutdown (SIGTERM Handlers)

Every service handles SIGTERM:
1. Log the signal
2. Write heartbeat with `status: "shutting-down"`
3. Close DB connections
4. Exit cleanly (code 0)

`slack-events-monitor` already has this. The others need it added.

### 4. LaunchAgent Plist Improvements

All services get:
- `ExitTimeOut: 15` — explicit SIGTERM-to-SIGKILL window
- `ProcessType` — `Background` for monitors, `Adaptive` for gateway + meeting-alerts

Network-dependent services also get:
- `KeepAlive > NetworkState: true` — don't restart-loop when WiFi is off
- `KeepAlive > SuccessfulExit: false` — don't restart on clean exit
- `ThrottleInterval: 30` (monitors) or `15` (meeting-alerts) or `10` (gateway)

### 5. Enhanced Tray App

**Heartbeat reading (30-second cycle):**

| Heartbeat State | Tray Shows |
|---|---|
| `status: "ok"`, fresh `lastCheck` | Running (green) |
| `status: "ok"`, stale `lastCheck` (>3x interval) | Unresponsive (yellow) |
| `status: "degraded"` | Degraded (yellow) |
| `status: "error"` or `"startup-failed"` | Error (red) |
| No heartbeat file | Unknown (gray) |
| PID dead (from launchctl) | Stopped/crashed (red) |

**Context menu shows heartbeat info:**
```
Green  Gmail Monitor  (PID 5390, last check 2s ago)
Yellow Followup Checker  (PID 7492, 42 errors, last check 18m ago)
Red    Slack Events  (startup failed: missing SLACK_APP_TOKEN)
```

**Notifications fire on state transitions:**
- Any service stops/crashes
- Any service becomes unresponsive
- Any service fails startup (with reason)
- Any service recovers (positive confirmation)

**Notification deduplication:** Track last notification per service. Re-notify after 15 minutes if condition persists, immediately on state change.

## Testing — Outcome-Focused

| # | Test | Verifies |
|---|------|----------|
| 1 | Stale heartbeat triggers unresponsive status | Detects running-but-stuck services (the followup-checker failure) |
| 2 | Startup failure heartbeat surfaces error reason | User learns WHY a service is crash-looping (the gmail-token gap) |
| 3 | Missing credentials caught at startup | Services fail fast instead of silently degrading |
| 4 | Corrupted DB caught at startup | SQLITE_CORRUPT scenario detected before main loop |
| 5 | Heartbeat write is atomic (no partial reads) | Tray app never reads corrupted JSON |
| 6 | Same error state doesn't spam notifications | Alert once, remind after 15 min, don't fire every 30s |
| 7 | Recovery fires positive notification | User knows when something fixes itself |

**Test files:** `test-heartbeat.js`, `test-startup-validation.js`
**Pattern:** Plain Node.js `assert` module, runnable standalone

## Future Extensions (no design changes needed)

- **Outcome metrics:** Add `metrics.conversationsResolvedToday`, `metrics.sentMailCheckSuccess` to heartbeat. Tray app checks for staleness.
- **Error rate tracking:** Add `errors.countLastHour` to heartbeat. Tray alerts if threshold exceeded.
- **Socket health probes:** Add Unix domain socket endpoints for real-time event-loop liveness checks.
