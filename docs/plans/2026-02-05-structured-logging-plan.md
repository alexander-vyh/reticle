# Structured Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace raw `console.log` with structured pino logging, starting with `unsub` and `gmail-monitor.js` as proof of concept.

**Architecture:** A shared `lib/logger.js` factory creates named pino loggers that write JSON to `~/.openclaw/logs/<name>.log` (with rotation) and pretty-printed output to stdout. Scripts import it with `require('./lib/logger')('script-name')`.

**Tech Stack:** pino, pino-pretty, pino-roll (Node.js)

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install pino, pino-pretty, and pino-roll**

Run:
```bash
cd ~/.openclaw/workspace && npm install pino pino-pretty pino-roll
```

Expected: package.json gains three new dependencies, node_modules updated.

**Step 2: Verify installation**

Run:
```bash
cd ~/.openclaw/workspace && node -e "require('pino'); require('pino-pretty'); require('pino-roll'); console.log('OK')"
```

Expected: `OK`

**Step 3: Commit**

```bash
cd ~/.openclaw/workspace
git add package.json package-lock.json
git commit -m "deps: add pino, pino-pretty, pino-roll for structured logging"
```

---

### Task 2: Create lib/logger.js

**Files:**
- Create: `lib/logger.js`

**Step 1: Create the lib directory**

Run:
```bash
mkdir -p ~/.openclaw/workspace/lib
```

**Step 2: Write lib/logger.js**

```js
'use strict';

const pino = require('pino');
const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(process.env.HOME, '.openclaw', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Create a named logger that writes JSON to file and pretty output to stdout.
 *
 * @param {string} name - Logger name (used as filename and in log lines)
 * @param {object} [opts] - Options
 * @param {string} [opts.correlationId] - Cross-process correlation ID
 * @returns {import('pino').Logger}
 */
module.exports = function createLogger(name, opts = {}) {
  const level = process.env.LOG_LEVEL || 'info';
  const logFile = path.join(LOG_DIR, `${name}.log`);

  const bindings = { name };
  if (opts.correlationId) {
    bindings.correlationId = opts.correlationId;
  }

  const targets = [
    // File transport with rotation
    {
      target: 'pino-roll',
      options: {
        file: logFile,
        size: '10m',
        limit: { count: 7 }
      },
      level
    },
    // Pretty stdout
    {
      target: 'pino-pretty',
      options: {
        destination: 1,
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname'
      },
      level
    }
  ];

  const transport = pino.transport({ targets });

  const logger = pino({ level, ...bindings }, transport);

  // Convenience: create a child logger with a correlation ID
  logger.child = logger.child.bind(logger);

  return logger;
};
```

**Step 3: Verify logger works**

Run:
```bash
cd ~/.openclaw/workspace && node -e "
const log = require('./lib/logger')('test');
log.info('Hello from structured logging');
log.info({ foo: 'bar' }, 'With context');
log.error({ err: new Error('boom') }, 'Something failed');
"
```

Expected: Pretty output on stdout AND a file at `~/.openclaw/logs/test.log` containing JSON lines.

**Step 4: Verify log file was created with JSON content**

Run:
```bash
cat ~/.openclaw/logs/test.log
```

Expected: JSON lines with `level`, `time`, `msg`, and `name: "test"` fields.

**Step 5: Clean up test log**

Run:
```bash
rm ~/.openclaw/logs/test.log
```

**Step 6: Commit**

```bash
cd ~/.openclaw/workspace
git add lib/logger.js
git commit -m "feat: add shared structured logger (pino + file rotation)"
```

---

### Task 3: Migrate unsub

**Files:**
- Modify: `unsub`

This script has ~15 console.log/error calls. Replace them all with the structured logger.

**Step 1: Add logger import and parse correlation ID from args**

At the top of `unsub`, after the existing requires, replace the constants section:

Old (lines 7-16):
```js
const fs = require('fs');
const { google } = require('googleapis');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execSync } = require('child_process');

const CREDENTIALS_PATH = process.env.HOME + '/.openclaw/gmail-credentials.json';
const TOKEN_PATH = process.env.HOME + '/.openclaw/gmail-token.json';
const GMAIL_ACCOUNT = 'user@example.com';
```

New:
```js
const fs = require('fs');
const { google } = require('googleapis');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execSync } = require('child_process');

const CREDENTIALS_PATH = process.env.HOME + '/.openclaw/gmail-credentials.json';
const TOKEN_PATH = process.env.HOME + '/.openclaw/gmail-token.json';
const GMAIL_ACCOUNT = 'user@example.com';

// Parse --correlation-id from args (passed by gmail-monitor)
const correlationArg = process.argv.find(a => a.startsWith('--correlation-id='));
const correlationId = correlationArg ? correlationArg.split('=')[1] : undefined;
const log = require('./lib/logger')('unsub', { correlationId });
```

**Step 2: Replace all console.log/error calls in unsub**

Replace each `console.log` and `console.error` with the appropriate log level. Here is the full mapping for the `main()` function and other functions:

In `getGmailClient()` (line 32):
```js
// Old: console.error('✗ Not authorized yet. Run: node gmail-auth.js');
// New:
log.error('Not authorized yet. Run: node gmail-auth.js');
```

In `searchEmail()` — no logging changes needed (returns null silently, which is fine).

In `main()` function, replace all console calls:

```js
async function main() {
  const query = process.argv.slice(2).filter(a => !a.startsWith('--correlation-id=')).join(' ');
  if (!query) {
    log.error('Usage: unsub <search query>');
    process.exit(1);
  }

  let emailId;

  const idMatch = query.match(/^id:(\S+)$/);
  if (idMatch) {
    emailId = idMatch[1];
    log.info({ emailId }, 'Using message ID directly');
  } else {
    log.info({ query }, 'Searching for email');
    emailId = searchEmail(query);
    if (!emailId) {
      log.error({ query }, 'No email found');
      process.exit(1);
    }
    log.info({ emailId }, 'Found email');
  }

  const gmail = getGmailClient();

  log.info('Fetching email via Gmail API');
  const email = await getEmail(gmail, emailId);

  const from = email.payload.headers.find(h => h.name === 'From')?.value || 'Unknown';
  const subject = email.payload.headers.find(h => h.name === 'Subject')?.value || 'No subject';

  log.info({ from, subject }, 'Email retrieved');

  log.info('Looking for unsubscribe link');
  const unsub = extractUnsubscribeLink(email);

  if (!unsub) {
    log.error({ from, subject }, 'No unsubscribe link found in email');
    process.exit(1);
  }

  log.info({ method: unsub.method }, 'Found unsubscribe link');

  if (unsub.mailto) {
    log.warn({ mailto: unsub.mailto }, 'Mailto unsubscribe requires manual action');
    execSync(`open "mailto:${unsub.mailto}"`);
    process.exit(1);
  }

  log.info({ url: unsub.url.substring(0, 80) }, 'Visiting unsubscribe URL');

  try {
    const result = await visitUrl(unsub.url);
    log.info({ status: result.status }, 'Unsubscribe request sent');

    log.info('Archiving email');
    await archiveEmail(gmail, emailId);
    log.info('Email archived');

    log.info({ from, subject }, 'Successfully unsubscribed');
  } catch (error) {
    log.error({ err: error, url: unsub.url }, 'Failed to unsubscribe');
    execSync(`open "${unsub.url}"`);
    process.exit(1);
  }
}

main().catch(error => {
  log.fatal({ err: error }, 'Unhandled error');
  process.exit(1);
});
```

**Step 3: Test unsub with a dry search**

Run:
```bash
cd ~/.openclaw/workspace && node unsub "id:19c2fed919be283b" 2>&1 | head -20
```

Expected: Pretty-printed structured output on stdout. Also check:

```bash
cat ~/.openclaw/logs/unsub.log | head -5
```

Expected: JSON lines with `name: "unsub"`, proper level numbers, and structured fields.

**Step 4: Test correlation ID passthrough**

Run:
```bash
cd ~/.openclaw/workspace && node unsub --correlation-id=test-123 "id:19c2fed919be283b" 2>&1 | head -5
```

Then:
```bash
cat ~/.openclaw/logs/unsub.log | jq 'select(.correlationId == "test-123")' | head -5
```

Expected: All log lines include `correlationId: "test-123"`.

**Step 5: Commit**

```bash
cd ~/.openclaw/workspace
git add unsub
git commit -m "feat: migrate unsub to structured logging with pino"
```

---

### Task 4: Migrate gmail-monitor.js

**Files:**
- Modify: `gmail-monitor.js`

This is the larger migration (~49 console.log/error calls). The pattern is the same as unsub.

**Step 1: Add logger import at top of gmail-monitor.js**

After the existing requires (line 11), add:

```js
const log = require('./lib/logger')('gmail-monitor');
```

**Step 2: Replace console calls in gmail-monitor.js**

Apply these replacements throughout the file. Key mappings:

**`sendMacOSNotification()`** (lines 177-178):
```js
// Old: console.error('  ✗ macOS notification error:', error.message);
// New:
log.error({ err: error }, 'macOS notification error');
// Old: console.error('  ✗ terminal-notifier stderr:', error.stderr.toString());
// New:
log.error({ stderr: error.stderr?.toString() }, 'terminal-notifier stderr');
```

**`fetchAndCacheEmail()`** (lines 255-258):
```js
// Old: console.log(`     💾 Pre-cached email ${emailId}`);
// New:
log.info({ emailId }, 'Pre-cached email');
// Old: console.error(`     ✗ Failed to pre-cache email ${emailId}:`, error.message);
// New:
log.error({ err: error, emailId }, 'Failed to pre-cache email');
```

**`archiveEmail()`** (line 436):
```js
// Old: console.error(`     ✗ Archive failed: ${error.message}`);
// New:
log.error({ err: error, emailId }, 'Archive failed');
```

**`deleteEmail()`** (line 453):
```js
// Old: console.error(`     ✗ Delete failed: ${error.message}`);
// New:
log.error({ err: error, emailId }, 'Delete failed');
```

**`tagEmail()`** (line 468):
```js
// Old: console.error(`     ✗ Tag failed: ${error.message}`);
// New:
log.error({ err: error, emailId, label }, 'Tag failed');
```

**`getRecentEmails()`** (line 535):
```js
// Old: console.error('Error fetching emails:', error.message);
// New:
log.error({ err: error }, 'Error fetching emails');
```

**`saveLastCheckTime()`** (line 559):
```js
// Old: console.error('Error saving history:', error.message);
// New:
log.error({ err: error }, 'Error saving history');
```

**`loadBatchQueue()`** (line 573):
```js
// Old: console.error('Error loading batch queue:', error.message);
// New:
log.error({ err: error }, 'Error loading batch queue');
```

**`saveBatchQueue()`** (line 585):
```js
// Old: console.error('Error saving batch queue:', error.message);
// New:
log.error({ err: error }, 'Error saving batch queue');
```

**`trackEmailConversation()`** (line 644):
```js
// Old: console.error('     ✗ Failed to track email:', error.message);
// New:
log.error({ err: error }, 'Failed to track email');
```

**`sendBatchSummary()`** (lines 653, 748, 751, 754, 761):
```js
// Old: console.log('  ℹ️  No non-urgent emails to summarize');
// New:
log.info('No non-urgent emails to summarize');

// Old: console.log(`  ✓ Sent batch summary (${batchQueue.length} emails)`);
// New:
log.info({ count: batchQueue.length }, 'Sent batch summary');

// Old: console.log(`  💾 Pre-caching ${emailsToShow.length} email(s)...`);
// New:
log.info({ count: emailsToShow.length }, 'Pre-caching emails');

// Old: console.log(`  ✓ Cached ${emailsToShow.length} email(s)`);
// New:
log.info({ count: emailsToShow.length }, 'Cached emails');

// Old: console.error('  ✗ Failed to send batch summary:', error.message);
// New:
log.error({ err: error }, 'Failed to send batch summary');
```

**`checkEmails()`** (lines 770-888):
```js
// Old: console.log(`[${timestamp}] Checking for new emails...`);
// New:
log.info('Checking for new emails');

// Old: console.log('  No unread emails in last 10 minutes');
// New:
log.info('No unread emails in last 10 minutes');

// Old: console.log(`  Found ${emails.length} unread email(s)`);
// New:
log.info({ count: emails.length }, 'Found unread emails');

// Old: console.log(`  📦 Archiving: ${fromShort}`);
//      console.log(`     Reason: ${filter.reason}`);
// New:
log.info({ from: fromShort, reason: filter.reason }, 'Archiving email');

// Old: console.log(`  🗑️  Deleting: ${fromShort}`);
//      console.log(`     Reason: ${filter.reason}`);
// New:
log.info({ from: fromShort, reason: filter.reason }, 'Deleting email');

// Old: console.log(`  🏷️  Tagging: ${fromShort}`);
//      console.log(`     Label: ${filter.label}`);
//      console.log(`     Reason: ${filter.reason}`);
// New:
log.info({ from: fromShort, label: filter.label, reason: filter.reason }, 'Tagging email');

// Old: console.log(`  📧 From: ${fromShort}`);
//      console.log(`     Subject: ${email.subject}`);
//      console.log(`     ${urgency.urgent ? ...}`);
// New:
log.info({
  from: fromShort,
  subject: email.subject,
  urgent: urgency.urgent,
  reason: urgency.urgent ? urgency.reason : undefined
}, urgency.urgent ? 'Urgent email detected' : 'Normal email queued');

// Old: console.log(`     ✓ Sent Slack DM with action buttons (${target})`);
// New:
log.info({ target }, 'Sent Slack DM with action buttons');

// Old: console.error(`     ✗ Slack error:`, error.message);
// New:
log.error({ err: error }, 'Slack notification failed');

// Old: console.log(`     ✓ Sent macOS notification`);
// New:
log.info('Sent macOS notification');

// Old: console.error(`     ✗ macOS notification error:`, error.message);
// New:
log.error({ err: error }, 'macOS notification failed');

// Old: console.log(summary);
// New:
log.info({
  total: emails.length,
  urgent: urgentCount,
  archived: filteringStats.archived,
  deleted: filteringStats.deleted,
  queued: batchQueue.length
}, 'Email check complete');

// Old: console.log('\n  ⏰ Batch summary time!');
// New:
log.info('Batch summary time');
```

**`main()`** (lines 908-941):
```js
// Old: console.log('🦞 OpenClaw Gmail Monitor');
//      console.log(`   Account: ${CONFIG.gmailAccount}`);
//      ... etc
// New:
log.info({
  account: CONFIG.gmailAccount,
  vipCount: VIPS.length,
  batchTimes: CONFIG.batchTimes,
  checkInterval: CONFIG.checkInterval / 1000
}, 'Gmail Monitor starting');

// Old: console.log(`   Loaded ${batchQueue.length} emails from previous batch queue\n`);
// New:
log.info({ count: batchQueue.length }, 'Loaded batch queue from previous session');

// Old: console.log('   ✓ Follow-ups tracking initialized\n');
// New:
log.info('Follow-ups tracking initialized');

// Old: console.error('   ✗ Failed to init follow-ups DB:', error.message);
// New:
log.error({ err: error }, 'Failed to init follow-ups DB');

// Old: console.error('Check error:', error);
// New:
log.error({ err: error }, 'Check error');

// Old: console.error('Fatal error:', error);
// New:
log.fatal({ err: error }, 'Fatal error');
```

Also remove all standalone `console.log('');` calls (empty lines) — pino handles formatting.

**Step 3: Test gmail-monitor startup**

Run:
```bash
cd ~/.openclaw/workspace && timeout 10 node gmail-monitor.js 2>&1 || true
```

Expected: Pretty structured output showing startup info and first email check. Also:

```bash
head -5 ~/.openclaw/logs/gmail-monitor.log
```

Expected: JSON lines with structured fields.

**Step 4: Commit**

```bash
cd ~/.openclaw/workspace
git add gmail-monitor.js
git commit -m "feat: migrate gmail-monitor to structured logging with pino"
```

---

### Task 5: Clean up old log files and shell redirects

**Files:**
- Modify: `start-followup-checker.sh` (note: NOT migrating followup-checker.js yet, just documenting the pattern change)
- Delete: old scattered log files in workspace/

**Step 1: Remove old gmail-monitor log files from workspace**

Run:
```bash
cd ~/.openclaw/workspace
rm -f gmail-monitor.log gmail-monitor-error.log
```

**Step 2: Verify new logs are in the right place**

Run:
```bash
ls -la ~/.openclaw/logs/
```

Expected: `gateway.log`, `gateway.err.log`, `unsub.log`, `gmail-monitor.log`

**Step 3: Commit**

```bash
cd ~/.openclaw/workspace
git add -A
git commit -m "chore: clean up old log files (now in ~/.openclaw/logs/)"
```

---

### Task 6: Verify end-to-end

**Step 1: Run unsub with correlation ID and verify log output**

Run:
```bash
cd ~/.openclaw/workspace && node unsub --correlation-id=e2e-test "id:19c2fed919be283b" 2>&1
```

**Step 2: Query logs with jq**

Run:
```bash
cat ~/.openclaw/logs/unsub.log | jq -c 'select(.correlationId == "e2e-test") | {level, msg}' | tail -5
```

Expected: JSON objects showing the unsub flow with correlation ID.

**Step 3: Verify gmail-monitor log rotation config**

Run:
```bash
cd ~/.openclaw/workspace && node -e "
const log = require('./lib/logger')('rotation-test');
for (let i = 0; i < 100; i++) log.info({ i }, 'test line');
setTimeout(() => {
  const fs = require('fs');
  const stat = fs.statSync(process.env.HOME + '/.openclaw/logs/rotation-test.log');
  console.log('Log file size:', stat.size, 'bytes');
  console.log('Rotation will kick in at 10MB');
  fs.unlinkSync(process.env.HOME + '/.openclaw/logs/rotation-test.log');
}, 1000);
"
```

Expected: Log file created, size reported, then cleaned up. Confirms pino-roll is wired correctly.

**Step 4: Final commit if any adjustments were needed**

```bash
cd ~/.openclaw/workspace
git add -A
git commit -m "chore: verify structured logging end-to-end"
```
