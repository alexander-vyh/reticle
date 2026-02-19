# Deploy & Operations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Single-command `bin/deploy` that syncs code, generates launchd plists, restarts services, and consolidates everything under `~/.claudia/`.

**Architecture:** Code stays in the git repo for development. `bin/deploy` rsyncs to `~/.claudia/app/`, generates launchd plists pointing there, and manages service lifecycle via `launchctl`. Config, data, and logs all live under `~/.claudia/`.

**Tech Stack:** Bash (deploy script), macOS launchd, Node.js, rsync

---

### Task 1: Update DB and Config Paths

Update `claudia-db.js` and `lib/config.js` to use `~/.claudia/` paths with env var overrides for test isolation.

**Files:**
- Modify: `claudia-db.js:8-9`
- Modify: `lib/config.js:7`
- Modify: `.gitignore` (add claudia.db pattern)
- Test: `test-claudia-db.js` (existing tests use CLAUDIA_DB_PATH env override, no changes needed)

**Step 1: Update claudia-db.js DB_DIR**

Change lines 8-9 from:
```javascript
const DB_DIR = path.join(process.env.HOME, '.openclaw', 'workspace');
const DB_PATH = process.env.CLAUDIA_DB_PATH || path.join(DB_DIR, 'claudia.db');
```
To:
```javascript
const DB_DIR = process.env.CLAUDIA_DATA_DIR || path.join(process.env.HOME, '.claudia', 'data');
const DB_PATH = process.env.CLAUDIA_DB_PATH || path.join(DB_DIR, 'claudia.db');
```

**Step 2: Update lib/config.js configDir**

Change line 7 from:
```javascript
const configDir = path.join(os.homedir(), '.config', 'claudia');
```
To:
```javascript
const configDir = process.env.CLAUDIA_CONFIG_DIR || path.join(os.homedir(), '.claudia', 'config');
```

**Step 3: Update .gitignore**

Add a `claudia.db` section (replace the `# OpenClaw database` section):
```
# Claudia database
claudia.db
claudia.db-*
```

**Step 4: Run tests to verify nothing broke**

Run: `npm test`
Expected: All 69 claudia-db assertions pass + tray service-manager tests pass. The test file sets `CLAUDIA_DB_PATH` env var, so it never hits the default path.

**Step 5: Commit**

```bash
git add claudia-db.js lib/config.js .gitignore
git commit -m "refactor: move default paths from ~/.openclaw/ to ~/.claudia/"
```

---

### Task 2: Update Service Manager and Tray Tests

Update the tray app's service inventory to match the correct set of services.

**Files:**
- Modify: `tray/service-manager.js:5-11`
- Modify: `tray/test-service-manager.js`

**Step 1: Update SERVICES array in tray/service-manager.js**

Replace lines 5-11:
```javascript
const SERVICES = [
  { label: 'Meeting Alerts', launchdLabel: 'com.openclaw.meeting-alerts' },
  { label: 'Gmail Monitor',  launchdLabel: 'ai.openclaw.gmail-monitor' },
  { label: 'Slack Monitor',  launchdLabel: 'ai.openclaw.slack-monitor' },
  { label: 'Slack Events',   launchdLabel: 'ai.openclaw.slack-events' },
  { label: 'Gateway',        launchdLabel: 'ai.openclaw.gateway' },
];
```

With:
```javascript
const SERVICES = [
  { label: 'Gmail Monitor',      launchdLabel: 'ai.claudia.gmail-monitor' },
  { label: 'Slack Events',       launchdLabel: 'ai.claudia.slack-events' },
  { label: 'Meeting Alerts',     launchdLabel: 'ai.claudia.meeting-alerts' },
  { label: 'Follow-up Checker',  launchdLabel: 'ai.claudia.followup-checker' },
  { label: 'Gateway',            launchdLabel: 'ai.openclaw.gateway' },
];
```

**Step 2: Update test-service-manager.js**

Replace the SAMPLE_OUTPUT and assertions to match new labels. The test data must use the new `ai.claudia.*` labels:

```javascript
'use strict';

const assert = require('assert');
const { parseLaunchctlList, SERVICES, statusFromEntry } = require('./service-manager');

// --- Test: parseLaunchctlList ---
const SAMPLE_OUTPUT = [
  'PID\tStatus\tLabel',
  '58827\t0\tai.claudia.gmail-monitor',
  '23103\t0\tai.claudia.slack-events',
  '-\t1\tai.claudia.meeting-alerts',
  '-\t0\tai.claudia.followup-checker',
  '18910\t0\tai.openclaw.gateway',
].join('\n');

const parsed = parseLaunchctlList(SAMPLE_OUTPUT);

assert.strictEqual(parsed['ai.claudia.gmail-monitor'].pid, 58827);
assert.strictEqual(parsed['ai.claudia.gmail-monitor'].exitCode, 0);
assert.strictEqual(parsed['ai.claudia.slack-events'].pid, 23103);
assert.strictEqual(parsed['ai.claudia.meeting-alerts'].pid, null);
assert.strictEqual(parsed['ai.claudia.meeting-alerts'].exitCode, 1);
assert.strictEqual(parsed['ai.claudia.followup-checker'].pid, null);
assert.strictEqual(parsed['ai.claudia.followup-checker'].exitCode, 0);
assert.strictEqual(parsed['ai.openclaw.gateway'].pid, 18910);

// --- Test: statusFromEntry ---
assert.strictEqual(statusFromEntry({ pid: 23103, exitCode: 0 }), 'running');
assert.strictEqual(statusFromEntry({ pid: null, exitCode: 0 }), 'stopped');
assert.strictEqual(statusFromEntry({ pid: null, exitCode: 1 }), 'error');
assert.strictEqual(statusFromEntry(undefined), 'unloaded');

// --- Test: SERVICES list matches expected inventory ---
assert.strictEqual(SERVICES.length, 5);
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.gmail-monitor'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.slack-events'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.meeting-alerts'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.claudia.followup-checker'));
assert.ok(SERVICES.find(s => s.launchdLabel === 'ai.openclaw.gateway'));
assert.ok(!SERVICES.find(s => s.launchdLabel === 'ai.openclaw.slack-monitor'), 'Old slack-monitor must not be in SERVICES');

console.log('All service-manager tests passed');
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add tray/service-manager.js tray/test-service-manager.js
git commit -m "refactor: update service inventory to ai.claudia.* labels, add followup-checker"
```

---

### Task 3: Remove Dead Code

Delete superseded files from the repo.

**Files:**
- Delete: `slack-monitor.js`
- Delete: `start-followup-checker.sh`
- Delete: `start-meeting-alerts.sh`
- Delete: `stop-meeting-alerts.sh`
- Delete: `gmail-monitor.sh`
- Modify: `.gitignore` (remove slack-monitor-state.json, followup-checker.pid, meeting-alerts.pid entries)

**Step 1: Delete the files**

```bash
git rm slack-monitor.js start-followup-checker.sh start-meeting-alerts.sh stop-meeting-alerts.sh gmail-monitor.sh
```

**Step 2: Clean up .gitignore**

Remove these lines that reference deleted services/files:
- `slack-monitor-state.json` (line 15)
- `followup-checker.pid` (line 34)
- `meeting-alerts.pid` (line 49)

Also remove the now-obsolete sections:
- `# OpenClaw database` section (lines 36-38) — replaced in Task 1
- `# Follow-ups database` section references to `follow-ups.db` and `followups.db` (lines 31-33) — old schema, no longer used

**Step 3: Verify no remaining references to deleted files**

Run: `grep -r 'slack-monitor\|start-followup-checker\|start-meeting-alerts\|stop-meeting-alerts\|gmail-monitor\.sh' --include='*.js' --include='*.json' .`
Expected: No matches in active code (only in docs/plans/).

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove dead code (old slack-monitor, shell scripts)"
```

---

### Task 4: Create the Deploy Script

Create `bin/deploy` — the single-command deployment tool.

**Files:**
- Create: `bin/deploy`

**Step 1: Create bin/ directory**

```bash
mkdir -p bin
```

**Step 2: Write the deploy script**

Create `bin/deploy`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Claudia Deploy Script
# Usage: bin/deploy [--skip-pull] [--skip-install]

CLAUDIA_HOME="$HOME/.claudia"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
UID_VAL=$(id -u)

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}==>${NC} $1"; }
warn()  { echo -e "${YELLOW}==>${NC} $1"; }
error() { echo -e "${RED}==>${NC} $1"; }

# Parse flags
SKIP_PULL=false
SKIP_INSTALL=false
for arg in "$@"; do
  case $arg in
    --skip-pull) SKIP_PULL=true ;;
    --skip-install) SKIP_INSTALL=true ;;
  esac
done

# --- Step 1: Create directory structure ---
info "Ensuring ~/.claudia/ directory structure..."
mkdir -p "$CLAUDIA_HOME"/{app,data,logs,config}

# --- Step 2: First-run migration ---
# Config: ~/.config/claudia/ → ~/.claudia/config/
if [ -d "$HOME/.config/claudia" ] && [ ! -f "$CLAUDIA_HOME/config/secrets.json" ]; then
  info "Migrating config from ~/.config/claudia/ to ~/.claudia/config/..."
  cp -n "$HOME/.config/claudia/"* "$CLAUDIA_HOME/config/" 2>/dev/null || true
  warn "Old config left in place at ~/.config/claudia/ (remove manually when ready)"
fi

# Database: ~/.openclaw/workspace/claudia.db → ~/.claudia/data/
if [ -f "$HOME/.openclaw/workspace/claudia.db" ] && [ ! -f "$CLAUDIA_HOME/data/claudia.db" ]; then
  info "Migrating database from ~/.openclaw/workspace/ to ~/.claudia/data/..."
  cp "$HOME/.openclaw/workspace/claudia.db" "$CLAUDIA_HOME/data/claudia.db"
  # Copy WAL/SHM files if they exist
  cp "$HOME/.openclaw/workspace/claudia.db-wal" "$CLAUDIA_HOME/data/claudia.db-wal" 2>/dev/null || true
  cp "$HOME/.openclaw/workspace/claudia.db-shm" "$CLAUDIA_HOME/data/claudia.db-shm" 2>/dev/null || true
  warn "Old database left in place at ~/.openclaw/workspace/ (remove manually when ready)"
fi

# --- Step 3: Pull latest ---
if [ "$SKIP_PULL" = false ]; then
  info "Pulling latest from main..."
  cd "$REPO_DIR"
  git pull origin main
fi

# --- Step 4: Install dependencies in repo ---
if [ "$SKIP_INSTALL" = false ]; then
  info "Installing dependencies in repo..."
  cd "$REPO_DIR"
  npm install --silent
fi

# --- Step 5: Sync code to ~/.claudia/app/ ---
info "Syncing code to ~/.claudia/app/..."
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='tray' \
  --exclude='docs' \
  --exclude='sounds' \
  --exclude='scripts' \
  --exclude='bin' \
  --exclude='test-*.js' \
  --exclude='*.log' \
  --exclude='*.sh' \
  --exclude='*.pid' \
  --exclude='*.db' \
  --exclude='*.db-*' \
  --exclude='.gitignore' \
  --exclude='.github' \
  --exclude='.claude' \
  --exclude='.serena' \
  --exclude='.worktrees' \
  --exclude='.gastown-ignore' \
  --exclude='CLAUDE.md' \
  --exclude='email-cache' \
  --exclude='*-state.json' \
  --exclude='*-heartbeat.json' \
  --exclude='*-batch-queue.json' \
  --exclude='*-last-check.txt' \
  "$REPO_DIR/" "$CLAUDIA_HOME/app/"

# --- Step 6: Install production dependencies ---
if [ "$SKIP_INSTALL" = false ]; then
  info "Installing production dependencies in ~/.claudia/app/..."
  cd "$CLAUDIA_HOME/app"
  npm install --omit=dev --silent
fi

# --- Step 7: Generate and load launchd plists ---
info "Generating launchd plists..."

# Service definitions: label|js_file
SERVICES=(
  "gmail-monitor|gmail-monitor.js"
  "slack-events|slack-events-monitor.js"
  "meeting-alerts|meeting-alert-monitor.js"
  "followup-checker|followup-checker.js"
)

for svc in "${SERVICES[@]}"; do
  IFS='|' read -r label jsfile <<< "$svc"
  plist_label="ai.claudia.$label"
  plist_path="$PLIST_DIR/$plist_label.plist"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$plist_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$CLAUDIA_HOME/app/$jsfile</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$CLAUDIA_HOME/logs/$label.log</string>
  <key>StandardErrorPath</key>
  <string>$CLAUDIA_HOME/logs/$label-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
PLIST
done

# --- Step 8: Unload old openclaw plists ---
OLD_LABELS=(
  "ai.openclaw.gmail-monitor"
  "ai.openclaw.slack-monitor"
  "ai.openclaw.slack-events"
  "com.openclaw.meeting-alerts"
)

for old_label in "${OLD_LABELS[@]}"; do
  old_plist="$PLIST_DIR/$old_label.plist"
  if [ -f "$old_plist" ]; then
    warn "Removing old plist: $old_label"
    launchctl bootout "gui/$UID_VAL/$old_label" 2>/dev/null || true
    rm -f "$old_plist"
  fi
done

# --- Step 9: Load new plists and start services ---
info "Loading services..."
for svc in "${SERVICES[@]}"; do
  IFS='|' read -r label jsfile <<< "$svc"
  plist_label="ai.claudia.$label"
  plist_path="$PLIST_DIR/$plist_label.plist"

  # Bootout if already loaded (ignore errors)
  launchctl bootout "gui/$UID_VAL/$plist_label" 2>/dev/null || true
  sleep 0.5

  # Bootstrap (load + start)
  launchctl bootstrap "gui/$UID_VAL" "$plist_path"
done

# --- Step 10: Report status ---
sleep 2
info "Service status:"
echo ""
for svc in "${SERVICES[@]}"; do
  IFS='|' read -r label jsfile <<< "$svc"
  plist_label="ai.claudia.$label"

  pid=$(launchctl list "$plist_label" 2>/dev/null | grep '"PID"' | awk '{print $3}' | tr -d ';' || true)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo -e "  ${GREEN}running${NC}  $label (PID $pid)"
  else
    # Fallback: check via launchctl list grep
    status_line=$(launchctl list 2>/dev/null | grep "$plist_label" || true)
    if [ -n "$status_line" ]; then
      pid_col=$(echo "$status_line" | awk '{print $1}')
      exit_col=$(echo "$status_line" | awk '{print $2}')
      if [ "$pid_col" != "-" ]; then
        echo -e "  ${GREEN}running${NC}  $label (PID $pid_col)"
      elif [ "$exit_col" = "0" ]; then
        echo -e "  ${YELLOW}stopped${NC}  $label (exit 0)"
      else
        echo -e "  ${RED}error${NC}    $label (exit $exit_col)"
      fi
    else
      echo -e "  ${RED}unloaded${NC} $label"
    fi
  fi
done

echo ""
info "Deploy complete!"
```

**Step 3: Make it executable**

```bash
chmod +x bin/deploy
```

**Step 4: Test script syntax**

Run: `bash -n bin/deploy`
Expected: No syntax errors.

**Step 5: Commit**

```bash
git add bin/deploy
git commit -m "feat: add bin/deploy script for single-command deployment"
```

---

### Task 5: Run Full Test Suite

Verify everything still passes after all changes.

**Step 1: Run tests**

Run: `npm test`
Expected: All 69 claudia-db assertions pass + tray service-manager tests pass.

**Step 2: Verify no references to old paths in active code**

Run: `grep -r '\.openclaw' --include='*.js' . | grep -v node_modules | grep -v docs/ | grep -v '.serena'`
Expected: No matches (all `.openclaw` references should be gone from active JS files).

Run: `grep -r 'slack-monitor' --include='*.js' . | grep -v node_modules | grep -v docs/`
Expected: No matches (old slack-monitor references should be gone).

---

### Task 6: Deploy and Verify

Actually run the deploy and verify services start.

**Step 1: Push changes to main**

This assumes the work has been done on a feature branch and merged (or pushed directly if on main). The deploy script will `git pull`.

**Step 2: Run deploy**

Run: `bin/deploy --skip-pull` (skip pull since we're deploying from the current state)
Expected:
- `~/.claudia/app/` populated with code
- `~/.claudia/data/` directory exists
- `~/.claudia/logs/` directory exists
- `~/.claudia/config/` has secrets migrated from `~/.config/claudia/`
- 4 new launchd plists in `~/Library/LaunchAgents/ai.claudia.*`
- Old `ai.openclaw.*` plists removed
- All 4 services reported as running

**Step 3: Verify database creation**

Run: `ls -la ~/.claudia/data/`
Expected: `claudia.db` file exists (created on first service start).

**Step 4: Verify logs**

Run: `ls ~/.claudia/logs/`
Expected: Log files for each service (`gmail-monitor.log`, `slack-events.log`, etc.)

**Step 5: Verify services are running**

Run: `launchctl list | grep ai.claudia`
Expected: All 4 services listed with PIDs.

**Step 6: Spot-check a service log**

Run: `tail -20 ~/.claudia/logs/gmail-monitor.log`
Expected: Pino-formatted JSON log lines showing the service starting and running.

---

### Task 7: Commit and Finalize

**Step 1: Update .gitignore for bin/**

The `bin/deploy` script should NOT be gitignored — it's part of the repo.

**Step 2: Final commit if any loose changes**

```bash
git status
# If anything uncommitted:
git add -A && git commit -m "chore: final deploy and operations cleanup"
```

**Step 3: Verify full test suite**

Run: `npm test`
Expected: All tests pass.
