'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-kg.db');
process.env.ORG_MEMORY_DB_PATH = TEST_DB_PATH;

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB_PATH + suffix); } catch {}
  }
}

function freshDb() {
  cleanup();
  delete require.cache[require.resolve('./lib/org-memory-db')];
  delete require.cache[require.resolve('./lib/knowledge-graph')];
  const orgDb = require('./lib/org-memory-db');
  return orgDb.initDatabase(TEST_DB_PATH);
}

function testCreateEntity() {
  const db = freshDb();
  const kg = require('./lib/knowledge-graph');
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
  const kg = require('./lib/knowledge-graph');
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
  const kg = require('./lib/knowledge-graph');
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
  const kg = require('./lib/knowledge-graph');
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
  const kg = require('./lib/knowledge-graph');
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
  const kg = require('./lib/knowledge-graph');
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
  const kg = require('./lib/knowledge-graph');
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
  const kg = require('./lib/knowledge-graph');
  const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });
  const now = Math.floor(Date.now() / 1000);

  kg.addFact(db, { entityId: entity.id, attribute: 'role', value: 'EM', factType: 'state', validFrom: now });
  kg.addFact(db, { entityId: entity.id, attribute: 'team', value: 'CSE', factType: 'state', validFrom: now });

  const state = kg.getCurrentState(db, entity.id);
  assert.strictEqual(state.role, 'EM');
  assert.strictEqual(state.team, 'CSE');
  db.close();
  cleanup();
  console.log('  PASS: getCurrentState');
}

function testResolveIdentity() {
  const db = freshDb();
  const kg = require('./lib/knowledge-graph');
  const person = kg.createEntity(db, { entityType: 'person', canonicalName: 'Keshon Bowman' });
  kg.addIdentity(db, { entityId: person.id, source: 'slack', externalId: 'U04ABC123' });
  kg.addIdentity(db, { entityId: person.id, source: 'email', externalId: 'faramir@co.com' });

  assert.strictEqual(kg.resolveIdentity(db, 'slack', 'U04ABC123'), person.id);
  assert.strictEqual(kg.resolveIdentity(db, 'email', 'faramir@co.com'), person.id);
  assert.strictEqual(kg.resolveIdentity(db, 'slack', 'UNKNOWN'), null);
  db.close();
  cleanup();
  console.log('  PASS: resolveIdentity');
}

function testInsertRawMessage() {
  const db = freshDb();
  const kg = require('./lib/knowledge-graph');
  const msg = kg.insertRawMessage(db, {
    source: 'slack',
    sourceId: 'C123:1234567890.123456',
    channelId: 'C123',
    channelName: 'iops-dw',
    authorId: null,
    authorName: 'Kinski Wu',
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
  const kg = require('./lib/knowledge-graph');
  kg.createEntity(db, { entityType: 'decision', canonicalName: 'Use PSGs' });
  kg.createEntity(db, { entityType: 'action_item', canonicalName: 'Map profiles' });
  kg.createEntity(db, { entityType: 'person', canonicalName: 'Kinski Wu' });

  const workEntities = kg.getActiveEntities(db, { types: ['decision', 'action_item'] });
  assert.strictEqual(workEntities.length, 2);

  const all = kg.getActiveEntities(db);
  assert.strictEqual(all.length, 3);
  db.close();
  cleanup();
  console.log('  PASS: getActiveEntities');
}

function testInsertRawMessageDedup() {
  const db = freshDb();
  const kg = require('./lib/knowledge-graph');
  const now = Math.floor(Date.now() / 1000);

  const msg1 = kg.insertRawMessage(db, {
    source: 'slack', sourceId: 'C123:111', channelId: 'C123',
    content: 'first', occurredAt: now
  });
  assert.ok(msg1.id);

  // Same source+sourceId — should return existing, not throw
  const msg2 = kg.insertRawMessage(db, {
    source: 'slack', sourceId: 'C123:111', channelId: 'C123',
    content: 'duplicate', occurredAt: now
  });
  assert.strictEqual(msg2.id, msg1.id, 'Should return same message on dedup');

  const count = db.prepare('SELECT count(*) as c FROM raw_messages').get();
  assert.strictEqual(count.c, 1, 'Should not create duplicate raw_messages');

  db.close();
  cleanup();
  console.log('  PASS: insertRawMessage dedup');
}

function testGetUnextractedAndMarkExtracted() {
  const db = freshDb();
  const kg = require('./lib/knowledge-graph');
  const now = Math.floor(Date.now() / 1000);

  kg.insertRawMessage(db, { source: 'slack', sourceId: 'C1:1', channelId: 'C1', content: 'msg1', occurredAt: now });
  kg.insertRawMessage(db, { source: 'slack', sourceId: 'C1:2', channelId: 'C1', content: 'msg2', occurredAt: now + 1 });
  kg.insertRawMessage(db, { source: 'slack', sourceId: 'C1:3', channelId: 'C1', content: 'msg3', occurredAt: now + 2 });

  const unextracted = kg.getUnextractedMessages(db, { limit: 2 });
  assert.strictEqual(unextracted.length, 2);

  kg.markExtracted(db, unextracted.map(m => m.id));

  const remaining = kg.getUnextractedMessages(db);
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].content, 'msg3');

  db.close();
  cleanup();
  console.log('  PASS: getUnextracted + markExtracted');
}

function testDeactivateEntity() {
  const db = freshDb();
  const kg = require('./lib/knowledge-graph');
  const entity = kg.createEntity(db, { entityType: 'action_item', canonicalName: 'Old task' });
  assert.strictEqual(entity.is_active, 1);

  kg.deactivateEntity(db, entity.id);

  const updated = kg.getEntity(db, entity.id);
  assert.strictEqual(updated.is_active, 0);

  // Should not appear in active entities
  const active = kg.getActiveEntities(db, { types: ['action_item'] });
  assert.strictEqual(active.length, 0);

  db.close();
  cleanup();
  console.log('  PASS: deactivateEntity');
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
testInsertRawMessageDedup();
testGetUnextractedAndMarkExtracted();
testDeactivateEntity();
console.log('All knowledge-graph tests passed.');
