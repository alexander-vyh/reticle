# Schema Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `followups-db.js` with a new `claudia-db.js` module implementing the 9-table schema from [the design doc](2026-02-19-schema-redesign-design.md), then migrate all 4 services to use it.

**Architecture:** New `claudia-db.js` creates a fresh `claudia.db` SQLite database with typed entity tables, a generic edge table for cross-entity links, and an append-only action log for ML training. Every entity table gets a JSON `metadata` column. All entities reference an `accounts` table for multi-account support. Services are migrated one at a time, each as its own commit.

**Tech Stack:** better-sqlite3 (existing), Node.js assert (existing test pattern), no new dependencies.

**Important conventions:**
- Tests use plain Node.js `assert` module (no test framework)
- DB path: `~/.openclaw/workspace/claudia.db` (replaces `followups.db`)
- All functions that previously took `(db, ...)` now take `(db, accountId, ...)` where applicable
- No delete rules — only 'archive', 'alert', 'demote', 'flag'
- Tests use `@example.com` addresses (gitleaks blocks real company emails)
- Runtime code reads the actual email from `CONFIG.gmailAccount`

**Reference:** Full SQL DDL is in `docs/plans/2026-02-19-schema-redesign-design.md`

---

## Service → Function Usage Map

| Service | DB var | Functions used |
|---------|--------|---------------|
| gmail-monitor.js | `followupsDbConn` | initDatabase, getActiveRules, recordRuleHit, trackConversation, getPendingResponses, updateConversationState, getRulesSummary |
| slack-events-monitor.js | `followupsDbConn` | initDatabase, trackConversation, updateConversationState, resolveConversation, createRule, deactivateRule, getRuleById |
| meeting-alert-monitor.js | `o3Db` | initDatabase, upsertO3Session, getO3Session, getLastO3ForReport, getPendingResponses, markO3Notified, getWeeklyO3Summary |
| followup-checker.js | `db` | initDatabase, getPendingResponses, getResolvedToday, getAwaitingReplies, markNotified, logNotification |

No service uses direct SQL — all access is via module exports.

---

### Task 1: Create claudia-db.js — Schema, Accounts, Entity Links, Action Log

The foundation: `initDatabase()` creates all 9 tables, plus the three infrastructure APIs (accounts, links, action log).

**Files:**
- Create: `claudia-db.js`
- Create: `test-claudia-db.js`

**Step 1: Write the failing test for initDatabase + accounts**

```js
// test-claudia-db.js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests
const TEST_DB_PATH = path.join(os.tmpdir(), `claudia-test-${Date.now()}.db`);
process.env.CLAUDIA_DB_PATH = TEST_DB_PATH;

const claudiaDb = require('./claudia-db');

// Cleanup on exit
process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = claudiaDb.initDatabase();

// --- Test: Database initializes with all tables ---
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all().map(r => r.name);
assert.deepStrictEqual(tables, [
  'accounts', 'action_log', 'conversations', 'email_rules',
  'emails', 'entity_links', 'notification_log', 'o3_sessions', 'unsubscribes'
]);
console.log('PASS: all 9 tables created');

// --- Test: upsertAccount + getAccount ---
const acct = claudiaDb.upsertAccount(db, {
  email: 'alexanderv@example.com',
  provider: 'gmail',
  display_name: 'Alexander (Work)',
  is_primary: 1
});
assert.ok(acct.id);
assert.strictEqual(acct.email, 'alexanderv@example.com');

const fetched = claudiaDb.getAccount(db, 'alexanderv@example.com');
assert.strictEqual(fetched.id, acct.id);
assert.strictEqual(fetched.is_primary, 1);
console.log('PASS: upsertAccount + getAccount');

// --- Test: getPrimaryAccount ---
const primary = claudiaDb.getPrimaryAccount(db);
assert.strictEqual(primary.email, 'alexanderv@example.com');
console.log('PASS: getPrimaryAccount');

// --- Test: upsert is idempotent ---
const acct2 = claudiaDb.upsertAccount(db, {
  email: 'alexanderv@example.com',
  display_name: 'Alexander V'
});
assert.strictEqual(acct2.id, acct.id);
assert.strictEqual(acct2.display_name, 'Alexander V');
console.log('PASS: upsert idempotent');

console.log('\n--- Task 1 accounts tests passed ---');
```

**Step 2: Run test — verify it fails**

```bash
node test-claudia-db.js
```
Expected: `Cannot find module './claudia-db'`

**Step 3: Write claudia-db.js — initDatabase + accounts**

```js
// claudia-db.js
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_DIR = path.join(process.env.HOME, '.openclaw', 'workspace');
const DB_PATH = process.env.CLAUDIA_DB_PATH || path.join(DB_DIR, 'claudia.db');

// --- Entity Type + Relationship Registries ---

const ENTITY_TYPES = {
  email: 'email',
  conversation: 'conversation',
  unsubscribe: 'unsubscribe',
  email_rule: 'email_rule',
  o3_session: 'o3_session',
  todo: 'todo',
  calendar_event: 'calendar_event',
  slack_message: 'slack_message',
};

const RELATIONSHIPS = {
  belongs_to: 'belongs_to',
  triggered: 'triggered',
  replied_to: 'replied_to',
  follow_up_for: 'follow_up_for',
  unsubscribed_from: 'unsubscribed_from',
  mentioned_in: 'mentioned_in',
};

function generateId() {
  return crypto.randomUUID();
}

function initDatabase() {
  if (!process.env.CLAUDIA_DB_PATH) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id           TEXT PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      provider     TEXT NOT NULL DEFAULT 'gmail',
      display_name TEXT,
      is_primary   INTEGER NOT NULL DEFAULT 0,
      metadata     TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS emails (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES accounts(id),
      gmail_id    TEXT,
      thread_id   TEXT,
      from_addr   TEXT NOT NULL,
      from_name   TEXT,
      to_addrs    TEXT,
      cc_addrs    TEXT,
      subject     TEXT,
      date        INTEGER NOT NULL,
      direction   TEXT NOT NULL,
      snippet     TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_emails_account  ON emails(account_id);
    CREATE INDEX IF NOT EXISTS idx_emails_gmail_id ON emails(account_id, gmail_id);
    CREATE INDEX IF NOT EXISTS idx_emails_thread   ON emails(account_id, thread_id);
    CREATE INDEX IF NOT EXISTS idx_emails_from     ON emails(from_addr);
    CREATE INDEX IF NOT EXISTS idx_emails_date     ON emails(date);

    CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY,
      account_id    TEXT NOT NULL REFERENCES accounts(id),
      type          TEXT NOT NULL,
      subject       TEXT,
      participants  TEXT,
      state         TEXT NOT NULL DEFAULT 'active',
      waiting_for   TEXT,
      urgency       TEXT DEFAULT 'normal',
      first_seen    INTEGER NOT NULL,
      last_activity INTEGER NOT NULL,
      resolved_at   INTEGER,
      snoozed_until INTEGER,
      metadata      TEXT,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conv_account  ON conversations(account_id);
    CREATE INDEX IF NOT EXISTS idx_conv_state    ON conversations(state);
    CREATE INDEX IF NOT EXISTS idx_conv_waiting  ON conversations(waiting_for) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_conv_activity ON conversations(last_activity);

    CREATE TABLE IF NOT EXISTS unsubscribes (
      id              TEXT PRIMARY KEY,
      account_id      TEXT NOT NULL REFERENCES accounts(id),
      sender_addr     TEXT,
      sender_domain   TEXT NOT NULL,
      method          TEXT NOT NULL,
      unsubscribe_url TEXT,
      requested_at    INTEGER NOT NULL,
      confirmed       INTEGER DEFAULT 0,
      confirmed_at    INTEGER,
      emails_since    INTEGER DEFAULT 0,
      metadata        TEXT,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_unsub_domain ON unsubscribes(sender_domain);
    CREATE INDEX IF NOT EXISTS idx_unsub_addr   ON unsubscribes(sender_addr);

    CREATE TABLE IF NOT EXISTS email_rules (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id             TEXT NOT NULL REFERENCES accounts(id),
      rule_type              TEXT NOT NULL,
      match_from             TEXT,
      match_from_domain      TEXT,
      match_to               TEXT,
      match_subject_contains TEXT,
      source_email           TEXT,
      source_subject         TEXT,
      hit_count              INTEGER NOT NULL DEFAULT 0,
      last_hit_at            INTEGER,
      active                 INTEGER NOT NULL DEFAULT 1,
      metadata               TEXT,
      created_at             INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rules_from   ON email_rules(match_from) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS idx_rules_domain ON email_rules(match_from_domain) WHERE active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_unique ON email_rules(
      account_id, rule_type,
      COALESCE(match_from,''), COALESCE(match_from_domain,''),
      COALESCE(match_to,''), COALESCE(match_subject_contains,'')
    );

    CREATE TABLE IF NOT EXISTS entity_links (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type  TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      target_type  TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      relationship TEXT NOT NULL,
      metadata     TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_links_source ON entity_links(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_links_target ON entity_links(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_links_rel    ON entity_links(relationship);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique ON entity_links(
      source_type, source_id, target_type, target_id, relationship
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      account_id  TEXT REFERENCES accounts(id),
      actor       TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      action      TEXT NOT NULL,
      context     TEXT,
      outcome     TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_action_time    ON action_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_action_entity  ON action_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_action_actor   ON action_log(actor);
    CREATE INDEX IF NOT EXISTS idx_action_type    ON action_log(action);
    CREATE INDEX IF NOT EXISTS idx_action_account ON action_log(account_id, timestamp);

    CREATE TABLE IF NOT EXISTS o3_sessions (
      id                  TEXT PRIMARY KEY,
      account_id          TEXT NOT NULL REFERENCES accounts(id),
      report_name         TEXT NOT NULL,
      report_email        TEXT NOT NULL,
      scheduled_start     INTEGER NOT NULL,
      scheduled_end       INTEGER NOT NULL,
      verified            INTEGER,
      zoom_meeting_id     TEXT,
      zoom_summary        TEXT,
      prep_sent_afternoon INTEGER,
      prep_sent_before    INTEGER,
      post_nudge_sent     INTEGER,
      lattice_logged      INTEGER,
      metadata            TEXT,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_o3_account ON o3_sessions(account_id);
    CREATE INDEX IF NOT EXISTS idx_o3_report  ON o3_sessions(report_email);
    CREATE INDEX IF NOT EXISTS idx_o3_start   ON o3_sessions(scheduled_start);

    CREATE TABLE IF NOT EXISTS notification_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id        TEXT REFERENCES accounts(id),
      conversation_id   TEXT NOT NULL,
      notification_type TEXT NOT NULL,
      channel           TEXT DEFAULT 'slack',
      sent_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      metadata          TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_notif_conv    ON notification_log(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_notif_account ON notification_log(account_id, sent_at);
  `);

  return db;
}

// --- Accounts ---

function upsertAccount(db, { email, provider = 'gmail', display_name = null, is_primary = 0, metadata = null }) {
  const existing = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
  if (existing) {
    db.prepare(`UPDATE accounts SET
      provider = COALESCE(?, provider),
      display_name = COALESCE(?, display_name),
      is_primary = ?,
      metadata = COALESCE(?, metadata),
      updated_at = strftime('%s','now')
      WHERE email = ?`
    ).run(provider, display_name, is_primary, metadata ? JSON.stringify(metadata) : null, email);
    return db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
  }
  const id = generateId();
  db.prepare(`INSERT INTO accounts (id, email, provider, display_name, is_primary, metadata)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, email, provider, display_name, is_primary, metadata ? JSON.stringify(metadata) : null);
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

function getAccount(db, email) {
  return db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
}

function getPrimaryAccount(db) {
  return db.prepare('SELECT * FROM accounts WHERE is_primary = 1 LIMIT 1').get();
}

module.exports = {
  DB_PATH,
  ENTITY_TYPES,
  RELATIONSHIPS,
  initDatabase,
  upsertAccount,
  getAccount,
  getPrimaryAccount,
};
```

**Step 4: Run test — verify it passes**

```bash
node test-claudia-db.js
```
Expected: All 4 assertions pass.

**Step 5: Add entity link tests to test-claudia-db.js**

Append to `test-claudia-db.js`:

```js
// --- Test: link + getLinked ---
claudiaDb.link(db, {
  sourceType: 'email', sourceId: 'email-1',
  targetType: 'conversation', targetId: 'conv-1',
  relationship: 'belongs_to'
});

const linked = claudiaDb.getLinked(db, 'email', 'email-1');
assert.strictEqual(linked.length, 1);
assert.strictEqual(linked[0].target_type, 'conversation');
assert.strictEqual(linked[0].target_id, 'conv-1');
console.log('PASS: link + getLinked (forward)');

// Reverse lookup
const reverse = claudiaDb.getLinked(db, 'conversation', 'conv-1');
assert.strictEqual(reverse.length, 1);
assert.strictEqual(reverse[0].source_type, 'email');
console.log('PASS: getLinked (reverse)');

// Filtered lookup
claudiaDb.link(db, {
  sourceType: 'email', sourceId: 'email-1',
  targetType: 'todo', targetId: 'todo-1',
  relationship: 'triggered'
});
const filtered = claudiaDb.getLinked(db, 'email', 'email-1', {
  targetType: 'todo'
});
assert.strictEqual(filtered.length, 1);
assert.strictEqual(filtered[0].relationship, 'triggered');
console.log('PASS: getLinked (filtered)');

// Duplicate link is idempotent (upsert)
claudiaDb.link(db, {
  sourceType: 'email', sourceId: 'email-1',
  targetType: 'conversation', targetId: 'conv-1',
  relationship: 'belongs_to'
});
const afterDup = claudiaDb.getLinked(db, 'email', 'email-1');
assert.strictEqual(afterDup.length, 2); // still 2, not 3
console.log('PASS: duplicate link is idempotent');

// Invalid entity type throws
assert.throws(() => {
  claudiaDb.link(db, {
    sourceType: 'bogus', sourceId: 'x',
    targetType: 'email', targetId: 'y',
    relationship: 'belongs_to'
  });
}, /Unknown entity type/);
console.log('PASS: invalid entity type throws');

// unlink
claudiaDb.unlink(db, 'email', 'email-1', 'todo', 'todo-1', 'triggered');
const afterUnlink = claudiaDb.getLinked(db, 'email', 'email-1');
assert.strictEqual(afterUnlink.length, 1);
console.log('PASS: unlink');

console.log('\n--- Task 1 entity_links tests passed ---');
```

**Step 6: Implement link, getLinked, unlink in claudia-db.js**

Add before `module.exports`:

```js
// --- Entity Links ---

function validateEntityType(type) {
  if (!Object.values(ENTITY_TYPES).includes(type)) {
    throw new Error(`Unknown entity type: "${type}". Valid types: ${Object.keys(ENTITY_TYPES).join(', ')}`);
  }
}

function link(db, { sourceType, sourceId, targetType, targetId, relationship, metadata = null }) {
  validateEntityType(sourceType);
  validateEntityType(targetType);
  db.prepare(`INSERT INTO entity_links (source_type, source_id, target_type, target_id, relationship, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_type, source_id, target_type, target_id, relationship) DO UPDATE SET
      metadata = COALESCE(excluded.metadata, entity_links.metadata)`
  ).run(sourceType, sourceId, targetType, targetId, relationship, metadata ? JSON.stringify(metadata) : null);
}

function getLinked(db, entityType, entityId, { direction, relationship, targetType, sourceType } = {}) {
  const results = [];
  // Forward: this entity is the source
  if (direction !== 'reverse') {
    let sql = 'SELECT * FROM entity_links WHERE source_type = ? AND source_id = ?';
    const params = [entityType, entityId];
    if (targetType) { sql += ' AND target_type = ?'; params.push(targetType); }
    if (relationship) { sql += ' AND relationship = ?'; params.push(relationship); }
    results.push(...db.prepare(sql).all(...params));
  }
  // Reverse: this entity is the target
  if (direction !== 'forward') {
    let sql = 'SELECT * FROM entity_links WHERE target_type = ? AND target_id = ?';
    const params = [entityType, entityId];
    if (sourceType) { sql += ' AND source_type = ?'; params.push(sourceType); }
    if (relationship) { sql += ' AND relationship = ?'; params.push(relationship); }
    results.push(...db.prepare(sql).all(...params));
  }
  return results;
}

function unlink(db, sourceType, sourceId, targetType, targetId, relationship) {
  db.prepare(`DELETE FROM entity_links
    WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND relationship = ?`
  ).run(sourceType, sourceId, targetType, targetId, relationship);
}
```

Update `module.exports` to include `link, getLinked, unlink`.

**Step 7: Run tests — verify link tests pass**

```bash
node test-claudia-db.js
```

**Step 8: Add action log tests to test-claudia-db.js**

Append:

```js
// --- Test: logAction + getEntityHistory + getRecentActions ---
claudiaDb.logAction(db, {
  accountId: acct.id, actor: 'system', entityType: 'email', entityId: 'email-1',
  action: 'received', context: { from: 'test@example.com' }
});
claudiaDb.logAction(db, {
  accountId: acct.id, actor: 'rule:5', entityType: 'email', entityId: 'email-1',
  action: 'archived', context: { rule: 'zoom-filter' }, outcome: { labels_removed: ['INBOX'] }
});
claudiaDb.logAction(db, {
  accountId: acct.id, actor: 'user', entityType: 'email', entityId: 'email-1',
  action: 'moved_to_inbox', context: { reason: 'user override' }
});

const history = claudiaDb.getEntityHistory(db, 'email', 'email-1');
assert.strictEqual(history.length, 3);
assert.strictEqual(history[0].action, 'received');
assert.strictEqual(history[2].action, 'moved_to_inbox');
console.log('PASS: logAction + getEntityHistory');

const userActions = claudiaDb.getRecentActions(db, { actor: 'user' });
assert.strictEqual(userActions.length, 1);
assert.strictEqual(userActions[0].action, 'moved_to_inbox');
console.log('PASS: getRecentActions filtered by actor');

const allActions = claudiaDb.getRecentActions(db, { accountId: acct.id });
assert.strictEqual(allActions.length, 3);
console.log('PASS: getRecentActions filtered by account');

console.log('\n--- Task 1 action_log tests passed ---');
```

**Step 9: Implement logAction, getEntityHistory, getRecentActions**

Add before `module.exports`:

```js
// --- Action Log ---

function logAction(db, { accountId = null, actor, entityType = null, entityId = null, action, context = null, outcome = null, metadata = null }) {
  db.prepare(`INSERT INTO action_log (account_id, actor, entity_type, entity_id, action, context, outcome, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId, actor, entityType, entityId, action,
    context ? JSON.stringify(context) : null,
    outcome ? JSON.stringify(outcome) : null,
    metadata ? JSON.stringify(metadata) : null
  );
}

function getEntityHistory(db, entityType, entityId) {
  return db.prepare(
    'SELECT * FROM action_log WHERE entity_type = ? AND entity_id = ? ORDER BY timestamp ASC'
  ).all(entityType, entityId);
}

function getRecentActions(db, { accountId, actor, action, since, limit = 100 } = {}) {
  let sql = 'SELECT * FROM action_log WHERE 1=1';
  const params = [];
  if (accountId) { sql += ' AND account_id = ?'; params.push(accountId); }
  if (actor) { sql += ' AND actor = ?'; params.push(actor); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (since) { sql += ' AND timestamp >= ?'; params.push(since); }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}
```

Update `module.exports` to include `logAction, getEntityHistory, getRecentActions`.

**Step 10: Run tests — verify all Task 1 tests pass**

```bash
node test-claudia-db.js
```
Expected: All tests pass.

**Step 11: Commit**

```bash
git add claudia-db.js test-claudia-db.js
git commit -m "feat: add claudia-db module with schema, accounts, entity links, and action log"
```

---

### Task 2: Add Email Functions

**Files:**
- Modify: `claudia-db.js`
- Modify: `test-claudia-db.js`

**Step 1: Add email tests to test-claudia-db.js**

Append:

```js
// --- Test: upsertEmail + getEmailByGmailId + getEmailsByThread ---
const email = claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: '19c748749068b21d',
  thread_id: 'thread-abc',
  from_addr: 'noreply@okta.com',
  from_name: 'Okta',
  to_addrs: ['alexanderv@example.com'],
  subject: 'Okta rate limit warning',
  date: Math.floor(Date.now() / 1000),
  direction: 'inbound',
  snippet: 'Your org has exceeded...'
});
assert.ok(email.id);
assert.strictEqual(email.gmail_id, '19c748749068b21d');
console.log('PASS: upsertEmail');

const byGmail = claudiaDb.getEmailByGmailId(db, acct.id, '19c748749068b21d');
assert.strictEqual(byGmail.id, email.id);
console.log('PASS: getEmailByGmailId');

// Second email in same thread
claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: '19c748749068b22e',
  thread_id: 'thread-abc',
  from_addr: 'alexanderv@example.com',
  to_addrs: ['noreply@okta.com'],
  subject: 'Re: Okta rate limit warning',
  date: Math.floor(Date.now() / 1000) + 60,
  direction: 'outbound'
});

const thread = claudiaDb.getEmailsByThread(db, acct.id, 'thread-abc');
assert.strictEqual(thread.length, 2);
console.log('PASS: getEmailsByThread');

// Upsert same gmail_id updates existing
const updated = claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: '19c748749068b21d',
  thread_id: 'thread-abc',
  from_addr: 'noreply@okta.com',
  subject: 'Okta rate limit warning (updated)',
  date: Math.floor(Date.now() / 1000),
  direction: 'inbound'
});
assert.strictEqual(updated.id, email.id);
assert.strictEqual(updated.subject, 'Okta rate limit warning (updated)');
console.log('PASS: upsertEmail idempotent');

console.log('\n--- Task 2 email tests passed ---');
```

**Step 2: Run test — verify it fails**

```bash
node test-claudia-db.js
```
Expected: `claudiaDb.upsertEmail is not a function`

**Step 3: Implement email functions in claudia-db.js**

Add before `module.exports`:

```js
// --- Emails ---

function upsertEmail(db, accountId, { gmail_id, thread_id = null, from_addr, from_name = null,
    to_addrs = null, cc_addrs = null, subject = null, date, direction, snippet = null, metadata = null }) {
  if (gmail_id) {
    const existing = db.prepare('SELECT * FROM emails WHERE account_id = ? AND gmail_id = ?').get(accountId, gmail_id);
    if (existing) {
      db.prepare(`UPDATE emails SET
        thread_id = COALESCE(?, thread_id), from_addr = ?, from_name = COALESCE(?, from_name),
        to_addrs = COALESCE(?, to_addrs), cc_addrs = COALESCE(?, cc_addrs),
        subject = COALESCE(?, subject), date = ?, direction = ?,
        snippet = COALESCE(?, snippet), metadata = COALESCE(?, metadata)
        WHERE id = ?`
      ).run(
        thread_id, from_addr, from_name,
        to_addrs ? JSON.stringify(to_addrs) : null, cc_addrs ? JSON.stringify(cc_addrs) : null,
        subject, date, direction, snippet,
        metadata ? JSON.stringify(metadata) : null, existing.id
      );
      return db.prepare('SELECT * FROM emails WHERE id = ?').get(existing.id);
    }
  }
  const id = generateId();
  db.prepare(`INSERT INTO emails (id, account_id, gmail_id, thread_id, from_addr, from_name,
    to_addrs, cc_addrs, subject, date, direction, snippet, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, accountId, gmail_id, thread_id, from_addr, from_name,
    to_addrs ? JSON.stringify(to_addrs) : null, cc_addrs ? JSON.stringify(cc_addrs) : null,
    subject, date, direction, snippet, metadata ? JSON.stringify(metadata) : null);
  return db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
}

function getEmailByGmailId(db, accountId, gmailId) {
  return db.prepare('SELECT * FROM emails WHERE account_id = ? AND gmail_id = ?').get(accountId, gmailId);
}

function getEmailsByThread(db, accountId, threadId) {
  return db.prepare('SELECT * FROM emails WHERE account_id = ? AND thread_id = ? ORDER BY date ASC')
    .all(accountId, threadId);
}
```

Update `module.exports` to include `upsertEmail, getEmailByGmailId, getEmailsByThread`.

**Step 4: Run tests — verify pass**

```bash
node test-claudia-db.js
```

**Step 5: Commit**

```bash
git add claudia-db.js test-claudia-db.js
git commit -m "feat: add email entity functions to claudia-db"
```

---

### Task 3: Port Conversation Functions

These are the most heavily used functions across services. The API stays nearly identical — just adding `accountId` as the second parameter.

**Files:**
- Modify: `claudia-db.js`
- Modify: `test-claudia-db.js`

**Step 1: Add conversation tests**

Append to `test-claudia-db.js`:

```js
// --- Test: trackConversation ---
const now = Math.floor(Date.now() / 1000);
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:thread-1',
  type: 'email',
  subject: 'Q1 Budget Review',
  from_user: 'boss@example.com',
  from_name: 'Boss',
  last_sender: 'them',
  waiting_for: 'my-response',
  metadata: { urgency: 'high' }
});

const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:thread-1');
assert.strictEqual(conv.type, 'email');
assert.strictEqual(conv.subject, 'Q1 Budget Review');
assert.strictEqual(conv.waiting_for, 'my-response');
assert.strictEqual(conv.account_id, acct.id);
console.log('PASS: trackConversation');

// --- Test: updateConversationState ---
claudiaDb.updateConversationState(db, 'email:thread-1', 'me', 'their-response');
const updated2 = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:thread-1');
assert.strictEqual(updated2.waiting_for, 'their-response');
console.log('PASS: updateConversationState');

// --- Test: getPendingResponses ---
const pending = claudiaDb.getPendingResponses(db, acct.id, { type: 'email' });
assert.strictEqual(pending.length, 1);
assert.strictEqual(pending[0].id, 'email:thread-1');
console.log('PASS: getPendingResponses');

// --- Test: resolveConversation ---
claudiaDb.resolveConversation(db, 'email:thread-1');
const resolved = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:thread-1');
assert.ok(resolved.resolved_at);
assert.strictEqual(resolved.state, 'resolved');
console.log('PASS: resolveConversation');

// --- Test: getAwaitingReplies ---
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:thread-2',
  type: 'email',
  subject: 'Pending question',
  from_user: 'me@example.com',
  from_name: 'Me',
  last_sender: 'me',
  waiting_for: 'their-response'
});
const awaiting = claudiaDb.getAwaitingReplies(db, acct.id, {});
assert.ok(awaiting.length >= 1);
console.log('PASS: getAwaitingReplies');

// --- Test: getResolvedToday ---
const resolvedToday = claudiaDb.getResolvedToday(db, acct.id, 'email');
assert.strictEqual(resolvedToday.length, 1);
console.log('PASS: getResolvedToday');

// --- Test: getStats ---
const stats = claudiaDb.getStats(db, acct.id);
assert.ok(stats.total >= 2);
console.log('PASS: getStats');

console.log('\n--- Task 3 conversation tests passed ---');
```

**Step 2: Run test — verify it fails**

```bash
node test-claudia-db.js
```
Expected: `claudiaDb.trackConversation is not a function`

**Step 3: Implement conversation functions**

Read the existing `trackConversation`, `updateConversationState`, `resolveConversation`, `getPendingResponses`, `getAwaitingReplies`, `getResolvedToday`, `getStats`, `markNotified`, `logNotification` from `followups-db.js` and port them with `accountId` parameter added. The logic stays the same — just the table has `account_id` now.

Key mapping (old → new signature):
- `trackConversation(db, data)` → `trackConversation(db, accountId, data)`
- `updateConversationState(db, id, sender, waitingFor)` → same (no account needed, id is unique)
- `resolveConversation(db, id)` → same
- `getPendingResponses(db, opts)` → `getPendingResponses(db, accountId, opts)`
- `getAwaitingReplies(db, opts)` → `getAwaitingReplies(db, accountId, opts)`
- `getResolvedToday(db, type)` → `getResolvedToday(db, accountId, type)`
- `getStats(db)` → `getStats(db, accountId)`
- `markNotified(db, id)` → same (id is unique)
- `logNotification(db, convId, type)` → `logNotification(db, accountId, convId, type)`

Implement each function by reading the existing implementation from `followups-db.js` and adapting:
- Add `account_id` to INSERT statements
- Add `account_id = ?` to WHERE clauses where filtering by account
- Update the `metadata` column to use JSON (it was already JSON in the old schema)
- Add `state` and `urgency` fields to conversations

**Step 4: Run tests — verify pass**

```bash
node test-claudia-db.js
```

**Step 5: Commit**

```bash
git add claudia-db.js test-claudia-db.js
git commit -m "feat: port conversation tracking functions to claudia-db"
```

---

### Task 4: Add Unsubscribe Functions

**Files:**
- Modify: `claudia-db.js`
- Modify: `test-claudia-db.js`

**Step 1: Add unsubscribe tests**

Append to `test-claudia-db.js`:

```js
// --- Test: recordUnsubscribe ---
const unsub = claudiaDb.recordUnsubscribe(db, acct.id, {
  sender_addr: 'marketing@vanta.com',
  sender_domain: 'vanta.com',
  method: 'list-unsubscribe-post',
  unsubscribe_url: 'https://vanta.com/unsubscribe?token=abc',
  metadata: { trigger_email_subject: 'Vanta Security Update' }
});
assert.ok(unsub.id);
assert.strictEqual(unsub.sender_domain, 'vanta.com');
assert.strictEqual(unsub.confirmed, 0);
console.log('PASS: recordUnsubscribe');

// --- Test: checkUnsubscribed ---
const check = claudiaDb.checkUnsubscribed(db, acct.id, 'vanta.com');
assert.strictEqual(check.unsubscribed, true);
assert.strictEqual(check.emails_since, 0);
console.log('PASS: checkUnsubscribed (positive)');

const checkNone = claudiaDb.checkUnsubscribed(db, acct.id, 'unknown.com');
assert.strictEqual(checkNone.unsubscribed, false);
console.log('PASS: checkUnsubscribed (negative)');

// --- Test: incrementEmailsSince ---
claudiaDb.incrementEmailsSince(db, acct.id, 'vanta.com');
claudiaDb.incrementEmailsSince(db, acct.id, 'vanta.com');
const check2 = claudiaDb.checkUnsubscribed(db, acct.id, 'vanta.com');
assert.strictEqual(check2.emails_since, 2);
console.log('PASS: incrementEmailsSince');

// --- Test: confirmUnsubscribe ---
claudiaDb.confirmUnsubscribe(db, unsub.id);
const check3 = claudiaDb.checkUnsubscribed(db, acct.id, 'vanta.com');
assert.strictEqual(check3.confirmed, true);
console.log('PASS: confirmUnsubscribe');

console.log('\n--- Task 4 unsubscribe tests passed ---');
```

**Step 2: Run test — verify failure**

**Step 3: Implement unsubscribe functions**

```js
// --- Unsubscribes ---

function recordUnsubscribe(db, accountId, { sender_addr = null, sender_domain, method,
    unsubscribe_url = null, metadata = null }) {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO unsubscribes (id, account_id, sender_addr, sender_domain, method,
    unsubscribe_url, requested_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, accountId, sender_addr, sender_domain, method, unsubscribe_url, now,
    metadata ? JSON.stringify(metadata) : null);
  return db.prepare('SELECT * FROM unsubscribes WHERE id = ?').get(id);
}

function checkUnsubscribed(db, accountId, senderDomain) {
  const row = db.prepare(
    'SELECT * FROM unsubscribes WHERE account_id = ? AND sender_domain = ? ORDER BY requested_at DESC LIMIT 1'
  ).get(accountId, senderDomain);
  if (!row) return { unsubscribed: false, emails_since: 0, confirmed: false };
  return {
    unsubscribed: true,
    emails_since: row.emails_since,
    confirmed: !!row.confirmed,
    requested_at: row.requested_at,
    method: row.method,
    id: row.id
  };
}

function incrementEmailsSince(db, accountId, senderDomain) {
  db.prepare(
    `UPDATE unsubscribes SET emails_since = emails_since + 1
     WHERE account_id = ? AND sender_domain = ? AND id = (
       SELECT id FROM unsubscribes WHERE account_id = ? AND sender_domain = ?
       ORDER BY requested_at DESC LIMIT 1
     )`
  ).run(accountId, senderDomain, accountId, senderDomain);
}

function confirmUnsubscribe(db, unsubscribeId) {
  db.prepare(
    'UPDATE unsubscribes SET confirmed = 1, confirmed_at = strftime(\'%s\',\'now\') WHERE id = ?'
  ).run(unsubscribeId);
}
```

Update `module.exports`.

**Step 4: Run tests — verify pass**

```bash
node test-claudia-db.js
```

**Step 5: Commit**

```bash
git add claudia-db.js test-claudia-db.js
git commit -m "feat: add unsubscribe tracking functions to claudia-db"
```

---

### Task 5: Port Email Rule Functions

**Files:**
- Modify: `claudia-db.js`
- Modify: `test-claudia-db.js`

**Step 1: Add email rule tests**

Append to `test-claudia-db.js`:

```js
// --- Test: createRule ---
const rule = claudiaDb.createRule(db, acct.id, {
  rule_type: 'archive',
  match_from: 'noreply@zoom.us',
  source_email: 'noreply@zoom.us',
  source_subject: 'Meeting reminder'
});
assert.ok(rule.id);
assert.strictEqual(rule.rule_type, 'archive');
console.log('PASS: createRule');

// --- Test: getActiveRules ---
const rules = claudiaDb.getActiveRules(db, acct.id);
assert.ok(rules.length >= 1);
assert.strictEqual(rules[0].match_from, 'noreply@zoom.us');
console.log('PASS: getActiveRules');

// --- Test: recordRuleHit ---
claudiaDb.recordRuleHit(db, rule.id);
claudiaDb.recordRuleHit(db, rule.id);
const hitRule = claudiaDb.getRuleById(db, rule.id);
assert.strictEqual(hitRule.hit_count, 2);
console.log('PASS: recordRuleHit');

// --- Test: deactivateRule ---
claudiaDb.deactivateRule(db, rule.id);
const deactivated = claudiaDb.getRuleById(db, rule.id);
assert.strictEqual(deactivated.active, 0);
const activeRules = claudiaDb.getActiveRules(db, acct.id);
assert.strictEqual(activeRules.filter(r => r.match_from === 'noreply@zoom.us').length, 0);
console.log('PASS: deactivateRule');

// --- Test: getRulesSummary ---
// Re-create for summary test
claudiaDb.createRule(db, acct.id, { rule_type: 'archive', match_from_domain: 'example.com' });
const summary = claudiaDb.getRulesSummary(db, acct.id);
assert.ok(summary.total >= 1);
console.log('PASS: getRulesSummary');

// --- Test: no delete rules allowed ---
assert.throws(() => {
  claudiaDb.createRule(db, acct.id, { rule_type: 'delete', match_from: 'spam@bad.com' });
}, /delete rules are not allowed/i);
console.log('PASS: delete rules blocked');

console.log('\n--- Task 5 email_rules tests passed ---');
```

**Step 2: Run test — verify failure**

**Step 3: Implement email rule functions**

Port from `followups-db.js`, adding `accountId` parameter and the delete-rule guard:

```js
// --- Email Rules ---

const ALLOWED_RULE_TYPES = ['archive', 'alert', 'demote', 'flag'];

function createRule(db, accountId, { rule_type, match_from = null, match_from_domain = null,
    match_to = null, match_subject_contains = null, source_email = null, source_subject = null, metadata = null }) {
  if (rule_type === 'delete') {
    throw new Error('Delete rules are not allowed. Use archive, alert, demote, or flag.');
  }
  const mf = match_from ? match_from.toLowerCase() : null;
  const mfd = match_from_domain ? match_from_domain.toLowerCase() : null;
  const mt = match_to ? match_to.toLowerCase() : null;
  const msc = match_subject_contains ? match_subject_contains.toLowerCase() : null;

  const result = db.prepare(`INSERT INTO email_rules
    (account_id, rule_type, match_from, match_from_domain, match_to, match_subject_contains, source_email, source_subject, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, rule_type, COALESCE(match_from,''), COALESCE(match_from_domain,''),
                 COALESCE(match_to,''), COALESCE(match_subject_contains,''))
    DO UPDATE SET active = 1, source_email = COALESCE(excluded.source_email, email_rules.source_email),
                  source_subject = COALESCE(excluded.source_subject, email_rules.source_subject)`
  ).run(accountId, rule_type, mf, mfd, mt, msc, source_email, source_subject,
    metadata ? JSON.stringify(metadata) : null);
  return db.prepare('SELECT * FROM email_rules WHERE id = ?').get(result.lastInsertRowid);
}

function getActiveRules(db, accountId) {
  return db.prepare('SELECT * FROM email_rules WHERE account_id = ? AND active = 1').all(accountId);
}

function recordRuleHit(db, ruleId) {
  db.prepare(
    "UPDATE email_rules SET hit_count = hit_count + 1, last_hit_at = strftime('%s','now') WHERE id = ?"
  ).run(ruleId);
}

function deactivateRule(db, ruleId) {
  db.prepare('UPDATE email_rules SET active = 0 WHERE id = ?').run(ruleId);
}

function getRuleById(db, ruleId) {
  return db.prepare('SELECT * FROM email_rules WHERE id = ?').get(ruleId);
}

function getRulesSummary(db, accountId) {
  const total = db.prepare('SELECT COUNT(*) as c FROM email_rules WHERE account_id = ? AND active = 1').get(accountId).c;
  const top = db.prepare(
    'SELECT * FROM email_rules WHERE account_id = ? AND active = 1 ORDER BY hit_count DESC LIMIT 10'
  ).all(accountId);
  return { total, top };
}
```

Update `module.exports`.

**Step 4: Run tests — verify pass**

```bash
node test-claudia-db.js
```

**Step 5: Commit**

```bash
git add claudia-db.js test-claudia-db.js
git commit -m "feat: port email rule functions to claudia-db with delete-rule guard"
```

---

### Task 6: Port O3 Session + Notification Functions

**Files:**
- Modify: `claudia-db.js`
- Modify: `test-claudia-db.js`

**Step 1: Add O3 + notification tests**

Append to `test-claudia-db.js`:

```js
// --- Test: upsertO3Session ---
const o3Start = Math.floor(Date.now() / 1000);
claudiaDb.upsertO3Session(db, acct.id, {
  id: 'cal-event-1',
  report_name: 'Jane Smith',
  report_email: 'jane@example.com',
  scheduled_start: o3Start,
  scheduled_end: o3Start + 1800,
  created_at: o3Start - 86400
});

const session = claudiaDb.getO3Session(db, 'cal-event-1');
assert.strictEqual(session.report_name, 'Jane Smith');
assert.strictEqual(session.account_id, acct.id);
console.log('PASS: upsertO3Session + getO3Session');

// --- Test: markO3Notified ---
claudiaDb.markO3Notified(db, 'cal-event-1', 'prep_sent_afternoon');
const notified = claudiaDb.getO3Session(db, 'cal-event-1');
assert.strictEqual(notified.prep_sent_afternoon, 1);
console.log('PASS: markO3Notified');

// --- Test: getLastO3ForReport ---
const last = claudiaDb.getLastO3ForReport(db, 'jane@example.com', o3Start + 1);
assert.strictEqual(last.id, 'cal-event-1');
console.log('PASS: getLastO3ForReport');

// --- Test: logNotification + markNotified (uses conv from Task 3) ---
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:notif-test',
  type: 'email',
  subject: 'Notification test',
  from_user: 'test@example.com',
  from_name: 'Test',
  last_sender: 'them',
  waiting_for: 'my-response'
});
claudiaDb.logNotification(db, acct.id, 'email:notif-test', 'immediate');
const notifCount = db.prepare('SELECT COUNT(*) as c FROM notification_log WHERE conversation_id = ?')
  .get('email:notif-test').c;
assert.strictEqual(notifCount, 1);
console.log('PASS: logNotification');

claudiaDb.markNotified(db, 'email:notif-test');
const notifConv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('email:notif-test');
assert.ok(notifConv.updated_at);
console.log('PASS: markNotified');

console.log('\n--- Task 6 O3 + notification tests passed ---');
console.log('\n=== ALL CLAUDIA-DB TESTS PASSED ===');
```

**Step 2: Run test — verify failure**

**Step 3: Implement O3 + notification functions**

Port directly from `followups-db.js`, adding `accountId` to O3 functions and adjusting column names:

```js
// --- O3 Sessions ---

function upsertO3Session(db, accountId, { id, report_name, report_email, scheduled_start, scheduled_end, created_at }) {
  db.prepare(`INSERT INTO o3_sessions (id, account_id, report_name, report_email, scheduled_start, scheduled_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      report_name = excluded.report_name,
      report_email = excluded.report_email,
      scheduled_start = excluded.scheduled_start,
      scheduled_end = excluded.scheduled_end`
  ).run(id, accountId, report_name, report_email, scheduled_start, scheduled_end, created_at || Math.floor(Date.now() / 1000));
}

function getO3Session(db, id) {
  return db.prepare('SELECT * FROM o3_sessions WHERE id = ?').get(id);
}

function markO3Notified(db, sessionId, field) {
  const allowed = ['prep_sent_afternoon', 'prep_sent_before', 'post_nudge_sent', 'lattice_logged'];
  if (!allowed.includes(field)) throw new Error(`Invalid O3 notification field: ${field}`);
  db.prepare(`UPDATE o3_sessions SET ${field} = 1 WHERE id = ?`).run(sessionId);
}

function getLastO3ForReport(db, reportEmail, beforeTimestamp) {
  return db.prepare(
    'SELECT * FROM o3_sessions WHERE report_email = ? AND scheduled_start < ? ORDER BY scheduled_start DESC LIMIT 1'
  ).get(reportEmail, beforeTimestamp);
}

function getO3SessionsForReport(db, reportEmail) {
  return db.prepare('SELECT * FROM o3_sessions WHERE report_email = ? ORDER BY scheduled_start DESC').all(reportEmail);
}

function getWeeklyO3Summary(db, weekStart, weekEnd) {
  return db.prepare(
    'SELECT * FROM o3_sessions WHERE scheduled_start >= ? AND scheduled_start < ? ORDER BY scheduled_start ASC'
  ).all(weekStart, weekEnd);
}

function markO3LatticeLogged(db, sessionId) {
  db.prepare("UPDATE o3_sessions SET lattice_logged = 1 WHERE id = ?").run(sessionId);
}

// --- Notifications ---

function logNotification(db, accountId, conversationId, notificationType, channel = 'slack') {
  db.prepare(`INSERT INTO notification_log (account_id, conversation_id, notification_type, channel)
    VALUES (?, ?, ?, ?)`
  ).run(accountId, conversationId, notificationType, channel);
}

function markNotified(db, conversationId) {
  db.prepare(
    "UPDATE conversations SET notified_at = strftime('%s','now'), updated_at = strftime('%s','now') WHERE id = ?"
  ).run(conversationId);
}
```

Wait — `conversations` table in new schema doesn't have `notified_at`. That was in the old schema. We need to decide: add it to conversations, or rely on notification_log queries.

**Decision:** Keep `notified_at` in conversations for quick lookups (the old pattern works well). Add it to the conversations DDL:

In `initDatabase()`, add after `snoozed_until INTEGER,`:
```sql
      notified_at   INTEGER,
```

Update `module.exports` with all new functions.

**Step 4: Run tests — verify pass**

```bash
node test-claudia-db.js
```

**Step 5: Commit**

```bash
git add claudia-db.js test-claudia-db.js
git commit -m "feat: port O3 session and notification functions to claudia-db"
```

---

### Task 7: Migrate gmail-monitor.js

The biggest migration — gmail-monitor uses 7 functions.

**Files:**
- Modify: `gmail-monitor.js`

**Step 1: Read current gmail-monitor.js DB usage**

Functions used and their call sites:
1. `followupsDb.initDatabase()` → line 1289
2. `followupsDb.getActiveRules(followupsDbConn)` → line 376
3. `followupsDb.recordRuleHit(followupsDbConn, rule.id)` → line 409
4. `followupsDb.trackConversation(db, {...})` → line 803 (in trackEmailConversation)
5. `followupsDb.getPendingResponses(followupsDbConn, { type: 'email' })` → line 986
6. `followupsDb.updateConversationState(followupsDbConn, conv.id, 'me', 'their-response')` → line 1008
7. `followupsDb.getRulesSummary(followupsDbConn)` → line 1238

**Step 2: Update imports and initialization**

Change:
```js
const followupsDb = require('./followups-db');
```
to:
```js
const claudiaDb = require('./claudia-db');
```

In `main()`, change:
```js
followupsDbConn = followupsDb.initDatabase();
```
to:
```js
followupsDbConn = claudiaDb.initDatabase();
// Ensure primary account exists
const primaryAccount = claudiaDb.upsertAccount(followupsDbConn, {
  email: CONFIG.gmailAccount,
  provider: 'gmail',
  display_name: 'Primary',
  is_primary: 1
});
const accountId = primaryAccount.id;
```

Store `accountId` in a module-level variable accessible to all functions.

**Step 3: Update each function call**

For each call site, the change is:
- `followupsDb.getActiveRules(followupsDbConn)` → `claudiaDb.getActiveRules(followupsDbConn, accountId)`
- `followupsDb.recordRuleHit(followupsDbConn, rule.id)` → `claudiaDb.recordRuleHit(followupsDbConn, rule.id)` (unchanged — ruleId is unique)
- `followupsDb.trackConversation(db, data)` → `claudiaDb.trackConversation(db, accountId, data)`
- `followupsDb.getPendingResponses(followupsDbConn, opts)` → `claudiaDb.getPendingResponses(followupsDbConn, accountId, opts)`
- `followupsDb.updateConversationState(...)` → `claudiaDb.updateConversationState(...)` (unchanged)
- `followupsDb.getRulesSummary(followupsDbConn)` → `claudiaDb.getRulesSummary(followupsDbConn, accountId)`

**Step 4: Smoke test**

```bash
node gmail-monitor.js
```
Verify it starts without errors, processes at least one check cycle, and exits cleanly with Ctrl+C.

**Step 5: Commit**

```bash
git add gmail-monitor.js
git commit -m "refactor: migrate gmail-monitor to claudia-db"
```

---

### Task 8: Migrate slack-events-monitor.js

**Files:**
- Modify: `slack-events-monitor.js`

**Step 1: Read current DB usage**

Functions used:
1. `followupsDb.initDatabase()` → line 1302
2. `followupsDb.trackConversation(db, data)` → line 185
3. `followupsDb.updateConversationState(...)` → line 894
4. `followupsDb.resolveConversation(...)` → line 902
5. `followupsDb.createRule(...)` → lines 731, 756, 822, 947, 1013, 1046
6. `followupsDb.deactivateRule(...)` → lines 736, 826, 945, 963, 1025
7. `followupsDb.getRuleById(...)` → lines 760, 925, 929, 948, 962, 1011

**Step 2: Update imports and initialization**

Same pattern as gmail-monitor:
```js
const claudiaDb = require('./claudia-db');
```

In `main()`, add account upsert after `initDatabase()`.

**Step 3: Update each function call**

- `followupsDb.trackConversation(db, data)` → `claudiaDb.trackConversation(db, accountId, data)`
- `followupsDb.createRule(db, data)` → `claudiaDb.createRule(db, accountId, data)` (6 call sites)
- `followupsDb.deactivateRule(db, id)` → `claudiaDb.deactivateRule(db, id)` (unchanged)
- `followupsDb.getRuleById(db, id)` → `claudiaDb.getRuleById(db, id)` (unchanged)
- `followupsDb.updateConversationState(...)` → `claudiaDb.updateConversationState(...)` (unchanged)
- `followupsDb.resolveConversation(...)` → `claudiaDb.resolveConversation(...)` (unchanged)

**Step 4: Smoke test**

```bash
node slack-events-monitor.js
```
Verify startup without errors.

**Step 5: Commit**

```bash
git add slack-events-monitor.js
git commit -m "refactor: migrate slack-events-monitor to claudia-db"
```

---

### Task 9: Migrate meeting-alert-monitor.js + followup-checker.js

These two are smaller and can be done together.

**Files:**
- Modify: `meeting-alert-monitor.js`
- Modify: `followup-checker.js`

**Step 1: Migrate meeting-alert-monitor.js**

Functions used:
1. `initDatabase()` → line 694
2. `upsertO3Session(db, data)` → line 293 → `upsertO3Session(db, accountId, data)`
3. `getO3Session(db, id)` → line 301 → unchanged
4. `getLastO3ForReport(db, email, ts)` → line 149, 192 → unchanged
5. `getPendingResponses(db, opts)` → line 155, 198 → `getPendingResponses(db, accountId, opts)`
6. `markO3Notified(db, id, field)` → line 175, 224, 269 → unchanged
7. `getWeeklyO3Summary(db, start, end)` → line 388 → unchanged

Update imports and initialization (same pattern). Update `upsertO3Session` and `getPendingResponses` calls to pass `accountId`.

**Step 2: Migrate followup-checker.js**

Functions used:
1. `initDatabase()` → line 418
2. `getPendingResponses(db, opts)` → lines 197, 258, 363 → `getPendingResponses(db, accountId, opts)`
3. `getResolvedToday(db, type)` → line 198 → `getResolvedToday(db, accountId, type)`
4. `getAwaitingReplies(db, opts)` → line 335 → `getAwaitingReplies(db, accountId, opts)`
5. `markNotified(db, id)` → lines 315, 390 → unchanged
6. `logNotification(db, convId, type)` → lines 316, 353, 391 → `logNotification(db, accountId, convId, type)`

Update imports, initialization, and function calls.

**Step 3: Smoke test both**

```bash
node meeting-alert-monitor.js
node followup-checker.js
```

**Step 4: Commit**

```bash
git add meeting-alert-monitor.js followup-checker.js
git commit -m "refactor: migrate meeting-alert-monitor and followup-checker to claudia-db"
```

---

### Task 10: Update Tests, Root Config, and Cleanup

**Files:**
- Remove: `followups-db.js`
- Remove: `test-followups.js`
- Modify: `package.json` (root)

**Step 1: Update root package.json test script**

Change:
```json
"test": "npm test --prefix tray"
```
to:
```json
"test": "node test-claudia-db.js && npm test --prefix tray"
```

**Step 2: Run full test suite**

```bash
npm test
```
Expected: Both claudia-db tests and tray tests pass.

**Step 3: Remove old files**

```bash
git rm followups-db.js test-followups.js
```

**Step 4: Verify no remaining references**

```bash
grep -r 'followups-db' --include='*.js' .
grep -r 'followups\.db' --include='*.js' .
```
Expected: No matches (or only in docs/plans which are fine).

**Step 5: Restart all services**

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gmail-monitor
launchctl kickstart -k gui/$(id -u)/ai.openclaw.slack-monitor
launchctl kickstart -k gui/$(id -u)/ai.openclaw.slack-events
launchctl kickstart -k gui/$(id -u)/com.openclaw.meeting-alerts
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

Verify via tray app that all services are running (green dot).

**Step 6: Commit**

```bash
git add package.json
git commit -m "refactor: remove followups-db.js, update test script to include claudia-db tests"
```

**Step 7: Final verification**

Check that the new `claudia.db` file was created:
```bash
ls -la ~/.openclaw/workspace/claudia.db
```

Check that services are writing to it:
```bash
sqlite3 ~/.openclaw/workspace/claudia.db "SELECT * FROM accounts;"
sqlite3 ~/.openclaw/workspace/claudia.db "SELECT COUNT(*) FROM action_log;"
```

---

## Summary

| Task | What | Files | Est. Steps |
|------|------|-------|------------|
| 1 | Schema + accounts + links + action log | claudia-db.js, test-claudia-db.js | 11 |
| 2 | Email entity functions | claudia-db.js, test-claudia-db.js | 5 |
| 3 | Conversation functions (port) | claudia-db.js, test-claudia-db.js | 5 |
| 4 | Unsubscribe functions (new) | claudia-db.js, test-claudia-db.js | 5 |
| 5 | Email rule functions (port) | claudia-db.js, test-claudia-db.js | 5 |
| 6 | O3 + notification functions (port) | claudia-db.js, test-claudia-db.js | 5 |
| 7 | Migrate gmail-monitor | gmail-monitor.js | 5 |
| 8 | Migrate slack-events-monitor | slack-events-monitor.js | 5 |
| 9 | Migrate meeting-alert + followup-checker | meeting-alert-monitor.js, followup-checker.js | 4 |
| 10 | Tests, cleanup, verification | package.json, remove old files | 7 |
