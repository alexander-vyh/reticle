# Reticle Periodic Digest — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a two-tier personal reflection digest (daily + weekly) that collects structured items from all data sources, detects longitudinal patterns, and delivers AI-narrated Slack summaries.

**Architecture:** Three-layer pipeline — deterministic collectors produce `DigestItem[]`, pattern detectors compute trends from snapshot history, AI narration arranges items into readable prose. The AI cannot add facts, only present them.

**Tech Stack:** Node.js, better-sqlite3, googleapis, @anthropic-ai/sdk, Slack Web API (raw https), pino logging

**Design Doc:** `docs/plans/2026-02-23-reticle-periodic-digest-design.md`

---

## Task 1: DigestItem module (`lib/digest-item.js`)

**Files:**
- Create: `lib/digest-item.js`
- Create: `test-digest-item.js`

**Step 1: Write the failing test**

```js
'use strict';

const assert = require('assert');

// This will fail until we create the module
const { createDigestItem, createPatternInsight, deduplicateItems } = require('./lib/digest-item');

// --- Test: createDigestItem with all required fields ---
const item = createDigestItem({
  collector: 'followup',
  observation: 'Sarah Chen emailed you about "Q3 Budget Review" 52 hours ago',
  reason: 'Unreplied email older than 48 hours',
  authority: 'Auto-capture: hygiene obligation',
  consequence: 'Will appear in tomorrow\'s digest if still unreplied.',
  sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/abc123',
  sourceType: 'email',
  category: 'unreplied',
  priority: 'high',
  ageSeconds: 187200,
  counterparty: 'Sarah Chen',
  observedAt: 1740300000
});

assert.ok(item.id, 'Should auto-generate an id');
assert.ok(item.id.startsWith('digest-followup-'), 'Id should be prefixed with collector name');
assert.strictEqual(item.collector, 'followup');
assert.strictEqual(item.priority, 'high');
assert.ok(item.collectedAt, 'Should auto-set collectedAt');
console.log('PASS: createDigestItem with all fields');

// --- Test: createDigestItem rejects missing required fields ---
assert.throws(() => {
  createDigestItem({ collector: 'test' }); // missing observation, reason, etc.
}, /Missing required field/);
console.log('PASS: createDigestItem rejects missing fields');

// --- Test: createDigestItem rejects invalid priority ---
assert.throws(() => {
  createDigestItem({
    collector: 'test',
    observation: 'test',
    reason: 'test',
    authority: 'test',
    consequence: 'test',
    sourceType: 'email',
    category: 'unreplied',
    priority: 'EXTREME',
    observedAt: 1740300000
  });
}, /Invalid priority/);
console.log('PASS: createDigestItem rejects invalid priority');

// --- Test: createPatternInsight ---
const insight = createPatternInsight({
  type: 'trend',
  observation: 'Reply time increased from 8h to 14h over 3 weeks',
  evidence: { thisWeek: { avgReplyHours: 14 }, lastWeek: { avgReplyHours: 11 } },
  significance: 'moderate',
  reason: '3-week upward trend',
  authority: 'Pattern detection: computed from digest snapshots',
  consequence: 'Informational.'
});

assert.ok(insight.id.startsWith('pattern-'));
assert.strictEqual(insight.type, 'trend');
assert.strictEqual(insight.significance, 'moderate');
console.log('PASS: createPatternInsight');

// --- Test: deduplicateItems ---
const items = [
  createDigestItem({
    collector: 'followup',
    observation: 'Unreplied email from Sarah',
    reason: 'r', authority: 'a', consequence: 'c',
    sourceType: 'email', sourceUrl: 'https://mail.google.com/abc',
    category: 'unreplied', priority: 'normal',
    observedAt: 1740300000,
    entityId: 'thread-abc'
  }),
  createDigestItem({
    collector: 'email',
    observation: 'VIP unreplied: Sarah',
    reason: 'r', authority: 'a', consequence: 'c',
    sourceType: 'email', sourceUrl: 'https://mail.google.com/abc',
    category: 'vip-unreplied', priority: 'high',
    observedAt: 1740300000,
    entityId: 'thread-abc'
  }),
  createDigestItem({
    collector: 'calendar',
    observation: 'Meeting tomorrow',
    reason: 'r', authority: 'a', consequence: 'c',
    sourceType: 'calendar',
    category: 'meeting-with-open-followups', priority: 'high',
    observedAt: 1740300000,
    entityId: 'cal-event-1'
  })
];

const deduped = deduplicateItems(items);
assert.strictEqual(deduped.length, 2, 'Should remove duplicate email item');
// The high-priority version should win
const emailItem = deduped.find(i => i.sourceType === 'email');
assert.strictEqual(emailItem.priority, 'high', 'Higher priority should win dedup');
assert.strictEqual(emailItem.collector, 'email', 'Higher priority collector should win');
console.log('PASS: deduplicateItems keeps higher priority');

console.log('\n=== ALL DIGEST-ITEM TESTS PASSED ===');
```

**Step 2: Run test to verify it fails**

Run: `node test-digest-item.js`
Expected: FAIL with `Cannot find module './lib/digest-item'`

**Step 3: Write minimal implementation**

```js
'use strict';

const crypto = require('crypto');

const VALID_PRIORITIES = ['low', 'normal', 'high', 'critical'];
const VALID_SIGNIFICANCE = ['minor', 'moderate', 'notable'];
const REQUIRED_ITEM_FIELDS = ['collector', 'observation', 'reason', 'authority', 'consequence', 'sourceType', 'category', 'priority', 'observedAt'];
const REQUIRED_INSIGHT_FIELDS = ['type', 'observation', 'evidence', 'significance', 'reason', 'authority', 'consequence'];

function createDigestItem(fields) {
  for (const field of REQUIRED_ITEM_FIELDS) {
    if (!fields[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  if (!VALID_PRIORITIES.includes(fields.priority)) {
    throw new Error(`Invalid priority: ${fields.priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }

  return {
    id: `digest-${fields.collector}-${crypto.randomBytes(6).toString('hex')}`,
    collector: fields.collector,
    observation: fields.observation,
    reason: fields.reason,
    authority: fields.authority,
    consequence: fields.consequence,
    sourceUrl: fields.sourceUrl || null,
    sourceType: fields.sourceType,
    category: fields.category,
    priority: fields.priority,
    ageSeconds: fields.ageSeconds || null,
    counterparty: fields.counterparty || null,
    entityId: fields.entityId || null,
    observedAt: fields.observedAt,
    collectedAt: Math.floor(Date.now() / 1000)
  };
}

function createPatternInsight(fields) {
  for (const field of REQUIRED_INSIGHT_FIELDS) {
    if (fields[field] === undefined || fields[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  if (!VALID_SIGNIFICANCE.includes(fields.significance)) {
    throw new Error(`Invalid significance: ${fields.significance}`);
  }

  return {
    id: `pattern-${crypto.randomBytes(6).toString('hex')}`,
    type: fields.type,
    observation: fields.observation,
    evidence: fields.evidence,
    significance: fields.significance,
    reason: fields.reason,
    authority: fields.authority,
    consequence: fields.consequence
  };
}

function deduplicateItems(items) {
  const priorityRank = { low: 0, normal: 1, high: 2, critical: 3 };
  const seen = new Map(); // key: `${sourceType}:${entityId}` → item

  for (const item of items) {
    if (!item.entityId) {
      // Items without entityId are never duplicates
      seen.set(item.id, item);
      continue;
    }

    const key = `${item.sourceType}:${item.entityId}`;
    const existing = seen.get(key);

    if (!existing || priorityRank[item.priority] > priorityRank[existing.priority]) {
      seen.set(key, item);
    }
  }

  return Array.from(seen.values());
}

module.exports = { createDigestItem, createPatternInsight, deduplicateItems, VALID_PRIORITIES };
```

**Step 4: Run test to verify it passes**

Run: `node test-digest-item.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add lib/digest-item.js test-digest-item.js
git commit -m "feat(digest): add DigestItem and PatternInsight data types with validation and dedup"
```

---

## Task 2: DB schema extension (`claudia-db.js`)

**Files:**
- Modify: `claudia-db.js` (add `digest_snapshots` table + 3 functions)
- Modify: `test-claudia-db.js` (add snapshot tests)

**Step 1: Write the failing test**

Append to the end of `test-claudia-db.js` (before the final "ALL PASSED" line):

```js
// --- Test: digest_snapshots table exists ---
const snapshotTable = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='digest_snapshots'"
).get();
assert.ok(snapshotTable, 'digest_snapshots table should exist');
console.log('PASS: digest_snapshots table created');

// --- Test: saveSnapshot ---
const testItems = [
  { id: 'test-1', collector: 'followup', observation: 'test', priority: 'normal' },
  { id: 'test-2', collector: 'email', observation: 'test2', priority: 'high' }
];
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-23',
  cadence: 'daily',
  items: testItems
});
console.log('PASS: saveSnapshot');

// --- Test: getSnapshotsForRange ---
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-22',
  cadence: 'daily',
  items: [{ id: 'test-3', collector: 'followup', observation: 'yesterday' }]
});
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-21',
  cadence: 'weekly',
  items: [{ id: 'test-4' }]
});

const snapshots = claudiaDb.getSnapshotsForRange(db, acct.id, '2026-02-20', '2026-02-24');
assert.strictEqual(snapshots.length, 3, 'Should return all 3 snapshots in range');
// Items should be parsed back to arrays
assert.ok(Array.isArray(snapshots[0].items), 'Items should be parsed from JSON');
console.log('PASS: getSnapshotsForRange');

// Filtered by cadence
const dailyOnly = claudiaDb.getSnapshotsForRange(db, acct.id, '2026-02-20', '2026-02-24', 'daily');
assert.strictEqual(dailyOnly.length, 2, 'Should return only daily snapshots');
console.log('PASS: getSnapshotsForRange with cadence filter');

// --- Test: pruneOldSnapshots ---
// Add an old snapshot
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2025-01-01',
  cadence: 'daily',
  items: [{ id: 'ancient' }]
});
const beforePrune = claudiaDb.getSnapshotsForRange(db, acct.id, '2025-01-01', '2025-01-02');
assert.strictEqual(beforePrune.length, 1);

claudiaDb.pruneOldSnapshots(db, acct.id, 56); // 56 days = 8 weeks
const afterPrune = claudiaDb.getSnapshotsForRange(db, acct.id, '2025-01-01', '2025-01-02');
assert.strictEqual(afterPrune.length, 0, 'Old snapshot should be pruned');
console.log('PASS: pruneOldSnapshots');

// --- Test: account isolation for snapshots ---
claudiaDb.saveSnapshot(db, acctB.id, {
  snapshotDate: '2026-02-23',
  cadence: 'daily',
  items: [{ id: 'acctB-item' }]
});
const acctASnapshots = claudiaDb.getSnapshotsForRange(db, acct.id, '2026-02-23', '2026-02-24');
// Should only have acct A's snapshot from earlier, not acct B's
const acctAItems = acctASnapshots.flatMap(s => s.items);
assert.ok(!acctAItems.some(i => i.id === 'acctB-item'), 'Account A should not see account B snapshots');
console.log('PASS: snapshot account isolation');

console.log('\n--- Digest snapshot tests passed ---');
```

Also update the table-existence assertion at the top of the test file to include the new table:

```js
assert.deepStrictEqual(tables, [
  'accounts', 'action_log', 'conversations', 'digest_snapshots', 'email_rules',
  'emails', 'entity_links', 'notification_log', 'o3_sessions', 'unsubscribes'
]);
console.log('PASS: all 10 tables created');
```

**Step 2: Run test to verify it fails**

Run: `node test-claudia-db.js`
Expected: FAIL at table assertion (9 tables, not 10)

**Step 3: Write minimal implementation**

Add to `claudia-db.js`:

1. In `initDatabase()`, add this table after the `notification_log` CREATE TABLE (before the closing `` ` ``):

```sql
CREATE TABLE IF NOT EXISTS digest_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  snapshot_date  TEXT NOT NULL,
  cadence        TEXT NOT NULL,
  items          TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_digest_date ON digest_snapshots(account_id, snapshot_date);
```

2. Add these three functions before the `module.exports` block:

```js
function saveSnapshot(db, accountId, { snapshotDate, cadence, items }) {
  db.prepare(`
    INSERT INTO digest_snapshots (account_id, snapshot_date, cadence, items)
    VALUES (?, ?, ?, ?)
  `).run(accountId, snapshotDate, cadence, JSON.stringify(items));
}

function getSnapshotsForRange(db, accountId, startDate, endDate, cadence = null) {
  let sql = `
    SELECT * FROM digest_snapshots
    WHERE account_id = ? AND snapshot_date >= ? AND snapshot_date < ?
  `;
  const params = [accountId, startDate, endDate];

  if (cadence) {
    sql += ` AND cadence = ?`;
    params.push(cadence);
  }

  sql += ` ORDER BY snapshot_date ASC`;

  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    items: JSON.parse(row.items)
  }));
}

function pruneOldSnapshots(db, accountId, maxAgeDays) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
  const cutoff = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD

  db.prepare(`
    DELETE FROM digest_snapshots
    WHERE account_id = ? AND snapshot_date < ?
  `).run(accountId, cutoff);
}
```

3. Add to `module.exports`:

```js
saveSnapshot,
getSnapshotsForRange,
pruneOldSnapshots,
```

**Step 4: Run test to verify it passes**

Run: `node test-claudia-db.js`
Expected: All tests PASS including new snapshot tests

**Step 5: Commit**

```bash
git add claudia-db.js test-claudia-db.js
git commit -m "feat(db): add digest_snapshots table for longitudinal pattern detection"
```

---

## Task 3: Follow-up collector (`lib/digest-collectors.js` — part 1)

**Files:**
- Create: `lib/digest-collectors.js`
- Create: `test-digest-collectors.js`

The collector module exports four functions. We build them one at a time. Start with the follow-up collector since it exercises the most DB queries.

**Step 1: Write the failing test**

```js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB
const TEST_DB_PATH = path.join(os.tmpdir(), `claudia-collector-test-${Date.now()}.db`);
process.env.CLAUDIA_DB_PATH = TEST_DB_PATH;

const claudiaDb = require('./claudia-db');
const { collectFollowups } = require('./lib/digest-collectors');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = claudiaDb.initDatabase();
const acct = claudiaDb.upsertAccount(db, {
  email: 'test@example.com', provider: 'gmail',
  display_name: 'Test User', is_primary: 1
});

// --- Seed test data ---
const now = Math.floor(Date.now() / 1000);

// Unreplied email: 52 hours old (should be high priority)
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:old-unreplied',
  type: 'email',
  subject: 'Q3 Budget Review',
  from_user: 'sarah@example.com',
  from_name: 'Sarah Chen',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now - (52 * 3600)
});

// Unreplied DM: 2 hours old (should be normal, under 24h threshold so excluded from daily)
claudiaDb.trackConversation(db, acct.id, {
  id: 'slack-dm:recent',
  type: 'slack-dm',
  subject: 'Quick question',
  from_user: 'U12345',
  from_name: 'Dev Teammate',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now - (2 * 3600)
});

// Awaiting reply: 5 days old
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:awaiting-old',
  type: 'email',
  subject: 'Vendor Contract',
  from_user: 'me@example.com',
  from_name: 'Me',
  last_sender: 'me',
  waiting_for: 'their-response',
  last_activity: now - (5 * 86400)
});

// Resolved today
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:resolved-today',
  type: 'email',
  subject: 'Resolved Issue',
  from_user: 'boss@example.com',
  from_name: 'Boss',
  last_sender: 'them',
  waiting_for: 'my-response'
});
claudiaDb.resolveConversation(db, 'email:resolved-today');

// --- Test: collectFollowups ---
const items = collectFollowups(db, acct.id);

assert.ok(Array.isArray(items), 'Should return an array');
assert.ok(items.length >= 3, `Should have at least 3 items, got ${items.length}`);

// Check the old unreplied email is high priority
const oldUnreplied = items.find(i => i.entityId === 'email:old-unreplied');
assert.ok(oldUnreplied, 'Should include 52h unreplied email');
assert.strictEqual(oldUnreplied.priority, 'high', '48-72h unreplied should be high');
assert.strictEqual(oldUnreplied.category, 'unreplied');
assert.strictEqual(oldUnreplied.collector, 'followup');
assert.ok(oldUnreplied.observation.includes('Sarah Chen'), 'Observation should name the counterparty');
assert.ok(oldUnreplied.reason, 'Must have a reason');
assert.ok(oldUnreplied.authority, 'Must have authority');
assert.ok(oldUnreplied.consequence, 'Must have consequence');
console.log('PASS: old unreplied email is high priority with full explainability');

// Check awaiting reply
const awaitingItem = items.find(i => i.entityId === 'email:awaiting-old');
assert.ok(awaitingItem, 'Should include 5-day awaiting reply');
assert.strictEqual(awaitingItem.category, 'awaiting');
assert.strictEqual(awaitingItem.priority, 'normal', '3-7d awaiting should be normal');
console.log('PASS: awaiting reply item with correct priority');

// Check resolved today (low priority positive signal)
const resolvedItem = items.find(i => i.entityId === 'email:resolved-today');
assert.ok(resolvedItem, 'Should include resolved-today');
assert.strictEqual(resolvedItem.category, 'resolved-today');
assert.strictEqual(resolvedItem.priority, 'low');
console.log('PASS: resolved-today is low priority positive signal');

// All items should have the DigestItem shape
for (const item of items) {
  assert.ok(item.id, `Item missing id: ${JSON.stringify(item)}`);
  assert.ok(item.observation, `Item missing observation: ${item.id}`);
  assert.ok(item.reason, `Item missing reason: ${item.id}`);
  assert.ok(item.authority, `Item missing authority: ${item.id}`);
  assert.ok(item.consequence, `Item missing consequence: ${item.id}`);
}
console.log('PASS: all items have full DigestItem shape');

console.log('\n=== FOLLOW-UP COLLECTOR TESTS PASSED ===');
```

**Step 2: Run test to verify it fails**

Run: `node test-digest-collectors.js`
Expected: FAIL with `Cannot find module './lib/digest-collectors'`

**Step 3: Write minimal implementation**

Create `lib/digest-collectors.js`:

```js
'use strict';

const claudiaDb = require('../claudia-db');
const { createDigestItem } = require('./digest-item');

function formatAge(seconds) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

function unrepliedPriority(ageSeconds) {
  if (ageSeconds > 72 * 3600) return 'critical';
  if (ageSeconds > 48 * 3600) return 'high';
  if (ageSeconds > 24 * 3600) return 'normal';
  return 'low';
}

function awaitingPriority(ageSeconds) {
  if (ageSeconds > 7 * 86400) return 'high';
  if (ageSeconds > 3 * 86400) return 'normal';
  return 'low';
}

function collectFollowups(db, accountId) {
  const now = Math.floor(Date.now() / 1000);
  const items = [];

  // Unreplied conversations (waiting for my response)
  const pending = claudiaDb.getPendingResponses(db, accountId, {});
  for (const conv of pending) {
    const age = now - conv.last_activity;
    const priority = unrepliedPriority(age);
    const name = conv.from_name || conv.from_user;
    const typeLabel = conv.type === 'email' ? 'emailed' : conv.type === 'slack-dm' ? 'sent you a DM' : 'mentioned you';

    items.push(createDigestItem({
      collector: 'followup',
      observation: `${name} ${typeLabel}${conv.subject ? ` about "${conv.subject}"` : ''} ${formatAge(age)} ago`,
      reason: `Unreplied for ${formatAge(age)}`,
      authority: 'Auto-capture: hygiene obligation (unreplied message)',
      consequence: priority === 'low'
        ? 'Under 24h. Will not appear unless it ages further.'
        : 'Will appear in tomorrow\'s digest if still unreplied. No enforcement configured.',
      sourceType: conv.type,
      category: 'unreplied',
      priority,
      ageSeconds: age,
      counterparty: name,
      entityId: conv.id,
      observedAt: conv.last_activity
    }));
  }

  // Awaiting replies (waiting for their response)
  const awaiting = claudiaDb.getAwaitingReplies(db, accountId, {});
  for (const conv of awaiting) {
    const age = now - conv.last_activity;
    const priority = awaitingPriority(age);
    const name = conv.from_name || conv.from_user;

    items.push(createDigestItem({
      collector: 'followup',
      observation: `You ${conv.type === 'email' ? 'emailed' : 'messaged'} ${name}${conv.subject ? ` about "${conv.subject}"` : ''} ${formatAge(age)} ago — no reply yet`,
      reason: `Awaiting reply for ${formatAge(age)}`,
      authority: 'Auto-capture: you initiated this thread',
      consequence: 'Informational. No action required unless you want to follow up.',
      sourceType: conv.type,
      category: 'awaiting',
      priority,
      ageSeconds: age,
      counterparty: name,
      entityId: conv.id,
      observedAt: conv.last_activity
    }));
  }

  // Stale conversations (active but no activity for 7+ days)
  const allActive = db.prepare(`
    SELECT * FROM conversations
    WHERE account_id = ? AND state = 'active' AND last_activity < ?
    ORDER BY last_activity ASC
  `).all(accountId, now - (7 * 86400));

  for (const conv of allActive) {
    // Skip if already captured as unreplied or awaiting
    if (items.some(i => i.entityId === conv.id)) continue;

    const age = now - conv.last_activity;
    const name = conv.from_name || conv.from_user;

    items.push(createDigestItem({
      collector: 'followup',
      observation: `Conversation with ${name}${conv.subject ? ` about "${conv.subject}"` : ''} has been inactive for ${formatAge(age)}`,
      reason: 'No activity for 7+ days on an open conversation',
      authority: 'Auto-capture: stale conversation detection',
      consequence: 'Consider resolving or following up.',
      sourceType: conv.type,
      category: 'stale',
      priority: 'normal',
      ageSeconds: age,
      counterparty: name,
      entityId: conv.id,
      observedAt: conv.last_activity
    }));
  }

  // Resolved today (positive signal)
  const resolved = claudiaDb.getResolvedToday(db, accountId);
  for (const conv of resolved) {
    const name = conv.from_name || conv.from_user;

    items.push(createDigestItem({
      collector: 'followup',
      observation: `Resolved: conversation with ${name}${conv.subject ? ` about "${conv.subject}"` : ''}`,
      reason: 'Resolved or responded to today',
      authority: 'Auto-capture: resolution tracking',
      consequence: 'No action needed. Positive signal for weekly patterns.',
      sourceType: conv.type,
      category: 'resolved-today',
      priority: 'low',
      ageSeconds: 0,
      counterparty: name,
      entityId: conv.id,
      observedAt: conv.resolved_at || Math.floor(Date.now() / 1000)
    }));
  }

  return items;
}

module.exports = { collectFollowups };
```

**Step 4: Run test to verify it passes**

Run: `node test-digest-collectors.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add lib/digest-collectors.js test-digest-collectors.js
git commit -m "feat(digest): add follow-up collector with priority tiers and explainability"
```

---

## Task 4: Email collector (`lib/digest-collectors.js` — part 2)

**Files:**
- Modify: `lib/digest-collectors.js` (add `collectEmail`)
- Modify: `test-digest-collectors.js` (add email collector tests)

**Step 1: Write the failing test**

Append to `test-digest-collectors.js` (before the final PASSED message, or start a new section):

```js
const { collectEmail } = require('./lib/digest-collectors');

// --- Seed email data ---
claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: 'gmail-001', thread_id: 'thread-001',
  from_addr: 'vip@example.com', from_name: 'VIP Boss',
  subject: 'Urgent request', date: now - 3600,
  direction: 'inbound'
});
claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: 'gmail-002', thread_id: 'thread-002',
  from_addr: 'test@example.com', to_addrs: JSON.stringify(['someone@example.com']),
  subject: 'Sent by me', date: now - 7200,
  direction: 'outbound'
});

// Log a commitment action
claudiaDb.logAction(db, {
  accountId: acct.id, actor: 'user', entityType: 'email', entityId: 'gmail-001',
  action: 'commitment', context: { text: 'I will review the RFC by Friday' }
});

const vipEmails = ['vip@example.com'];

const emailItems = collectEmail(db, acct.id, { vipEmails });

assert.ok(Array.isArray(emailItems));

// Should have volume item
const volumeItem = emailItems.find(i => i.category === 'email-volume');
assert.ok(volumeItem, 'Should include email volume');
assert.strictEqual(volumeItem.priority, 'low');
console.log('PASS: email volume item');

// Should have commitment item
const commitItem = emailItems.find(i => i.category === 'commitment');
assert.ok(commitItem, 'Should include commitment from action log');
assert.ok(commitItem.observation.includes('review the RFC'), 'Should include commitment text');
console.log('PASS: commitment item');

console.log('\n=== EMAIL COLLECTOR TESTS PASSED ===');
```

**Step 2: Run test to verify it fails**

Run: `node test-digest-collectors.js`
Expected: FAIL — `collectEmail is not a function` (not yet exported)

**Step 3: Write minimal implementation**

Add to `lib/digest-collectors.js`:

```js
function collectEmail(db, accountId, { vipEmails = [] } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(startOfDay.getTime() / 1000);
  const items = [];

  // Email volume today
  const received = db.prepare(
    'SELECT COUNT(*) as c FROM emails WHERE account_id = ? AND date >= ? AND direction = ?'
  ).get(accountId, dayStart, 'inbound');
  const sent = db.prepare(
    'SELECT COUNT(*) as c FROM emails WHERE account_id = ? AND date >= ? AND direction = ?'
  ).get(accountId, dayStart, 'outbound');

  items.push(createDigestItem({
    collector: 'email',
    observation: `Email today: ${received.c} received, ${sent.c} sent`,
    reason: 'Daily email volume summary',
    authority: 'Auto-capture: email activity tracking',
    consequence: 'Informational context for patterns.',
    sourceType: 'email',
    category: 'email-volume',
    priority: 'low',
    observedAt: now
  }));

  // VIP unreplied — check for VIP emails that are in unreplied conversations
  if (vipEmails.length > 0) {
    const pending = claudiaDb.getPendingResponses(db, accountId, { type: 'email' });
    for (const conv of pending) {
      const fromAddr = (conv.from_user || '').toLowerCase();
      if (vipEmails.includes(fromAddr)) {
        const age = now - conv.last_activity;
        items.push(createDigestItem({
          collector: 'email',
          observation: `VIP unreplied: ${conv.from_name || conv.from_user}${conv.subject ? ` — "${conv.subject}"` : ''} (${formatAge(age)})`,
          reason: `Unreplied email from VIP sender for ${formatAge(age)}`,
          authority: 'Auto-capture: VIP sender list',
          consequence: 'VIP messages are high priority. Consider responding promptly.',
          sourceType: 'email',
          category: 'vip-unreplied',
          priority: 'high',
          ageSeconds: age,
          counterparty: conv.from_name || conv.from_user,
          entityId: conv.id,
          observedAt: conv.last_activity
        }));
      }
    }
  }

  // Commitments logged today
  const commitments = db.prepare(`
    SELECT * FROM action_log
    WHERE account_id = ? AND actor = 'user' AND action = 'commitment'
      AND timestamp >= ?
    ORDER BY timestamp DESC
  `).all(accountId, dayStart);

  for (const entry of commitments) {
    const ctx = entry.context ? JSON.parse(entry.context) : {};
    items.push(createDigestItem({
      collector: 'email',
      observation: `You committed: "${ctx.text || 'commitment recorded'}"`,
      reason: 'Explicit commitment logged today',
      authority: 'Auto-capture: explicit commitment by user',
      consequence: 'Will be tracked for follow-through in future digests.',
      sourceType: 'email',
      category: 'commitment',
      priority: 'normal',
      entityId: entry.entity_id,
      observedAt: entry.timestamp
    }));
  }

  return items;
}
```

Update the `module.exports` to include `collectEmail`.

**Step 4: Run test to verify it passes**

Run: `node test-digest-collectors.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add lib/digest-collectors.js test-digest-collectors.js
git commit -m "feat(digest): add email collector with VIP detection and commitment tracking"
```

---

## Task 5: O3/Meeting collector (`lib/digest-collectors.js` — part 3)

**Files:**
- Modify: `lib/digest-collectors.js` (add `collectO3`)
- Modify: `test-digest-collectors.js` (add O3 tests)

**Step 1: Write the failing test**

Append to `test-digest-collectors.js`:

```js
const { collectO3 } = require('./lib/digest-collectors');

// --- Seed O3 data ---
claudiaDb.upsertO3Session(db, acct.id, {
  id: 'cal-o3-1',
  report_name: 'Jane Smith',
  report_email: 'jane@example.com',
  scheduled_start: now - (2 * 86400), // 2 days ago
  scheduled_end: now - (2 * 86400) + 1800,
  created_at: now - (3 * 86400)
});
// This O3 happened but Lattice not logged
claudiaDb.markO3Notified(db, 'cal-o3-1', 'prep_sent_before');

// Upcoming O3: tomorrow
claudiaDb.upsertO3Session(db, acct.id, {
  id: 'cal-o3-2',
  report_name: 'Dev Reyes',
  report_email: 'dev@example.com',
  scheduled_start: now + 86400,
  scheduled_end: now + 86400 + 1800,
  created_at: now
});

const o3Items = collectO3(db, acct.id);

assert.ok(Array.isArray(o3Items));

// Should flag the incomplete O3
const incomplete = o3Items.find(i => i.category === 'o3-incomplete');
assert.ok(incomplete, 'Should flag O3 without Lattice entry');
assert.strictEqual(incomplete.priority, 'high');
assert.ok(incomplete.observation.includes('Jane Smith'), 'Should name the report');
console.log('PASS: O3 incomplete flagged');

// Should show upcoming O3
const upcoming = o3Items.find(i => i.category === 'o3-upcoming');
assert.ok(upcoming, 'Should show upcoming O3');
assert.ok(upcoming.observation.includes('Dev Reyes'));
console.log('PASS: O3 upcoming shown');

console.log('\n=== O3 COLLECTOR TESTS PASSED ===');
```

**Step 2: Run test to verify it fails**

Run: `node test-digest-collectors.js`
Expected: FAIL — `collectO3 is not a function`

**Step 3: Write minimal implementation**

Add to `lib/digest-collectors.js`:

```js
function collectO3(db, accountId) {
  const now = Math.floor(Date.now() / 1000);
  const items = [];

  // Week boundaries
  const weekStart = now - (7 * 86400);
  const tomorrow = now + 86400;
  const nextWeekEnd = now + (7 * 86400);

  // Incomplete O3s this week (happened but not logged in Lattice)
  const thisWeekSessions = claudiaDb.getWeeklyO3Summary(db, weekStart, now);
  for (const session of thisWeekSessions) {
    if (!session.lattice_logged) {
      const daysAgo = Math.round((now - session.scheduled_start) / 86400);
      items.push(createDigestItem({
        collector: 'o3',
        observation: `You had a 1:1 with ${session.report_name} ${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago but haven't logged it in Lattice`,
        reason: `O3 session completed ${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago without Lattice entry`,
        authority: 'Auto-capture: O3 accountability tracking',
        consequence: 'Will appear in weekly digest pattern section. Consider logging before Friday.',
        sourceType: 'o3',
        category: 'o3-incomplete',
        priority: 'high',
        counterparty: session.report_name,
        entityId: session.id,
        observedAt: session.scheduled_start
      }));
    }

    // Prep gap: meeting happened but no prep was sent
    if (!session.prep_sent_before && !session.prep_sent_afternoon) {
      items.push(createDigestItem({
        collector: 'o3',
        observation: `1:1 with ${session.report_name} occurred without prep reminder`,
        reason: 'No prep notification was sent before this O3',
        authority: 'Auto-capture: O3 prep tracking',
        consequence: 'Retrospective note. Check if meeting-alert-monitor is running.',
        sourceType: 'o3',
        category: 'o3-prep-gap',
        priority: 'normal',
        counterparty: session.report_name,
        entityId: session.id,
        observedAt: session.scheduled_start
      }));
    }
  }

  // Upcoming O3s (tomorrow for daily, next week for weekly)
  const upcomingSessions = claudiaDb.getWeeklyO3Summary(db, now, nextWeekEnd);
  for (const session of upcomingSessions) {
    const hoursUntil = Math.round((session.scheduled_start - now) / 3600);
    const label = hoursUntil < 24 ? 'tomorrow' : `in ${Math.round(hoursUntil / 24)} days`;

    items.push(createDigestItem({
      collector: 'o3',
      observation: `1:1 with ${session.report_name} ${label}`,
      reason: 'Upcoming O3 session',
      authority: 'Auto-capture: calendar-based O3 detection',
      consequence: 'Prep reminder will fire before the meeting.',
      sourceType: 'o3',
      category: 'o3-upcoming',
      priority: 'normal',
      counterparty: session.report_name,
      entityId: session.id,
      observedAt: session.scheduled_start
    }));
  }

  return items;
}
```

Update `module.exports` to include `collectO3`.

**Step 4: Run test to verify it passes**

Run: `node test-digest-collectors.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add lib/digest-collectors.js test-digest-collectors.js
git commit -m "feat(digest): add O3/meeting collector with incomplete and upcoming detection"
```

---

## Task 6: Calendar collector (`lib/digest-collectors.js` — part 4)

**Files:**
- Modify: `lib/digest-collectors.js` (add `collectCalendar`)
- Modify: `test-digest-collectors.js` (add calendar tests)

**Step 1: Write the failing test**

The calendar collector calls Google Calendar API, so the test uses mock data.

Append to `test-digest-collectors.js`:

```js
const { collectCalendar } = require('./lib/digest-collectors');

// --- Test with mock calendar events ---
const mockEvents = [
  {
    id: 'event-1',
    summary: 'Sync with Sarah',
    start: { dateTime: new Date(Date.now() + 86400000).toISOString() },
    end: { dateTime: new Date(Date.now() + 86400000 + 1800000).toISOString() },
    attendees: [
      { email: 'test@example.com', self: true },
      { email: 'sarah@example.com', displayName: 'Sarah Chen' }
    ]
  },
  {
    id: 'event-2',
    summary: 'Team standup',
    start: { dateTime: new Date(Date.now() + 86400000 + 3600000).toISOString() },
    end: { dateTime: new Date(Date.now() + 86400000 + 5400000).toISOString() },
    attendees: [
      { email: 'test@example.com', self: true },
      { email: 'nobody@example.com', displayName: 'Nobody' }
    ]
  }
];

// sarah@example.com has an unreplied conversation (from followup test data above)
const calItems = collectCalendar(db, acct.id, mockEvents);

assert.ok(Array.isArray(calItems));

// Should flag meeting with Sarah because she has an open conversation
const meetingWithFollowup = calItems.find(
  i => i.category === 'meeting-with-open-followups' && i.observation.includes('Sarah')
);
assert.ok(meetingWithFollowup, 'Should flag meeting with attendee who has open followup');
assert.strictEqual(meetingWithFollowup.priority, 'high');
console.log('PASS: meeting with open followup flagged');

// Meeting with nobody@example.com should NOT produce a followup item
const nobodyItem = calItems.find(
  i => i.category === 'meeting-with-open-followups' && i.observation.includes('Nobody')
);
assert.ok(!nobodyItem, 'Should not flag meeting with attendee who has no open followups');
console.log('PASS: meeting without open followups not flagged');

console.log('\n=== CALENDAR COLLECTOR TESTS PASSED ===');
```

**Step 2: Run test to verify it fails**

Run: `node test-digest-collectors.js`
Expected: FAIL — `collectCalendar is not a function`

**Step 3: Write minimal implementation**

Add to `lib/digest-collectors.js`:

```js
function collectCalendar(db, accountId, calendarEvents) {
  const now = Math.floor(Date.now() / 1000);
  const items = [];

  if (!calendarEvents || calendarEvents.length === 0) return items;

  // Get all active conversations for cross-referencing
  const activeConvs = db.prepare(`
    SELECT * FROM conversations
    WHERE account_id = ? AND state = 'active'
  `).all(accountId);

  // Build a map of email → conversation[]
  const convByEmail = new Map();
  for (const conv of activeConvs) {
    const email = (conv.from_user || '').toLowerCase();
    if (!convByEmail.has(email)) convByEmail.set(email, []);
    convByEmail.get(email).push(conv);
  }

  for (const event of calendarEvents) {
    if (!event.attendees) continue;

    const otherAttendees = event.attendees.filter(a => !a.self);

    for (const attendee of otherAttendees) {
      const email = (attendee.email || '').toLowerCase();
      const convs = convByEmail.get(email);
      if (!convs || convs.length === 0) continue;

      // Has open conversations with this attendee
      const unreplied = convs.filter(c => c.waiting_for === 'my-response');
      const awaiting = convs.filter(c => c.waiting_for === 'their-response');

      if (unreplied.length > 0) {
        const name = attendee.displayName || attendee.email;
        const convSubjects = unreplied.map(c => c.subject).filter(Boolean).join(', ');

        items.push(createDigestItem({
          collector: 'calendar',
          observation: `You have a meeting with ${name} (${event.summary}) and an unreplied ${unreplied[0].type === 'email' ? 'email' : 'message'}${convSubjects ? `: "${convSubjects}"` : ''}`,
          reason: 'Open follow-up with a meeting attendee',
          authority: 'Auto-capture: cross-referencing calendar with open conversations',
          consequence: 'Consider replying before the meeting, or raising it during.',
          sourceType: 'calendar',
          category: 'meeting-with-open-followups',
          priority: 'high',
          counterparty: name,
          entityId: event.id,
          observedAt: now
        }));
      }
    }
  }

  // Meeting density
  const totalMinutes = calendarEvents.reduce((sum, e) => {
    const start = new Date(e.start.dateTime).getTime();
    const end = new Date(e.end.dateTime).getTime();
    return sum + (end - start) / 60000;
  }, 0);
  const totalHours = Math.round(totalMinutes / 60 * 10) / 10;

  if (calendarEvents.length > 0) {
    items.push(createDigestItem({
      collector: 'calendar',
      observation: `${calendarEvents.length} meetings scheduled (${totalHours}h total)`,
      reason: 'Calendar density summary',
      authority: 'Auto-capture: calendar activity tracking',
      consequence: 'Informational context.',
      sourceType: 'calendar',
      category: 'meeting-density',
      priority: 'low',
      observedAt: now
    }));
  }

  return items;
}
```

Update `module.exports` to include `collectCalendar`.

**Step 4: Run test to verify it passes**

Run: `node test-digest-collectors.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add lib/digest-collectors.js test-digest-collectors.js
git commit -m "feat(digest): add calendar collector with meeting-attendee cross-referencing"
```

---

## Task 7: Pattern detection (`lib/digest-patterns.js`)

**Files:**
- Create: `lib/digest-patterns.js`
- Create: `test-digest-patterns.js`

**Step 1: Write the failing test**

```js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB_PATH = path.join(os.tmpdir(), `claudia-patterns-test-${Date.now()}.db`);
process.env.CLAUDIA_DB_PATH = TEST_DB_PATH;

const claudiaDb = require('./claudia-db');
const { detectPatterns } = require('./lib/digest-patterns');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = claudiaDb.initDatabase();
const acct = claudiaDb.upsertAccount(db, {
  email: 'test@example.com', provider: 'gmail',
  display_name: 'Test', is_primary: 1
});

// --- Seed 4 weeks of snapshot data ---
// Week 1 (3 weeks ago): fast reply times
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-02',
  cadence: 'daily',
  items: [
    { category: 'unreplied', ageSeconds: 4 * 3600, counterparty: 'Alice' },
    { category: 'unreplied', ageSeconds: 6 * 3600, counterparty: 'Bob' },
    { category: 'unreplied', ageSeconds: 2 * 3600, counterparty: 'Charlie' },
    { category: 'resolved-today', counterparty: 'Dave' },
    { category: 'resolved-today', counterparty: 'Eve' }
  ]
});

// Week 2: slightly slower
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-09',
  cadence: 'daily',
  items: [
    { category: 'unreplied', ageSeconds: 8 * 3600, counterparty: 'Alice' },
    { category: 'unreplied', ageSeconds: 10 * 3600, counterparty: 'Bob' },
    { category: 'resolved-today', counterparty: 'Charlie' }
  ]
});

// Week 3: much slower (>25% increase = moderate)
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-16',
  cadence: 'daily',
  items: [
    { category: 'unreplied', ageSeconds: 14 * 3600, counterparty: 'Alice' },
    { category: 'unreplied', ageSeconds: 18 * 3600, counterparty: 'Alice' },
    { category: 'unreplied', ageSeconds: 12 * 3600, counterparty: 'Bob' }
  ]
});

// This week: current items
const thisWeekItems = [
  { category: 'unreplied', ageSeconds: 20 * 3600, counterparty: 'Alice' },
  { category: 'unreplied', ageSeconds: 16 * 3600, counterparty: 'Alice' },
  { category: 'unreplied', ageSeconds: 22 * 3600, counterparty: 'Bob' }
];

const insights = detectPatterns(db, acct.id, thisWeekItems, '2026-02-23');

assert.ok(Array.isArray(insights));

// Should detect reply latency trend
const latencyTrend = insights.find(i => i.id && i.observation.toLowerCase().includes('reply'));
assert.ok(latencyTrend, 'Should detect reply latency trend');
assert.ok(['moderate', 'notable'].includes(latencyTrend.significance),
  `Significance should be moderate or notable, got: ${latencyTrend.significance}`);
assert.ok(latencyTrend.evidence, 'Should include evidence');
assert.ok(latencyTrend.reason, 'Must have reason');
assert.ok(latencyTrend.authority, 'Must have authority');
console.log('PASS: reply latency trend detected');

// Should detect recurring counterparty (Alice appears in every week)
const recurringAlice = insights.find(
  i => i.observation.toLowerCase().includes('alice') && i.type === 'recurring'
);
assert.ok(recurringAlice, 'Should flag Alice as recurring counterparty');
console.log('PASS: recurring counterparty detected');

// All insights should have the PatternInsight shape
for (const insight of insights) {
  assert.ok(insight.id, 'Missing id');
  assert.ok(insight.observation, 'Missing observation');
  assert.ok(insight.reason, 'Missing reason');
  assert.ok(insight.authority, 'Missing authority');
  assert.ok(insight.consequence, 'Missing consequence');
}
console.log('PASS: all insights have valid shape');

// --- Test: no patterns when insufficient history ---
const emptyInsights = detectPatterns(db, acct.id, thisWeekItems, '2025-01-01');
// With date far in the past, no snapshots in range
// detectPatterns should handle this gracefully
assert.ok(Array.isArray(emptyInsights));
console.log('PASS: handles insufficient history gracefully');

console.log('\n=== PATTERN DETECTION TESTS PASSED ===');
```

**Step 2: Run test to verify it fails**

Run: `node test-digest-patterns.js`
Expected: FAIL — `Cannot find module './lib/digest-patterns'`

**Step 3: Write minimal implementation**

Create `lib/digest-patterns.js`:

```js
'use strict';

const claudiaDb = require('../claudia-db');
const { createPatternInsight } = require('./digest-item');

function detectPatterns(db, accountId, currentItems, currentDate) {
  // Get 4 weeks of snapshot history
  const endDate = currentDate;
  const startDate = new Date(currentDate);
  startDate.setDate(startDate.getDate() - 28);
  const startStr = startDate.toISOString().split('T')[0];

  const snapshots = claudiaDb.getSnapshotsForRange(db, accountId, startStr, endDate);

  if (snapshots.length < 2) {
    // Not enough history for patterns
    return [];
  }

  const insights = [];

  // Group snapshots by week
  const weeks = groupByWeek(snapshots);

  // Detector 1: Reply latency trend
  const latencyInsight = detectReplyLatencyTrend(weeks, currentItems);
  if (latencyInsight) insights.push(latencyInsight);

  // Detector 2: Follow-up close rate
  const closeRateInsight = detectCloseRateTrend(weeks, currentItems);
  if (closeRateInsight) insights.push(closeRateInsight);

  // Detector 3: Recurring counterparties
  const recurringInsights = detectRecurringCounterparties(weeks, currentItems);
  insights.push(...recurringInsights);

  return insights;
}

function groupByWeek(snapshots) {
  const weeks = new Map();
  for (const snap of snapshots) {
    const date = new Date(snap.snapshot_date);
    // ISO week start (Monday)
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay() + 1);
    const key = weekStart.toISOString().split('T')[0];

    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(...snap.items);
  }
  // Return sorted by week key (oldest first)
  return Array.from(weeks.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekKey, items]) => ({ weekKey, items }));
}

function avgReplyAge(items) {
  const unreplied = items.filter(i => i.category === 'unreplied' && i.ageSeconds);
  if (unreplied.length === 0) return null;
  const total = unreplied.reduce((sum, i) => sum + i.ageSeconds, 0);
  return { avg: total / unreplied.length, count: unreplied.length };
}

function detectReplyLatencyTrend(weeks, currentItems) {
  if (weeks.length < 2) return null;

  const currentAvg = avgReplyAge(currentItems);
  if (!currentAvg) return null;

  const weeklyAvgs = weeks.map(w => ({
    week: w.weekKey,
    ...avgReplyAge(w.items)
  })).filter(w => w.avg !== null);

  if (weeklyAvgs.length < 2) return null;

  // Compare current to oldest available
  const oldest = weeklyAvgs[0];
  const percentChange = ((currentAvg.avg - oldest.avg) / oldest.avg) * 100;

  let significance = null;
  if (percentChange > 50) significance = 'notable';
  else if (percentChange > 25) significance = 'moderate';

  if (!significance) return null;

  const currentHours = Math.round(currentAvg.avg / 3600);
  const oldestHours = Math.round(oldest.avg / 3600);

  return createPatternInsight({
    type: 'trend',
    observation: `Your average reply time increased from ${oldestHours}h to ${currentHours}h over the last ${weeklyAvgs.length + 1} weeks`,
    evidence: {
      thisWeek: { avgReplyHours: currentHours, sampleSize: currentAvg.count },
      history: weeklyAvgs.map(w => ({
        week: w.week,
        avgReplyHours: Math.round(w.avg / 3600),
        sampleSize: w.count
      }))
    },
    significance,
    reason: `${Math.round(percentChange)}% increase in reply latency over ${weeklyAvgs.length + 1} weeks`,
    authority: 'Pattern detection: computed from digest snapshots',
    consequence: 'Informational. No enforcement configured.'
  });
}

function detectCloseRateTrend(weeks, currentItems) {
  if (weeks.length < 2) return null;

  const closeRate = (items) => {
    const resolved = items.filter(i => i.category === 'resolved-today').length;
    const total = items.filter(i =>
      i.category === 'unreplied' || i.category === 'awaiting' || i.category === 'resolved-today'
    ).length;
    if (total === 0) return null;
    return { rate: resolved / total, resolved, total };
  };

  const currentRate = closeRate(currentItems);
  if (!currentRate) return null;

  const weeklyRates = weeks.map(w => ({
    week: w.weekKey,
    ...closeRate(w.items)
  })).filter(w => w.rate !== null);

  if (weeklyRates.length < 2) return null;

  const recentRate = weeklyRates[weeklyRates.length - 1];
  const percentDrop = ((recentRate.rate - currentRate.rate) / recentRate.rate) * 100;

  if (percentDrop < 15) return null;

  return createPatternInsight({
    type: 'trend',
    observation: `Follow-up close rate dropped from ${Math.round(recentRate.rate * 100)}% to ${Math.round(currentRate.rate * 100)}%`,
    evidence: {
      thisWeek: currentRate,
      lastWeek: recentRate
    },
    significance: 'moderate',
    reason: `${Math.round(percentDrop)}% decrease in close rate`,
    authority: 'Pattern detection: computed from digest snapshots',
    consequence: 'More items are being carried forward without resolution.'
  });
}

function detectRecurringCounterparties(weeks, currentItems) {
  // Count appearances across weeks
  const allItems = [...weeks.flatMap(w => w.items), ...currentItems];
  const weeklyAppearances = new Map(); // counterparty → Set of week keys

  for (const week of weeks) {
    for (const item of week.items) {
      if (item.category !== 'unreplied' || !item.counterparty) continue;
      if (!weeklyAppearances.has(item.counterparty)) {
        weeklyAppearances.set(item.counterparty, new Set());
      }
      weeklyAppearances.get(item.counterparty).add(week.weekKey);
    }
  }

  // Add current week
  const currentWeekKey = 'current';
  for (const item of currentItems) {
    if (item.category !== 'unreplied' || !item.counterparty) continue;
    if (!weeklyAppearances.has(item.counterparty)) {
      weeklyAppearances.set(item.counterparty, new Set());
    }
    weeklyAppearances.get(item.counterparty).add(currentWeekKey);
  }

  const insights = [];
  for (const [name, weekSet] of weeklyAppearances) {
    if (weekSet.size < 2) continue;

    const totalCount = allItems.filter(
      i => i.category === 'unreplied' && i.counterparty === name
    ).length;

    let significance = 'minor';
    if (totalCount >= 5) significance = 'moderate';

    insights.push(createPatternInsight({
      type: 'recurring',
      observation: `${name} has appeared in unreplied items across ${weekSet.size} weeks (${totalCount} total occurrences)`,
      evidence: {
        counterparty: name,
        weeksPresent: weekSet.size,
        totalOccurrences: totalCount
      },
      significance,
      reason: `Recurring unreplied items with the same person across ${weekSet.size} weeks`,
      authority: 'Pattern detection: computed from digest snapshots',
      consequence: 'Consider whether this relationship needs a different communication pattern.'
    }));
  }

  return insights;
}

module.exports = { detectPatterns };
```

**Step 4: Run test to verify it passes**

Run: `node test-digest-patterns.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add lib/digest-patterns.js test-digest-patterns.js
git commit -m "feat(digest): add pattern detection with latency, close rate, and recurring counterparty detectors"
```

---

## Task 8: AI narration (`lib/digest-narration.js`)

**Files:**
- Create: `lib/digest-narration.js`
- Create: `test-digest-narration.js`

**Step 1: Write the failing test**

Testing AI narration without actual API calls. Test the prompt building and fallback formatting.

```js
'use strict';

const assert = require('assert');

const { buildDailyPrompt, buildWeeklyPrompt, formatFallback } = require('./lib/digest-narration');

// --- Test: buildDailyPrompt ---
const items = [
  {
    id: 'test-1', collector: 'followup', priority: 'high',
    observation: 'Sarah emailed you 52h ago', reason: 'Unreplied >48h',
    authority: 'Auto-capture: hygiene', consequence: 'Will escalate.',
    sourceType: 'email', category: 'unreplied'
  },
  {
    id: 'test-2', collector: 'calendar', priority: 'low',
    observation: '5 meetings (4.5h)', reason: 'Calendar density',
    authority: 'Auto-capture', consequence: 'Informational.',
    sourceType: 'calendar', category: 'meeting-density'
  }
];

const dailyPrompt = buildDailyPrompt(items);
assert.ok(dailyPrompt.system, 'Should have system prompt');
assert.ok(dailyPrompt.user, 'Should have user message');
assert.ok(dailyPrompt.system.includes('calm'), 'System prompt should mention tone');
assert.ok(dailyPrompt.system.includes('Do not add information'), 'Should include grounding rule');
assert.ok(dailyPrompt.user.includes('Sarah emailed'), 'User message should contain item data');
console.log('PASS: buildDailyPrompt');

// --- Test: buildWeeklyPrompt ---
const patterns = [
  {
    id: 'pattern-1', type: 'trend', significance: 'moderate',
    observation: 'Reply time increased 8h to 14h',
    evidence: {}, reason: 'trend', authority: 'computed', consequence: 'info'
  }
];

const weeklyPrompt = buildWeeklyPrompt(items, patterns);
assert.ok(weeklyPrompt.system.includes('reflection'), 'Weekly should mention reflection');
assert.ok(weeklyPrompt.user.includes('Reply time increased'), 'Should include patterns');
console.log('PASS: buildWeeklyPrompt');

// --- Test: formatFallback ---
const fallback = formatFallback(items);
assert.ok(fallback.includes('Sarah emailed'), 'Fallback should list observations');
assert.ok(fallback.includes('high'), 'Fallback should show priority');
console.log('PASS: formatFallback');

// --- Test: empty items ---
const emptyDaily = buildDailyPrompt([]);
assert.ok(emptyDaily.user.includes('no items') || emptyDaily.user.includes('[]'),
  'Empty items should be handled');
console.log('PASS: empty items handled');

console.log('\n=== NARRATION TESTS PASSED ===');
```

**Step 2: Run test to verify it fails**

Run: `node test-digest-narration.js`
Expected: FAIL — `Cannot find module './lib/digest-narration'`

**Step 3: Write minimal implementation**

Create `lib/digest-narration.js`:

```js
'use strict';

const ai = require('./ai');
const log = require('./logger')('digest-narration');

const DAILY_SYSTEM = `You are writing a brief end-of-day digest for a busy professional.

Rules:
- Every item below is a verified fact. Do not add information.
- Group items by urgency: critical first, then high, then normal. Omit low items if >10 items total (note the omission count).
- For each item, preserve the observation and consequence.
- Tone: calm, factual, resolution-oriented. No praise or scolding. No urgency theater.
- Keep it concise. Target: 1-2 sentences per item.
- If there are no items, respond: "Nothing requiring attention today."
- Use Slack mrkdwn formatting (*bold*, _italic_, bullet points).

Must never:
- Invent connections between items not present in the data
- Assign emotional states
- Use motivational language
- Create urgency beyond what the priority field indicates
- Suggest underperformance`;

const WEEKLY_SYSTEM = `You are writing a weekly reflection digest for a busy professional.

This is not a task list. It is a mirror — showing what happened this week, what patterns are emerging, and what deserves attention next week.

Rules:
- Every claim must trace to the structured data below. Do not add information.
- Group the digest into sections:
  1. "This week" — items resolved, commitments kept, meetings completed
  2. "Still open" — items carried forward, grouped by counterparty
  3. "Patterns" — only include if pattern insights are provided and non-empty
  4. "Next week" — upcoming O3s, meetings with open followups
- Tone: calm, reflective, resolution-oriented. No praise or scolding.
- Cite sources naturally: "(email, Tuesday)" or "(Slack DM, 3 days ago)"
- If a pattern has significance "notable", lead the Patterns section with it.
- Use Slack mrkdwn formatting.

Must never:
- Invent connections between items not present in the data
- Assign emotional states
- Use motivational language
- Create urgency beyond what the priority field indicates
- Suggest underperformance`;

function buildDailyPrompt(items) {
  return {
    system: DAILY_SYSTEM,
    user: `Digest items:\n${JSON.stringify(items, null, 2)}`
  };
}

function buildWeeklyPrompt(items, patterns) {
  return {
    system: WEEKLY_SYSTEM,
    user: `Digest items:\n${JSON.stringify(items, null, 2)}\n\nPattern insights:\n${JSON.stringify(patterns, null, 2)}`
  };
}

function formatFallback(items) {
  if (items.length === 0) return 'Nothing requiring attention today.';

  const priorityOrder = ['critical', 'high', 'normal', 'low'];
  const sorted = [...items].sort(
    (a, b) => priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority)
  );

  const lines = sorted.map(item =>
    `• [${item.priority}] ${item.observation}`
  );

  return `*Digest* (narration unavailable — raw items):\n${lines.join('\n')}`;
}

async function narrateDaily(items) {
  const prompt = buildDailyPrompt(items);
  return callNarration(prompt, 'claude-haiku-4-5-20251001', 1000);
}

async function narrateWeekly(items, patterns) {
  const prompt = buildWeeklyPrompt(items, patterns);
  return callNarration(prompt, 'claude-sonnet-4-5-20250514', 2000);
}

async function callNarration(prompt, model, maxTokens) {
  const client = ai.getClient();
  if (!client) {
    log.warn('AI client unavailable — using fallback');
    return null;
  }

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }]
    });

    const text = response.content[0]?.text;
    log.info({
      model,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    }, 'Narration complete');

    return text || null;
  } catch (err) {
    log.warn({ err, model }, 'Narration failed');
    return null;
  }
}

module.exports = {
  buildDailyPrompt,
  buildWeeklyPrompt,
  formatFallback,
  narrateDaily,
  narrateWeekly
};
```

**Step 4: Run test to verify it passes**

Run: `node test-digest-narration.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add lib/digest-narration.js test-digest-narration.js
git commit -m "feat(digest): add AI narration layer with daily/weekly prompts and fallback formatting"
```

---

## Task 9: Daily digest service (`digest-daily.js`)

**Files:**
- Create: `digest-daily.js`

**Step 1: Write the implementation**

No separate test file for this — it's a thin orchestrator that composes tested modules. Manual testing via `node digest-daily.js`.

```js
'use strict';

const config = require('./lib/config');
const claudiaDb = require('./claudia-db');
const log = require('./lib/logger')('digest-daily');
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');
const { sendSlackDM } = require('./lib/slack');
const { collectFollowups, collectEmail, collectO3, collectCalendar } = require('./lib/digest-collectors');
const { deduplicateItems } = require('./lib/digest-item');
const { narrateDaily, formatFallback } = require('./lib/digest-narration');
const calendarAuth = require('./calendar-auth');

const SERVICE_NAME = 'digest-daily';

async function main() {
  log.info('Daily digest starting');

  // Skip Friday if weekly digest covers it
  const today = new Date();
  if (today.getDay() === 5) {
    log.info('Skipping daily digest on Friday — weekly digest covers it');
    process.exit(0);
  }

  // Startup validation
  const validation = validatePrerequisites(SERVICE_NAME, [
    { type: 'database', path: claudiaDb.DB_PATH, description: 'Claudia database' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }

  const db = claudiaDb.initDatabase();
  const primaryAccount = claudiaDb.upsertAccount(db, {
    email: config.gmailAccount,
    provider: 'gmail',
    display_name: 'Primary',
    is_primary: 1
  });
  const accountId = primaryAccount.id;

  // Layer 1: Collect from all sources
  const collectors = [
    { name: 'followup', fn: () => collectFollowups(db, accountId) },
    { name: 'email', fn: () => collectEmail(db, accountId, { vipEmails: config.vipEmails }) },
    { name: 'o3', fn: () => collectO3(db, accountId) }
  ];

  // Calendar collector needs API call
  let calendarEvents = [];
  try {
    const calendar = await calendarAuth.getCalendarClient();
    if (calendar) {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: tomorrow.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50
      });
      calendarEvents = (response.data.items || []).filter(e => e.start.dateTime);
    }
  } catch (err) {
    log.warn({ err }, 'Calendar fetch failed — skipping calendar collector');
  }

  collectors.push({
    name: 'calendar',
    fn: () => collectCalendar(db, accountId, calendarEvents)
  });

  let allItems = [];
  const failedCollectors = [];

  for (const collector of collectors) {
    try {
      const items = collector.fn();
      allItems.push(...items);
      log.info({ collector: collector.name, count: items.length }, 'Collector completed');
    } catch (err) {
      log.error({ err, collector: collector.name }, 'Collector failed');
      failedCollectors.push(collector.name);
    }
  }

  if (allItems.length === 0 && failedCollectors.length === collectors.length) {
    await sendSlackDM('Daily digest unavailable — all collectors failed. Check logs.');
    process.exit(1);
  }

  // Deduplicate
  allItems = deduplicateItems(allItems);
  log.info({ total: allItems.length, failed: failedCollectors }, 'Collection complete');

  // Save snapshot
  const dateStr = new Date().toISOString().split('T')[0];
  claudiaDb.saveSnapshot(db, accountId, {
    snapshotDate: dateStr,
    cadence: 'daily',
    items: allItems
  });

  // Layer 3: AI narration
  let message = await narrateDaily(allItems);

  if (!message) {
    // Retry once
    log.warn('First narration attempt failed, retrying in 30s');
    await new Promise(r => setTimeout(r, 30000));
    message = await narrateDaily(allItems);
  }

  if (!message) {
    log.warn('Narration failed — using fallback');
    message = formatFallback(allItems);
  }

  // Add note about failed collectors
  if (failedCollectors.length > 0) {
    message += `\n\n_Note: ${failedCollectors.join(', ')} data unavailable for this digest._`;
  }

  // Deliver
  await sendSlackDM(message);
  log.info('Daily digest delivered');

  heartbeat.write(SERVICE_NAME, { status: 'ok', itemCount: allItems.length });
  process.exit(0);
}

main().catch(err => {
  log.fatal({ err }, 'Daily digest crashed');
  process.exit(1);
});
```

**Step 2: Verify it starts without crashing**

Run: `node digest-daily.js`
Expected: Runs collectors, calls AI, sends Slack DM, exits. (If today is Friday, exits early with a log message.)

**Step 3: Commit**

```bash
git add digest-daily.js
git commit -m "feat(digest): add daily digest service orchestrator"
```

---

## Task 10: Weekly digest service (`digest-weekly.js`)

**Files:**
- Create: `digest-weekly.js`

**Step 1: Write the implementation**

```js
'use strict';

const config = require('./lib/config');
const claudiaDb = require('./claudia-db');
const log = require('./lib/logger')('digest-weekly');
const heartbeat = require('./lib/heartbeat');
const { validatePrerequisites } = require('./lib/startup-validation');
const { sendSlackDM } = require('./lib/slack');
const { collectFollowups, collectEmail, collectO3, collectCalendar } = require('./lib/digest-collectors');
const { deduplicateItems } = require('./lib/digest-item');
const { detectPatterns } = require('./lib/digest-patterns');
const { narrateWeekly, formatFallback } = require('./lib/digest-narration');
const calendarAuth = require('./calendar-auth');

const SERVICE_NAME = 'digest-weekly';
const SNAPSHOT_MAX_AGE_DAYS = 56; // 8 weeks

async function main() {
  log.info('Weekly digest starting');

  // Startup validation
  const validation = validatePrerequisites(SERVICE_NAME, [
    { type: 'database', path: claudiaDb.DB_PATH, description: 'Claudia database' }
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }

  const db = claudiaDb.initDatabase();
  const primaryAccount = claudiaDb.upsertAccount(db, {
    email: config.gmailAccount,
    provider: 'gmail',
    display_name: 'Primary',
    is_primary: 1
  });
  const accountId = primaryAccount.id;

  // Layer 1: Collect from all sources (same as daily, but full week context)
  const collectors = [
    { name: 'followup', fn: () => collectFollowups(db, accountId) },
    { name: 'email', fn: () => collectEmail(db, accountId, { vipEmails: config.vipEmails }) },
    { name: 'o3', fn: () => collectO3(db, accountId) }
  ];

  // Calendar: fetch next week's events for preview
  let calendarEvents = [];
  try {
    const calendar = await calendarAuth.getCalendarClient();
    if (calendar) {
      const now = new Date();
      const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: nextWeek.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100
      });
      calendarEvents = (response.data.items || []).filter(e => e.start.dateTime);
    }
  } catch (err) {
    log.warn({ err }, 'Calendar fetch failed — skipping calendar collector');
  }

  collectors.push({
    name: 'calendar',
    fn: () => collectCalendar(db, accountId, calendarEvents)
  });

  let allItems = [];
  const failedCollectors = [];

  for (const collector of collectors) {
    try {
      const items = collector.fn();
      allItems.push(...items);
      log.info({ collector: collector.name, count: items.length }, 'Collector completed');
    } catch (err) {
      log.error({ err, collector: collector.name }, 'Collector failed');
      failedCollectors.push(collector.name);
    }
  }

  if (allItems.length === 0 && failedCollectors.length === collectors.length) {
    await sendSlackDM('Weekly digest unavailable — all collectors failed. Check logs.');
    process.exit(1);
  }

  // Deduplicate
  allItems = deduplicateItems(allItems);
  log.info({ total: allItems.length, failed: failedCollectors }, 'Collection complete');

  // Save snapshot
  const dateStr = new Date().toISOString().split('T')[0];
  claudiaDb.saveSnapshot(db, accountId, {
    snapshotDate: dateStr,
    cadence: 'weekly',
    items: allItems
  });

  // Layer 2: Pattern detection
  const patterns = detectPatterns(db, accountId, allItems, dateStr);
  log.info({ patternCount: patterns.length }, 'Pattern detection complete');

  // Layer 3: AI narration
  let message = await narrateWeekly(allItems, patterns);

  if (!message) {
    log.warn('First narration attempt failed, retrying in 30s');
    await new Promise(r => setTimeout(r, 30000));
    message = await narrateWeekly(allItems, patterns);
  }

  if (!message) {
    log.warn('Narration failed — using fallback');
    message = formatFallback(allItems);
    if (patterns.length > 0) {
      message += '\n\n*Patterns detected:*\n';
      message += patterns.map(p => `• [${p.significance}] ${p.observation}`).join('\n');
    }
  }

  if (failedCollectors.length > 0) {
    message += `\n\n_Note: ${failedCollectors.join(', ')} data unavailable for this digest._`;
  }

  // Deliver
  await sendSlackDM(message);
  log.info('Weekly digest delivered');

  // Prune old snapshots
  claudiaDb.pruneOldSnapshots(db, accountId, SNAPSHOT_MAX_AGE_DAYS);
  log.info({ maxAgeDays: SNAPSHOT_MAX_AGE_DAYS }, 'Old snapshots pruned');

  heartbeat.write(SERVICE_NAME, { status: 'ok', itemCount: allItems.length, patternCount: patterns.length });
  process.exit(0);
}

main().catch(err => {
  log.fatal({ err }, 'Weekly digest crashed');
  process.exit(1);
});
```

**Step 2: Verify it starts without crashing**

Run: `node digest-weekly.js`
Expected: Runs all 3 layers, sends Slack DM, prunes snapshots, exits.

**Step 3: Commit**

```bash
git add digest-weekly.js
git commit -m "feat(digest): add weekly digest service with pattern detection and snapshot pruning"
```

---

## Task 11: Launchd integration (`bin/deploy`)

**Files:**
- Modify: `bin/deploy`

**Step 1: Read current deploy script**

Run: `cat bin/deploy` to understand the existing plist template pattern.

**Step 2: Add two new plist templates**

Add `digest-daily` and `digest-weekly` plist generation to `bin/deploy`, following the exact same pattern as existing services. Key differences:

- `ai.claudia.digest-daily`: `StartCalendarInterval` for weekdays at 18:00
  ```xml
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  ```

- `ai.claudia.digest-weekly`: `StartCalendarInterval` for Friday at 16:00
  ```xml
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>16</integer><key>Minute</key><integer>0</integer></dict>
  ```

Both should use `KeepAlive: false` (run-once, not persistent).

**Step 3: Verify deploy generates correct plists**

Run: `bin/deploy --dry-run` (if supported) or inspect generated plists.

**Step 4: Commit**

```bash
git add bin/deploy
git commit -m "feat(deploy): add digest-daily and digest-weekly launchd plist templates"
```

---

## Task 12: Tray app integration (`tray/service-manager.js`)

**Files:**
- Modify: `tray/service-manager.js`

**Step 1: Read the SERVICES array**

Check the existing pattern in `tray/service-manager.js` for how services are defined.

**Step 2: Add both digest services**

Add to the SERVICES array:

```js
{
  name: 'digest-daily',
  label: 'ai.claudia.digest-daily',
  display: 'Daily Digest',
  heartbeatFile: 'digest-daily'
},
{
  name: 'digest-weekly',
  label: 'ai.claudia.digest-weekly',
  display: 'Weekly Digest',
  heartbeatFile: 'digest-weekly'
}
```

**Step 3: Verify tray app picks them up**

Run: `npm test --prefix tray`
Expected: Tests pass. The new services should appear in the tray menu.

**Step 4: Commit**

```bash
git add tray/service-manager.js
git commit -m "feat(tray): add digest-daily and digest-weekly to service manager"
```

---

## Task 13: Update test runner in `package.json`

**Files:**
- Modify: `package.json`

**Step 1: Add new test files to the test script**

Current test script: `node test-heartbeat.js && node test-startup-validation.js && node test-claudia-db.js && npm test --prefix tray`

Update to:

```json
"test": "node test-heartbeat.js && node test-startup-validation.js && node test-claudia-db.js && node test-digest-item.js && node test-digest-collectors.js && node test-digest-patterns.js && node test-digest-narration.js && npm test --prefix tray"
```

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add digest tests to test runner"
```

---

## Task 14: End-to-end verification

**Step 1: Run the daily digest manually**

Run: `node digest-daily.js`
Expected: Produces a Slack DM with your current follow-ups, emails, O3 status, and calendar items.

**Step 2: Run the weekly digest manually**

Run: `node digest-weekly.js`
Expected: Produces a longer Slack DM with this week's summary, still-open items, and (if enough history exists) pattern insights. On first run, should note "Pattern detection requires 2+ weeks of data."

**Step 3: Verify snapshots were saved**

Run: `sqlite3 ~/.claudia/claudia.db "SELECT snapshot_date, cadence, length(items) FROM digest_snapshots ORDER BY snapshot_date DESC LIMIT 5;"`
Expected: Shows today's daily and weekly snapshots.

**Step 4: Run full test suite one more time**

Run: `npm test`
Expected: All tests PASS

**Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during e2e verification"
```
