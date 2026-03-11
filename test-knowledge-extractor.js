'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase } = require('./lib/org-memory-db');
const kg = require('./lib/knowledge-graph');

function tmpDb() {
  const p = path.join(os.tmpdir(), `test-extractor-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = initDatabase(p);
  return { db, path: p };
}

function cleanup(dbPath) {
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
}

// --- Test: parseAiResponse handles well-formed JSON array ---
{
  const { parseAiResponse } = require('./knowledge-extractor');

  const aiText = `\`\`\`json
[
  {"entity": "Alice", "attribute": "committed_to", "value": "Send the report by Friday", "fact_type": "event", "confidence": 0.9, "source_message_id": "msg-1"},
  {"entity": "Bob", "attribute": "status_update", "value": "Working on IAM integration", "fact_type": "state", "confidence": 0.8, "source_message_id": "msg-2"}
]
\`\`\``;

  const facts = parseAiResponse(aiText);
  assert.strictEqual(facts.length, 2);
  assert.strictEqual(facts[0].entity, 'Alice');
  assert.strictEqual(facts[0].attribute, 'committed_to');
  assert.strictEqual(facts[1].fact_type, 'state');
  console.log('PASS: parseAiResponse handles well-formed JSON array');
}

// --- Test: parseAiResponse handles bare JSON (no code fence) ---
{
  const { parseAiResponse } = require('./knowledge-extractor');

  const aiText = '[{"entity": "Carol", "attribute": "decided", "value": "Use Terraform", "fact_type": "event", "confidence": 0.7, "source_message_id": "msg-3"}]';
  const facts = parseAiResponse(aiText);
  assert.strictEqual(facts.length, 1);
  assert.strictEqual(facts[0].entity, 'Carol');
  console.log('PASS: parseAiResponse handles bare JSON');
}

// --- Test: parseAiResponse returns empty array for invalid JSON ---
{
  const { parseAiResponse } = require('./knowledge-extractor');

  assert.deepStrictEqual(parseAiResponse('not json'), []);
  assert.deepStrictEqual(parseAiResponse(''), []);
  assert.deepStrictEqual(parseAiResponse(null), []);
  console.log('PASS: parseAiResponse returns empty array for invalid input');
}

// --- Test: parseAiResponse filters out facts below confidence threshold ---
{
  const { parseAiResponse } = require('./knowledge-extractor');

  const aiText = JSON.stringify([
    { entity: 'A', attribute: 'committed_to', value: 'x', fact_type: 'event', confidence: 0.9, source_message_id: 'm1' },
    { entity: 'B', attribute: 'decided', value: 'y', fact_type: 'event', confidence: 0.3, source_message_id: 'm2' },
    { entity: 'C', attribute: 'role', value: 'z', fact_type: 'state', confidence: 0.6, source_message_id: 'm3' },
  ]);

  const facts = parseAiResponse(aiText, { minConfidence: 0.5 });
  assert.strictEqual(facts.length, 2);
  assert.strictEqual(facts[0].entity, 'A');
  assert.strictEqual(facts[1].entity, 'C');
  console.log('PASS: parseAiResponse filters below confidence threshold');
}

// --- Test: parseAiResponse validates required fields ---
{
  const { parseAiResponse } = require('./knowledge-extractor');

  const aiText = JSON.stringify([
    { entity: 'Good', attribute: 'committed_to', value: 'do thing', fact_type: 'event', confidence: 0.9, source_message_id: 'm1' },
    { entity: '', attribute: 'committed_to', value: 'do thing', fact_type: 'event', confidence: 0.9, source_message_id: 'm2' },
    { entity: 'Missing attr', value: 'do thing', fact_type: 'event', confidence: 0.9, source_message_id: 'm3' },
    { entity: 'Bad type', attribute: 'committed_to', value: 'do thing', fact_type: 'bogus', confidence: 0.9, source_message_id: 'm4' },
  ]);

  const facts = parseAiResponse(aiText);
  assert.strictEqual(facts.length, 1);
  assert.strictEqual(facts[0].entity, 'Good');
  console.log('PASS: parseAiResponse validates required fields');
}

// --- Test: buildBatches groups by channel, respects batch size ---
{
  const { buildBatches } = require('./knowledge-extractor');

  const messages = [
    { id: '1', channel_name: 'general', content: 'msg1', author_name: 'A', occurred_at: 100 },
    { id: '2', channel_name: 'general', content: 'msg2', author_name: 'B', occurred_at: 200 },
    { id: '3', channel_name: 'random', content: 'msg3', author_name: 'C', occurred_at: 300 },
    { id: '4', channel_name: 'general', content: 'msg4', author_name: 'A', occurred_at: 400 },
  ];

  const batches = buildBatches(messages, { batchSize: 2 });

  // Should have batches grouped by channel, split by size
  assert.ok(batches.length >= 2, `expected >=2 batches, got ${batches.length}`);

  // All messages accounted for
  const allIds = batches.flatMap(b => b.messages.map(m => m.id));
  assert.strictEqual(allIds.length, 4);

  // Channel grouping: 'general' messages should be together (or split into size-limited batches)
  const generalBatches = batches.filter(b => b.channel === 'general');
  const generalIds = generalBatches.flatMap(b => b.messages.map(m => m.id));
  assert.ok(generalIds.includes('1'));
  assert.ok(generalIds.includes('2'));
  assert.ok(generalIds.includes('4'));

  console.log('PASS: buildBatches groups by channel and respects batch size');
}

// --- Test: storeFacts resolves entities and calls upsertFact ---
{
  const { db, path: p } = tmpDb();
  const { storeFacts } = require('./knowledge-extractor');

  try {
    // Create a person entity with identity
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice Test' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_ALICE', displayName: 'Alice Test' });

    // Insert a raw message so we have a source_message_id
    kg.insertRawMessage(db, {
      source: 'slack', sourceId: 'test:1', channelName: 'general',
      authorExtId: 'U_ALICE', authorId: entity.id, authorName: 'Alice Test',
      content: 'I will send the report by Friday', occurredAt: 1000,
    });
    const msg = db.prepare("SELECT id FROM raw_messages WHERE source_id = 'test:1'").get();

    const parsedFacts = [
      { entity: 'Alice Test', attribute: 'committed_to', value: 'Send the report by Friday', fact_type: 'event', confidence: 0.9, source_message_id: msg.id },
    ];

    const result = storeFacts(db, parsedFacts);
    assert.strictEqual(result.stored, 1);
    assert.strictEqual(result.skipped, 0);

    // Verify fact was stored
    const facts = kg.getEntityFacts(db, entity.id, { attribute: 'committed_to' });
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0].value, 'Send the report by Friday');

    console.log('PASS: storeFacts resolves entities and stores facts');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: storeFacts creates new entity for unknown person ---
{
  const { db, path: p } = tmpDb();
  const { storeFacts } = require('./knowledge-extractor');

  try {
    const parsedFacts = [
      { entity: 'Unknown Person', attribute: 'status_update', value: 'Working on project X', fact_type: 'state', confidence: 0.8, source_message_id: null },
    ];

    const result = storeFacts(db, parsedFacts);
    assert.strictEqual(result.stored, 1);

    // New entity should exist
    const entity = db.prepare("SELECT * FROM entities WHERE canonical_name = 'Unknown Person'").get();
    assert.ok(entity, 'should have created entity for unknown person');
    assert.strictEqual(entity.entity_type, 'person');

    const facts = kg.getEntityFacts(db, entity.id);
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0].value, 'Working on project X');

    console.log('PASS: storeFacts creates new entity for unknown person');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: isLikelyBot detects known bot patterns ---
{
  const { isLikelyBot } = require('./knowledge-extractor');

  assert.strictEqual(isLikelyBot({ author_name: 'Assist', author_ext_id: 'U0664HM0RR9' }), true);
  assert.strictEqual(isLikelyBot({ author_name: 'Slackbot', author_ext_id: 'USLACKBOT' }), true);
  assert.strictEqual(isLikelyBot({ author_name: 'Jellyfish', author_ext_id: 'UJELLY' }), true);
  assert.strictEqual(isLikelyBot({ author_name: 'Bill Price', author_ext_id: 'U041' }), false);
  assert.strictEqual(isLikelyBot({ author_name: null, author_ext_id: null }), false);
  console.log('PASS: isLikelyBot detects known bot patterns');
}

// --- Test: collectCommitments returns digest items for open event facts ---
{
  const { db, path: p } = tmpDb();
  const { collectCommitments } = require('./lib/digest-collectors');

  try {
    const now = Math.floor(Date.now() / 1000);

    // Create entity with open commitment
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Test Person' });
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'committed_to',
      value: 'Send the TPS report',
      factType: 'event',
      now: now - (2 * 86400), // 2 days ago
    });

    // Create stale action item (10 days old)
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'asked_to',
      value: 'Review security policy',
      factType: 'event',
      now: now - (10 * 86400), // 10 days old — stale
    });

    // Create state fact (should NOT appear — only events)
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'status_update',
      value: 'Working on something',
      factType: 'state',
      now: now - 86400,
    });

    const items = collectCommitments(db);
    assert.strictEqual(items.length, 2, 'should return 2 items (only event facts)');

    // Fresh commitment should be normal priority
    const fresh = items.find(i => i.observation.includes('Send the TPS report'));
    assert.ok(fresh, 'should include fresh commitment');
    assert.strictEqual(fresh.priority, 'normal');
    assert.strictEqual(fresh.collector, 'commitments');

    // Stale item should be high priority
    const stale = items.find(i => i.observation.includes('Review security policy'));
    assert.ok(stale, 'should include stale action item');
    assert.strictEqual(stale.priority, 'high');

    console.log('PASS: collectCommitments returns digest items for open event facts');
  } finally {
    db.close();
    cleanup(p);
  }
}

console.log('\nAll knowledge-extractor tests passed.');
