'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase } = require('./lib/org-memory-db');
const kg = require('./lib/knowledge-graph');

function tmpDb() {
  const p = path.join(os.tmpdir(), `test-crack-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = initDatabase(p);
  return { db, path: p };
}

function cleanup(dbPath) {
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
}

// ──────────────────────────────────────────────────────────────────────────
// Test 1: findCracks returns stale commitments ranked by severity
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const { findCracks } = require('./lib/crack-finder');
    const now = Math.floor(Date.now() / 1000);

    // Alice: 3 stale commitments (oldest 15 days), 0 resolved → high severity
    const alice = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });
    for (let i = 0; i < 3; i++) {
      kg.upsertFact(db, {
        entityId: alice.id, attribute: 'committed_to',
        value: `Task ${i}`, factType: 'event', now: now - 86400 * (15 - i),
      });
    }

    // Bob: 1 fresh commitment (2 days old), 2 resolved → low severity
    const bob = kg.createEntity(db, { entityType: 'person', canonicalName: 'Bob' });
    kg.upsertFact(db, {
      entityId: bob.id, attribute: 'asked_to',
      value: 'Fresh task', factType: 'event', now: now - 86400 * 2,
    });
    const resolved1 = kg.upsertFact(db, {
      entityId: bob.id, attribute: 'committed_to',
      value: 'Done task 1', factType: 'event', now: now - 86400 * 10,
    });
    kg.resolveEvent(db, {
      factId: resolved1.id, entityId: bob.id, attribute: 'committed_to',
      resolution: 'completed', confidence: 1.0, rationale: 'test',
    });
    const resolved2 = kg.upsertFact(db, {
      entityId: bob.id, attribute: 'committed_to',
      value: 'Done task 2', factType: 'event', now: now - 86400 * 8,
    });
    kg.resolveEvent(db, {
      factId: resolved2.id, entityId: bob.id, attribute: 'committed_to',
      resolution: 'completed', confidence: 1.0, rationale: 'test',
    });

    // Carol: 0 commitments → should not appear
    kg.createEntity(db, { entityType: 'person', canonicalName: 'Carol' });

    const cracks = findCracks(db, { staleDays: 7 });

    assert.ok(Array.isArray(cracks), 'findCracks should return an array');
    assert.ok(cracks.length >= 1, 'Should find at least Alice');

    // Alice should rank higher than Bob (more stale, 0% resolved)
    const aliceCrack = cracks.find(c => c.entityName === 'Alice');
    const bobCrack = cracks.find(c => c.entityName === 'Bob');
    assert.ok(aliceCrack, 'Alice should appear in cracks');
    assert.ok(aliceCrack.staleCount >= 3, 'Alice should have 3+ stale items');
    assert.ok(aliceCrack.oldestDays >= 14, 'Alice oldest should be ~15 days');
    assert.strictEqual(aliceCrack.resolvedCount, 0);

    if (bobCrack) {
      assert.ok(cracks.indexOf(aliceCrack) < cracks.indexOf(bobCrack),
        'Alice should rank before Bob (higher severity)');
    }

    // Carol should not appear (no commitments)
    assert.strictEqual(cracks.find(c => c.entityName === 'Carol'), undefined);

    console.log('PASS: findCracks returns stale commitments ranked by severity');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 2: findCracks respects monitored-only filter
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const { findCracks } = require('./lib/crack-finder');
    const now = Math.floor(Date.now() / 1000);

    const monitored = kg.createEntity(db, { entityType: 'person', canonicalName: 'Monitored' });
    db.prepare('UPDATE entities SET monitored = 1 WHERE id = ?').run(monitored.id);
    kg.upsertFact(db, {
      entityId: monitored.id, attribute: 'committed_to',
      value: 'Stale thing', factType: 'event', now: now - 86400 * 10,
    });

    const unmonitored = kg.createEntity(db, { entityType: 'person', canonicalName: 'Unmonitored' });
    kg.upsertFact(db, {
      entityId: unmonitored.id, attribute: 'committed_to',
      value: 'Also stale', factType: 'event', now: now - 86400 * 10,
    });

    const all = findCracks(db, { staleDays: 7 });
    assert.strictEqual(all.length, 2, 'Without filter, both should appear');

    const filtered = findCracks(db, { staleDays: 7, monitoredOnly: true });
    assert.strictEqual(filtered.length, 1, 'With filter, only monitored');
    assert.strictEqual(filtered[0].entityName, 'Monitored');

    console.log('PASS: findCracks respects monitored-only filter');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test 3: findCracks returns topStaleItems with source info
// ──────────────────────────────────────────────────────────────────────────
{
  const { db, path: p } = tmpDb();
  try {
    const { findCracks } = require('./lib/crack-finder');
    const now = Math.floor(Date.now() / 1000);

    const person = kg.createEntity(db, { entityType: 'person', canonicalName: 'Dave' });
    for (let i = 0; i < 5; i++) {
      kg.upsertFact(db, {
        entityId: person.id, attribute: 'committed_to',
        value: `Commitment ${i}`, factType: 'event', now: now - 86400 * (20 - i),
      });
    }

    const cracks = findCracks(db, { staleDays: 7, topN: 3 });
    const dave = cracks.find(c => c.entityName === 'Dave');
    assert.ok(dave, 'Dave should appear');
    assert.ok(dave.topStaleItems.length <= 3, 'Should cap at topN=3');
    assert.ok(dave.topStaleItems[0].ageDays >= dave.topStaleItems[1].ageDays,
      'Stale items should be sorted oldest first');
    assert.ok(dave.topStaleItems[0].value, 'Items should have value');
    assert.ok(dave.topStaleItems[0].attribute, 'Items should have attribute');

    console.log('PASS: findCracks returns topStaleItems capped at topN');
  } finally {
    db.close();
    cleanup(p);
  }
}

console.log('\nAll crack-finder tests passed.');
