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

// --- Test: storeFacts uses deferred attribution even for known entities ---
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

    // Fact should be stored with deferred attribution (entity_id = NULL, mentioned_name set)
    const fact = db.prepare(
      "SELECT * FROM facts WHERE mentioned_name = 'Alice Test' AND attribute = 'committed_to'"
    ).get();
    assert.ok(fact, 'fact should exist with mentioned_name');
    assert.strictEqual(fact.entity_id, null, 'entity_id should be NULL (deferred)');
    assert.strictEqual(fact.value, 'Send the report by Friday');

    console.log('PASS: storeFacts uses deferred attribution even for known entities');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: storeFacts does NOT create entity for unknown person (deferred) ---
{
  const { db, path: p } = tmpDb();
  const { storeFacts } = require('./knowledge-extractor');

  try {
    const parsedFacts = [
      { entity: 'Unknown Person', attribute: 'status_update', value: 'Working on project X', fact_type: 'state', confidence: 0.8, source_message_id: null },
    ];

    const result = storeFacts(db, parsedFacts);
    assert.strictEqual(result.stored, 1);

    // No entity should be created
    const entity = db.prepare("SELECT * FROM entities WHERE canonical_name = 'Unknown Person'").get();
    assert.strictEqual(entity, undefined, 'should NOT create entity for unknown person');

    // Fact should exist with mentioned_name
    const fact = db.prepare(
      "SELECT * FROM facts WHERE mentioned_name = 'Unknown Person'"
    ).get();
    assert.ok(fact, 'fact should exist with mentioned_name');
    assert.strictEqual(fact.entity_id, null);
    assert.strictEqual(fact.value, 'Working on project X');

    console.log('PASS: storeFacts does NOT create entity for unknown person (deferred)');
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
  assert.strictEqual(isLikelyBot({ author_name: 'Aragorn King', author_ext_id: 'U041' }), false);
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

// ──────────────────────────────────────────────────────────────────────────
// Partial index test — verify Phase 2 performance indexes exist in schema
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const indexNames = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='facts'"
    ).all().map(r => r.name);

    assert.ok(
      indexNames.includes('idx_facts_current_state'),
      `Expected partial index idx_facts_current_state, got: ${indexNames.join(', ')}`
    );
    assert.ok(
      indexNames.includes('idx_facts_open_events'),
      `Expected partial index idx_facts_open_events, got: ${indexNames.join(', ')}`
    );
    console.log('PASS: partial indexes idx_facts_current_state and idx_facts_open_events exist');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 1: resolveEvent() creates a resolution-evidence row with resolves_fact_id
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });
    const original = kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'committed_to',
      value: 'write search spec by Friday',
      factType: 'event',
    });
    assert.strictEqual(original.resolution, 'open', 'New event fact should start as open');

    kg.resolveEvent(db, {
      factId: original.id,
      entityId: entity.id,
      attribute: 'committed_to',
      resolution: 'completed',
      confidence: 0.95,
      sourceMessageId: 'msg-evidence-001',
      rationale: 'Alice said "spec is done and shared"',
    });

    // Original fact should be marked completed
    const resolved = db.prepare('SELECT * FROM facts WHERE id = ?').get(original.id);
    assert.strictEqual(resolved.resolution, 'completed', 'Original fact should be marked completed');
    assert.ok(resolved.resolved_at, 'Original fact should have resolved_at timestamp');

    // A new evidence row should exist with resolves_fact_id
    const evidence = db.prepare(
      'SELECT * FROM facts WHERE resolves_fact_id = ?'
    ).get(original.id);
    assert.ok(evidence, 'Resolution evidence row should exist');
    assert.strictEqual(evidence.entity_id, entity.id);
    assert.strictEqual(evidence.resolves_fact_id, original.id);
    assert.strictEqual(evidence.rationale, 'Alice said "spec is done and shared"');
    assert.strictEqual(evidence.source_message_id, 'msg-evidence-001');
    assert.ok(evidence.confidence >= 0.95, 'Evidence should preserve confidence');

    console.log('PASS: resolveEvent creates evidence row with resolves_fact_id');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 2: storeFacts() routes facts with `resolves` field to resolveEvent()
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Bob' });
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'asked_to',
      value: 'review the PR',
      factType: 'event',
    });

    const { storeFacts } = require('./knowledge-extractor');
    const result = storeFacts(db, [{
      entity: 'Bob',
      attribute: 'completion_signal',
      value: 'PR reviewed and approved',
      fact_type: 'event',
      confidence: 0.93,
      source_message_id: 'msg-002',
      resolves: 'asked_to:review the PR',
    }]);

    assert.strictEqual(result.stored, 1, 'Resolution fact should be stored');

    // Original should be resolved
    const original = db.prepare(
      "SELECT * FROM facts WHERE entity_id = ? AND attribute = 'asked_to' AND value = 'review the PR'"
    ).get(entity.id);
    assert.strictEqual(original.resolution, 'completed', 'Original should be resolved');

    // Evidence row should exist
    const evidence = db.prepare(
      'SELECT * FROM facts WHERE resolves_fact_id = ?'
    ).get(original.id);
    assert.ok(evidence, 'Evidence row should exist from storeFacts routing');

    // The completion_signal fact uses deferred attribution
    const signal = db.prepare(
      "SELECT * FROM facts WHERE attribute = 'completion_signal' AND mentioned_name = 'Bob'"
    ).get();
    assert.ok(signal, 'completion_signal fact should exist with mentioned_name');
    assert.strictEqual(signal.entity_id, null, 'completion_signal should use deferred attribution');

    console.log('PASS: storeFacts routes facts with resolves field to resolveEvent');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 3: storeFacts() without resolves — deferred attribution
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const { storeFacts } = require('./knowledge-extractor');
    const result = storeFacts(db, [{
      entity: 'Carol',
      attribute: 'committed_to',
      value: 'attend standup Monday',
      fact_type: 'event',
      confidence: 0.88,
    }]);

    assert.strictEqual(result.stored, 1);
    assert.strictEqual(result.skipped, 0);

    const fact = db.prepare(
      "SELECT * FROM facts WHERE attribute = 'committed_to' AND value = 'attend standup Monday'"
    ).get();
    assert.strictEqual(fact.resolution, 'open', 'Fact without resolves should be open');
    assert.strictEqual(fact.resolves_fact_id, null, 'No resolves_fact_id on normal facts');
    assert.strictEqual(fact.entity_id, null, 'Should use deferred attribution');
    assert.strictEqual(fact.mentioned_name, 'Carol', 'Should store mentioned_name');

    console.log('PASS: storeFacts without resolves — deferred attribution');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 4: resolveEvent() is a no-op when target fact does not exist
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Nobody' });

    // Should not throw, and should not create any rows
    kg.resolveEvent(db, {
      factId: 'nonexistent-fact-id',
      entityId: entity.id,
      attribute: 'committed_to',
      resolution: 'completed',
      confidence: 0.9,
      sourceMessageId: 'msg-x',
      rationale: 'phantom',
    });

    const evidence = db.prepare(
      "SELECT * FROM facts WHERE resolves_fact_id = 'nonexistent-fact-id'"
    ).get();
    assert.strictEqual(evidence, undefined, 'No evidence row for nonexistent target');

    console.log('PASS: resolveEvent is a no-op when target fact does not exist');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 5: Resolved commitment disappears from collectCommitments()
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const { collectCommitments } = require('./lib/digest-collectors');
    const { storeFacts } = require('./knowledge-extractor');

    // Create entity and commitment with entity_id set (simulates post-sweep state)
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Diana' });
    const ts = Math.floor(Date.now() / 1000) - 86400 * 10; // 10 days ago
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'committed_to',
      value: 'finish onboarding doc',
      factType: 'event',
      now: ts,
    });

    // Step 1: commitment should appear in digest (requires entity_id for JOIN)
    const before = collectCommitments(db);
    const item = before.find(i => i.observation && i.observation.includes('finish onboarding doc'));
    assert.ok(item, 'Open commitment should appear in collectCommitments');

    // Step 2: resolve via storeFacts (finds commitment by entity canonical_name lookup)
    storeFacts(db, [{
      entity: 'Diana',
      attribute: 'completion_signal',
      value: 'onboarding doc shared with team',
      fact_type: 'event',
      confidence: 0.95,
      source_message_id: 'msg-resolve-diana',
      resolves: 'committed_to:finish onboarding doc',
    }]);

    // Step 3: commitment should no longer appear
    const after = collectCommitments(db);
    const gone = after.find(i => i.observation && i.observation.includes('finish onboarding doc'));
    assert.strictEqual(gone, undefined, 'Resolved commitment should NOT appear in collectCommitments');

    console.log('PASS: resolved commitment disappears from collectCommitments');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 6: getOpenCommitmentsContext returns formatted context for batch authors
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const { getOpenCommitmentsContext } = require('./knowledge-extractor');

    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Eve' });
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'committed_to',
      value: 'write quarterly report',
      factType: 'event',
    });
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'asked_to',
      value: 'review budget proposal',
      factType: 'event',
    });

    // Messages from Eve — should get her open commitments
    const context = getOpenCommitmentsContext(db, [
      { author_name: 'Eve', content: 'done with the report' },
    ]);
    assert.ok(context.includes('OPEN COMMITMENTS'), 'Context should include header');
    assert.ok(context.includes('write quarterly report'), 'Should include committed_to');
    assert.ok(context.includes('review budget proposal'), 'Should include asked_to');
    assert.ok(context.includes('Eve'), 'Should include entity name');

    // Messages from unknown author — should get empty context
    const empty = getOpenCommitmentsContext(db, [
      { author_name: 'Unknown', content: 'hello' },
    ]);
    assert.strictEqual(empty, '', 'No open commitments for unknown author');

    console.log('PASS: getOpenCommitmentsContext returns formatted context for batch authors');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Deferred Attribution (el6.1) — schema: mentioned_name + nullable entity_id
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    const now = Math.floor(Date.now() / 1000);
    // Insert a fact with entity_id = NULL and mentioned_name set
    db.prepare(`
      INSERT INTO facts (id, entity_id, mentioned_name, attribute, value, fact_type, valid_from, extracted_at)
      VALUES ('test-null-eid', NULL, 'Alice Test', 'committed_to', 'do something', 'event', ?, ?)
    `).run(now, now);

    const row = db.prepare('SELECT * FROM facts WHERE id = ?').get('test-null-eid');
    assert.strictEqual(row.entity_id, null, 'entity_id should be NULL');
    assert.strictEqual(row.mentioned_name, 'Alice Test', 'mentioned_name should be stored');

    console.log('PASS: facts table supports mentioned_name and nullable entity_id');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Deferred Attribution (el6.1) — entity_aliases table exists
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entity_aliases'"
    ).all();
    assert.strictEqual(tables.length, 1, 'entity_aliases table should exist');

    const cols = db.pragma('table_info(entity_aliases)');
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('id'), 'should have id column');
    assert.ok(colNames.includes('entity_id'), 'should have entity_id column');
    assert.ok(colNames.includes('alias'), 'should have alias column');
    assert.ok(colNames.includes('alias_source'), 'should have alias_source column');

    console.log('PASS: entity_aliases table exists with correct schema');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Deferred Attribution (el6.1) — NFC normalization in addIdentity
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Test' });
    // NFD form of "é" (e + combining accent)
    const nfdName = 'Ren\u0065\u0301e';
    const nfcName = 'Ren\u00E9e';

    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_TEST', displayName: nfdName });

    const row = db.prepare('SELECT display_name FROM identity_map WHERE entity_id = ?').get(entity.id);
    assert.strictEqual(row.display_name, nfcName, 'display_name should be NFC-normalized');

    console.log('PASS: addIdentity NFC-normalizes display_name');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Deferred Attribution (el6.1) — seedAliases populates from identity_map
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Gimli Stone' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_DAN', displayName: 'Gimli Stone' });
    kg.addIdentity(db, { entityId: entity.id, source: 'jira', externalId: 'dan-jira', displayName: 'Gimli Stone' });

    kg.seedAliases(db);

    const aliases = db.prepare('SELECT * FROM entity_aliases WHERE entity_id = ?').all(entity.id);
    assert.ok(aliases.length >= 2, `should have at least 2 aliases, got ${aliases.length}`);

    const aliasValues = aliases.map(a => a.alias);
    assert.ok(aliasValues.includes('Gimli Stone'), 'should include canonical_name / display_name');
    assert.ok(aliasValues.includes('Gimli Stone'), 'should include display_name from jira');

    console.log('PASS: seedAliases populates from identity_map display_name');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Deferred Attribution (el6.1) — storeFacts uses deferred attribution
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  const { storeFacts } = require('./knowledge-extractor');

  try {
    const parsedFacts = [
      { entity: 'Unknown Person', attribute: 'committed_to', value: 'finish the report', fact_type: 'event', confidence: 0.9, source_message_id: null },
    ];

    const result = storeFacts(db, parsedFacts);
    assert.strictEqual(result.stored, 1);

    // Should NOT have created a new entity
    const entities = db.prepare("SELECT * FROM entities WHERE canonical_name = 'Unknown Person'").all();
    assert.strictEqual(entities.length, 0, 'should NOT create entity for unknown person');

    // Fact should have entity_id = NULL and mentioned_name set
    const fact = db.prepare("SELECT * FROM facts WHERE mentioned_name = 'Unknown Person'").get();
    assert.ok(fact, 'fact should exist with mentioned_name');
    assert.strictEqual(fact.entity_id, null, 'entity_id should be NULL');
    assert.strictEqual(fact.mentioned_name, 'Unknown Person');

    console.log('PASS: storeFacts uses deferred attribution (no entity creation)');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Deferred Attribution (el6.1) — storeFacts NFC-normalizes mentioned_name
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  const { storeFacts } = require('./knowledge-extractor');

  try {
    const nfdName = 'Ren\u0065\u0301e';
    const nfcName = 'Ren\u00E9e';

    storeFacts(db, [
      { entity: nfdName, attribute: 'decided', value: 'use NFC', fact_type: 'event', confidence: 0.9 },
    ]);

    const fact = db.prepare("SELECT mentioned_name FROM facts WHERE attribute = 'decided'").get();
    assert.strictEqual(fact.mentioned_name, nfcName, 'mentioned_name should be NFC-normalized');

    console.log('PASS: storeFacts NFC-normalizes mentioned_name');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Deferred Attribution (el6.1) — storeFacts deduplicates under null entity_id
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  const { storeFacts } = require('./knowledge-extractor');

  try {
    kg.insertRawMessage(db, {
      source: 'slack', sourceId: 'test:dedup', channelName: 'general',
      authorExtId: 'U_SOMEONE', authorName: 'Someone', content: 'I will do X', occurredAt: 1000,
    });
    const msg = db.prepare("SELECT id FROM raw_messages WHERE source_id = 'test:dedup'").get();

    const parsedFacts = [
      { entity: 'Someone', attribute: 'committed_to', value: 'do X', fact_type: 'event', confidence: 0.9, source_message_id: msg.id },
    ];

    // Store the same fact twice — should not create duplicate
    storeFacts(db, parsedFacts);
    storeFacts(db, parsedFacts);

    const facts = db.prepare(
      "SELECT * FROM facts WHERE mentioned_name = 'Someone' AND attribute = 'committed_to' AND value = 'do X'"
    ).all();
    assert.strictEqual(facts.length, 1, `should have exactly 1 fact, got ${facts.length}`);

    console.log('PASS: storeFacts deduplicates under null entity_id');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Deferred Attribution (el6.1) — storeFacts still resolves open commitments
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  const { storeFacts } = require('./knowledge-extractor');

  try {
    // Create an entity with an open commitment (pre-existing, has entity_id)
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Eve' });
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'asked_to',
      value: 'review the PR',
      factType: 'event',
    });

    // storeFacts with a resolves field — should still find and resolve the commitment
    storeFacts(db, [{
      entity: 'Eve',
      attribute: 'completion_signal',
      value: 'PR reviewed and approved',
      fact_type: 'event',
      confidence: 0.93,
      source_message_id: 'msg-resolve',
      resolves: 'asked_to:review the PR',
    }]);

    // Original should be resolved
    const original = db.prepare(
      "SELECT * FROM facts WHERE entity_id = ? AND attribute = 'asked_to' AND value = 'review the PR'"
    ).get(entity.id);
    assert.strictEqual(original.resolution, 'completed', 'Original commitment should be resolved');

    // The completion_signal fact should have entity_id = NULL (deferred)
    const signal = db.prepare(
      "SELECT * FROM facts WHERE attribute = 'completion_signal' AND value = 'PR reviewed and approved'"
    ).get();
    assert.ok(signal, 'completion_signal fact should exist');
    assert.strictEqual(signal.entity_id, null, 'completion_signal should use deferred attribution');
    assert.strictEqual(signal.mentioned_name, 'Eve', 'completion_signal should have mentioned_name');

    console.log('PASS: storeFacts resolves open commitments while using deferred attribution');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Deferred Attribution (el6.1) — getOpenCommitmentsContext includes deferred facts
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  const { getOpenCommitmentsContext, storeFacts } = require('./knowledge-extractor');

  try {
    // Store a deferred fact (entity_id = NULL, mentioned_name set)
    storeFacts(db, [{
      entity: 'Frank',
      attribute: 'committed_to',
      value: 'write the design doc',
      fact_type: 'event',
      confidence: 0.9,
    }]);

    // getOpenCommitmentsContext should find it by mentioned_name
    const context = getOpenCommitmentsContext(db, [
      { author_name: 'Frank', content: 'done with the doc' },
    ]);
    assert.ok(context.includes('write the design doc'),
      'should include deferred commitment in open commitments context');

    console.log('PASS: getOpenCommitmentsContext includes deferred facts');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Resolution Sweep (el6.2) — Path A: author attribution
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    // Set up: entity with identity and alias
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Gimli Stone' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_DAN', displayName: 'Gimli Stone' });
    kg.addAlias(db, { entityId: entity.id, alias: 'Gimli Stone', aliasSource: 'canonical_name' });

    // Insert a raw message from Daniel
    kg.insertRawMessage(db, {
      source: 'slack', sourceId: 'slack:msg1', channelName: 'general',
      authorExtId: 'U_DAN', authorName: 'Gimli Stone',
      content: 'I will ship the widget by Friday', occurredAt: 1000,
    });
    const msg = db.prepare("SELECT id FROM raw_messages WHERE source_id = 'slack:msg1'").get();

    // Store a deferred fact (entity_id = NULL) referencing the message
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'Gimli Stone',
      attribute: 'committed_to', value: 'ship the widget by Friday',
      factType: 'event', sourceMessageId: msg.id,
    });

    // Verify fact is unattributed
    const before = db.prepare('SELECT entity_id FROM facts WHERE mentioned_name = ?').get('Gimli Stone');
    assert.strictEqual(before.entity_id, null, 'pre-sweep: entity_id should be NULL');

    // Run sweep
    const { runSweep } = require('./knowledge-extractor');
    const metrics = runSweep(db);

    // Verify Path A attributed the fact
    const after = db.prepare('SELECT entity_id FROM facts WHERE mentioned_name = ?').get('Gimli Stone');
    assert.strictEqual(after.entity_id, entity.id, 'post-sweep: entity_id should be set via Path A');
    assert.strictEqual(metrics.sweepPathAMatched, 1);
    assert.strictEqual(metrics.sweepKnownNamesUnattributed, 0);

    console.log('PASS: sweep Path A attributes self-referencing facts via author_ext_id');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Resolution Sweep (el6.2) — Path A does NOT attribute non-self facts
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    // Alice is the author, but the fact is about Bob
    const alice = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });
    kg.addIdentity(db, { entityId: alice.id, source: 'slack', externalId: 'U_ALICE', displayName: 'Alice' });
    kg.addAlias(db, { entityId: alice.id, alias: 'Alice', aliasSource: 'canonical_name' });

    kg.insertRawMessage(db, {
      source: 'slack', sourceId: 'slack:msg2', channelName: 'general',
      authorExtId: 'U_ALICE', authorName: 'Alice',
      content: 'Bob said he would review the PR', occurredAt: 1000,
    });
    const msg = db.prepare("SELECT id FROM raw_messages WHERE source_id = 'slack:msg2'").get();

    // Fact about Bob, from Alice's message
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'Bob',
      attribute: 'committed_to', value: 'review the PR',
      factType: 'event', sourceMessageId: msg.id,
    });

    const { runSweep } = require('./knowledge-extractor');
    const metrics = runSweep(db);

    // Path A should NOT attribute — Bob doesn't match Alice's aliases
    const fact = db.prepare("SELECT entity_id FROM facts WHERE mentioned_name = 'Bob'").get();
    assert.strictEqual(fact.entity_id, null, 'should NOT attribute Bob to Alice');
    assert.strictEqual(metrics.sweepPathAMatched, 0);

    console.log('PASS: sweep Path A does not attribute non-self facts');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Resolution Sweep (el6.2) — Path B: mention attribution via alias table
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    // Set up entity with alias — no source message needed for Path B
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Aragorn King' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_BILL', displayName: 'Aragorn King' });
    kg.addAlias(db, { entityId: entity.id, alias: 'Aragorn King', aliasSource: 'canonical_name' });

    // Deferred fact without a source_message_id
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'Aragorn King',
      attribute: 'asked_to', value: 'review the budget',
      factType: 'event',
    });

    const { runSweep } = require('./knowledge-extractor');
    const metrics = runSweep(db);

    const fact = db.prepare("SELECT entity_id FROM facts WHERE mentioned_name = 'Aragorn King'").get();
    assert.strictEqual(fact.entity_id, entity.id, 'post-sweep: entity_id should be set via Path B');
    assert.strictEqual(metrics.sweepPathBMatched, 1);

    console.log('PASS: sweep Path B attributes via alias table');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Resolution Sweep (el6.2) — Path B case-insensitive matching
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Eowyn Rider' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_KEN', displayName: 'Eowyn Rider' });
    kg.addAlias(db, { entityId: entity.id, alias: 'Eowyn Rider', aliasSource: 'canonical_name' });

    // Mentioned name has different case
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'ken dominiec',
      attribute: 'decided', value: 'approve the plan',
      factType: 'event',
    });

    const { runSweep } = require('./knowledge-extractor');
    const metrics = runSweep(db);

    const fact = db.prepare("SELECT entity_id FROM facts WHERE mentioned_name = 'ken dominiec'").get();
    assert.strictEqual(fact.entity_id, entity.id, 'case-insensitive match should work');
    assert.strictEqual(metrics.sweepPathBMatched, 1);

    console.log('PASS: sweep Path B handles case-insensitive matching');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Resolution Sweep (el6.2) — unmatched names stay unattributed
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'Totally Unknown Person',
      attribute: 'committed_to', value: 'do something',
      factType: 'event',
    });

    const { runSweep } = require('./knowledge-extractor');
    const metrics = runSweep(db);

    const fact = db.prepare("SELECT entity_id FROM facts WHERE mentioned_name = 'Totally Unknown Person'").get();
    assert.strictEqual(fact.entity_id, null, 'unknown name should stay unattributed');
    assert.strictEqual(metrics.sweepPathAMatched, 0);
    assert.strictEqual(metrics.sweepPathBMatched, 0);
    assert.strictEqual(metrics.sweepAvailableNullFacts, 1);

    console.log('PASS: sweep leaves unmatched names unattributed');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Resolution Sweep (el6.2) — observable failure: knownNamesUnattributed
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    // Set up entity with alias
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Gandalf Grey' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_KINSKI', displayName: 'Gandalf Grey' });
    kg.addAlias(db, { entityId: entity.id, alias: 'Gandalf Grey', aliasSource: 'canonical_name' });

    // Deferred fact with a known name — but alias match fails because
    // the mentioned_name is a variant not in the alias table
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'K. Wu',
      attribute: 'committed_to', value: 'send the report',
      factType: 'event',
    });
    // Also a fact with exact alias match
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'Gandalf Grey',
      attribute: 'decided', value: 'use Terraform',
      factType: 'event',
    });

    const { runSweep } = require('./knowledge-extractor');
    const metrics = runSweep(db);

    // "Gandalf Grey" should be attributed (Path B), "K. Wu" should not
    assert.strictEqual(metrics.sweepPathBMatched, 1);
    // "K. Wu" has no alias → stays unattributed, but it's NOT a "known name"
    // (no alias exists for "K. Wu"), so knownNamesUnattributed = 0
    assert.strictEqual(metrics.sweepKnownNamesUnattributed, 0,
      'K. Wu is NOT a known alias, so should not count as known-unattributed');

    console.log('PASS: sweep observable failure signal counts correctly');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Resolution Sweep (el6.2) — idempotent re-run
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Geoff' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_G', displayName: 'Geoff' });
    kg.addAlias(db, { entityId: entity.id, alias: 'Geoff', aliasSource: 'canonical_name' });

    kg.upsertFact(db, {
      entityId: null, mentionedName: 'Geoff',
      attribute: 'committed_to', value: 'deploy by EOD',
      factType: 'event',
    });

    const { runSweep } = require('./knowledge-extractor');

    // First run: should attribute
    const m1 = runSweep(db);
    assert.strictEqual(m1.sweepPathBMatched, 1);

    // Second run: nothing to sweep (fact already has entity_id)
    const m2 = runSweep(db);
    assert.strictEqual(m2.sweepAvailableNullFacts, 0);
    assert.strictEqual(m2.sweepPathAMatched, 0);
    assert.strictEqual(m2.sweepPathBMatched, 0);

    console.log('PASS: sweep is idempotent on re-run');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Resolution Sweep (el6.2) — embedded in runExtraction
// ══════════════════════════════════════════════════════════════════════════
{
  const { db, path: p } = tmpDb();
  try {
    // Set up entity with alias
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'SweepTest' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_ST', displayName: 'SweepTest' });
    kg.addAlias(db, { entityId: entity.id, alias: 'SweepTest', aliasSource: 'canonical_name' });

    // Insert a raw message and mark it unextracted
    kg.insertRawMessage(db, {
      source: 'slack', sourceId: 'slack:sweep-test', channelName: 'general',
      authorExtId: 'U_ST', authorName: 'SweepTest',
      content: 'I will finalize the spec', occurredAt: 1000,
    });

    // Simulate what runExtraction does: storeFacts creates deferred facts
    const { storeFacts, runSweep } = require('./knowledge-extractor');
    storeFacts(db, [{
      entity: 'SweepTest',
      attribute: 'committed_to',
      value: 'finalize the spec',
      fact_type: 'event',
      confidence: 0.9,
      source_message_id: db.prepare("SELECT id FROM raw_messages WHERE source_id = 'slack:sweep-test'").get().id,
    }]);

    // Verify deferred before sweep
    const before = db.prepare("SELECT entity_id FROM facts WHERE mentioned_name = 'SweepTest'").get();
    assert.strictEqual(before.entity_id, null, 'pre-sweep: deferred');

    // Sweep should attribute via Path A (author_ext_id matches)
    const metrics = runSweep(db);
    assert.ok(metrics.sweepPathAMatched >= 1 || metrics.sweepPathBMatched >= 1,
      'sweep should attribute at least 1 fact');

    const after = db.prepare("SELECT entity_id FROM facts WHERE mentioned_name = 'SweepTest'").get();
    assert.strictEqual(after.entity_id, entity.id, 'post-sweep: attributed');

    console.log('PASS: sweep works end-to-end with storeFacts + runSweep');
  } finally {
    db.close();
    cleanup(p);
  }
}

console.log('\nAll knowledge-extractor tests passed.');
