# Raw Message Identity & Metadata Enrichment

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure every raw_message stores the source system's user ID (`author_ext_id`) and enriched metadata so identity resolution can be re-run without re-pulling from source APIs.

**Architecture:** Add one typed column (`author_ext_id`) for the universal cross-source join key. All other enrichments (source_msg_id, source_parent_ref, event_type, source-specific threading) go into the existing `metadata` JSON column per the project convention: "JSON metadata columns for flexible attributes — promote to typed columns only when query performance demands it." Backfill existing rows by reverse-looking up identity_map.

**Tech Stack:** Node.js, better-sqlite3, existing org-memory schema

---

## Background

The `raw_messages` table currently stores `author_id` (resolved entity UUID) but not the source system's user ID. When `resolveIdentity()` returns null (unknown user), the external ID is lost permanently — making it impossible to re-resolve identity later without re-pulling from source APIs.

**Key files to understand before starting:**
- `lib/org-memory-db.js:26-44` — raw_messages schema
- `lib/knowledge-graph.js:163-195` — `resolveIdentity()` and `insertRawMessage()`
- `lib/slack-capture.js:10-32` — Slack capture (calls `insertRawMessage`)
- `lib/jira-capture.js:37-58` — Jira capture (calls `insertRawMessage`)
- `slack-events-monitor.js:420-438` — Real-time Slack capture call site
- `slack-backfill.js:210-221` — Backfill Slack capture call site
- `jira-activity-collector.js:84-94` — Jira collector capture call site

**Design conventions (from CLAUDE.md):**
- JSON `metadata` columns for flexible attributes
- Promote to typed columns only when query performance demands it
- Epoch seconds for all timestamps
- App-level validation over DB constraints (see entity_links pattern)

---

### Task 1: Add `author_ext_id` column and update `insertRawMessage`

**Files:**
- Modify: `lib/org-memory-db.js:26-44` (schema)
- Modify: `lib/knowledge-graph.js:172-195` (insertRawMessage)
- Test: `test-jira-capture.js` (existing — will verify column exists on returned rows)

**Step 1: Write the failing test**

Add to the top of `test-jira-capture.js`, after the existing `tmpDb()` helper (line 16), before the first test block (line 24):

```javascript
// --- Test: author_ext_id is stored on raw_message ---
{
  const { db, path: p } = tmpDb();
  try {
    const result = captureJiraActivity(db, {
      issueKey: 'EXT-1',
      summary: 'Test ext id',
      status: 'Open',
      assigneeAccountId: 'jira-acct-999',
      assigneeName: 'Test Person',
      projectKey: 'EXT',
      updatedAt: 1709900000,
      changeType: 'created',
      changeDetail: null,
    });

    assert.strictEqual(result.author_ext_id, 'jira-acct-999',
      'author_ext_id should store the source system user ID');
    console.log('PASS: author_ext_id is stored on raw_message');
  } finally {
    cleanup(p);
  }
}
```

**Step 2: Run test to verify it fails**

Run: `node test-jira-capture.js`
Expected: FAIL — `result.author_ext_id` is `undefined`

**Step 3: Implement the schema and insertRawMessage changes**

In `lib/org-memory-db.js`, add the column to the CREATE TABLE (after line 32, `author_id`):

```sql
      author_ext_id TEXT,
```

Add an ALTER TABLE migration after the CREATE TABLE block (after line 44, the last CREATE INDEX):

```javascript
    // Migration: add author_ext_id for identity re-resolution
    try {
      db.exec('ALTER TABLE raw_messages ADD COLUMN author_ext_id TEXT');
    } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
```

Add an index for backfill sweeps (after the ALTER TABLE):

```javascript
    db.exec('CREATE INDEX IF NOT EXISTS idx_raw_author_ext ON raw_messages(author_ext_id)');
```

In `lib/knowledge-graph.js`, update `insertRawMessage` signature (line 172) to accept `authorExtId`:

```javascript
function insertRawMessage(db, { source, sourceId, channelId, channelName, authorExtId, authorId, authorName, content, threadId, occurredAt, metadata }) {
```

Update the INSERT statement (lines 186-192) to include `author_ext_id`:

```javascript
  db.prepare(
    `INSERT INTO raw_messages (id, source, source_id, channel_id, channel_name,
      author_ext_id, author_id, author_name, content, thread_id, occurred_at, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, source, sourceId, channelId || null, channelName || null,
    authorExtId || null, authorId || null, authorName || null, content, threadId || null,
    occurredAt || now, metadata ? JSON.stringify(metadata) : null, now
  );
```

**Step 4: Run test to verify it passes**

Run: `node test-jira-capture.js`
Expected: PASS (but `author_ext_id` will be null — we haven't updated jira-capture yet)

Wait — the test expects `'jira-acct-999'` but `captureJiraActivity` doesn't pass `authorExtId` yet. We need to update the capture module too. Move to Step 5.

**Step 5: Update `lib/jira-capture.js` to pass `authorExtId`**

In `lib/jira-capture.js`, update the `insertRawMessage` call (lines 47-57) to include `authorExtId`:

```javascript
  return kg.insertRawMessage(db, {
    source: 'jira',
    sourceId,
    channelId: projectKey,
    channelName: projectKey,
    authorExtId: assigneeAccountId || null,
    authorId: authorEntityId,
    authorName: assigneeName || null,
    content,
    threadId: issueKey,
    occurredAt: updatedAt,
  });
```

**Step 6: Run test to verify it passes**

Run: `node test-jira-capture.js`
Expected: ALL tests PASS, including new `author_ext_id` test

**Step 7: Commit**

```bash
git add lib/org-memory-db.js lib/knowledge-graph.js lib/jira-capture.js test-jira-capture.js
git commit -m "feat: add author_ext_id column to raw_messages for identity re-resolution"
```

---

### Task 2: Update Slack capture to pass `authorExtId`

**Files:**
- Modify: `lib/slack-capture.js:10-32`
- Test: `test-slack-capture-isolation.js`

**Step 1: Write the failing test**

Add to `test-slack-capture-isolation.js`, after the last test function (around line 120):

```javascript
// --- Test 4: author_ext_id stores the Slack user ID ---
function testAuthorExtId() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  const result = capture.captureMessage(db, {
    channel: 'C_EXT_TEST',
    channelName: 'ext-test',
    ts: '1709900000.000099',
    user: 'U_TEST_EXT_99',
    userName: 'Aragorn King',
    text: 'Testing author_ext_id storage',
    threadTs: null,
    channelType: 'channel',
  });

  assert.strictEqual(result.author_ext_id, 'U_TEST_EXT_99',
    'author_ext_id should store the Slack user ID');
  console.log('  PASS: author_ext_id stores the Slack user ID');
}
```

Add `testAuthorExtId();` to the test runner section at the bottom.

**Step 2: Run test to verify it fails**

Run: `node test-slack-capture-isolation.js`
Expected: FAIL — `result.author_ext_id` is null/undefined

**Step 3: Update `lib/slack-capture.js`**

In `captureMessage` (line 21), add `authorExtId: user` to the `insertRawMessage` call:

```javascript
  return kg.insertRawMessage(db, {
    source: 'slack',
    sourceId,
    channelId: channel,
    channelName: resolvedChannelName,
    authorExtId: user,
    authorId: authorEntityId,
    authorName: userName || null,
    content: text,
    threadId: threadTs || null,
    occurredAt: Math.floor(parseFloat(ts)),
  });
```

**Step 4: Run test to verify it passes**

Run: `node test-slack-capture-isolation.js`
Expected: ALL tests PASS

**Step 5: Commit**

```bash
git add lib/slack-capture.js test-slack-capture-isolation.js
git commit -m "feat: pass Slack user ID as authorExtId in slack-capture"
```

---

### Task 3: Enrich metadata at Slack capture sites

**Files:**
- Modify: `lib/slack-capture.js:10-32`
- Modify: `slack-backfill.js:210-221`
- Modify: `slack-events-monitor.js:429-438`
- Test: `test-slack-capture-isolation.js`

**Step 1: Write the failing test**

Add to `test-slack-capture-isolation.js`:

```javascript
// --- Test 5: metadata includes source-specific fields ---
function testMetadataEnrichment() {
  const db = freshDb();
  const capture = require('./lib/slack-capture');

  const result = capture.captureMessage(db, {
    channel: 'C_META_TEST',
    channelName: 'meta-test',
    ts: '1709900000.000088',
    user: 'U_META_01',
    userName: 'Meta User',
    text: 'Testing metadata enrichment',
    threadTs: '1709900000.000001',
    channelType: 'channel',
    clientMsgId: 'abc-def-123',
    subtype: null,
  });

  const meta = JSON.parse(result.metadata);
  assert.strictEqual(meta.source_msg_id, 'abc-def-123',
    'metadata should include source_msg_id from client_msg_id');
  assert.strictEqual(meta.event_type, 'message',
    'metadata should include event_type');
  assert.strictEqual(meta.source_parent_ref, 'C_META_TEST:1709900000.000001',
    'metadata should include source_parent_ref for threaded messages');
  console.log('  PASS: metadata includes source-specific fields');
}
```

Add `testMetadataEnrichment();` to the test runner.

**Step 2: Run test to verify it fails**

Run: `node test-slack-capture-isolation.js`
Expected: FAIL — `result.metadata` is null

**Step 3: Update `lib/slack-capture.js` to build enriched metadata**

Update `captureMessage` to accept additional fields and build metadata:

```javascript
function captureMessage(db, { channel, channelName, ts, user, userName, text, threadTs, channelType, clientMsgId, subtype }) {
  const sourceId = `${channel}:${ts}`;

  // Resolve author to entity ID if identity is known
  const authorEntityId = kg.resolveIdentity(db, 'slack', user);

  // DMs get a synthetic channel name
  const resolvedChannelName = channelType === 'im'
    ? `dm-${userName || user}`
    : (channelName || channel);

  // Build enriched metadata for future consumers
  const metadata = {
    event_type: 'message',
    source_msg_id: clientMsgId || null,
    source_parent_ref: threadTs ? `${channel}:${threadTs}` : null,
    subtype: subtype || null,
  };

  return kg.insertRawMessage(db, {
    source: 'slack',
    sourceId,
    channelId: channel,
    channelName: resolvedChannelName,
    authorExtId: user,
    authorId: authorEntityId,
    authorName: userName || null,
    content: text,
    threadId: threadTs || null,
    occurredAt: Math.floor(parseFloat(ts)),
    metadata,
  });
}
```

**Step 4: Run test to verify it passes**

Run: `node test-slack-capture-isolation.js`
Expected: ALL tests PASS

**Step 5: Update `slack-backfill.js` to pass `clientMsgId` and `subtype`**

In `slack-backfill.js`, update the `captureMessage` call (around line 212):

```javascript
      captureMessage(db, {
        channel: channel.id,
        channelName: channel.name,
        ts: msg.ts,
        user: msg.user,
        userName,
        text: msg.text,
        threadTs: msg.thread_ts || null,
        channelType: 'channel',
        clientMsgId: msg.client_msg_id || null,
        subtype: msg.subtype || null,
      });
```

**Step 6: Update `slack-events-monitor.js` to pass `clientMsgId` and `subtype`**

In `slack-events-monitor.js`, update the `captureMessage` call (around line 429):

```javascript
      slackCapture.captureMessage(omDb, {
        channel: event.channel,
        channelName,
        ts: event.ts,
        user: event.user,
        userName,
        text: event.text,
        threadTs: event.thread_ts || null,
        channelType: event.channel_type,
        clientMsgId: event.client_msg_id || null,
        subtype: event.subtype || null,
      });
```

**Step 7: Run full test suite**

Run: `npm test`
Expected: ALL tests PASS

**Step 8: Commit**

```bash
git add lib/slack-capture.js slack-backfill.js slack-events-monitor.js test-slack-capture-isolation.js
git commit -m "feat: enrich Slack capture with metadata (source_msg_id, event_type, parent_ref)"
```

---

### Task 4: Enrich metadata at Jira capture site

**Files:**
- Modify: `lib/jira-capture.js:37-58`
- Test: `test-jira-capture.js`

**Step 1: Write the failing test**

Add to `test-jira-capture.js`:

```javascript
// --- Test: metadata includes Jira-specific fields ---
{
  const { db, path: p } = tmpDb();
  try {
    const result = captureJiraActivity(db, {
      issueKey: 'META-1',
      summary: 'Test metadata',
      status: 'Done',
      assigneeAccountId: 'jira-acct-meta',
      assigneeName: 'Meta Person',
      projectKey: 'META',
      updatedAt: 1709900000,
      changeType: 'status',
      changeDetail: 'In Progress -> Done',
      changelogId: '99887',
    });

    const meta = JSON.parse(result.metadata);
    assert.strictEqual(meta.event_type, 'status_change',
      'metadata event_type should be status_change');
    assert.strictEqual(meta.source_msg_id, '99887',
      'metadata source_msg_id should store changelog ID');
    assert.strictEqual(meta.source_parent_ref, 'META-1',
      'metadata source_parent_ref should be the issue key');
    assert.strictEqual(meta.field, 'status',
      'metadata should include the changed field');
    assert.strictEqual(meta.from, 'In Progress',
      'metadata should include from value');
    assert.strictEqual(meta.to, 'Done',
      'metadata should include to value');
    console.log('PASS: metadata includes Jira-specific fields');
  } finally {
    cleanup(p);
  }
}
```

**Step 2: Run test to verify it fails**

Run: `node test-jira-capture.js`
Expected: FAIL — `result.metadata` is null

**Step 3: Update `lib/jira-capture.js` to build enriched metadata**

Update `captureJiraActivity` signature to accept `changelogId`, and build metadata:

```javascript
function captureJiraActivity(db, { issueKey, summary, status, assigneeAccountId, assigneeName, projectKey, updatedAt, changeType, changeDetail, changelogId }) {
  const sourceId = `${issueKey}:${changeType}:${updatedAt}`;

  // Resolve assignee to entity ID if identity is known
  const authorEntityId = assigneeAccountId
    ? kg.resolveIdentity(db, 'jira', assigneeAccountId)
    : null;

  const content = formatActivityContent({ issueKey, summary, status, changeType, changeDetail });

  // Map changeType to event_type
  const EVENT_TYPE_MAP = {
    status: 'status_change',
    resolution: 'status_change',
    created: 'created',
    assignee: 'assigned',
    comment: 'comment',
  };
  const eventType = EVENT_TYPE_MAP[changeType] || 'status_change';

  // Parse from/to from changeDetail (format: "From -> To")
  let fromVal = null, toVal = null;
  if (changeDetail && changeDetail.includes(' -> ')) {
    const parts = changeDetail.split(' -> ');
    fromVal = parts[0] || null;
    toVal = parts[1] || null;
  }

  const metadata = {
    event_type: eventType,
    source_msg_id: changelogId || null,
    source_parent_ref: issueKey,
    field: changeType,
    from: fromVal,
    to: toVal,
    issue_type: null,  // not available at this layer yet
  };

  return kg.insertRawMessage(db, {
    source: 'jira',
    sourceId,
    channelId: projectKey,
    channelName: projectKey,
    authorExtId: assigneeAccountId || null,
    authorId: authorEntityId,
    authorName: assigneeName || null,
    content,
    threadId: issueKey,
    occurredAt: updatedAt,
    metadata,
  });
}
```

**Step 4: Run test to verify it passes**

Run: `node test-jira-capture.js`
Expected: ALL tests PASS

**Step 5: Update `jira-activity-collector.js` to pass `changelogId`**

In `jira-activity-collector.js`, the changelog `change` object should have an `id` field from the Jira API. Check if `jira-reader.js` `parseIssueActivity` preserves it. If not, add it.

In the `captureJiraActivity` call (around line 84), add `changelogId`:

```javascript
      captureJiraActivity(db, {
        issueKey: activity.key,
        summary: activity.summary,
        status: activity.status,
        assigneeAccountId: change.authorAccountId,
        assigneeName: change.author,
        projectKey: issue.key.split('-')[0],
        updatedAt,
        changeType: change.field,
        changeDetail,
        changelogId: change.changelogId || null,
      });
```

Check `lib/jira-reader.js` `parseIssueActivity` — add `changelogId: entry.id` to the change objects if not already there.

**Step 6: Run full test suite**

Run: `npm test`
Expected: ALL tests PASS

**Step 7: Commit**

```bash
git add lib/jira-capture.js jira-activity-collector.js lib/jira-reader.js test-jira-capture.js
git commit -m "feat: enrich Jira capture with metadata (event_type, changelog_id, field transitions)"
```

---

### Task 5: Backfill `author_ext_id` on existing rows

**Files:**
- Create: `scripts/backfill-author-ext-id.js`

**Step 1: Write the backfill script**

```javascript
#!/usr/bin/env node
/**
 * Backfill author_ext_id on existing raw_messages rows.
 *
 * Strategy:
 * 1. Rows WITH author_id: reverse-lookup identity_map (entity_id → external_id)
 * 2. Rows WITHOUT author_id: cannot be backfilled from DB alone.
 *    Log these for manual review.
 *
 * Idempotent — safe to run multiple times.
 */
'use strict';

const { initDatabase } = require('../lib/org-memory-db');

const db = initDatabase();

// Step 1: Backfill rows that have author_id (resolved entity)
const withAuthor = db.prepare(`
  SELECT rm.id, rm.source, rm.author_id, im.external_id
  FROM raw_messages rm
  JOIN identity_map im ON im.entity_id = rm.author_id AND im.source = rm.source
  WHERE rm.author_ext_id IS NULL AND rm.author_id IS NOT NULL
`).all();

const update = db.prepare('UPDATE raw_messages SET author_ext_id = ? WHERE id = ?');
let backfilled = 0;

const txn = db.transaction(() => {
  for (const row of withAuthor) {
    update.run(row.external_id, row.id);
    backfilled++;
  }
});
txn();

console.log(`Backfilled ${backfilled} rows with author_ext_id from identity_map`);

// Step 2: Report rows that can't be backfilled
const orphaned = db.prepare(`
  SELECT source, author_name, COUNT(*) as count
  FROM raw_messages
  WHERE author_ext_id IS NULL
  GROUP BY source, author_name
  ORDER BY count DESC
`).all();

if (orphaned.length > 0) {
  console.log(`\nRows without author_ext_id (cannot backfill from DB):`);
  for (const row of orphaned) {
    console.log(`  ${row.source} / ${row.author_name || '(null)'}: ${row.count} messages`);
  }
  console.log(`\nThese need re-capture from source APIs or manual update.`);
} else {
  console.log('All rows have author_ext_id. No orphans.');
}
```

**Step 2: Run the backfill**

Run: `node scripts/backfill-author-ext-id.js`
Expected: Reports backfilled count and any orphaned rows

**Step 3: Commit**

```bash
git add scripts/backfill-author-ext-id.js
git commit -m "feat: add backfill script for author_ext_id on existing raw_messages"
```

---

### Task 6: Re-run Slack backfill to fill gaps

**Step 1: Re-run slack-backfill with enriched capture**

The Slack backfill now passes `authorExtId`, `clientMsgId`, and `subtype`. Re-running it will:
- Skip existing rows (UNIQUE constraint on source_id)
- NOT update existing rows with the new fields

To fill metadata on existing Slack rows, we need to wipe and re-capture:

Run: `DRY_RUN=1 node slack-backfill.js --days 7` (verify count matches expectations)
Then: `node slack-backfill.js --days 7` (existing rows are idempotent — skipped)

For existing rows that need metadata enrichment, the backfill script from Task 5 handles `author_ext_id`. Metadata enrichment on old rows is a nice-to-have, not critical — new captures going forward will have full metadata.

**Step 2: Verify data**

Run:
```bash
node -e "
const db = require('./lib/org-memory-db').initDatabase();
const total = db.prepare('SELECT COUNT(*) as c FROM raw_messages').get();
const withExtId = db.prepare('SELECT COUNT(*) as c FROM raw_messages WHERE author_ext_id IS NOT NULL').get();
const withMeta = db.prepare('SELECT COUNT(*) as c FROM raw_messages WHERE metadata IS NOT NULL').get();
console.log('Total:', total.c);
console.log('With author_ext_id:', withExtId.c);
console.log('With metadata:', withMeta.c);
"
```

**Step 3: Commit if any new data was captured**

```bash
git commit --allow-empty -m "chore: verify backfill and re-capture complete"
```

---

### Task 7: End-to-end outcome verification

The outcome isn't "column exists" or "tests pass." It's: **every message captured today is re-resolvable a decade from now without access to the source APIs.**

Verify the exact scenario that motivated this work:

**Step 1: Run all tests**

Run: `npm test`
Expected: ALL tests PASS — no regressions

**Step 2: Capture a non-team-member message and verify ext_id is stored**

```bash
node -e "
const { initDatabase } = require('./lib/org-memory-db');
const { captureMessage } = require('./lib/slack-capture');
const db = initDatabase();

// Simulate a message from someone NOT in identity_map
const result = captureMessage(db, {
  channel: 'C_VERIFY',
  channelName: 'verify-channel',
  ts: String(Math.floor(Date.now()/1000)) + '.999999',
  user: 'U_FUTURE_HIRE',
  userName: 'Future Hire',
  text: 'This message should survive identity resolution later',
  threadTs: null,
  channelType: 'channel',
});

console.log('author_id:', result.author_id, '(should be null — unknown person)');
console.log('author_ext_id:', result.author_ext_id, '(should be U_FUTURE_HIRE)');
console.log('metadata:', result.metadata);

// Verify: ext_id is stored even though identity is unknown
const assert = require('assert');
assert.strictEqual(result.author_id, null);
assert.strictEqual(result.author_ext_id, 'U_FUTURE_HIRE');
console.log('PASS: unknown person message stored with ext_id');
"
```

Expected: `author_ext_id` = `U_FUTURE_HIRE`, `author_id` = null

**Step 3: Add the person to identity_map and run backfill sweep**

```bash
node -e "
const { initDatabase } = require('./lib/org-memory-db');
const kg = require('./lib/knowledge-graph');
const db = initDatabase();

// Later: we learn who U_FUTURE_HIRE is — add them to identity_map
const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Future Hire' });
kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_FUTURE_HIRE', displayName: 'Future Hire' });
console.log('Created entity:', entity.id);

// Now sweep: resolve author_id for all messages with this ext_id
const unresolved = db.prepare(
  \"SELECT id, source, author_ext_id FROM raw_messages WHERE author_ext_id = ? AND author_id IS NULL\"
).all('U_FUTURE_HIRE');

const update = db.prepare('UPDATE raw_messages SET author_id = ? WHERE id = ?');
const txn = db.transaction(() => {
  for (const row of unresolved) {
    const entityId = kg.resolveIdentity(db, row.source, row.author_ext_id);
    if (entityId) update.run(entityId, row.id);
  }
});
txn();

// Verify: message now has author_id
const msg = db.prepare(
  \"SELECT author_id, author_ext_id, author_name FROM raw_messages WHERE author_ext_id = 'U_FUTURE_HIRE'\"
).get();

const assert = require('assert');
assert.strictEqual(msg.author_id, entity.id, 'author_id should now resolve to entity');
assert.strictEqual(msg.author_ext_id, 'U_FUTURE_HIRE', 'ext_id should be unchanged');
console.log('PASS: late-binding identity resolution works — message now has author_id');
console.log('Result:', JSON.stringify(msg));
"
```

Expected: The message that was captured with null `author_id` now has it resolved — proving the dataset is re-resolvable without touching Slack's API.

**Step 4: Final commit and PR**

```bash
git add -A
git commit -m "chore: final verification of identity enrichment"
```
