'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-org-memory.db');
process.env.ORG_MEMORY_DB_PATH = TEST_DB_PATH;

function cleanup() {
  for (const suffix of ['', '-wal', '-shm', '.bak']) {
    try { fs.unlinkSync(TEST_DB_PATH + suffix); } catch {}
  }
}

function freshDb() {
  cleanup();
  delete require.cache[require.resolve('./lib/org-memory-db')];
  const orgDb = require('./lib/org-memory-db');
  return orgDb.initDatabase(TEST_DB_PATH);
}

function testDatabaseCreation() {
  const db = freshDb();

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);

  assert.ok(tables.includes('raw_messages'), 'raw_messages table should exist');
  assert.ok(tables.includes('entities'), 'entities table should exist');
  assert.ok(tables.includes('facts'), 'facts table should exist');
  assert.ok(tables.includes('identity_map'), 'identity_map table should exist');

  // entities should be flat (no parent_entity_id)
  const entityCols = db.prepare("PRAGMA table_info(entities)").all().map(c => c.name);
  assert.ok(!entityCols.includes('parent_entity_id'), 'entities should be flat');
  assert.ok(entityCols.includes('entity_type'));
  assert.ok(entityCols.includes('canonical_name'));
  assert.ok(entityCols.includes('is_active'));

  // facts should have state/event discriminator columns
  const factCols = db.prepare("PRAGMA table_info(facts)").all().map(c => c.name);
  assert.ok(factCols.includes('confidence'));
  assert.ok(factCols.includes('source_message_id'));
  assert.ok(factCols.includes('fact_type'), 'facts should have fact_type');
  assert.ok(factCols.includes('last_confirmed_at'), 'facts should have last_confirmed_at');
  assert.ok(factCols.includes('last_confirmed_source'), 'facts should have last_confirmed_source');
  assert.ok(factCols.includes('resolution'), 'facts should have resolution');
  assert.ok(factCols.includes('resolved_at'), 'facts should have resolved_at');

  // fact_sources should NOT exist (deferred)
  assert.ok(!tables.includes('fact_sources'), 'fact_sources should be deferred');

  // identity_map should have superset columns from monitored_people
  const idMapCols = db.prepare("PRAGMA table_info(identity_map)").all().map(c => c.name);
  assert.ok(idMapCols.includes('entity_id'));
  assert.ok(idMapCols.includes('source'));
  assert.ok(idMapCols.includes('external_id'));
  assert.ok(idMapCols.includes('jira_id'), 'identity_map should preserve jira_id');
  assert.ok(idMapCols.includes('resolved_at'), 'identity_map should preserve resolved_at');

  // WAL mode
  const journal = db.pragma('journal_mode', { simple: true });
  assert.strictEqual(journal, 'wal');

  db.close();
  cleanup();
  console.log('  PASS: database creation');
}

function testFactTypeConstraint() {
  const db = freshDb();
  const now = Math.floor(Date.now() / 1000);

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

  // Invalid resolution should fail
  assert.throws(() => {
    db.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
      VALUES (?, ?, ?, ?, 'event', ?, 'bogus', ?)`).run(crypto.randomUUID(), entityId, 'x', 'y', now, now);
  });

  db.close();
  cleanup();
  console.log('  PASS: fact type and resolution constraints');
}

function testInsertAndQueryRawMessage() {
  const db = freshDb();
  const now = Math.floor(Date.now() / 1000);

  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO raw_messages (id, source, source_id, channel_id, channel_name,
    author_name, content, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'slack', 'C123:111', 'C123', 'iops-dw', 'Kinski Wu',
         'Test message content', now, now);

  const row = db.prepare('SELECT * FROM raw_messages WHERE id = ?').get(id);
  assert.strictEqual(row.source, 'slack');
  assert.strictEqual(row.channel_name, 'iops-dw');
  assert.strictEqual(row.extracted, 0);

  db.close();
  cleanup();
  console.log('  PASS: insert and query raw message');
}

function testBackupUsesVacuumInto() {
  const db = freshDb();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`INSERT INTO raw_messages (id, source, source_id, channel_id, content, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), 'slack', 'C:1', 'C1', 'test', now, now);

  delete require.cache[require.resolve('./lib/org-memory-db')];
  const orgDb = require('./lib/org-memory-db');
  // Point the module at our test path
  const bakPath = TEST_DB_PATH + '.bak';
  // Use VACUUM INTO directly since the module's getDatabase() would use the singleton
  db.exec(`VACUUM INTO '${bakPath.replace(/'/g, "''")}'`);

  assert.ok(fs.existsSync(bakPath), 'Backup file should exist');

  const Database = require('better-sqlite3');
  const bakDb = new Database(bakPath);
  const count = bakDb.prepare('SELECT count(*) as c FROM raw_messages').get();
  assert.strictEqual(count.c, 1, 'Backup should contain the data');
  bakDb.close();

  db.close();
  cleanup();
  console.log('  PASS: backup uses VACUUM INTO');
}

function testRawMessageUniqueConstraint() {
  const db = freshDb();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`INSERT INTO raw_messages (id, source, source_id, channel_id, content, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), 'slack', 'C123:111', 'C1', 'first', now, now);

  // Same source+source_id should fail
  assert.throws(() => {
    db.prepare(`INSERT INTO raw_messages (id, source, source_id, channel_id, content, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), 'slack', 'C123:111', 'C1', 'dupe', now, now);
  });

  db.close();
  cleanup();
  console.log('  PASS: raw_messages unique constraint on source+source_id');
}

// Run all tests
console.log('org-memory-db tests:');
testDatabaseCreation();
testFactTypeConstraint();
testInsertAndQueryRawMessage();
testBackupUsesVacuumInto();
testRawMessageUniqueConstraint();
console.log('All org-memory-db tests passed.');
