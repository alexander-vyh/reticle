# Claudia Deploy & Operations Design

**Date:** 2026-02-19
**Status:** Approved
**Goal:** Single-command deploy, consolidated directory structure, correct service inventory.

## Problem

Current state is fragile and scattered:
- Launchd plists point directly into the git repo, using stale `openclaw` naming
- Config in `~/.config/claudia/`, database in `~/.openclaw/workspace/`, logs next to source
- `followup-checker` has no launchd plist (only shell scripts)
- `slack-monitor.js` still running despite being superseded by `slack-events-monitor.js`
- No automated deploy: updating code requires manual git pull + npm install + restart
- Gateway plist references a separately-installed OpenClaw npm package

## Design

### Directory Structure

Consolidate under `~/.claudia/`:

```
~/.claudia/
  app/              # Deployed code (synced from git repo)
    claudia-db.js
    gmail-monitor.js
    slack-events-monitor.js
    meeting-alert-monitor.js
    followup-checker.js
    lib/
    node_modules/   # Production dependencies
    package.json
  data/
    claudia.db      # SQLite database (WAL mode)
  logs/             # All service logs
    gmail-monitor.log
    gmail-monitor-error.log
    slack-events.log
    ...
  config/           # Secrets and team data
    secrets.json
    team.json
    gmail-credentials.json
    gmail-token.json
    calendar-token.json
```

### Service Inventory

| # | Service | Launchd Label | Source File |
|---|---|---|---|
| 1 | Gmail Monitor | `ai.claudia.gmail-monitor` | gmail-monitor.js |
| 2 | Slack Events | `ai.claudia.slack-events` | slack-events-monitor.js |
| 3 | Meeting Alerts | `ai.claudia.meeting-alerts` | meeting-alert-monitor.js |
| 4 | Follow-up Checker | `ai.claudia.followup-checker` | followup-checker.js |
| 5 | Gateway | `ai.openclaw.gateway` | External (unchanged) |

**Removed:** `ai.openclaw.slack-monitor` (superseded by slack-events-monitor.js)

### Deploy Script (`bin/deploy`)

Single command that:

1. **Pulls latest** from main in the git repo
2. **Installs root dependencies** (`npm install`)
3. **Syncs code** to `~/.claudia/app/` via rsync (excluding .git, node_modules, logs, tests, docs, tray/)
4. **Installs production dependencies** in `~/.claudia/app/` (`npm install --omit=dev`)
5. **Generates launchd plists** from templates for all 4 Claudia services
6. **Loads/reloads plists** via `launchctl bootout` + `launchctl bootstrap`
7. **Restarts all services**
8. **Reports status** (shows which services are running)

### Code Changes Required

#### `claudia-db.js` — Update DB_DIR
```
- const DB_DIR = path.join(process.env.HOME, '.openclaw', 'workspace');
+ const DB_DIR = process.env.CLAUDIA_DATA_DIR || path.join(process.env.HOME, '.claudia', 'data');
```

#### `lib/config.js` — Update config dir
```
- const configDir = path.join(os.homedir(), '.config', 'claudia');
+ const configDir = process.env.CLAUDIA_CONFIG_DIR || path.join(os.homedir(), '.claudia', 'config');
```

#### `tray/service-manager.js` — Update SERVICES array
```javascript
const SERVICES = [
  { label: 'Gmail Monitor',      launchdLabel: 'ai.claudia.gmail-monitor' },
  { label: 'Slack Events',       launchdLabel: 'ai.claudia.slack-events' },
  { label: 'Meeting Alerts',     launchdLabel: 'ai.claudia.meeting-alerts' },
  { label: 'Follow-up Checker',  launchdLabel: 'ai.claudia.followup-checker' },
  { label: 'Gateway',            launchdLabel: 'ai.openclaw.gateway' },
];
```

### Launchd Plist Template

Each Claudia service plist follows this pattern:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.claudia.{{SERVICE_NAME}}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>{{HOME}}/.claudia/app/{{JS_FILE}}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{{HOME}}/.claudia/logs/{{SERVICE_NAME}}.log</string>
  <key>StandardErrorPath</key>
  <string>{{HOME}}/.claudia/logs/{{SERVICE_NAME}}-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>{{HOME}}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
```

### First-Run Migration

The deploy script handles one-time migration:

1. **Config:** If `~/.config/claudia/` exists and `~/.claudia/config/` doesn't, move (or symlink) the files
2. **Database:** If `~/.openclaw/workspace/claudia.db` exists and `~/.claudia/data/claudia.db` doesn't, move it
3. **Old plists:** Unload and remove `ai.openclaw.gmail-monitor`, `ai.openclaw.slack-monitor`, `ai.openclaw.slack-events`, `com.openclaw.meeting-alerts`
4. **Old files:** Remove `slack-monitor.js`, shell scripts (`start-*.sh`, `stop-*.sh`, `gmail-monitor.sh`)

### Cleanup (Dead Code Removal)

Files to delete from the repo:
- `slack-monitor.js` — superseded by `slack-events-monitor.js`
- `start-followup-checker.sh` — replaced by launchd
- `start-meeting-alerts.sh` — replaced by launchd
- `stop-meeting-alerts.sh` — replaced by launchd
- `gmail-monitor.sh` — replaced by launchd

### Tray App

No structural changes to the tray app beyond updating `service-manager.js` SERVICES array. It continues to run from the git repo during development (or as a built `.app`).

### What This Does NOT Cover

- Automatic deployment on merge (user runs `bin/deploy` manually)
- Log rotation (future enhancement)
- Database backup before deploy (future enhancement)
- Tray app packaging as standalone `.app` (existing `electron-builder` setup handles this)
