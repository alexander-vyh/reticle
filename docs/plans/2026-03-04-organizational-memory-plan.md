# Organizational Memory System — Implementation Plan (Revised)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an entity-centric knowledge graph that captures Slack messages in real time, extracts structured knowledge using AI, and serves a Crack Finder consumer that identifies stale commitments, unaddressed risks, and dropped follow-ups — the most Reticle-aligned value surface.

**Architecture:** Three incremental phases — real-time capture to `raw_messages` (no AI, in separate `org-memory.db`), daily AI extraction into `entities`/`facts`/`entity_links` (via Claude Sonnet), and graph consumers starting with Crack Finder. Each phase ships independently and proves value before the next begins.

**Tech Stack:** Node.js, SQLite (better-sqlite3), Claude Sonnet (extraction), Claude Opus (editorial), existing claudia infrastructure (slack-reader, ai.js, gateway, tray, launchd).

**Design doc:** `docs/plans/2026-03-03-organizational-memory-design.md`
**Supersedes:** `docs/plans/2026-03-03-organizational-memory-plan.md` (original 9-task monolith)

---

## Key Design Decisions (from review)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Crack Finder is the first consumer | Most Reticle-aligned: pure graph queries, no AI at consumption time, surfaces credibility leaks |
| 2 | Organizational extraction IS user-centric | For a people manager, team commitments/behaviors/deliverables ARE the user's core concern |
| 3 | Channel scoping is a non-issue | Socket Mode only receives events from channels the bot is a member of — already scoped |
| 4 | 3-phase incremental delivery | Capture → validate extraction → build consumers. Each phase proves value independently |
| 5 | VACUUM INTO for atomic backups | `fs.copyFileSync` can corrupt mid-write. VACUUM INTO is atomic at the SQLite level |
| 6 | better-sqlite3 `.backup()` API | Native, no shell spawning, proper error handling. Already a project dependency |
| 7 | Layered identity seeding | monitored_people → team.json → Slack API. Uses all existing data sources in priority order |
| 8 | entity_links stays in claudia.db | Preserves schema redesign. Use SQLite ATTACH for cross-DB queries when needed |
| 9 | State/event fact type discriminator | State facts (role, status) have `last_confirmed_at`. Event facts (commitments, action items) have `resolution` status. Different temporal semantics, different staleness signals |
| 10 | Defer partial indexes to Phase 2 | Phase 1 is capture-only — no queries against facts yet |
| 11 | Skip SQL views | Consumers use queries directly. Less maintenance surface |
| 12 | Defer entity deactivation | Manual for now. Add lifecycle management when entity count becomes a problem |
| 13 | Validate relationships in link() | The RELATIONSHIPS registry exists but isn't enforced. One-line fix prevents garbage edges |
| 14 | Idempotent extraction writes | Re-running extraction on the same messages produces the same result. No cross-DB transaction coordination needed |
| 15 | identity_map is a superset of monitored_people | Migrates all columns (jira_id, resolved_at, sync fields). No data loss on migration |

---

## Phase Overview

```
Phase 1: CAPTURE (this plan — ship first)
  Goal: Real data flowing into raw_messages from day one.
  Tasks 1-5. No AI. No extraction. Just reliable capture.

  Deliverable: sqlite3 org-memory.db "SELECT count(*) FROM raw_messages"
  shows messages accumulating in real time.

Phase 2: EXTRACTION (separate plan — after 1-2 weeks of captured data)
  Goal: AI extraction validated against real captured messages.
  Tasks 6-8. Daily batch extraction. Iterate on prompts with real data.

  Deliverable: entities and facts populated with high-quality extractions.
  Manual review confirms extraction matches what actually happened.

Phase 3: CONSUMERS (separate plan — after extraction quality is proven)
  Goal: Crack Finder surfaces stale items. Weekly Report narrates the week.
  Tasks 9-12. Gateway API. Deploy integration.

  Deliverable: Crack Finder identifies real stale commitments.
  Weekly report replaces the never-deployed weekly-summary-synthesizer.
```

---

## Codebase Notes (post-rebase onto main)

After rebasing onto `main`, the following infrastructure exists and affects this plan:

- **`lib/people-store.js`** — CRUD for `monitored_people` table. Will be replaced by `identity_map` in org-memory.db. Keep functional during all phases; remove in follow-on once migration is verified.
- **`lib/feedback-collector.js`** — collects Slack messages for feedback using `slack-reader.js`. Two-stage AI pattern (assessment → draft) is reusable for the knowledge extractor in Phase 2.
- **`gateway.js`** — now has 8 endpoints: `/people` CRUD, `/feedback/candidates` CRUD, `/feedback/stats`, `/health`. Error handler at line 105 — new routes must go BEFORE it. `express.json()` middleware already exists (line 14).
- **`test-claudia-db.js`** — asserts exactly **12 tables** and checks `ENTITY_TYPES`/`RELATIONSHIPS` constants (lines 419-432). Adding entity types/relationships requires updating assertions.
- **`claudia-db.js`** — `ENTITY_TYPES` already includes `slack_message`. `link()`, `getLinked()`, `unlink()` functions (lines 295-330) operate on `entity_links` with `validateEntityType()` enforcement but **no `validateRelationship()` enforcement** (Issue 13 fix needed). Knowledge graph module should delegate to these rather than raw SQL.
- **`bin/deploy`** — scheduled services use **full plist XML blocks** per service.
- **`tray/service-manager.js`** — 10 services, `HEARTBEAT_NAMES` map with null for scheduled services.
- **`lib/config.js`** — loads `team.json` with `directReports`, `vips`, etc. Used for layered identity seeding.
- **`lib/ai.js`** — exports `getClient()` using OAuth keychain. New code must import from `lib/ai.js`, never duplicate the keychain logic.
- **`lib/slack.js`** — exports `sendSlackDM()` for Slack delivery.
- **`lib/slack-reader.js`** — exports `getUserInfo()`, `getConversationInfo()` with caching. Used for capture-time name resolution.
- **`weekly-summary-synthesizer.js`** — never deployed to launchd (no plist in `bin/deploy`). Will be deleted in Phase 3.
- **`weekly-summary-collector.js`** — never deployed to launchd. Will be deleted in Phase 3.

---

# Phase 1: Capture

**Goal:** Get real Slack messages flowing into `raw_messages` in a separate `org-memory.db`. No AI. No extraction. Just reliable, real-time capture with identity resolution.

**Success criteria:** After deploying, `raw_messages` accumulates messages in real time. Identity seeding populates reference entities from existing data. The schema correctly models both state facts and event facts (for Phase 2 to write into).

---

## Task 1: Entity Type Registries + Relationship Validation

Add new entity types and relationships to `claudia-db.js` so that `entity_links` validation accepts knowledge graph entity types. Also fix the missing relationship validation in `link()`.

**Files:**
- Modify: `claudia-db.js` (extend ENTITY_TYPES, RELATIONSHIPS, add validateRelationship)
- Modify: `test/test-claudia-db.js` (add registry and validation assertions)

### Step 1: Write the failing tests

Add to `test/test-claudia-db.js`:

```js
function testKnowledgeGraphRegistries() {
  // New entity types registered
  assert.ok(claudiaDb.ENTITY_TYPES.initiative);
  assert.ok(claudiaDb.ENTITY_TYPES.decision);
  assert.ok(claudiaDb.ENTITY_TYPES.action_item);
  assert.ok(claudiaDb.ENTITY_TYPES.risk);
  assert.ok(claudiaDb.ENTITY_TYPES.contribution);
  assert.ok(claudiaDb.ENTITY_TYPES.person);
  assert.ok(claudiaDb.ENTITY_TYPES.team);
  assert.ok(claudiaDb.ENTITY_TYPES.vendor);

  // New relationships registered
  assert.ok(claudiaDb.RELATIONSHIPS.assigned_to);
  assert.ok(claudiaDb.RELATIONSHIPS.decided_by);
  assert.ok(claudiaDb.RELATIONSHIPS.raised_by);
  assert.ok(claudiaDb.RELATIONSHIPS.contributed_by);
  assert.ok(claudiaDb.RELATIONSHIPS.spawned_by);
  assert.ok(claudiaDb.RELATIONSHIPS.member_of);
  assert.ok(claudiaDb.RELATIONSHIPS.part_of);
  assert.ok(claudiaDb.RELATIONSHIPS.relates_to);
  assert.ok(claudiaDb.RELATIONSHIPS.blocks);

  console.log('  PASS: knowledge graph registries');
}

function testRelationshipValidation() {
  const db = claudiaDb.initDatabase();
  const crypto = require('crypto');

  // Valid relationship should work
  claudiaDb.link(db, {
    sourceType: 'person',
    sourceId: crypto.randomUUID(),
    targetType: 'team',
    targetId: crypto.randomUUID(),
    relationship: 'member_of'
  });

  // Invalid relationship should throw
  assert.throws(() => {
    claudiaDb.link(db, {
      sourceType: 'person',
      sourceId: crypto.randomUUID(),
      targetType: 'team',
      targetId: crypto.randomUUID(),
      relationship: 'banana'
    });
  }, /Unknown relationship/);

  db.close();
  console.log('  PASS: relationship validation');
}
```

### Step 2: Run test to verify it fails

Run: `node test/test-claudia-db.js`
Expected: FAIL — new entity types not registered, relationship validation not enforced.

### Step 3: Add registries and validation to claudia-db.js

Add to `ENTITY_TYPES` (note: `slack_message` already exists):
```js
initiative: 'initiative',
decision: 'decision',
action_item: 'action_item',
risk: 'risk',
contribution: 'contribution',
person: 'person',
team: 'team',
vendor: 'vendor',
```

Add to `RELATIONSHIPS`:
```js
assigned_to: 'assigned_to',
decided_by: 'decided_by',
raised_by: 'raised_by',
contributed_by: 'contributed_by',
spawned_by: 'spawned_by',
member_of: 'member_of',
part_of: 'part_of',
relates_to: 'relates_to',
blocks: 'blocks',
```

Add `validateRelationship()` function (mirrors existing `validateEntityType()`):
```js
function validateRelationship(relationship) {
  if (!Object.values(RELATIONSHIPS).includes(relationship)) {
    throw new Error(`Unknown relationship: ${relationship}`);
  }
}
```

Add call to `validateRelationship(relationship)` inside `link()`, alongside the existing `validateEntityType()` calls.

No new tables in `claudia.db`. Update table count assertions if needed.

### Step 4: Run test to verify it passes

Run: `node test/test-claudia-db.js`
Expected: PASS.

### Step 5: Commit

```bash
git add claudia-db.js test/test-claudia-db.js
git commit -m "feat(schema): add knowledge graph registries and enforce relationship validation"
```

---

## Task 2: Org Memory Database

Create a separate SQLite database for the organizational memory system, isolated from `claudia.db`. The schema includes the **state/event fact type model** with `fact_type`, `last_confirmed_at`, and `resolution` columns.

**Files:**
- Create: `lib/org-memory-db.js`
- Create: `test/test-org-memory-db.js`

### Step 1: Write the failing test

Create `test/test-org-memory-db.js`:

```js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', 'test-org-memory.db');
process.env.ORG_MEMORY_DB_PATH = TEST_DB_PATH;

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB_PATH + suffix); } catch {}
  }
}

function freshDb() {
  cleanup();
  // Clear require cache to get fresh module state
  delete require.cache[require.resolve('../lib/org-memory-db')];
  const orgDb = require('../lib/org-memory-db');
  return orgDb.initDatabase(TEST_DB_PATH);
}

function testDatabaseCreation() {
  const db = freshDb();

  // Check tables exist
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);

  assert.ok(tables.includes('raw_messages'), 'raw_messages table should exist');
  assert.ok(tables.includes('entities'), 'entities table should exist');
  assert.ok(tables.includes('facts'), 'facts table should exist');
  assert.ok(tables.includes('identity_map'), 'identity_map table should exist');

  // entities should NOT have parent_entity_id (flat)
  const entityCols = db.prepare("PRAGMA table_info(entities)").all().map(c => c.name);
  assert.ok(!entityCols.includes('parent_entity_id'), 'entities should be flat');
  assert.ok(entityCols.includes('entity_type'));
  assert.ok(entityCols.includes('canonical_name'));
  assert.ok(entityCols.includes('is_active'));

  // facts should have the state/event discriminator columns
  const factCols = db.prepare("PRAGMA table_info(facts)").all().map(c => c.name);
  assert.ok(factCols.includes('confidence'));
  assert.ok(factCols.includes('source_message_id'));
  assert.ok(factCols.includes('fact_type'), 'facts should have fact_type column');
  assert.ok(factCols.includes('last_confirmed_at'), 'facts should have last_confirmed_at column');
  assert.ok(factCols.includes('last_confirmed_source'), 'facts should have last_confirmed_source column');
  assert.ok(factCols.includes('resolution'), 'facts should have resolution column');
  assert.ok(factCols.includes('resolved_at'), 'facts should have resolved_at column');

  // fact_sources table should NOT exist (deferred)
  assert.ok(!tables.includes('fact_sources'), 'fact_sources should be deferred');

  // identity_map should have superset columns from monitored_people
  const idMapCols = db.prepare("PRAGMA table_info(identity_map)").all().map(c => c.name);
  assert.ok(idMapCols.includes('entity_id'));
  assert.ok(idMapCols.includes('source'));
  assert.ok(idMapCols.includes('external_id'));
  assert.ok(idMapCols.includes('jira_id'), 'identity_map should preserve jira_id from monitored_people');
  assert.ok(idMapCols.includes('resolved_at'), 'identity_map should preserve resolved_at');

  // WAL mode should be set
  const journal = db.pragma('journal_mode', { simple: true });
  assert.strictEqual(journal, 'wal');

  db.close();
  cleanup();
  console.log('  PASS: database creation');
}

function testFactTypeConstraint() {
  const db = freshDb();
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);

  // Create an entity first
  const entityId = crypto.randomUUID();
  db.prepare(`INSERT INTO entities (id, entity_type, canonical_name, is_active, created_at)
    VALUES (?, ?, ?, 1, ?)`).run(entityId, 'action_item', 'Test task', now);

  // State fact should work
  db.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, extracted_at)
    VALUES (?, ?, ?, ?, 'state', ?, ?)`).run(crypto.randomUUID(), entityId, 'role', 'EM', now, now);

  // Event fact should work
  db.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, 'event', ?, 'open', ?)`).run(crypto.randomUUID(), entityId, 'status', 'open', now, now);

  // Invalid fact_type should fail
  assert.throws(() => {
    db.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, extracted_at)
      VALUES (?, ?, ?, ?, 'invalid', ?, ?)`).run(crypto.randomUUID(), entityId, 'foo', 'bar', now, now);
  });

  db.close();
  cleanup();
  console.log('  PASS: fact type constraint');
}

function testInsertAndQueryRawMessage() {
  const db = freshDb();
  const crypto = require('crypto');

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO raw_messages (id, source, source_id, channel_id, channel_name,
    author_name, content, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'slack', 'C123:111', 'C123', 'eng-platform', 'Gandalf Grey',
         'Test message content', now, now);

  const row = db.prepare('SELECT * FROM raw_messages WHERE id = ?').get(id);
  assert.strictEqual(row.source, 'slack');
  assert.strictEqual(row.channel_name, 'eng-platform');
  assert.strictEqual(row.extracted, 0);

  db.close();
  cleanup();
  console.log('  PASS: insert and query raw message');
}

function testBackupUsesVacuumInto() {
  const db = freshDb();
  const orgDb = require('../lib/org-memory-db');

  // Insert some data so backup has something
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO raw_messages (id, source, source_id, channel_id, content, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), 'slack', 'C:1', 'C1', 'test', now, now);

  const bakPath = orgDb.backupDatabase();
  assert.ok(fs.existsSync(bakPath), 'Backup file should exist');

  // Verify backup is a valid SQLite database
  const Database = require('better-sqlite3');
  const bakDb = new Database(bakPath);
  const count = bakDb.prepare('SELECT count(*) as c FROM raw_messages').get();
  assert.strictEqual(count.c, 1, 'Backup should contain the data');
  bakDb.close();

  db.close();
  try { fs.unlinkSync(bakPath); } catch {}
  cleanup();
  console.log('  PASS: backup uses VACUUM INTO');
}

// Run all tests
console.log('org-memory-db tests:');
testDatabaseCreation();
testFactTypeConstraint();
testInsertAndQueryRawMessage();
testBackupUsesVacuumInto();
console.log('All org-memory-db tests passed.');
```

### Step 2: Run test to verify it fails

Run: `node test/test-org-memory-db.js`
Expected: FAIL — `lib/org-memory-db.js` does not exist.

### Step 3: Implement lib/org-memory-db.js

Create `lib/org-memory-db.js`:

```js
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const CLAUDIA_HOME = process.env.CLAUDIA_HOME || path.join(require('os').homedir(), '.claudia');
const DB_PATH = process.env.ORG_MEMORY_DB_PATH || path.join(CLAUDIA_HOME, 'data', 'org-memory.db');

let _db = null;

function initDatabase(dbPath) {
  const resolvedPath = dbPath || DB_PATH;

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_messages (
      id            TEXT PRIMARY KEY,
      source        TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      channel_id    TEXT,
      channel_name  TEXT,
      author_id     TEXT,
      author_name   TEXT,
      content       TEXT NOT NULL,
      thread_id     TEXT,
      occurred_at   INTEGER NOT NULL,
      metadata      TEXT,
      extracted     INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_source ON raw_messages(source, source_id);
    CREATE INDEX IF NOT EXISTS idx_raw_pending ON raw_messages(extracted, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_raw_channel ON raw_messages(channel_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_raw_author ON raw_messages(author_id, occurred_at);

    CREATE TABLE IF NOT EXISTS entities (
      id               TEXT PRIMARY KEY,
      entity_type      TEXT NOT NULL,
      canonical_name   TEXT NOT NULL,
      is_active        INTEGER DEFAULT 1,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type, is_active);
    CREATE INDEX IF NOT EXISTS idx_entities_active ON entities(is_active);

    CREATE TABLE IF NOT EXISTS facts (
      id                    TEXT PRIMARY KEY,
      entity_id             TEXT NOT NULL REFERENCES entities(id),
      attribute             TEXT NOT NULL,
      value                 TEXT,
      fact_type             TEXT NOT NULL DEFAULT 'state'
                              CHECK(fact_type IN ('state', 'event')),
      valid_from            INTEGER NOT NULL,
      valid_to              INTEGER,
      confidence            REAL DEFAULT 1.0,
      source_message_id     TEXT,
      last_confirmed_at     INTEGER,
      last_confirmed_source TEXT,
      resolution            TEXT CHECK(resolution IN ('open', 'completed', 'abandoned', 'superseded')),
      resolved_at           INTEGER,
      extracted_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id, attribute);
    CREATE INDEX IF NOT EXISTS idx_facts_current ON facts(entity_id, attribute, valid_to);
    CREATE INDEX IF NOT EXISTS idx_facts_date ON facts(valid_from);
    CREATE INDEX IF NOT EXISTS idx_facts_extracted ON facts(extracted_at);

    CREATE TABLE IF NOT EXISTS identity_map (
      entity_id    TEXT NOT NULL REFERENCES entities(id),
      source       TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      display_name TEXT,
      jira_id      TEXT,
      resolved_at  INTEGER,
      metadata     TEXT,
      PRIMARY KEY (source, external_id)
    );
  `);

  return db;
}

function getDatabase() {
  if (!_db) {
    _db = initDatabase();
  }
  return _db;
}

function backupDatabase() {
  const bakPath = DB_PATH + '.bak';
  const db = getDatabase();
  // VACUUM INTO creates an atomic, consistent backup
  // Safe even if writes are happening concurrently
  db.exec(`VACUUM INTO '${bakPath.replace(/'/g, "''")}'`);
  return bakPath;
}

module.exports = { initDatabase, getDatabase, backupDatabase, DB_PATH };
```

**Key differences from original plan:**
- `facts` table includes `fact_type` ('state'/'event') with CHECK constraint
- `facts` table includes `last_confirmed_at` and `last_confirmed_source` for state fact re-confirmation
- `facts` table includes `resolution` and `resolved_at` for event fact lifecycle
- `identity_map` includes `jira_id`, `resolved_at`, `metadata` from monitored_people (superset schema)
- `backupDatabase()` uses `VACUUM INTO` instead of `fs.copyFileSync`

### Step 4: Run test to verify it passes

Run: `node test/test-org-memory-db.js`
Expected: All 4 tests PASS.

### Step 5: Commit

```bash
git add lib/org-memory-db.js test/test-org-memory-db.js
git commit -m "feat: add org-memory.db with state/event fact model and atomic backup"
```

---

## Task 3: Knowledge Graph Module

Core CRUD and query module for entities, facts, raw messages, and identity resolution. Implements the state/event fact upsert logic.

**Files:**
- Create: `lib/knowledge-graph.js`
- Create: `test/test-knowledge-graph.js`

### Step 1: Write the failing test

Create `test/test-knowledge-graph.js`:

```js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', 'test-kg.db');
process.env.ORG_MEMORY_DB_PATH = TEST_DB_PATH;

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB_PATH + suffix); } catch {}
  }
}

function freshDb() {
  cleanup();
  delete require.cache[require.resolve('../lib/org-memory-db')];
  const orgDb = require('../lib/org-memory-db');
  return orgDb.initDatabase(TEST_DB_PATH);
}

const kg = require('../lib/knowledge-graph');

function testCreateEntity() {
  const db = freshDb();
  const entity = kg.createEntity(db, {
    entityType: 'action_item',
    canonicalName: 'Rotate HubSpot token'
  });
  assert.ok(entity.id);
  assert.strictEqual(entity.entity_type, 'action_item');
  assert.strictEqual(entity.canonical_name, 'Rotate HubSpot token');
  assert.strictEqual(entity.is_active, 1);
  db.close();
  cleanup();
  console.log('  PASS: createEntity');
}

function testAddStateFact() {
  const db = freshDb();
  const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });
  const now = Math.floor(Date.now() / 1000);

  const fact = kg.addFact(db, {
    entityId: entity.id,
    attribute: 'role',
    value: 'Engineering Manager',
    factType: 'state',
    validFrom: now,
    confidence: 0.95
  });
  assert.ok(fact.id);
  assert.strictEqual(fact.fact_type, 'state');
  assert.strictEqual(fact.valid_to, null);
  assert.strictEqual(fact.resolution, null);
  db.close();
  cleanup();
  console.log('  PASS: addStateFact');
}

function testAddEventFact() {
  const db = freshDb();
  const entity = kg.createEntity(db, { entityType: 'action_item', canonicalName: 'Fix the bug' });
  const now = Math.floor(Date.now() / 1000);

  const fact = kg.addFact(db, {
    entityId: entity.id,
    attribute: 'status',
    value: 'open',
    factType: 'event',
    validFrom: now,
    resolution: 'open'
  });
  assert.ok(fact.id);
  assert.strictEqual(fact.fact_type, 'event');
  assert.strictEqual(fact.resolution, 'open');
  db.close();
  cleanup();
  console.log('  PASS: addEventFact');
}

function testStateFactReconfirmation() {
  const db = freshDb();
  const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });
  const now = Math.floor(Date.now() / 1000);

  // First extraction: role = EM
  kg.upsertFact(db, {
    entityId: entity.id,
    attribute: 'role',
    value: 'Engineering Manager',
    factType: 'state',
    sourceMessageId: 'msg-1',
    now
  });

  // Second extraction: same role re-confirmed
  kg.upsertFact(db, {
    entityId: entity.id,
    attribute: 'role',
    value: 'Engineering Manager',
    factType: 'state',
    sourceMessageId: 'msg-2',
    now: now + 86400
  });

  // Should still be one active fact, not two
  const facts = db.prepare(
    "SELECT * FROM facts WHERE entity_id = ? AND attribute = 'role' AND valid_to IS NULL"
  ).all(entity.id);
  assert.strictEqual(facts.length, 1, 'Should not create duplicate state fact');
  assert.strictEqual(facts[0].last_confirmed_at, now + 86400, 'Should update last_confirmed_at');
  assert.strictEqual(facts[0].last_confirmed_source, 'msg-2', 'Should update last_confirmed_source');

  db.close();
  cleanup();
  console.log('  PASS: state fact re-confirmation');
}

function testStateFactValueChange() {
  const db = freshDb();
  const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });
  const now = Math.floor(Date.now() / 1000);

  kg.upsertFact(db, {
    entityId: entity.id, attribute: 'role', value: 'EM',
    factType: 'state', sourceMessageId: 'msg-1', now
  });

  kg.upsertFact(db, {
    entityId: entity.id, attribute: 'role', value: 'Staff Engineer',
    factType: 'state', sourceMessageId: 'msg-2', now: now + 86400
  });

  // Old fact should be closed
  const closed = db.prepare(
    "SELECT * FROM facts WHERE entity_id = ? AND attribute = 'role' AND valid_to IS NOT NULL"
  ).all(entity.id);
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(closed[0].value, 'EM');

  // New fact should be open
  const current = db.prepare(
    "SELECT * FROM facts WHERE entity_id = ? AND attribute = 'role' AND valid_to IS NULL"
  ).all(entity.id);
  assert.strictEqual(current.length, 1);
  assert.strictEqual(current[0].value, 'Staff Engineer');

  db.close();
  cleanup();
  console.log('  PASS: state fact value change');
}

function testEventFactDeduplication() {
  const db = freshDb();
  const entity = kg.createEntity(db, { entityType: 'action_item', canonicalName: 'Fix the bug' });
  const now = Math.floor(Date.now() / 1000);

  // First extraction: event created
  kg.upsertFact(db, {
    entityId: entity.id, attribute: 'status', value: 'open',
    factType: 'event', sourceMessageId: 'msg-1', now, resolution: 'open'
  });

  // Re-extraction: same event — should be skipped
  kg.upsertFact(db, {
    entityId: entity.id, attribute: 'status', value: 'open',
    factType: 'event', sourceMessageId: 'msg-2', now: now + 86400, resolution: 'open'
  });

  // Should still be one event fact
  const facts = db.prepare(
    "SELECT * FROM facts WHERE entity_id = ? AND fact_type = 'event'"
  ).all(entity.id);
  assert.strictEqual(facts.length, 1, 'Should not create duplicate event fact');

  db.close();
  cleanup();
  console.log('  PASS: event fact deduplication');
}

function testResolveEventFact() {
  const db = freshDb();
  const entity = kg.createEntity(db, { entityType: 'action_item', canonicalName: 'Fix the bug' });
  const now = Math.floor(Date.now() / 1000);

  kg.upsertFact(db, {
    entityId: entity.id, attribute: 'status', value: 'open',
    factType: 'event', sourceMessageId: 'msg-1', now, resolution: 'open'
  });

  kg.resolveEvent(db, {
    entityId: entity.id, attribute: 'status',
    resolution: 'completed', resolvedAt: now + 86400
  });

  const fact = db.prepare(
    "SELECT * FROM facts WHERE entity_id = ? AND attribute = 'status' AND fact_type = 'event'"
  ).get(entity.id);
  assert.strictEqual(fact.resolution, 'completed');
  assert.strictEqual(fact.resolved_at, now + 86400);

  db.close();
  cleanup();
  console.log('  PASS: resolve event fact');
}

function testGetCurrentState() {
  const db = freshDb();
  const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });
  const now = Math.floor(Date.now() / 1000);

  kg.addFact(db, { entityId: entity.id, attribute: 'role', value: 'EM', factType: 'state', validFrom: now });
  kg.addFact(db, { entityId: entity.id, attribute: 'team', value: 'Infrastructure', factType: 'state', validFrom: now });

  const state = kg.getCurrentState(db, entity.id);
  assert.strictEqual(state.role, 'EM');
  assert.strictEqual(state.team, 'Infrastructure');
  db.close();
  cleanup();
  console.log('  PASS: getCurrentState');
}

function testResolveIdentity() {
  const db = freshDb();
  const person = kg.createEntity(db, { entityType: 'person', canonicalName: 'Faramir Guard' });
  kg.addIdentity(db, { entityId: person.id, source: 'slack', externalId: 'U04ABC123' });
  kg.addIdentity(db, { entityId: person.id, source: 'email', externalId: 'keshon@co.com' });

  assert.strictEqual(kg.resolveIdentity(db, 'slack', 'U04ABC123'), person.id);
  assert.strictEqual(kg.resolveIdentity(db, 'email', 'keshon@co.com'), person.id);
  assert.strictEqual(kg.resolveIdentity(db, 'slack', 'UNKNOWN'), null);
  db.close();
  cleanup();
  console.log('  PASS: resolveIdentity');
}

function testInsertRawMessage() {
  const db = freshDb();
  const msg = kg.insertRawMessage(db, {
    source: 'slack',
    sourceId: 'C123:1234567890.123456',
    channelId: 'C123',
    channelName: 'eng-platform',
    authorId: null,
    authorName: 'Gandalf Grey',
    content: 'Let us use Permission Set Groups instead',
    threadId: null,
    occurredAt: Math.floor(Date.now() / 1000)
  });
  assert.ok(msg.id);
  assert.strictEqual(msg.extracted, 0);
  db.close();
  cleanup();
  console.log('  PASS: insertRawMessage');
}

function testGetActiveEntities() {
  const db = freshDb();
  kg.createEntity(db, { entityType: 'decision', canonicalName: 'Use PSGs' });
  kg.createEntity(db, { entityType: 'action_item', canonicalName: 'Map profiles' });
  kg.createEntity(db, { entityType: 'person', canonicalName: 'Gandalf Grey' });

  const workEntities = kg.getActiveEntities(db, { types: ['decision', 'action_item'] });
  assert.strictEqual(workEntities.length, 2);

  const all = kg.getActiveEntities(db);
  assert.strictEqual(all.length, 3);
  db.close();
  cleanup();
  console.log('  PASS: getActiveEntities');
}

// Run all tests
console.log('knowledge-graph tests:');
testCreateEntity();
testAddStateFact();
testAddEventFact();
testStateFactReconfirmation();
testStateFactValueChange();
testEventFactDeduplication();
testResolveEventFact();
testGetCurrentState();
testResolveIdentity();
testInsertRawMessage();
testGetActiveEntities();
console.log('All knowledge-graph tests passed.');
```

### Step 2: Run test to verify it fails

Run: `node test/test-knowledge-graph.js`
Expected: FAIL — `lib/knowledge-graph.js` does not exist.

### Step 3: Implement lib/knowledge-graph.js

Create `lib/knowledge-graph.js` with these functions. All operate on the org-memory.db connection passed as `db`:

**Entity operations:**
- `createEntity(db, { entityType, canonicalName })` — inserts into `entities`, returns row
- `getEntity(db, id)` — returns entity by id
- `getEntitiesByType(db, type, { activeOnly, since, limit })` — filtered query
- `getActiveEntities(db, { types, limit })` — returns active entities for AI context window
- `deactivateEntity(db, id)` — sets `is_active = 0`

**Fact operations (state/event aware):**
- `addFact(db, { entityId, attribute, value, factType, validFrom, confidence, sourceMessageId, extractedAt, resolution })` — low-level insert into `facts`
- `upsertFact(db, { entityId, attribute, value, factType, sourceMessageId, now, resolution })` — the smart upsert:
  - **State facts:** Check if current active fact has same value. If so, update `last_confirmed_at`. If different value, close old and insert new. If no existing, insert new.
  - **Event facts:** Check if an open event fact with same entity+attribute+value exists. If so, skip (deduplicate). If not, insert new.
- `resolveEvent(db, { entityId, attribute, resolution, resolvedAt })` — updates resolution status on an open event fact
- `getCurrentState(db, entityId)` — returns `{ attribute: value }` for all current facts where `valid_to IS NULL`
- `getEntityFacts(db, entityId, { attribute, since })` — returns all facts for entity

**Identity operations:**
- `addIdentity(db, { entityId, source, externalId, displayName, jiraId })` — inserts into `identity_map`
- `resolveIdentity(db, source, externalId)` — returns entity_id or null

**Raw message operations:**
- `insertRawMessage(db, { source, sourceId, channelId, channelName, authorId, authorName, content, threadId, occurredAt, metadata })` — upsert on source+source_id
- `getUnextractedMessages(db, { limit, since })` — returns `raw_messages WHERE extracted = 0`
- `markExtracted(db, messageIds)` — sets `extracted = 1` for given IDs

**Cross-DB operations (Phase 2/3):**
- `linkEntities(mainDb, { sourceId, sourceType, targetId, targetType, relationship, metadata })` — delegates to `claudia-db.link()`. Note: takes `mainDb` (claudia.db connection), not `db` (org-memory.db).
- `getLinkedEntities(mainDb, entityType, entityId, { relationship, direction })` — delegates to `claudia-db.getLinked()`

Use `crypto.randomUUID()` for IDs. Epoch seconds for all timestamps.

### Step 4: Run test to verify it passes

Run: `node test/test-knowledge-graph.js`
Expected: All 11 tests PASS.

### Step 5: Commit

```bash
git add lib/knowledge-graph.js test/test-knowledge-graph.js
git commit -m "feat: add knowledge graph module with state/event fact upsert logic"
```

---

## Task 4: Identity Seeding

Bootstrap reference entities (people, teams, vendors) and populate identity_map using the layered approach: monitored_people → team.json → Slack API.

**Files:**
- Create: `lib/seed-data.js`
- Create: `test/test-seed-data.js`

### Step 1: Write the failing test

Create `test/test-seed-data.js`:

```js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '..', 'test-seed.db');
process.env.ORG_MEMORY_DB_PATH = TEST_DB_PATH;
process.env.CLAUDIA_DB_PATH = path.join(__dirname, '..', 'test-seed-claudia.db');

function cleanup() {
  for (const p of [TEST_DB_PATH, path.join(__dirname, '..', 'test-seed-claudia.db')]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(p + suffix); } catch {}
    }
  }
}

function freshDbs() {
  cleanup();
  delete require.cache[require.resolve('../lib/org-memory-db')];
  delete require.cache[require.resolve('../claudia-db')];
  const orgDb = require('../lib/org-memory-db');
  const claudiaDb = require('../claudia-db');
  return {
    db: orgDb.initDatabase(TEST_DB_PATH),
    mainDb: claudiaDb.initDatabase()
  };
}

const seedData = require('../lib/seed-data');

function testSeedCreatesTeams() {
  const { db, mainDb } = freshDbs();
  seedData.seedAll(db, mainDb);

  const teams = db.prepare("SELECT * FROM entities WHERE entity_type = 'team'").all();
  assert.strictEqual(teams.length, 3);
  assert.ok(teams.find(t => t.canonical_name === 'Infrastructure'));
  assert.ok(teams.find(t => t.canonical_name === 'Support'));
  assert.ok(teams.find(t => t.canonical_name === 'Platform'));
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed creates teams');
}

function testSeedCreatesPeople() {
  const { db, mainDb } = freshDbs();
  seedData.seedAll(db, mainDb);

  const people = db.prepare("SELECT * FROM entities WHERE entity_type = 'person'").all();
  assert.ok(people.length >= 7, `Expected at least 7 people, got ${people.length}`);
  assert.ok(people.find(p => p.canonical_name === 'Gandalf Grey'));
  assert.ok(people.find(p => p.canonical_name === 'Faramir Guard'));
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed creates people');
}

function testSeedLinksPeopleToTeams() {
  const { db, mainDb } = freshDbs();
  seedData.seedAll(db, mainDb);

  const gandalf = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Gandalf Grey'").get();
  const infra = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Infrastructure'").get();

  const link = mainDb.prepare(
    "SELECT * FROM entity_links WHERE source_type = 'person' AND source_id = ? AND target_type = 'team' AND target_id = ? AND relationship = 'member_of'"
  ).get(gandalf.id, infra.id);
  assert.ok(link, 'Gandalf should be member_of Infrastructure');
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed links people to teams');
}

function testSeedCreatesVendors() {
  const { db, mainDb } = freshDbs();
  seedData.seedAll(db, mainDb);

  const vendors = db.prepare("SELECT * FROM entities WHERE entity_type = 'vendor'").all();
  assert.ok(vendors.length >= 5, `Expected at least 5 vendors, got ${vendors.length}`);
  assert.ok(vendors.find(v => v.canonical_name === 'Okta'));
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed creates vendors');
}

function testSeedIsIdempotent() {
  const { db, mainDb } = freshDbs();
  seedData.seedAll(db, mainDb);
  seedData.seedAll(db, mainDb); // Run twice

  const people = db.prepare("SELECT * FROM entities WHERE entity_type = 'person'").all();
  const gandalf = people.filter(p => p.canonical_name === 'Gandalf Grey');
  assert.strictEqual(gandalf.length, 1, 'Should not duplicate Gandalf Grey');
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed is idempotent');
}

function testSeedFromMonitoredPeople() {
  const { db, mainDb } = freshDbs();

  // Simulate existing monitored_people data
  mainDb.prepare(`INSERT INTO monitored_people (id, name, slack_user_id, relationship, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('mp-1', 'Test Person', 'U_TEST_123', 'direct_report',
    Math.floor(Date.now() / 1000));

  seedData.seedFromMonitoredPeople(db, mainDb);

  // Should have created entity and identity_map entry
  const identity = db.prepare(
    "SELECT * FROM identity_map WHERE source = 'slack' AND external_id = 'U_TEST_123'"
  ).get();
  assert.ok(identity, 'Should create identity_map entry from monitored_people');

  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed from monitored_people');
}

console.log('seed-data tests:');
testSeedCreatesTeams();
testSeedCreatesPeople();
testSeedLinksPeopleToTeams();
testSeedCreatesVendors();
testSeedIsIdempotent();
testSeedFromMonitoredPeople();
console.log('All seed-data tests passed.');
```

### Step 2: Run test to verify it fails

Run: `node test/test-seed-data.js`
Expected: FAIL — `lib/seed-data.js` does not exist.

### Step 3: Implement lib/seed-data.js

Create `lib/seed-data.js` with:

- `TEAMS` constant: `['Infrastructure', 'Support', 'Platform']`
- `PEOPLE` constant: array of `{ name, team }` objects for the 7 team members
- `VENDORS` constant: array of vendor names
- `seedAll(db, mainDb)` function:
  1. Create team entities in org-memory.db (idempotent — check by canonical_name before insert)
  2. Create people entities, link each to their team via `claudia-db.link()` on mainDb with `member_of`
  3. Create vendor entities
  4. Call `seedFromMonitoredPeople(db, mainDb)` for layered identity seeding
  5. All idempotent — check-before-insert pattern
- `seedFromMonitoredPeople(db, mainDb)` function:
  1. Read all rows from `monitored_people` in claudia.db
  2. For each person: find or create matching entity in org-memory.db
  3. Copy `slack_user_id` into `identity_map` (source='slack')
  4. Copy `jira_id` if present
  5. Skip if identity already exists (idempotent)

**Opportunity:** Also consider sourcing additional team members from `config.directReports` (loaded from `team.json`) for people not yet in `monitored_people`.

Do NOT include email addresses or Slack IDs in the seed data file (gitleaks will catch them). Identity mapping comes from monitored_people and config at runtime.

### Step 4: Run test to verify it passes

Run: `node test/test-seed-data.js`
Expected: All 6 tests PASS.

### Step 5: Commit

```bash
git add lib/seed-data.js test/test-seed-data.js
git commit -m "feat: add layered identity seeding from monitored_people, team.json, and config"
```

---

## Task 5: Real-Time Slack Capture

Extend `slack-events-monitor.js` to write ALL non-bot messages to `raw_messages` in org-memory.db, with channel name and author name resolved at capture time.

**Files:**
- Modify: `slack-events-monitor.js` (add raw_messages writes in `handleEvent`)

### Step 1: Understand current message flow

Read `slack-events-monitor.js:handleEvent`. Currently:
- Bot messages and own messages are filtered out (keep this)
- DMs are tracked via `trackMessage` for response monitoring
- @mentions are tracked via `trackMessage`
- Other channel messages are ignored

The change: after the existing filters, write every non-bot, non-self message to `raw_messages` via `kg.insertRawMessage`. This is additive — doesn't change existing behavior.

### Step 2: Add raw message capture to handleEvent

At the top of `slack-events-monitor.js`, add:
```js
const orgMemoryDb = require('./lib/org-memory-db');
const kg = require('./lib/knowledge-graph');
const slackReader = require('./lib/slack-reader');
```

In `handleEvent`, AFTER the bot/self filters, add the raw_messages capture:

```js
// Capture all non-bot messages to raw_messages for knowledge graph
if (event.type === 'message' && !event.subtype && event.user !== CONFIG.myUserId) {
  try {
    const omDb = orgMemoryDb.getDatabase();
    const sourceId = `${event.channel}:${event.ts}`;
    const authorEntityId = kg.resolveIdentity(omDb, 'slack', event.user);

    // Resolve names at capture time (cached by slack-reader)
    const authorName = await slackReader.getUserInfo(event.user);
    const channelName = event.channel_type === 'im'
      ? `dm-${authorName}`
      : await slackReader.getConversationInfo(event.channel);

    kg.insertRawMessage(omDb, {
      source: 'slack',
      sourceId,
      channelId: event.channel,
      channelName,
      authorId: authorEntityId,
      authorName,
      content: event.text || '',
      threadId: event.thread_ts || null,
      occurredAt: Math.floor(parseFloat(event.ts)),
    });
  } catch (err) {
    // Non-fatal — don't let capture failures break event processing
    log.warn({ err: err.message, channel: event.channel }, 'Failed to capture raw message');
  }
}
```

This is a non-fatal wrapper — capture failures don't break existing Slack event processing.

### Step 3: Test manually

Run `slack-events-monitor.js` briefly, send a test message in Slack, verify a row appears:

```bash
sqlite3 ~/.claudia/data/org-memory.db \
  "SELECT source, channel_name, author_name, substr(content,1,60) FROM raw_messages ORDER BY occurred_at DESC LIMIT 5;"
```

### Step 4: Commit

```bash
git add slack-events-monitor.js
git commit -m "feat(capture): write all slack messages to org-memory.db with name resolution"
```

---

## Phase 1 Verification

### Run all tests

```bash
node test/test-claudia-db.js && \
node test/test-org-memory-db.js && \
node test/test-knowledge-graph.js && \
node test/test-seed-data.js && \
npm test --prefix tray
```

All should pass.

### Manual E2E

1. **Seed the database:**
   ```bash
   node -e "
     const orgDb = require('./lib/org-memory-db');
     const claudiaDb = require('./claudia-db');
     const seedData = require('./lib/seed-data');
     const db = orgDb.getDatabase();
     const mainDb = claudiaDb.initDatabase();
     seedData.seedAll(db, mainDb);
     console.log('Seeded');
     db.close(); mainDb.close();
   "
   ```

2. **Verify entities created:**
   ```bash
   sqlite3 ~/.claudia/data/org-memory.db \
     "SELECT entity_type, canonical_name FROM entities ORDER BY entity_type, canonical_name;"
   ```

3. **Verify identity_map populated:**
   ```bash
   sqlite3 ~/.claudia/data/org-memory.db \
     "SELECT im.source, im.external_id, e.canonical_name FROM identity_map im JOIN entities e ON e.id = im.entity_id;"
   ```

4. **Start slack-events-monitor** and let it capture messages. Verify raw_messages:
   ```bash
   sqlite3 ~/.claudia/data/org-memory.db \
     "SELECT source, channel_name, author_name, substr(content,1,60) FROM raw_messages ORDER BY occurred_at DESC LIMIT 10;"
   ```

5. **Let it run for 1-2 weeks** before starting Phase 2. Accumulate real data for extraction validation.

### Commit any fixes

```bash
git add -A
git commit -m "fix: adjustments from Phase 1 end-to-end testing"
```

---

# Phase 2: Extraction (separate plan — after captured data exists)

> **Write this plan after Phase 1 has been running for 1-2 weeks with real data.**

## Overview

Phase 2 adds the AI extraction layer. It reads unprocessed `raw_messages`, sends them to Claude Sonnet for structured extraction, and writes entities/facts using the state/event fact model.

### Tasks (to be detailed in Phase 2 plan)

**Task 6: Knowledge Extractor**
- Create: `knowledge-extractor.js`, `test/test-knowledge-extractor.js`
- Daily batch extraction via launchd
- Pre-extraction backup using `better-sqlite3 .backup()` API (for large DBs) or VACUUM INTO (for small DBs)
- State/event-aware write logic:
  - State facts: use `upsertFact()` with re-confirmation (last_confirmed_at)
  - Event facts: use `upsertFact()` with deduplication (skip if same value exists open)
- Extraction is **idempotent**: re-running on the same messages produces the same entities/facts. No cross-DB transaction coordination needed.
- Value normalization before comparison (lowercase, trim) to prevent spurious transitions from AI formatting variance
- `initiative` is NOT in extraction entity types — initiatives tied to hierarchy (deferred)

**Task 7: Extraction Prompt Design**
- System prompt instructs Claude to distinguish state observations from event occurrences
- AI returns `fact_type` for each extracted fact
- Entity resolution against active entities list
- Confidence scoring on extracted facts

**Task 8: Add Partial Indexes**
- Now that queries against facts happen, add the indexes from the design doc:
  - `idx_facts_current_state` on facts(entity_id, attribute) WHERE valid_to IS NULL AND fact_type = 'state'
  - `idx_facts_open_events` on facts(entity_id) WHERE fact_type = 'event' AND resolution = 'open'

### Validation criteria (before proceeding to Phase 3)

- Extract from at least 7 days of captured messages
- Manually review extracted entities against actual Slack conversations
- Confirm entity resolution correctly maps mentions to existing entities
- Confirm state facts don't have spurious transitions
- Confirm event facts are properly deduplicated
- Iterate on extraction prompts until quality is satisfactory

---

# Phase 3: Consumers (separate plan — after extraction quality is proven)

> **Write this plan after Phase 2 extraction quality has been validated.**

## Overview

Phase 3 builds the consumer layer. Crack Finder ships first (most Reticle-aligned), then Gateway API, then Weekly Report.

### Tasks (to be detailed in Phase 3 plan)

**Task 9: Crack Finder**
- Create: `crack-finder.js`, `test/test-crack-finder.js`
- Pure graph queries — no AI at consumption time
- Queries for:
  - Event facts with `resolution = 'open'` and `valid_from` older than N days (stale commitments)
  - Decisions with no spawned action items (decided but not acted on)
  - Risks with `resolution = 'open'` and no mitigation facts
- Uses state fact `last_confirmed_at` to gauge whether status-type facts are still believed current
- Delivers findings via Slack DM using `lib/slack.js`
- Runs daily or weekly via launchd

**Task 10: Gateway API Endpoints**
- Modify: `gateway.js`, `test/test-gateway.js`
- Knowledge graph query endpoints (entities, facts, cracks, person activity)
- Uses SQLite ATTACH for cross-DB entity_links queries
- On-demand extraction trigger (using async `child_process.exec`, NOT execSync)
- Backup endpoint using `better-sqlite3 .backup()` API

**Task 11: Weekly Report Consumer**
- Create: `weekly-report.js`, `test/test-weekly-report.js`
- Queries knowledge graph for entities with facts from past 7 days
- Groups by team via entity → person → team links (using ATTACH for cross-DB)
- Uses Opus for editorial synthesis
- Delivers via Slack DM
- Delete: `weekly-summary-synthesizer.js`, `weekly-summary-collector.js`

**Task 12: Deploy Integration**
- Modify: `bin/deploy` (add knowledge-extractor + crack-finder plists)
- Modify: `tray/service-manager.js` (add new services, remove old weekly-summary services)
- knowledge-extractor: daily at 11 PM via launchd
- crack-finder: daily at 7 AM via launchd (after extraction has run overnight)
- weekly-report: Friday at 8 AM via launchd

---

## Follow-on (separate plans, after Phase 3 is proven)

- Entity hierarchy (`parent_entity_id`) once extraction quality is proven
- `fact_sources` table for multi-source provenance
- Feedback prep consumer (O3 integration)
- Pattern detector consumer
- Todo surface consumer (with write-back)
- Slack command interface
- Email capture (extend gmail-monitor)
- Historical backfill from Slack
- Entity lifecycle management (auto-deactivation based on staleness signals)
- Remove `monitored_people` table and `lib/people-store.js` (after migration verified)
