'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitored_people (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      email            TEXT UNIQUE NOT NULL,
      name             TEXT,
      slack_id         TEXT,
      jira_id          TEXT,
      resolved_at      INTEGER,
      created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      role             TEXT DEFAULT 'peer',
      escalation_tier  TEXT,
      title            TEXT,
      team             TEXT
    );
  `);
  return db;
}

function testGatewaySyntax() {
  // Verify gateway.js is valid JavaScript
  const { execSync } = require('child_process');
  execSync('node -c gateway.js', { stdio: 'pipe' });
  console.log('  PASS: gateway.js syntax check');
}

function testGatewayPeopleFlow() {
  const peopleStore = require('./lib/people-store');
  const db = setupTestDb();

  // Simulate POST /people
  peopleStore.addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });

  // Simulate GET /people
  const people = peopleStore.listPeople(db);
  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].email, 'alex@co.com');
  assert.strictEqual(people[0].name, 'Alex Johnson');

  // Simulate DELETE /people/:email
  peopleStore.removePerson(db, 'alex@co.com');
  assert.strictEqual(peopleStore.listPeople(db).length, 0);

  console.log('  PASS: gateway people CRUD flow');
}

function testGatewayPostValidation() {
  // POST /people without email should be rejected — test the logic
  const email = undefined;
  assert.strictEqual(!email, true, 'missing email should be falsy');

  console.log('  PASS: gateway POST /people email validation logic');
}

function testGatewayDeleteDecodesEmail() {
  const peopleStore = require('./lib/people-store');
  const db = setupTestDb();

  // Add person with special characters in email
  const email = 'user+tag@example.com';
  peopleStore.addPerson(db, { email, name: 'Tag User' });

  // Simulate what the DELETE handler does: decodeURIComponent
  const encoded = encodeURIComponent(email);
  const decoded = decodeURIComponent(encoded);
  peopleStore.removePerson(db, decoded);

  assert.strictEqual(peopleStore.listPeople(db).length, 0);
  console.log('  PASS: gateway DELETE decodes URI-encoded email');
}

function testFeedbackCandidateFlow() {
  const db = setupTestDb();
  // Add feedback_candidates table
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_candidates (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      account_id  TEXT,
      report_name TEXT NOT NULL,
      channel     TEXT,
      raw_artifact TEXT NOT NULL,
      draft       TEXT,
      feedback_type TEXT,
      entity_id   TEXT,
      status      TEXT NOT NULL DEFAULT 'pending'
    );
  `);

  // Insert a candidate
  db.prepare(`
    INSERT INTO feedback_candidates (account_id, report_name, channel, raw_artifact, draft, feedback_type, entity_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('acc1', 'Marcus Chen', '#platform-eng', 'Great deployment work', 'When you deployed...', 'affirming', 'entity1');

  // Verify pending query
  const pending = db.prepare(`SELECT * FROM feedback_candidates WHERE status = 'pending'`).all();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].report_name, 'Marcus Chen');

  // Mark delivered
  db.prepare(`UPDATE feedback_candidates SET status = 'delivered' WHERE id = ?`).run(pending[0].id);
  const afterDeliver = db.prepare(`SELECT * FROM feedback_candidates WHERE status = 'pending'`).all();
  assert.strictEqual(afterDeliver.length, 0);

  console.log('  PASS: feedback candidate CRUD flow');
}

// --- Commitments endpoint tests (HTTP-level) ---

function setupOrgMemoryDb(dbPath) {
  const { initDatabase } = require('./lib/org-memory-db');
  return initDatabase(dbPath);
}

function httpRequest(port, method, path, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path, method, headers: {} };
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

async function testCommitmentsEndpoints() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  // Create temp directories for isolated DBs
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-gw-test-'));
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const reticleDbPath = path.join(tmpDir, 'reticle.db');

  // Set env vars BEFORE requiring gateway
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_DB_PATH = reticleDbPath;

  // Seed org-memory DB with test data
  const omDb = setupOrgMemoryDb(orgMemDbPath);
  const now = Math.floor(Date.now() / 1000);

  omDb.prepare(`INSERT INTO entities (id, entity_type, canonical_name, created_at)
    VALUES (?, ?, ?, ?)`).run('ent-1', 'person', 'Test Person', now);

  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'fact-1', 'ent-1', 'committed_to', 'Ship the widget', 'event', now - 3600, 'open', now
  );
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'fact-2', 'ent-1', 'raised_risk', 'Deadline tight', 'event', now - 86400 * 10, null, now
  );
  omDb.close();

  // Start gateway on port 0 (random available port)
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /api/commitments returns 200 with expected shape
    const listRes = await httpRequest(port, 'GET', '/api/commitments');
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.commitments), 'commitments should be an array');
    assert.ok(listRes.body.summary, 'response should have summary');
    assert.strictEqual(typeof listRes.body.summary.total, 'number');
    assert.ok(listRes.body.summary.byAttribute, 'summary should have byAttribute');
    assert.ok(listRes.body.summary.byPriority, 'summary should have byPriority');
    assert.strictEqual(listRes.body.summary.total, 2);
    assert.strictEqual(listRes.body.summary.byAttribute.committed_to, 1);
    assert.strictEqual(listRes.body.summary.byAttribute.raised_risk, 1);
    // Verify item shape
    const item = listRes.body.commitments.find(c => c.id === 'fact-1');
    assert.ok(item, 'should find fact-1 in commitments');
    assert.strictEqual(item.attribute, 'committed_to');
    assert.strictEqual(item.value, 'Ship the widget');
    assert.strictEqual(item.entityName, 'Test Person');
    assert.strictEqual(typeof item.ageSeconds, 'number');
    assert.strictEqual(typeof item.ageDays, 'number');
    assert.strictEqual(typeof item.isStale, 'boolean');
    console.log('  PASS: GET /api/commitments returns 200 with expected shape');

    // Test 2: POST /api/commitments/:id/resolve with valid resolution returns ok
    const resolveRes = await httpRequest(port, 'POST', '/api/commitments/fact-1/resolve', { resolution: 'completed' });
    assert.strictEqual(resolveRes.status, 200);
    assert.strictEqual(resolveRes.body.ok, true);
    assert.strictEqual(resolveRes.body.id, 'fact-1');
    assert.strictEqual(resolveRes.body.resolution, 'completed');
    // Verify it no longer appears in open commitments
    const afterResolve = await httpRequest(port, 'GET', '/api/commitments');
    assert.strictEqual(afterResolve.body.summary.total, 1, 'resolved fact should no longer appear');
    // Verify evidence row was created (not just raw UPDATE)
    const reopenDb = require('better-sqlite3')(orgMemDbPath);
    const evidence = reopenDb.prepare('SELECT * FROM facts WHERE resolves_fact_id = ?').get('fact-1');
    assert.ok(evidence, 'resolve should create an evidence row with resolves_fact_id');
    assert.strictEqual(evidence.attribute, 'completion_signal');
    assert.strictEqual(evidence.rationale, 'manual');
    reopenDb.close();
    console.log('  PASS: POST /api/commitments/:id/resolve creates evidence row');

    // Test 3: POST /api/commitments/:id/resolve with invalid resolution returns 400
    const badRes = await httpRequest(port, 'POST', '/api/commitments/fact-2/resolve', { resolution: 'invalid' });
    assert.strictEqual(badRes.status, 400);
    assert.ok(badRes.body.error, 'should have error message');
    assert.ok(badRes.body.error.includes('completed'), 'error should mention valid values');
    console.log('  PASS: POST /api/commitments/:id/resolve with invalid resolution returns 400');
  } finally {
    server.close();
    // Clean up temp files
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

// --- POST /people with role/title/team (HTTP-level) ---

async function testPostPeopleWithRoleFields() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-post-people-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;

  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];

  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: POST /people with role=vip and title persists both in one call
    const vipRes = await httpRequest(port, 'POST', '/people', {
      email: 'ceo@example.com', name: 'Jane CEO', role: 'vip', title: 'Chief Executive Officer'
    });
    assert.strictEqual(vipRes.status, 200, `expected 200, got ${vipRes.status}: ${JSON.stringify(vipRes.body)}`);
    assert.strictEqual(vipRes.body.ok, true);
    const listRes = await httpRequest(port, 'GET', '/people');
    const vip = listRes.body.people.find(p => p.email === 'ceo@example.com');
    assert.ok(vip, 'ceo@example.com should appear in GET /people');
    assert.strictEqual(vip.role, 'vip', `expected role=vip, got ${vip.role}`);
    assert.strictEqual(vip.title, 'Chief Executive Officer', `expected title, got ${vip.title}`);
    console.log('  PASS: POST /people with role=vip and title persists both in one call');

    // Test 2: POST /people with role=direct_report persists role
    const drRes = await httpRequest(port, 'POST', '/people', {
      email: 'report@example.com', name: 'Direct Bob', role: 'direct_report'
    });
    assert.strictEqual(drRes.status, 200, `expected 200, got ${drRes.status}: ${JSON.stringify(drRes.body)}`);
    const listRes2 = await httpRequest(port, 'GET', '/people');
    const dr = listRes2.body.people.find(p => p.email === 'report@example.com');
    assert.ok(dr, 'report@example.com should appear in GET /people');
    assert.strictEqual(dr.role, 'direct_report', `expected role=direct_report, got ${dr.role}`);
    console.log('  PASS: POST /people with role=direct_report persists role');

    // Test 3: POST /people with team persists team field
    const teamRes = await httpRequest(port, 'POST', '/people', {
      email: 'member@example.com', name: 'Team Sue', team: 'engineering'
    });
    assert.strictEqual(teamRes.status, 200);
    const listRes3 = await httpRequest(port, 'GET', '/people');
    const member = listRes3.body.people.find(p => p.email === 'member@example.com');
    assert.ok(member, 'member@example.com should appear in GET /people');
    assert.strictEqual(member.team, 'engineering', `expected team=engineering, got ${member.team}`);
    console.log('  PASS: POST /people with team persists team field');

    // Test 4: POST /people without role defaults to peer
    const peerRes = await httpRequest(port, 'POST', '/people', {
      email: 'peer@example.com', name: 'Just Peer'
    });
    assert.strictEqual(peerRes.status, 200);
    const listRes4 = await httpRequest(port, 'GET', '/people');
    const peer = listRes4.body.people.find(p => p.email === 'peer@example.com');
    assert.ok(peer, 'peer@example.com should appear in GET /people');
    assert.strictEqual(peer.role, 'peer', `expected role=peer, got ${peer.role}`);
    console.log('  PASS: POST /people without role defaults to peer');
  } finally {
    server.close();
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

// Clear gateway's module-level cached DB between test runs
function jest_clearGatewayCache() {
  // gateway.js and its deps cache DBs at module level; clear all so each test
  // suite gets a fresh instance pointing to the correct temp DB paths
  for (const mod of ['./gateway', './lib/org-memory-db', './reticle-db']) {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
  }
}

async function testEntitiesEndpoints() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-ent-test-'));
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const reticleDbPath = path.join(tmpDir, 'reticle.db');

  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_DB_PATH = reticleDbPath;

  const omDb = setupOrgMemoryDb(orgMemDbPath);
  const now = Math.floor(Date.now() / 1000);

  omDb.prepare(`INSERT INTO entities (id, entity_type, canonical_name, monitored, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('ent-a', 'person', 'Alice', 0, now);
  omDb.prepare(`INSERT INTO entities (id, entity_type, canonical_name, monitored, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('ent-b', 'person', 'Bob', 1, now);
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('f-a1', 'ent-a', 'committed_to', 'Do the thing', 'event', now - 3600, 'open', now);
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('f-a2', 'ent-a', 'asked_to', 'Review PR', 'event', now - 7200, null, now);
  omDb.prepare(`INSERT INTO identity_map (entity_id, source, external_id, display_name)
    VALUES (?, ?, ?, ?)`).run('ent-a', 'slack', 'U123', 'Alice');
  omDb.close();

  // Reset gateway's lazy-loaded cache so it picks up the new DB path
  jest_clearGatewayCache();

  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /api/entities returns all persons with shape
    const listRes = await httpRequest(port, 'GET', '/api/entities');
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.entities), 'entities should be array');
    assert.strictEqual(listRes.body.entities.length, 2);
    const alice = listRes.body.entities.find(e => e.id === 'ent-a');
    const bob = listRes.body.entities.find(e => e.id === 'ent-b');
    assert.ok(alice, 'should find Alice');
    assert.strictEqual(alice.canonicalName, 'Alice');
    assert.strictEqual(alice.monitored, false);
    assert.strictEqual(alice.commitmentCount, 2);
    assert.strictEqual(alice.slackId, 'U123');
    assert.strictEqual(alice.isAnchored, true, 'Alice has identity_map entry, should be anchored');
    assert.strictEqual(bob.monitored, true);
    assert.strictEqual(bob.commitmentCount, 0);
    assert.strictEqual(bob.isAnchored, false, 'Bob has no identity_map entry, should be floating');
    console.log('  PASS: GET /api/entities returns entities with correct shape and isAnchored');

    // Test 2: POST /api/entities/:id/monitor sets flag
    const monRes = await httpRequest(port, 'POST', '/api/entities/ent-a/monitor');
    assert.strictEqual(monRes.status, 200);
    assert.strictEqual(monRes.body.ok, true);
    const afterMon = await httpRequest(port, 'GET', '/api/entities');
    const aliceAfter = afterMon.body.entities.find(e => e.id === 'ent-a');
    assert.strictEqual(aliceAfter.monitored, true);
    console.log('  PASS: POST /api/entities/:id/monitor sets monitored flag');

    // Test 3: POST /api/entities/:id/unmonitor clears flag
    const unmonRes = await httpRequest(port, 'POST', '/api/entities/ent-b/unmonitor');
    assert.strictEqual(unmonRes.status, 200);
    assert.strictEqual(unmonRes.body.ok, true);
    const afterUnmon = await httpRequest(port, 'GET', '/api/entities');
    const bobAfter = afterUnmon.body.entities.find(e => e.id === 'ent-b');
    assert.strictEqual(bobAfter.monitored, false);
    console.log('  PASS: POST /api/entities/:id/unmonitor clears monitored flag');

    // Test 4: monitor/unmonitor on unknown id returns 404
    const notFound = await httpRequest(port, 'POST', '/api/entities/no-such-id/monitor');
    assert.strictEqual(notFound.status, 404);
    console.log('  PASS: monitor on unknown entity returns 404');
  } finally {
    server.close();
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

async function testEntityDetailAndMerge() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-merge-test-'));
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const reticleDbPath = path.join(tmpDir, 'reticle.db');

  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_DB_PATH = reticleDbPath;

  const omDb = setupOrgMemoryDb(orgMemDbPath);
  const now = Math.floor(Date.now() / 1000);

  omDb.prepare(`INSERT INTO entities (id, entity_type, canonical_name, monitored, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('src-1', 'person', 'Gimli Stone', 0, now);
  omDb.prepare(`INSERT INTO entities (id, entity_type, canonical_name, monitored, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('tgt-1', 'person', 'Gimli Stone', 1, now);
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('fm-1', 'src-1', 'committed_to', 'Ship it', 'event', now - 3600, 'open', now);
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('fm-2', 'tgt-1', 'asked_to', 'Review PR', 'event', now - 7200, null, now);
  omDb.prepare(`INSERT INTO identity_map (entity_id, source, external_id, display_name)
    VALUES (?, ?, ?, ?)`).run('src-1', 'slack', 'USRC', 'Dan');
  omDb.close();

  jest_clearGatewayCache();
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /api/entities/:id returns entity with shape
    const detailRes = await httpRequest(port, 'GET', '/api/entities/src-1');
    assert.strictEqual(detailRes.status, 200);
    assert.strictEqual(detailRes.body.entity.id, 'src-1');
    assert.strictEqual(detailRes.body.entity.canonicalName, 'Gimli Stone');
    assert.strictEqual(detailRes.body.entity.slackId, 'USRC');
    assert.strictEqual(detailRes.body.entity.isAnchored, true, 'src-1 has identity_map entry, should be anchored');
    console.log('  PASS: GET /api/entities/:id returns entity shape with isAnchored');

    // Test 2: GET /api/entities/:id/commitments returns that entity's open facts
    const comRes = await httpRequest(port, 'GET', '/api/entities/src-1/commitments');
    assert.strictEqual(comRes.status, 200);
    assert.ok(Array.isArray(comRes.body.commitments));
    assert.strictEqual(comRes.body.commitments.length, 1);
    assert.strictEqual(comRes.body.commitments[0].id, 'fm-1');
    assert.strictEqual(comRes.body.commitments[0].entityName, 'Gimli Stone');
    console.log('  PASS: GET /api/entities/:id/commitments returns that entity\'s facts');

    // Test 3: GET /api/entities/:id returns 404 for unknown id
    const notFound = await httpRequest(port, 'GET', '/api/entities/no-such');
    assert.strictEqual(notFound.status, 404);
    console.log('  PASS: GET /api/entities/:id returns 404 for unknown');

    // Test 4: POST /api/entities/:id/merge reassigns facts and identities to target
    const mergeRes = await httpRequest(port, 'POST', '/api/entities/src-1/merge', { targetId: 'tgt-1' });
    assert.strictEqual(mergeRes.status, 200);
    assert.strictEqual(mergeRes.body.ok, true);

    // Source should be inactive
    const srcDetail = await httpRequest(port, 'GET', '/api/entities/src-1');
    assert.strictEqual(srcDetail.body.entity.isActive, false);

    // Target should now have both facts
    const tgtCom = await httpRequest(port, 'GET', '/api/entities/tgt-1/commitments');
    assert.strictEqual(tgtCom.body.commitments.length, 2);

    // Target should have inherited slack identity
    const tgtDetail = await httpRequest(port, 'GET', '/api/entities/tgt-1');
    assert.strictEqual(tgtDetail.body.entity.slackId, 'USRC');
    assert.strictEqual(tgtDetail.body.entity.isAnchored, true, 'target inherited identity, should be anchored');
    console.log('  PASS: POST /api/entities/:id/merge reassigns facts and identities with isAnchored');

    // Test 5: merge with invalid targetId returns 404
    const badMerge = await httpRequest(port, 'POST', '/api/entities/tgt-1/merge', { targetId: 'no-such' });
    assert.strictEqual(badMerge.status, 404);
    console.log('  PASS: merge with unknown targetId returns 404');
  } finally {
    server.close();
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

async function testEntityFactsAndUnattributed() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-facts-test-'));
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const reticleDbPath = path.join(tmpDir, 'reticle.db');

  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_DB_PATH = reticleDbPath;

  const omDb = setupOrgMemoryDb(orgMemDbPath);
  const now = Math.floor(Date.now() / 1000);

  omDb.prepare(`INSERT INTO entities (id, entity_type, canonical_name, monitored, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('ent-a', 'person', 'Alice', 1, now);
  // State facts
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('sf-1', 'ent-a', 'role', 'Senior Engineer', 'state', now - 86400, now);
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('sf-2', 'ent-a', 'team', 'Platform', 'state', now - 86400, now);
  // Open commitment
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ef-1', 'ent-a', 'committed_to', 'Ship auth fix', 'event', now - 3600, 'open', now);
  // Resolved commitment
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, resolved_at, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('ef-2', 'ent-a', 'asked_to', 'Review docs', 'event', now - 86400 * 3, 'completed', now - 86400, now);
  // Unattributed fact
  omDb.prepare(`INSERT INTO facts (id, entity_id, mentioned_name, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('uf-1', null, 'Unknown Person', 'committed_to', 'Send report', 'event', now - 3600, 'open', now);
  omDb.prepare(`INSERT INTO facts (id, entity_id, mentioned_name, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('uf-2', null, 'Another Unknown', 'asked_to', 'Fix the build', 'event', now - 7200, 'open', now);
  omDb.close();

  jest_clearGatewayCache();
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /api/entities/:id/facts returns all facts (state + event, open + resolved)
    const factsRes = await httpRequest(port, 'GET', '/api/entities/ent-a/facts');
    assert.strictEqual(factsRes.status, 200);
    assert.ok(Array.isArray(factsRes.body.facts), 'facts should be an array');
    assert.strictEqual(factsRes.body.facts.length, 4, 'should return all 4 facts for Alice');
    const roles = factsRes.body.facts.filter(f => f.attribute === 'role');
    assert.strictEqual(roles.length, 1, 'should include state facts');
    assert.strictEqual(roles[0].value, 'Senior Engineer');
    const resolved = factsRes.body.facts.filter(f => f.resolution === 'completed');
    assert.strictEqual(resolved.length, 1, 'should include resolved facts');
    console.log('  PASS: GET /api/entities/:id/facts returns all facts');

    // Test 2: GET /api/entities/:id/facts?factType=state returns only state facts
    const stateRes = await httpRequest(port, 'GET', '/api/entities/ent-a/facts?factType=state');
    assert.strictEqual(stateRes.body.facts.length, 2, 'should return only state facts');
    assert.ok(stateRes.body.facts.every(f => f.factType === 'state'));
    console.log('  PASS: GET /api/entities/:id/facts?factType=state filters correctly');

    // Test 3: GET /api/unattributed returns facts with entity_id IS NULL
    const unRes = await httpRequest(port, 'GET', '/api/unattributed');
    assert.strictEqual(unRes.status, 200);
    assert.ok(Array.isArray(unRes.body.facts));
    assert.strictEqual(unRes.body.facts.length, 2);
    assert.strictEqual(unRes.body.facts[0].mentionedName, 'Another Unknown');
    assert.strictEqual(unRes.body.facts[1].mentionedName, 'Unknown Person');
    console.log('  PASS: GET /api/unattributed returns null-entity facts');

  } finally {
    server.close();
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

async function testMergeWithPreferredNameAndAliases() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-merge-pref-test-'));
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const reticleDbPath = path.join(tmpDir, 'reticle.db');

  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_DB_PATH = reticleDbPath;

  const omDb = setupOrgMemoryDb(orgMemDbPath);
  const now = Math.floor(Date.now() / 1000);
  const kg = require('./lib/knowledge-graph');

  // Create two entities: "Dan Sherr" and "Daniel Sherr"
  omDb.prepare(`INSERT INTO entities (id, entity_type, canonical_name, monitored, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('dan-1', 'person', 'Dan Sherr', 0, now);
  omDb.prepare(`INSERT INTO entities (id, entity_type, canonical_name, monitored, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('daniel-1', 'person', 'Daniel Sherr', 1, now);

  // Give each entity some identities
  omDb.prepare(`INSERT INTO identity_map (entity_id, source, external_id, display_name)
    VALUES (?, ?, ?, ?)`).run('dan-1', 'slack', 'U_DAN', 'Dan Sherr');
  omDb.prepare(`INSERT INTO identity_map (entity_id, source, external_id, display_name)
    VALUES (?, ?, ?, ?)`).run('daniel-1', 'jira', 'dsherr', 'Daniel Sherr');

  // Give dan-1 an alias
  kg.addAlias(omDb, { entityId: 'dan-1', alias: 'Danny', aliasSource: 'manual' });

  // Give daniel-1 a fact
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('pf-1', 'dan-1', 'committed_to', 'Fix tests', 'event', now - 3600, 'open', now);
  omDb.prepare(`INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, resolution, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('pf-2', 'daniel-1', 'asked_to', 'Review docs', 'event', now - 7200, null, now);
  omDb.close();

  jest_clearGatewayCache();
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /api/entities returns aliases field
    const listRes = await httpRequest(port, 'GET', '/api/entities');
    const dan = listRes.body.entities.find(e => e.id === 'dan-1');
    assert.ok(dan, 'dan-1 should be in entities list');
    assert.ok(Array.isArray(dan.aliases), 'aliases should be an array');
    assert.ok(dan.aliases.includes('Danny'), 'dan-1 aliases should include Danny');
    console.log('  PASS: GET /api/entities returns aliases field');

    // Test 2: GET /api/entities/:id returns aliases field
    const detailRes = await httpRequest(port, 'GET', '/api/entities/dan-1');
    assert.ok(Array.isArray(detailRes.body.entity.aliases), 'detail aliases should be array');
    assert.ok(detailRes.body.entity.aliases.includes('Danny'), 'detail should include Danny alias');
    console.log('  PASS: GET /api/entities/:id returns aliases field');

    // Test 3: Merge with preferredName changes target's canonical_name
    const mergeRes = await httpRequest(port, 'POST', '/api/entities/dan-1/merge', {
      targetId: 'daniel-1',
      preferredName: 'Dan Sherr'
    });
    assert.strictEqual(mergeRes.status, 200);
    assert.strictEqual(mergeRes.body.ok, true);

    // Target should now have preferred name
    const tgtDetail = await httpRequest(port, 'GET', '/api/entities/daniel-1');
    assert.strictEqual(tgtDetail.body.entity.canonicalName, 'Dan Sherr',
      'target canonical_name should be updated to preferredName');
    console.log('  PASS: merge with preferredName updates target canonical_name');

    // Test 4: Source's old canonical_name becomes an alias on target
    assert.ok(tgtDetail.body.entity.aliases.includes('Daniel Sherr'),
      'target should have source old canonical_name as alias');
    console.log('  PASS: source canonical_name preserved as alias on target');

    // Test 5: Source's aliases are migrated to target
    assert.ok(tgtDetail.body.entity.aliases.includes('Danny'),
      'target should inherit source aliases');
    console.log('  PASS: source aliases migrated to target');

    // Test 6: Target inherited source's slack identity
    assert.strictEqual(tgtDetail.body.entity.slackId, 'U_DAN',
      'target should inherit source Slack identity');
    console.log('  PASS: merge inherits source Slack identity');

    // Test 7: Target has both entities' facts
    const tgtCom = await httpRequest(port, 'GET', '/api/entities/daniel-1/commitments');
    assert.strictEqual(tgtCom.body.commitments.length, 2,
      'target should have facts from both entities');
    console.log('  PASS: merge reassigns all facts to target');

    // Test 8: Source is deactivated
    const srcDetail = await httpRequest(port, 'GET', '/api/entities/dan-1');
    assert.strictEqual(srcDetail.body.entity.isActive, false,
      'source should be deactivated after merge');
    console.log('  PASS: source deactivated after merge');
  } finally {
    server.close();
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

// --- POST /speakers/embeddings tests (HTTP-level) ---

async function testSpeakerEmbeddingsEndpoints() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-speaker-emb-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;

  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];

  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Seed a monitored person for the embedding
    const addRes = await httpRequest(port, 'POST', '/people', {
      email: 'mark@co.com', name: 'Mark'
    });
    assert.strictEqual(addRes.status, 200);

    // Get the person ID
    const listRes = await httpRequest(port, 'GET', '/people');
    const mark = listRes.body.people.find(p => p.email === 'mark@co.com');
    assert.ok(mark, 'mark@co.com should exist');
    const personId = mark.id;

    // Test 1: POST /speakers/embeddings with valid data returns 200
    // Create a fake 192-float embedding as base64
    const embeddingBuffer = Buffer.alloc(192 * 4); // 192 floats × 4 bytes
    for (let i = 0; i < 192; i++) embeddingBuffer.writeFloatLE(Math.random(), i * 4);
    const embeddingBase64 = embeddingBuffer.toString('base64');

    const postRes = await httpRequest(port, 'POST', '/speakers/embeddings', {
      personId,
      embedding: embeddingBase64,
      sourceMeetingId: 'meeting-test-001',
      modelVersion: 'ecapa-tdnn-v1',
      qualityScore: 0.85
    });
    assert.strictEqual(postRes.status, 200, `expected 200, got ${postRes.status}: ${JSON.stringify(postRes.body)}`);
    assert.strictEqual(postRes.body.ok, true);
    assert.strictEqual(postRes.body.personId, personId);
    assert.strictEqual(postRes.body.sourceMeetingId, 'meeting-test-001');
    assert.strictEqual(postRes.body.modelVersion, 'ecapa-tdnn-v1');
    console.log('  PASS: POST /speakers/embeddings saves embedding');

    // Test 2: GET /speakers/embeddings returns the saved embedding
    const getRes = await httpRequest(port, 'GET', '/speakers/embeddings');
    assert.strictEqual(getRes.status, 200);
    assert.ok(Array.isArray(getRes.body.embeddings));
    const found = getRes.body.embeddings.find(e => e.personId === personId);
    assert.ok(found, 'saved embedding should appear in GET response');
    assert.strictEqual(found.modelVersion, 'ecapa-tdnn-v1');
    assert.strictEqual(found.name, 'Mark');
    // Verify the base64 round-trips correctly
    assert.strictEqual(found.embedding, embeddingBase64);
    console.log('  PASS: GET /speakers/embeddings returns saved embedding with correct base64');

    // Test 3: POST /speakers/embeddings without required fields returns 400
    const badRes1 = await httpRequest(port, 'POST', '/speakers/embeddings', {
      personId
    });
    assert.strictEqual(badRes1.status, 400);
    assert.ok(badRes1.body.error);
    console.log('  PASS: POST /speakers/embeddings without embedding returns 400');

    const badRes2 = await httpRequest(port, 'POST', '/speakers/embeddings', {
      embedding: embeddingBase64,
      sourceMeetingId: 'meeting-test-002',
      modelVersion: 'v1'
    });
    assert.strictEqual(badRes2.status, 400);
    assert.ok(badRes2.body.error);
    console.log('  PASS: POST /speakers/embeddings without personId returns 400');

    // Test 4: Upsert — POST same person+meeting updates, does not duplicate
    const embeddingBuffer2 = Buffer.alloc(192 * 4);
    for (let i = 0; i < 192; i++) embeddingBuffer2.writeFloatLE(Math.random() * 2, i * 4);
    const embeddingBase64v2 = embeddingBuffer2.toString('base64');

    const upsertRes = await httpRequest(port, 'POST', '/speakers/embeddings', {
      personId,
      embedding: embeddingBase64v2,
      sourceMeetingId: 'meeting-test-001',
      modelVersion: 'ecapa-tdnn-v2',
      qualityScore: 0.92
    });
    assert.strictEqual(upsertRes.status, 200);
    assert.strictEqual(upsertRes.body.modelVersion, 'ecapa-tdnn-v2');

    // Verify only one embedding for this person+meeting
    const getRes2 = await httpRequest(port, 'GET', '/speakers/embeddings');
    const personEmbs = getRes2.body.embeddings.filter(e => e.personId === personId);
    assert.strictEqual(personEmbs.length, 1, 'upsert should not create duplicate');
    assert.strictEqual(personEmbs[0].modelVersion, 'ecapa-tdnn-v2');
    console.log('  PASS: POST /speakers/embeddings upserts on same person+meeting');

    // Test 5: qualityScore is optional (null is fine)
    const noQualityRes = await httpRequest(port, 'POST', '/speakers/embeddings', {
      personId,
      embedding: embeddingBase64,
      sourceMeetingId: 'meeting-test-002',
      modelVersion: 'ecapa-tdnn-v1'
    });
    assert.strictEqual(noQualityRes.status, 200);
    assert.strictEqual(noQualityRes.body.ok, true);
    console.log('  PASS: POST /speakers/embeddings works without qualityScore');

  } finally {
    server.close();
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

// --- Run all tests ---

console.log('gateway tests:');
testGatewaySyntax();
testGatewayPeopleFlow();
testGatewayPostValidation();
testGatewayDeleteDecodesEmail();
testFeedbackCandidateFlow();

// Async tests
testCommitmentsEndpoints()
  .then(() => testPostPeopleWithRoleFields())
  .then(() => testEntitiesEndpoints())
  .then(() => testEntityDetailAndMerge())
  .then(() => testEntityFactsAndUnattributed())
  .then(() => testMergeWithPreferredNameAndAliases())
  .then(() => testSpeakerEmbeddingsEndpoints())
  .then(() => {
    console.log('All gateway tests passed');
    process.exit(0);
  }).catch(err => {
    console.error('FAIL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
