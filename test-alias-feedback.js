'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase } = require('./lib/org-memory-db');
const kg = require('./lib/knowledge-graph');

function tmpDb() {
  const p = path.join(os.tmpdir(), `test-alias-fb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = initDatabase(p);
  return { db, path: p };
}

function cleanup(dbPath) {
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
}

// ======================================================================
// Schema: rejected_aliases table exists with correct columns
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='rejected_aliases'"
    ).all();
    assert.strictEqual(tables.length, 1, 'rejected_aliases table should exist');

    const cols = db.pragma('table_info(rejected_aliases)');
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('id'), 'should have id column');
    assert.ok(colNames.includes('entity_id'), 'should have entity_id column');
    assert.ok(colNames.includes('alias'), 'should have alias column');
    assert.ok(colNames.includes('rejected_at'), 'should have rejected_at column');
    assert.ok(colNames.includes('source_fact_id'), 'should have source_fact_id column');

    console.log('PASS: rejected_aliases table exists with correct schema');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// Schema: entity_aliases has confirmed_at column
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const cols = db.pragma('table_info(entity_aliases)');
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('confirmed_at'), 'entity_aliases should have confirmed_at column');

    console.log('PASS: entity_aliases has confirmed_at column');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// knowledge-graph: confirmAlias adds alias and attributes matching facts
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice Smith' });
    const now = Math.floor(Date.now() / 1000);

    // Create an unattributed fact with mentioned_name
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'A. Smith',
      attribute: 'committed_to', value: 'send the report',
      factType: 'event',
    });

    // A second unattributed fact with the same mentioned_name
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'A. Smith',
      attribute: 'decided', value: 'approve the budget',
      factType: 'event',
    });

    // Confirm the alias
    const result = kg.confirmAlias(db, {
      entityId: entity.id,
      mentionedName: 'A. Smith',
      sourceFactId: null,
    });

    // Alias should be stored
    const alias = db.prepare(
      "SELECT * FROM entity_aliases WHERE entity_id = ? AND alias = 'A. Smith'"
    ).get(entity.id);
    assert.ok(alias, 'alias should exist in entity_aliases');
    assert.strictEqual(alias.alias_source, 'user_confirmed');
    assert.ok(alias.confirmed_at, 'confirmed_at should be set');

    // Both matching facts should be attributed
    const facts = db.prepare(
      "SELECT * FROM facts WHERE mentioned_name = 'A. Smith'"
    ).all();
    for (const f of facts) {
      assert.strictEqual(f.entity_id, entity.id, `fact ${f.id} should be attributed`);
    }

    // Result should include count of attributed facts
    assert.strictEqual(result.attributedCount, 2, 'should report 2 attributed facts');

    console.log('PASS: confirmAlias adds alias and attributes matching facts');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// knowledge-graph: confirmAlias is idempotent (no error on re-confirm)
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Bob Jones' });

    kg.confirmAlias(db, { entityId: entity.id, mentionedName: 'B. Jones' });
    // Should not throw on re-confirm
    kg.confirmAlias(db, { entityId: entity.id, mentionedName: 'B. Jones' });

    const aliases = db.prepare(
      "SELECT * FROM entity_aliases WHERE entity_id = ? AND alias = 'B. Jones'"
    ).all(entity.id);
    assert.strictEqual(aliases.length, 1, 'should not create duplicate alias');

    console.log('PASS: confirmAlias is idempotent');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// knowledge-graph: rejectAlias records negative example
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Charlie Davis' });

    // Create an unattributed fact
    const fact = kg.upsertFact(db, {
      entityId: null, mentionedName: 'C. Davis',
      attribute: 'committed_to', value: 'fix the build',
      factType: 'event',
    });

    kg.rejectAlias(db, {
      entityId: entity.id,
      mentionedName: 'C. Davis',
      sourceFactId: fact.id,
    });

    const rejection = db.prepare(
      "SELECT * FROM rejected_aliases WHERE entity_id = ? AND alias = 'C. Davis'"
    ).get(entity.id);
    assert.ok(rejection, 'rejection should be recorded');
    assert.ok(rejection.rejected_at, 'rejected_at should be set');
    assert.strictEqual(rejection.source_fact_id, fact.id, 'should reference the fact');

    console.log('PASS: rejectAlias records negative example');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// knowledge-graph: rejectAlias is idempotent
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Dana White' });

    kg.rejectAlias(db, { entityId: entity.id, mentionedName: 'D. White' });
    kg.rejectAlias(db, { entityId: entity.id, mentionedName: 'D. White' });

    const rejections = db.prepare(
      "SELECT * FROM rejected_aliases WHERE entity_id = ? AND alias = 'D. White'"
    ).all(entity.id);
    assert.strictEqual(rejections.length, 1, 'should not create duplicate rejection');

    console.log('PASS: rejectAlias is idempotent');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// Sweep: confirmed alias causes automatic resolution on next sweep
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Eve Taylor' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_EVE', displayName: 'Eve Taylor' });

    // Confirm "E. Taylor" as an alias
    kg.confirmAlias(db, { entityId: entity.id, mentionedName: 'E. Taylor' });

    // Now insert a NEW unattributed fact with the same mentioned_name
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'E. Taylor',
      attribute: 'raised_risk', value: 'deployment timeline at risk',
      factType: 'event',
    });

    // Run sweep
    const { runSweep } = require('./knowledge-extractor');
    const metrics = runSweep(db);

    // The fact should be attributed via Path B (alias table lookup)
    const fact = db.prepare(
      "SELECT entity_id FROM facts WHERE mentioned_name = 'E. Taylor' AND attribute = 'raised_risk'"
    ).get();
    assert.strictEqual(fact.entity_id, entity.id, 'new fact should be auto-attributed after alias confirmation');
    assert.strictEqual(metrics.sweepPathBMatched, 1);

    console.log('PASS: confirmed alias causes automatic resolution on next sweep');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// Sweep: rejected alias prevents Path B attribution for that entity
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Frank Brown' });
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: 'U_FRANK', displayName: 'Frank Brown' });
    // Add alias that would match
    kg.addAlias(db, { entityId: entity.id, alias: 'F. Brown', aliasSource: 'canonical_name' });

    // Reject this alias for this entity
    kg.rejectAlias(db, { entityId: entity.id, mentionedName: 'F. Brown' });

    // Insert an unattributed fact with the rejected name
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'F. Brown',
      attribute: 'committed_to', value: 'finish the docs',
      factType: 'event',
    });

    // Run sweep
    const { runSweep } = require('./knowledge-extractor');
    const metrics = runSweep(db);

    // The fact should NOT be attributed (rejection overrides alias match)
    const fact = db.prepare(
      "SELECT entity_id FROM facts WHERE mentioned_name = 'F. Brown'"
    ).get();
    assert.strictEqual(fact.entity_id, null, 'rejected alias should prevent attribution');
    assert.strictEqual(metrics.sweepPathBMatched, 0);

    console.log('PASS: rejected alias prevents Path B attribution');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// Sweep: rejection is entity-specific (same name can match different entity)
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const frank = kg.createEntity(db, { entityType: 'person', canonicalName: 'Frank Brown' });
    const fred = kg.createEntity(db, { entityType: 'person', canonicalName: 'Fred Brown' });

    // "F. Brown" is rejected for Frank but confirmed for Fred
    kg.rejectAlias(db, { entityId: frank.id, mentionedName: 'F. Brown' });
    kg.confirmAlias(db, { entityId: fred.id, mentionedName: 'F. Brown' });

    // Insert unattributed fact
    kg.upsertFact(db, {
      entityId: null, mentionedName: 'F. Brown',
      attribute: 'asked_to', value: 'review the spec',
      factType: 'event',
    });

    // Run sweep
    const { runSweep } = require('./knowledge-extractor');
    const metrics = runSweep(db);

    // Should attribute to Fred (the only non-rejected match)
    const fact = db.prepare(
      "SELECT entity_id FROM facts WHERE mentioned_name = 'F. Brown'"
    ).get();
    assert.strictEqual(fact.entity_id, fred.id, 'should attribute to non-rejected entity');

    console.log('PASS: rejection is entity-specific');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// knowledge-graph: getAliases returns aliases for an entity
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Grace Lee' });
    kg.addAlias(db, { entityId: entity.id, alias: 'Grace Lee', aliasSource: 'canonical_name' });
    kg.confirmAlias(db, { entityId: entity.id, mentionedName: 'G. Lee' });

    const aliases = kg.getAliases(db, entity.id);
    assert.strictEqual(aliases.length, 2);
    const names = aliases.map(a => a.alias);
    assert.ok(names.includes('Grace Lee'));
    assert.ok(names.includes('G. Lee'));

    console.log('PASS: getAliases returns aliases for an entity');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// knowledge-graph: getRejectedAliases returns rejections for an entity
// ======================================================================
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Hank Moore' });
    kg.rejectAlias(db, { entityId: entity.id, mentionedName: 'H. Moore' });
    kg.rejectAlias(db, { entityId: entity.id, mentionedName: 'Hank M.' });

    const rejections = kg.getRejectedAliases(db, entity.id);
    assert.strictEqual(rejections.length, 2);
    const names = rejections.map(r => r.alias);
    assert.ok(names.includes('H. Moore'));
    assert.ok(names.includes('Hank M.'));

    console.log('PASS: getRejectedAliases returns rejections for an entity');
  } finally {
    db.close();
    cleanup(p);
  }
}

// ======================================================================
// Gateway HTTP tests: POST /api/entities/:id/aliases (confirm)
// ======================================================================

function httpRequest(port, method, urlPath, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path: urlPath, method, headers: {} };
    if (body) {
      const data = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(chunks) });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function clearGatewayCache() {
  for (const mod of ['./gateway', './lib/org-memory-db', './reticle-db']) {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
  }
}

async function testAliasEndpoints() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-alias-test-'));
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const reticleDbPath = path.join(tmpDir, 'reticle.db');

  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_DB_PATH = reticleDbPath;

  const omDb = initDatabase(orgMemDbPath);
  const now = Math.floor(Date.now() / 1000);

  // Create test entities and facts
  omDb.prepare(`INSERT INTO entities (id, entity_type, canonical_name, monitored, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('ent-alias-1', 'person', 'Alice Smith', 1, now);
  omDb.prepare(`INSERT INTO facts (id, entity_id, mentioned_name, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('fact-u1', null, 'A. Smith', 'committed_to', 'Send the report', 'event', now - 3600, 'open', now);
  omDb.prepare(`INSERT INTO facts (id, entity_id, mentioned_name, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('fact-u2', null, 'A. Smith', 'decided', 'Approve the plan', 'event', now - 7200, 'open', now);
  omDb.close();

  clearGatewayCache();
  // Use port 0 for the module-level listen to avoid conflicts with running gateway
  process.env.GATEWAY_PORT = '0';
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: POST /api/entities/:id/aliases — confirm an alias
    const confirmRes = await httpRequest(port, 'POST', '/api/entities/ent-alias-1/aliases', {
      mentionedName: 'A. Smith',
    });
    assert.strictEqual(confirmRes.status, 200);
    assert.strictEqual(confirmRes.body.ok, true);
    assert.strictEqual(confirmRes.body.attributedCount, 2, 'should attribute 2 facts');
    console.log('  PASS: POST /api/entities/:id/aliases confirms alias and attributes facts');

    // Test 2: Verify the facts are now attributed
    const factsRes = await httpRequest(port, 'GET', '/api/entities/ent-alias-1/facts');
    assert.strictEqual(factsRes.status, 200);
    // Should now have the 2 attributed facts
    const attributed = factsRes.body.facts.filter(f => f.attribute === 'committed_to' || f.attribute === 'decided');
    assert.strictEqual(attributed.length, 2, 'both facts should appear under the entity');
    console.log('  PASS: confirmed alias causes facts to appear under entity');

    // Test 3: The name should no longer appear in unattributed
    const unattRes = await httpRequest(port, 'GET', '/api/unattributed');
    const aSmithFacts = unattRes.body.facts.filter(f => f.mentionedName === 'A. Smith');
    assert.strictEqual(aSmithFacts.length, 0, 'A. Smith should no longer be unattributed');
    console.log('  PASS: confirmed name removed from unattributed queue');

    // Test 4: POST /api/entities/:id/aliases/reject — reject an alias
    const rejectRes = await httpRequest(port, 'POST', '/api/entities/ent-alias-1/aliases/reject', {
      mentionedName: 'Alicia S.',
      sourceFactId: 'fact-u1',
    });
    assert.strictEqual(rejectRes.status, 200);
    assert.strictEqual(rejectRes.body.ok, true);
    console.log('  PASS: POST /api/entities/:id/aliases/reject records rejection');

    // Test 5: GET /api/entities/:id/aliases — list aliases
    const aliasListRes = await httpRequest(port, 'GET', '/api/entities/ent-alias-1/aliases');
    assert.strictEqual(aliasListRes.status, 200);
    assert.ok(Array.isArray(aliasListRes.body.aliases), 'aliases should be array');
    const aliasNames = aliasListRes.body.aliases.map(a => a.alias);
    assert.ok(aliasNames.includes('A. Smith'), 'should include confirmed alias');
    console.log('  PASS: GET /api/entities/:id/aliases lists aliases');

    // Test 6: GET /api/entities/:id/aliases also returns rejections
    assert.ok(Array.isArray(aliasListRes.body.rejections), 'rejections should be array');
    const rejNames = aliasListRes.body.rejections.map(r => r.alias);
    assert.ok(rejNames.includes('Alicia S.'), 'should include rejected alias');
    console.log('  PASS: GET /api/entities/:id/aliases lists rejections');

    // Test 7: POST /api/entities/:id/aliases without mentionedName returns 400
    const badRes = await httpRequest(port, 'POST', '/api/entities/ent-alias-1/aliases', {});
    assert.strictEqual(badRes.status, 400);
    assert.ok(badRes.body.error);
    console.log('  PASS: POST /api/entities/:id/aliases without mentionedName returns 400');

    // Test 8: POST on unknown entity returns 404
    const notFound = await httpRequest(port, 'POST', '/api/entities/no-such/aliases', {
      mentionedName: 'X. Test',
    });
    assert.strictEqual(notFound.status, 404);
    console.log('  PASS: POST /api/entities/:id/aliases on unknown entity returns 404');

  } finally {
    server.close();
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

// Run async tests
testAliasEndpoints()
  .then(() => {
    console.log('\nAll alias feedback tests passed.');
    process.exit(0);
  }).catch(err => {
    console.error('FAIL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
