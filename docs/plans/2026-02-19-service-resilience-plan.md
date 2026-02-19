# Service Resilience — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make all 5 launchd-managed services fail visibly instead of silently, with standardized heartbeat files, startup validation, graceful shutdown, and enhanced tray app notifications.

**Architecture:** Each service writes a JSON heartbeat file after each work cycle. The tray app reads these files every 30 seconds and fires macOS notifications on state transitions. Services validate credentials/DB at startup and fail fast with a diagnostic heartbeat. SIGTERM handlers ensure graceful shutdown.

**Tech Stack:** Node.js `fs` (atomic file writes), Electron `Notification` API (tray app), launchd plists (process management). No new dependencies.

**Key paths:**
- Heartbeat files: `~/.config/claudia/heartbeats/<service>.json`
- Config: `~/.config/claudia/` (loaded by `lib/config.js`)
- Logs: `~/.openclaw/logs/` (pino) + `~/GitHub/claudia/*.log` (launchd stdout)
- LaunchAgent plists: `~/Library/LaunchAgents/`
- Tests use plain Node.js `assert` module, no test framework

**Reference:** Design doc at `docs/plans/2026-02-19-service-resilience-design.md`

---

### Task 1: Create lib/heartbeat.js — Shared Heartbeat Module

**Files:**
- Create: `lib/heartbeat.js`
- Create: `test-heartbeat.js`

**Step 1: Write the failing test**

```js
// test-heartbeat.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use temp dir for tests
const TEST_DIR = path.join(os.tmpdir(), `claudia-heartbeat-test-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

// Override heartbeat dir before requiring the module
process.env.CLAUDIA_HEARTBEAT_DIR = TEST_DIR;

const heartbeat = require('./lib/heartbeat');

// Cleanup on exit
process.on('exit', () => {
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}
});

// --- Test 1: writeHeartbeat creates a valid JSON file ---
heartbeat.write('test-service', {
  checkInterval: 60000,
  status: 'ok',
  metrics: { emailsProcessed: 42 }
});

const filePath = path.join(TEST_DIR, 'test-service.json');
assert.ok(fs.existsSync(filePath), 'heartbeat file should exist');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
assert.strictEqual(data.service, 'test-service');
assert.strictEqual(data.status, 'ok');
assert.strictEqual(data.checkInterval, 60000);
assert.ok(data.pid > 0);
assert.ok(data.lastCheck > 0);
assert.strictEqual(data.metrics.emailsProcessed, 42);
console.log('PASS: writeHeartbeat creates valid JSON');

// --- Test 2: Stale heartbeat detected as unresponsive ---
// Write a heartbeat with lastCheck 45 minutes ago, checkInterval 15 min
const staleTime = Date.now() - (45 * 60 * 1000);
fs.writeFileSync(path.join(TEST_DIR, 'stale-service.json'), JSON.stringify({
  service: 'stale-service',
  pid: 12345,
  startedAt: staleTime - 3600000,
  lastCheck: staleTime,
  checkInterval: 15 * 60 * 1000,
  status: 'ok',
  errors: { lastError: null, lastErrorAt: null, countSinceStart: 0 }
}));

const staleHealth = heartbeat.evaluate(heartbeat.read('stale-service'));
assert.strictEqual(staleHealth.health, 'unresponsive');
console.log('PASS: stale heartbeat detected as unresponsive');

// --- Test 3: Fresh heartbeat is healthy ---
heartbeat.write('fresh-service', { checkInterval: 60000, status: 'ok' });
const freshHealth = heartbeat.evaluate(heartbeat.read('fresh-service'));
assert.strictEqual(freshHealth.health, 'healthy');
console.log('PASS: fresh heartbeat is healthy');

// --- Test 4: startup-failed status surfaces error reason ---
fs.writeFileSync(path.join(TEST_DIR, 'broken-service.json'), JSON.stringify({
  service: 'broken-service',
  pid: 0,
  startedAt: Date.now(),
  lastCheck: Date.now(),
  checkInterval: 60000,
  status: 'startup-failed',
  errors: {
    lastError: 'Missing Gmail token: /path/to/gmail-token.json',
    lastErrorAt: Date.now(),
    countSinceStart: 1
  }
}));

const brokenHealth = heartbeat.evaluate(heartbeat.read('broken-service'));
assert.strictEqual(brokenHealth.health, 'startup-failed');
assert.ok(brokenHealth.error.includes('Missing Gmail token'));
console.log('PASS: startup-failed status surfaces error reason');

// --- Test 5: readAll returns all heartbeats ---
const all = heartbeat.readAll();
assert.ok(all.length >= 3);
assert.ok(all.find(h => h.service === 'test-service'));
assert.ok(all.find(h => h.service === 'stale-service'));
console.log('PASS: readAll returns all heartbeats');

// --- Test 6: Atomic write — no partial reads ---
for (let i = 0; i < 100; i++) {
  heartbeat.write('atomic-test', { checkInterval: 1000, status: 'ok', metrics: { i } });
  const read = heartbeat.read('atomic-test');
  assert.ok(read, `read should succeed on iteration ${i}`);
  assert.strictEqual(read.service, 'atomic-test');
}
console.log('PASS: 100 consecutive write/reads all valid (atomic)');

// --- Test 7: Missing heartbeat returns null ---
const missing = heartbeat.read('nonexistent-service');
assert.strictEqual(missing, null);
console.log('PASS: missing heartbeat returns null');

// --- Test 8: Error tracking in heartbeat ---
heartbeat.write('error-service', {
  checkInterval: 60000,
  status: 'error',
  errors: { lastError: 'SQLITE_CORRUPT', lastErrorAt: Date.now(), countSinceStart: 42 }
});
const errorHealth = heartbeat.evaluate(heartbeat.read('error-service'));
assert.strictEqual(errorHealth.health, 'error');
assert.strictEqual(errorHealth.errorCount, 42);
console.log('PASS: error status with count');

console.log('\n=== ALL HEARTBEAT TESTS PASSED ===');
```

**Step 2: Run test — verify it fails**

```bash
node test-heartbeat.js
```
Expected: `Cannot find module './lib/heartbeat'`

**Step 3: Write lib/heartbeat.js**

```js
// lib/heartbeat.js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HEARTBEAT_DIR = process.env.CLAUDIA_HEARTBEAT_DIR ||
  path.join(os.homedir(), '.config', 'claudia', 'heartbeats');

// Staleness multiplier: if lastCheck is older than checkInterval * this, service is unresponsive
const STALE_MULTIPLIER = 3;

function ensureDir() {
  fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
}

function filePath(serviceName) {
  return path.join(HEARTBEAT_DIR, `${serviceName}.json`);
}

function write(serviceName, { checkInterval, status = 'ok', errors = null, metrics = null }) {
  ensureDir();
  const data = {
    service: serviceName,
    pid: process.pid,
    startedAt: write._startedAt || (write._startedAt = Date.now()),
    lastCheck: Date.now(),
    uptime: Math.round(process.uptime()),
    checkInterval,
    status,
    errors: errors || { lastError: null, lastErrorAt: null, countSinceStart: 0 },
    metrics: metrics || {}
  };
  const target = filePath(serviceName);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, target);
}

function read(serviceName) {
  try {
    const raw = fs.readFileSync(filePath(serviceName), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readAll() {
  ensureDir();
  const results = [];
  for (const file of fs.readdirSync(HEARTBEAT_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(HEARTBEAT_DIR, file), 'utf8');
      results.push(JSON.parse(raw));
    } catch {
      // Skip corrupt/partial files
    }
  }
  return results;
}

function evaluate(heartbeatData) {
  if (!heartbeatData) {
    return { health: 'unknown', error: 'No heartbeat file found' };
  }

  if (heartbeatData.status === 'startup-failed') {
    return {
      health: 'startup-failed',
      error: heartbeatData.errors ? heartbeatData.errors.lastError : 'Unknown startup error',
      errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
    };
  }

  if (heartbeatData.status === 'error') {
    return {
      health: 'error',
      error: heartbeatData.errors ? heartbeatData.errors.lastError : null,
      errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
    };
  }

  if (heartbeatData.status === 'degraded') {
    return {
      health: 'degraded',
      error: heartbeatData.errors ? heartbeatData.errors.lastError : null,
      errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
    };
  }

  if (heartbeatData.status === 'shutting-down') {
    return { health: 'shutting-down', error: null, errorCount: 0 };
  }

  // Check staleness
  const age = Date.now() - heartbeatData.lastCheck;
  const threshold = heartbeatData.checkInterval * STALE_MULTIPLIER;
  if (age > threshold) {
    return {
      health: 'unresponsive',
      error: `No heartbeat for ${Math.round(age / 60000)} minutes (expected every ${Math.round(heartbeatData.checkInterval / 60000)} min)`,
      errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
    };
  }

  return {
    health: 'healthy',
    error: null,
    errorCount: heartbeatData.errors ? heartbeatData.errors.countSinceStart : 0
  };
}

module.exports = { write, read, readAll, evaluate, HEARTBEAT_DIR };
```

**Step 4: Run test — verify it passes**

```bash
node test-heartbeat.js
```
Expected: `=== ALL HEARTBEAT TESTS PASSED ===`

**Step 5: Commit**

```bash
git add lib/heartbeat.js test-heartbeat.js
git commit -m "feat: add shared heartbeat module with atomic writes and health evaluation"
```

---

### Task 2: Create lib/startup-validation.js — Prerequisite Checks

**Files:**
- Create: `lib/startup-validation.js`
- Create: `test-startup-validation.js`

**Step 1: Write the failing test**

```js
// test-startup-validation.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use temp dir for heartbeats
const TEST_DIR = path.join(os.tmpdir(), `claudia-startup-test-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.CLAUDIA_HEARTBEAT_DIR = TEST_DIR;

const { validatePrerequisites } = require('./lib/startup-validation');

// Cleanup
process.on('exit', () => {
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}
});

// --- Test 1: Missing file detected ---
const result1 = validatePrerequisites('test-missing', [
  { type: 'file', path: '/tmp/definitely-does-not-exist-12345.json', description: 'Gmail token' }
]);
assert.ok(result1.errors.length > 0);
assert.ok(result1.errors[0].includes('Gmail token'));
assert.ok(result1.errors[0].includes('/tmp/definitely-does-not-exist'));
console.log('PASS: missing file detected');

// --- Test 2: Existing file passes ---
const tmpFile = path.join(TEST_DIR, 'exists.json');
fs.writeFileSync(tmpFile, '{}');
const result2 = validatePrerequisites('test-exists', [
  { type: 'file', path: tmpFile, description: 'Test file' }
]);
assert.strictEqual(result2.errors.length, 0);
console.log('PASS: existing file passes');

// --- Test 3: Corrupted DB detected ---
const badDb = path.join(TEST_DIR, 'bad.db');
fs.writeFileSync(badDb, 'this is not a sqlite database');
const result3 = validatePrerequisites('test-bad-db', [
  { type: 'database', path: badDb, description: 'Followups DB' }
]);
assert.ok(result3.errors.length > 0);
assert.ok(result3.errors[0].includes('Followups DB'));
console.log('PASS: corrupted database detected');

// --- Test 4: Startup-failed heartbeat written on failure ---
const result4 = validatePrerequisites('test-heartbeat-write', [
  { type: 'file', path: '/tmp/nope-12345.json', description: 'Missing cred' }
]);
assert.ok(result4.errors.length > 0);
const hbFile = path.join(TEST_DIR, 'test-heartbeat-write.json');
assert.ok(fs.existsSync(hbFile), 'heartbeat file should be written on failure');
const hbData = JSON.parse(fs.readFileSync(hbFile, 'utf8'));
assert.strictEqual(hbData.status, 'startup-failed');
assert.ok(hbData.errors.lastError.includes('Missing cred'));
console.log('PASS: startup-failed heartbeat written on failure');

// --- Test 5: All checks pass returns no errors ---
const result5 = validatePrerequisites('test-all-good', [
  { type: 'file', path: tmpFile, description: 'Good file' }
]);
assert.strictEqual(result5.errors.length, 0);
console.log('PASS: all checks pass returns no errors');

// --- Test 6: Multiple failures collected ---
const result6 = validatePrerequisites('test-multi', [
  { type: 'file', path: '/tmp/nope1-12345.json', description: 'Cred A' },
  { type: 'file', path: '/tmp/nope2-12345.json', description: 'Cred B' }
]);
assert.strictEqual(result6.errors.length, 2);
console.log('PASS: multiple failures collected');

console.log('\n=== ALL STARTUP VALIDATION TESTS PASSED ===');
```

**Step 2: Run test — verify it fails**

```bash
node test-startup-validation.js
```
Expected: `Cannot find module './lib/startup-validation'`

**Step 3: Write lib/startup-validation.js**

```js
// lib/startup-validation.js
'use strict';

const fs = require('fs');
const heartbeat = require('./heartbeat');

/**
 * Validate service prerequisites before entering the main loop.
 *
 * @param {string} serviceName - Service name for heartbeat file
 * @param {Array} checks - Array of { type: 'file'|'database', path: string, description: string }
 * @returns {{ errors: string[] }} - Empty errors array means all checks passed
 */
function validatePrerequisites(serviceName, checks) {
  const errors = [];

  for (const check of checks) {
    if (check.type === 'file') {
      if (!fs.existsSync(check.path)) {
        errors.push(`Missing ${check.description}: ${check.path}`);
      }
    } else if (check.type === 'database') {
      try {
        const Database = require('better-sqlite3');
        const db = new Database(check.path, { readonly: true });
        db.pragma('quick_check');
        db.close();
      } catch (e) {
        errors.push(`${check.description} error: ${e.message}`);
      }
    }
  }

  if (errors.length > 0) {
    heartbeat.write(serviceName, {
      checkInterval: 0,
      status: 'startup-failed',
      errors: {
        lastError: errors.join('; '),
        lastErrorAt: Date.now(),
        countSinceStart: errors.length
      }
    });
  }

  return { errors };
}

module.exports = { validatePrerequisites };
```

**Step 4: Run test — verify it passes**

```bash
node test-startup-validation.js
```
Expected: `=== ALL STARTUP VALIDATION TESTS PASSED ===`

**Step 5: Commit**

```bash
git add lib/startup-validation.js test-startup-validation.js
git commit -m "feat: add startup validation module with heartbeat-on-failure"
```

---

### Task 3: Add Heartbeat + Startup Validation + SIGTERM to gmail-monitor

Gmail-monitor already has a `writeHeartbeat()` function. Replace it with the shared module and add startup validation.

**Files:**
- Modify: `gmail-monitor.js`

**Step 1: Update imports**

At the top of `gmail-monitor.js`, add:
```js
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');
```

**Step 2: Add startup validation to main()**

In the `main()` function, before `followupsDbConn = followupsDb.initDatabase()`, add:
```js
  // Validate prerequisites before starting
  const validation = validatePrerequisites('gmail-monitor', [
    { type: 'file', path: path.join(configDir, 'gmail-credentials.json'), description: 'Gmail credentials' },
    { type: 'file', path: path.join(configDir, 'gmail-token.json'), description: 'Gmail token' },
    { type: 'database', path: followupsDb.DB_PATH, description: 'Followups database' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }
```

Where `configDir` is `~/.config/claudia/` (read from `lib/config.js` or `path.join(os.homedir(), '.config', 'claudia')`). Check how gmail-monitor currently references these paths — it uses `config.gmailCredentialsPath` and `config.gmailTokenPath` from `lib/config.js`.

**Step 3: Replace writeHeartbeat with shared module**

Remove the existing `writeHeartbeat()` function (lines 1208-1221). Replace all calls to `writeHeartbeat()` with:
```js
heartbeat.write('gmail-monitor', {
  checkInterval: CONFIG.checkInterval,
  status: 'ok',
  metrics: {
    batchQueueSize: batchQueue.length,
    dailyStats
  }
});
```

Also remove the `heartbeatFile` entry from CONFIG since we no longer need it.

**Step 4: Add SIGTERM handler**

At the bottom of the file (before `main().catch()`):
```js
function shutdown(signal) {
  log.info({ signal }, 'Shutting down gracefully');
  heartbeat.write('gmail-monitor', { checkInterval: CONFIG.checkInterval, status: 'shutting-down' });
  if (followupsDbConn) try { followupsDbConn.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

**Step 5: Smoke test**

```bash
node gmail-monitor.js
```
Verify it starts, writes heartbeat to `~/.config/claudia/heartbeats/gmail-monitor.json`, and Ctrl+C writes `shutting-down` heartbeat.

```bash
cat ~/.config/claudia/heartbeats/gmail-monitor.json | python3 -m json.tool
```

**Step 6: Commit**

```bash
git add gmail-monitor.js
git commit -m "feat(gmail-monitor): add heartbeat, startup validation, and SIGTERM handler"
```

---

### Task 4: Add Heartbeat + Startup Validation + SIGTERM to followup-checker

**Files:**
- Modify: `followup-checker.js`

**Step 1: Add imports**

```js
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');
```

**Step 2: Add startup validation to main()**

Before `db = followupsDb.initDatabase()`:
```js
  const validation = validatePrerequisites('followup-checker', [
    { type: 'database', path: followupsDb.DB_PATH, description: 'Followups database' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }
```

**Step 3: Add heartbeat writes to runChecks()**

At the end of the `try` block in `runChecks()`, after the check functions:
```js
    heartbeat.write('followup-checker', {
      checkInterval: CONFIG.checkInterval,
      status: 'ok'
    });
```

In the `catch` block:
```js
    heartbeat.write('followup-checker', {
      checkInterval: CONFIG.checkInterval,
      status: 'error',
      errors: { lastError: error.message, lastErrorAt: Date.now(), countSinceStart: ++errorCount }
    });
```

Add `let errorCount = 0;` as a module-level variable.

**Step 4: Add SIGTERM handler**

```js
function shutdown(signal) {
  log.info({ signal }, 'Shutting down gracefully');
  heartbeat.write('followup-checker', { checkInterval: CONFIG.checkInterval, status: 'shutting-down' });
  if (db) try { db.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

**Step 5: Smoke test**

```bash
node followup-checker.js
```
Check heartbeat file exists and is valid JSON.

**Step 6: Commit**

```bash
git add followup-checker.js
git commit -m "feat(followup-checker): add heartbeat, startup validation, and SIGTERM handler"
```

---

### Task 5: Add Heartbeat + Startup Validation + SIGTERM to slack-monitor

**Files:**
- Modify: `slack-monitor.js`

**Step 1: Add imports**

```js
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');
```

**Step 2: Add startup validation to main()**

Before `loadState()`:
```js
  const validation = validatePrerequisites('slack-monitor', [
    { type: 'file', path: path.join(os.homedir(), '.config', 'claudia', 'config.json'), description: 'Claudia config (Slack tokens)' }
  ]);
  if (validation.errors.length > 0) {
    console.error('Startup validation failed:', validation.errors);
    process.exit(1);
  }
```

Note: `slack-monitor` uses `console.log` (not pino). Keep it consistent with the existing pattern.

**Step 3: Add heartbeat write after each check**

At the end of `checkSlack()`:
```js
  heartbeat.write('slack-monitor', {
    checkInterval: CONFIG.checkInterval,
    status: 'ok'
  });
```

In the catch block of the setInterval:
```js
    heartbeat.write('slack-monitor', {
      checkInterval: CONFIG.checkInterval,
      status: 'error',
      errors: { lastError: error.message, lastErrorAt: Date.now(), countSinceStart: ++errorCount }
    });
```

Add `let errorCount = 0;` as a module-level variable.

**Step 4: Add SIGTERM handler**

```js
function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`);
  heartbeat.write('slack-monitor', { checkInterval: CONFIG.checkInterval, status: 'shutting-down' });
  saveState();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

**Step 5: Smoke test + commit**

```bash
node slack-monitor.js
# Ctrl+C after one cycle
cat ~/.config/claudia/heartbeats/slack-monitor.json | python3 -m json.tool
git add slack-monitor.js
git commit -m "feat(slack-monitor): add heartbeat, startup validation, and SIGTERM handler"
```

---

### Task 6: Add Heartbeat + Startup Validation to slack-events-monitor

This service already has a SIGTERM handler. Add heartbeat and startup validation.

**Files:**
- Modify: `slack-events-monitor.js`

**Step 1: Add imports**

```js
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');
```

**Step 2: Add startup validation to main()**

Before the Socket Mode connection:
```js
  const validation = validatePrerequisites('slack-events', [
    { type: 'file', path: path.join(os.homedir(), '.config', 'claudia', 'config.json'), description: 'Claudia config (Slack tokens)' },
    { type: 'database', path: followupsDb.DB_PATH, description: 'Followups database' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }
```

**Step 3: Add heartbeat writes**

After successful WebSocket connection (`ws.on('open', ...)`):
```js
  heartbeat.write('slack-events', { checkInterval: 30000, status: 'ok' });
```

On WebSocket message processing (end of the `ws.on('message')` handler):
```js
  heartbeat.write('slack-events', { checkInterval: 30000, status: 'ok' });
```

On WebSocket close/error:
```js
  heartbeat.write('slack-events', {
    checkInterval: 30000,
    status: 'degraded',
    errors: { lastError: 'WebSocket disconnected, reconnecting', lastErrorAt: Date.now(), countSinceStart: ++errorCount }
  });
```

Note: `checkInterval` for a WebSocket-based service is the expected message frequency. Use 30s as a conservative estimate — if no messages arrive for 90s (3x), it's stale.

**Step 4: Update existing shutdown handler**

In the existing `shutdown()` function, add heartbeat write:
```js
function shutdown(signal) {
  log.info({ signal }, 'Received signal, shutting down');
  heartbeat.write('slack-events', { checkInterval: 30000, status: 'shutting-down' });
  saveState();
  if (ws) ws.close();
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  process.exit(0);
}
```

**Step 5: Smoke test + commit**

```bash
node slack-events-monitor.js
# Wait for WebSocket connection
cat ~/.config/claudia/heartbeats/slack-events.json | python3 -m json.tool
# Ctrl+C
git add slack-events-monitor.js
git commit -m "feat(slack-events): add heartbeat and startup validation"
```

---

### Task 7: Add Heartbeat + Startup Validation + SIGTERM to meeting-alert-monitor

**Files:**
- Modify: `meeting-alert-monitor.js`

**Step 1: Add imports**

```js
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');
```

**Step 2: Add startup validation to main()**

Before `calendar = await calendarAuth.getCalendarClient()`:
```js
  const validation = validatePrerequisites('meeting-alerts', [
    { type: 'file', path: path.join(os.homedir(), '.config', 'claudia', 'calendar-token.json'), description: 'Calendar token' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }
```

Check the actual calendar token path — read `calendarAuth` or the config to find the exact filename. It may be `google-calendar-token.json` or similar.

**Step 3: Add heartbeat writes**

After the calendar sync in the poll interval:
```js
  heartbeat.write('meeting-alerts', {
    checkInterval: CONFIG.pollInterval,
    status: 'ok',
    metrics: { upcomingMeetings: syncedEvents.length }
  });
```

**Step 4: Add SIGTERM handler**

```js
function shutdown(signal) {
  log.info({ signal }, 'Shutting down gracefully');
  heartbeat.write('meeting-alerts', { checkInterval: CONFIG.pollInterval, status: 'shutting-down' });
  if (o3Db) try { o3Db.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

Note: `o3Db` is local to `main()`. You'll need to make it module-level (move `let o3Db;` outside `main()`).

**Step 5: Smoke test + commit**

```bash
node meeting-alert-monitor.js
cat ~/.config/claudia/heartbeats/meeting-alerts.json | python3 -m json.tool
git add meeting-alert-monitor.js
git commit -m "feat(meeting-alerts): add heartbeat, startup validation, and SIGTERM handler"
```

---

### Task 8: Enhance Tray App — Heartbeat Reading + Smart Notifications

**Files:**
- Modify: `tray/main.js`
- Modify: `tray/service-manager.js`

**Step 1: Add heartbeat reading to service-manager.js**

In `tray/service-manager.js`, add the heartbeat integration. The tray app can't `require('../lib/heartbeat')` because it runs from a packaged Electron app. Instead, inline the read logic:

Add to `service-manager.js`:

```js
const os = require('os');

const HEARTBEAT_DIR = path.join(os.homedir(), '.config', 'claudia', 'heartbeats');

// Map launchd labels to heartbeat service names
const HEARTBEAT_NAMES = {
  'ai.openclaw.gmail-monitor': 'gmail-monitor',
  'ai.openclaw.slack-monitor': 'slack-monitor',
  'ai.openclaw.slack-events': 'slack-events',
  'com.openclaw.meeting-alerts': 'meeting-alerts',
  'ai.openclaw.gateway': null,  // Gateway doesn't write heartbeats (yet)
};

function readHeartbeat(launchdLabel) {
  const name = HEARTBEAT_NAMES[launchdLabel];
  if (!name) return null;
  try {
    const raw = fs.readFileSync(path.join(HEARTBEAT_DIR, `${name}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function evaluateHeartbeat(hb) {
  if (!hb) return { health: 'unknown', detail: null };
  if (hb.status === 'startup-failed') {
    return { health: 'startup-failed', detail: hb.errors ? hb.errors.lastError : 'Unknown error' };
  }
  if (hb.status === 'error' || hb.status === 'degraded') {
    return { health: hb.status, detail: hb.errors ? hb.errors.lastError : null, errorCount: hb.errors ? hb.errors.countSinceStart : 0 };
  }
  if (hb.status === 'shutting-down') {
    return { health: 'shutting-down', detail: null };
  }
  const age = Date.now() - hb.lastCheck;
  if (age > hb.checkInterval * 3) {
    return { health: 'unresponsive', detail: `No heartbeat for ${Math.round(age / 60000)}m` };
  }
  return { health: 'healthy', detail: null, errorCount: hb.errors ? hb.errors.countSinceStart : 0 };
}
```

Update `getStatuses()` to include heartbeat data:

```js
function getStatuses() {
  // ... existing launchctl parsing ...
  return SERVICES.map(svc => {
    const entry = parsed[svc.launchdLabel];
    const hb = readHeartbeat(svc.launchdLabel);
    const hbHealth = evaluateHeartbeat(hb);
    return {
      ...svc,
      status: statusFromEntry(entry),
      pid: entry ? entry.pid : null,
      exitCode: entry ? entry.exitCode : null,
      heartbeat: hb,
      heartbeatHealth: hbHealth
    };
  });
}
```

Export: add `readHeartbeat, evaluateHeartbeat` to `module.exports`.

**Step 2: Update tray/main.js — richer menu + smart notifications**

Replace the `STATUS_EMOJI` map and update `buildMenu` and `refreshStatus`:

```js
function getEffectiveStatus(svc) {
  // Combine launchctl status with heartbeat health
  if (svc.status !== 'running') return svc.status;  // process-level takes priority if not running
  if (!svc.heartbeatHealth) return 'running';  // no heartbeat data = trust launchctl
  const hh = svc.heartbeatHealth.health;
  if (hh === 'healthy') return 'running';
  if (hh === 'unresponsive' || hh === 'startup-failed' || hh === 'error') return hh;
  if (hh === 'degraded') return 'degraded';
  return 'running';
}

const STATUS_EMOJI = {
  running: '🟢', stopped: '⚫', error: '🔴', unloaded: '⚪', unknown: '❓',
  unresponsive: '🟡', degraded: '🟡', 'startup-failed': '🔴'
};
```

Update `buildMenu` to show heartbeat detail:

```js
const serviceItems = statuses.map(svc => {
  const effective = getEffectiveStatus(svc);
  const emoji = STATUS_EMOJI[effective] || '❓';
  const isRunning = svc.status === 'running';

  let detail = '';
  if (isRunning && svc.heartbeat) {
    const age = Math.round((Date.now() - svc.heartbeat.lastCheck) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
    detail = `PID ${svc.pid}, last check ${ageStr}`;
    if (svc.heartbeatHealth.errorCount > 0) {
      detail += `, ${svc.heartbeatHealth.errorCount} errors`;
    }
  } else if (isRunning) {
    detail = `PID ${svc.pid}`;
  } else if (effective === 'startup-failed') {
    detail = svc.heartbeatHealth.detail || 'startup failed';
  } else if (svc.exitCode != null && svc.status === 'error') {
    detail = `exit ${svc.exitCode}`;
  }
  // ... rest of menu item building with detail ...
```

Update `refreshStatus` notification logic to handle heartbeat transitions:

```js
// Track last notification time per service to avoid spam
let lastNotificationTime = {};
const NOTIFICATION_COOLDOWN = 15 * 60 * 1000; // 15 minutes

// In refreshStatus, after setting menu:
for (const svc of statuses) {
  const effective = getEffectiveStatus(svc);
  const prevEffective = previousStatuses[svc.launchdLabel];
  const now = Date.now();
  const lastNotif = lastNotificationTime[svc.launchdLabel] || 0;

  // State transition notifications
  if (prevEffective && prevEffective !== effective) {
    if (effective === 'error' || effective === 'stopped' || effective === 'unresponsive' || effective === 'startup-failed') {
      const body = svc.heartbeatHealth && svc.heartbeatHealth.detail
        ? svc.heartbeatHealth.detail
        : (svc.exitCode ? `Exit code ${svc.exitCode}` : 'Service stopped.');
      new Notification({
        title: `Claudia: ${svc.label} — ${effective}`,
        body
      }).show();
      lastNotificationTime[svc.launchdLabel] = now;
    } else if ((prevEffective === 'error' || prevEffective === 'unresponsive' || prevEffective === 'startup-failed') && effective === 'running') {
      new Notification({
        title: `Claudia: ${svc.label} recovered`,
        body: 'Service is running normally again.'
      }).show();
      lastNotificationTime[svc.launchdLabel] = now;
    }
  }

  // Persistent problem reminder (every 15 min)
  if ((effective === 'error' || effective === 'unresponsive' || effective === 'startup-failed') &&
      (now - lastNotif > NOTIFICATION_COOLDOWN) && prevEffective === effective) {
    new Notification({
      title: `Claudia: ${svc.label} still ${effective}`,
      body: svc.heartbeatHealth && svc.heartbeatHealth.detail || 'Check logs for details.'
    }).show();
    lastNotificationTime[svc.launchdLabel] = now;
  }
}

// Store effective status for next comparison
previousStatuses = {};
for (const svc of statuses) previousStatuses[svc.launchdLabel] = getEffectiveStatus(svc);
```

Add a second timer for heartbeat-enriched refreshes (30s):

```js
// In app.whenReady():
// Existing 10-second PID-level refresh stays
setInterval(refreshStatus, 10 * 1000);

// Heartbeat data only changes when services write it, so 30s is fine
// The refreshStatus function already reads heartbeats via getStatuses()
// No separate timer needed — just keep the 10s interval and
// heartbeat reads happen on each call (they're fast file reads)
```

Actually, since heartbeat file reads are negligible (~5 small JSON files), just keep the existing 10-second interval. No separate timer needed — simplify.

**Step 3: Update aggregate icon logic**

```js
function getAggregateIcon(statuses) {
  const effectives = statuses.map(s => getEffectiveStatus(s));
  if (effectives.some(e => e === 'error' || e === 'stopped' || e === 'startup-failed')) return getIcon('red');
  if (effectives.some(e => e === 'unresponsive' || e === 'degraded')) return getIcon('yellow');
  if (effectives.every(e => e === 'running')) return getIcon('green');
  return getIcon('yellow');
}
```

**Step 4: Build and test the tray app**

```bash
cd tray && npm run build
open dist/mac-arm64/Claudia.app
```

Verify:
- Menu shows heartbeat info (last check time, error counts)
- Aggregate icon reflects worst-case across services
- Kill a service externally and verify notification fires

**Step 5: Commit**

```bash
git add tray/main.js tray/service-manager.js
git commit -m "feat(tray): add heartbeat-aware health monitoring and smart notifications"
```

---

### Task 9: Update LaunchAgent Plists

**Files:**
- Modify: `~/Library/LaunchAgents/ai.openclaw.gmail-monitor.plist`
- Modify: `~/Library/LaunchAgents/ai.openclaw.slack-monitor.plist`
- Modify: `~/Library/LaunchAgents/ai.openclaw.slack-events.plist`
- Modify: `~/Library/LaunchAgents/com.openclaw.meeting-alerts.plist`
- Modify: `~/Library/LaunchAgents/ai.openclaw.gateway.plist`

**Step 1: Update each plist**

For **gmail-monitor**, **slack-monitor**, **slack-events**:
```xml
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>NetworkState</key>
        <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>ExitTimeOut</key>
    <integer>15</integer>

    <key>ProcessType</key>
    <string>Background</string>
```

For **meeting-alerts**:
```xml
    <!-- KeepAlive already has SuccessfulExit: false -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>NetworkState</key>
        <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>15</integer>

    <key>ExitTimeOut</key>
    <integer>10</integer>

    <key>ProcessType</key>
    <string>Adaptive</string>
```

For **gateway**:
```xml
    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>ExitTimeOut</key>
    <integer>10</integer>

    <key>ProcessType</key>
    <string>Adaptive</string>
```

**Step 2: Reload all services**

```bash
# Unload and reload each service to pick up plist changes
launchctl bootout gui/$(id -u)/ai.openclaw.gmail-monitor && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gmail-monitor.plist
launchctl bootout gui/$(id -u)/ai.openclaw.slack-monitor && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.slack-monitor.plist
launchctl bootout gui/$(id -u)/ai.openclaw.slack-events && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.slack-events.plist
launchctl bootout gui/$(id -u)/com.openclaw.meeting-alerts && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.meeting-alerts.plist
launchctl bootout gui/$(id -u)/ai.openclaw.gateway && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

**Step 3: Verify all services running**

```bash
launchctl list | grep -E 'openclaw|meeting'
```

All should show PIDs.

**Step 4: No git commit** — plists are in `~/Library/LaunchAgents/`, not in the repo. Consider creating plist templates in the repo if you want them version-controlled (future task).

---

### Task 10: End-to-End Verification

**Step 1: Run all tests**

```bash
node test-heartbeat.js && node test-startup-validation.js && npm test
```
Expected: All tests pass.

**Step 2: Verify heartbeat files exist for all services**

```bash
ls -la ~/.config/claudia/heartbeats/
```
Expected: `gmail-monitor.json`, `slack-monitor.json`, `slack-events.json`, `meeting-alerts.json`, `followup-checker.json`

**Step 3: Verify heartbeats are fresh**

```bash
for f in ~/.config/claudia/heartbeats/*.json; do echo "=== $(basename $f) ==="; python3 -c "import json,time; d=json.load(open('$f')); print(f'status: {d[\"status\"]}, age: {round((time.time()*1000 - d[\"lastCheck\"])/1000)}s')"; done
```
Expected: All status "ok", age < respective check interval.

**Step 4: Test startup failure detection**

Temporarily rename a credential file and restart a service:
```bash
mv ~/.config/claudia/gmail-token.json ~/.config/claudia/gmail-token.json.bak
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gmail-monitor
sleep 5
cat ~/.config/claudia/heartbeats/gmail-monitor.json | python3 -m json.tool
```
Expected: `status: "startup-failed"`, error mentions missing token. Tray app should show red for Gmail Monitor.

Restore:
```bash
mv ~/.config/claudia/gmail-token.json.bak ~/.config/claudia/gmail-token.json
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gmail-monitor
```

**Step 5: Test SIGTERM graceful shutdown**

```bash
launchctl kill SIGTERM gui/$(id -u)/ai.openclaw.gmail-monitor
sleep 2
cat ~/.config/claudia/heartbeats/gmail-monitor.json | python3 -m json.tool
```
Expected: `status: "shutting-down"` briefly, then service restarts and heartbeat becomes "ok".

**Step 6: Test tray notification on crash**

```bash
launchctl kill SIGKILL gui/$(id -u)/ai.openclaw.slack-monitor
```
Expected: macOS notification from Claudia about Slack Monitor stopping. Service auto-restarts via launchd.

**Step 7: Update root test script**

Modify `package.json`:
```json
"test": "node test-heartbeat.js && node test-startup-validation.js && npm test --prefix tray"
```

**Step 8: Commit test script update**

```bash
git add package.json
git commit -m "chore: add heartbeat and startup-validation tests to root test script"
```

**Step 9: Clean up old heartbeat file**

```bash
rm -f ~/GitHub/claudia/gmail-heartbeat.json
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Shared heartbeat module (TDD) | lib/heartbeat.js, test-heartbeat.js |
| 2 | Startup validation module (TDD) | lib/startup-validation.js, test-startup-validation.js |
| 3 | Gmail monitor: heartbeat + startup + SIGTERM | gmail-monitor.js |
| 4 | Followup checker: heartbeat + startup + SIGTERM | followup-checker.js |
| 5 | Slack monitor: heartbeat + startup + SIGTERM | slack-monitor.js |
| 6 | Slack events: heartbeat + startup (has SIGTERM) | slack-events-monitor.js |
| 7 | Meeting alerts: heartbeat + startup + SIGTERM | meeting-alert-monitor.js |
| 8 | Tray app: heartbeat-aware health + smart notifs | tray/main.js, tray/service-manager.js |
| 9 | LaunchAgent plist improvements | ~/Library/LaunchAgents/*.plist |
| 10 | End-to-end verification + cleanup | package.json |
