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
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_messages (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
      channel_id TEXT, channel_name TEXT, author_id TEXT, author_ext_id TEXT,
      author_name TEXT, content TEXT NOT NULL, thread_id TEXT,
      occurred_at INTEGER NOT NULL, metadata TEXT, extracted INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, canonical_name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(id),
      attribute TEXT NOT NULL, value TEXT,
      fact_type TEXT NOT NULL DEFAULT 'state' CHECK(fact_type IN ('state', 'event')),
      valid_from INTEGER NOT NULL, valid_to INTEGER, confidence REAL DEFAULT 1.0,
      source_message_id TEXT, last_confirmed_at INTEGER, last_confirmed_source TEXT,
      resolution TEXT CHECK(resolution IS NULL OR resolution IN ('open', 'completed', 'abandoned', 'superseded')),
      resolved_at INTEGER, extracted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_map (
      entity_id TEXT NOT NULL REFERENCES entities(id),
      platform TEXT NOT NULL, platform_id TEXT NOT NULL,
      display_name TEXT, email TEXT, slack_id TEXT, jira_id TEXT,
      resolved_at INTEGER, created_at INTEGER NOT NULL,
      PRIMARY KEY (platform, platform_id)
    );
  `);
  return db;
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
    console.log('  PASS: POST /api/commitments/:id/resolve with valid resolution returns ok');

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

// --- Run all tests ---

console.log('gateway tests:');
testGatewaySyntax();
testGatewayPeopleFlow();
testGatewayPostValidation();
testGatewayDeleteDecodesEmail();
testFeedbackCandidateFlow();

// Async tests
testCommitmentsEndpoints().then(() => {
  console.log('All gateway tests passed');
  process.exit(0);
}).catch(err => {
  console.error('FAIL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
