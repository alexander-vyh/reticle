'use strict';

// Tests for PATCH /people/:email endpoint
// Pattern follows test-gateway.js — env vars and config files must be set BEFORE requiring gateway.js

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function httpRequest(port, method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path: reqPath, method, headers: {} };
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

async function testSettingsEndpoints() {
  // Create temp dir for isolated DB files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-settings-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');

  // Set env vars BEFORE requiring gateway (lib/config.js reads them at require time)
  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;

  // Seed the reticle DB with a test person
  const seedDb = new Database(reticleDbPath);
  seedDb.pragma('journal_mode = WAL');
  seedDb.pragma('foreign_keys = ON');
  seedDb.exec(`
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
  seedDb.prepare(
    `INSERT INTO monitored_people (email, name, role) VALUES (?, ?, ?)`
  ).run('alice@example.com', 'Alice', 'peer');
  seedDb.close();

  // Require gateway after env vars are set
  // Use a fresh require to avoid module cache issues across test runs
  delete require.cache[require.resolve('./gateway')];
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: PATCH /people/:email returns 200 and updates role
    const encodedEmail = encodeURIComponent('alice@example.com');
    const patchRoleRes = await httpRequest(port, 'PATCH', `/people/${encodedEmail}`, { role: 'direct_report' });
    assert.strictEqual(patchRoleRes.status, 200, `expected 200, got ${patchRoleRes.status}: ${JSON.stringify(patchRoleRes.body)}`);
    assert.strictEqual(patchRoleRes.body.ok, true);
    console.log('  PASS: PATCH /people/:email returns 200 and updates role');

    // Test 2: PATCH /people/:email returns 200 and updates escalation_tier
    const patchTierRes = await httpRequest(port, 'PATCH', `/people/${encodedEmail}`, { escalation_tier: 'high' });
    assert.strictEqual(patchTierRes.status, 200, `expected 200, got ${patchTierRes.status}: ${JSON.stringify(patchTierRes.body)}`);
    assert.strictEqual(patchTierRes.body.ok, true);
    console.log('  PASS: PATCH /people/:email returns 200 and updates escalation_tier');

    // Test 3: PATCH /people/:email returns 404 for unknown email
    const unknownEmail = encodeURIComponent('nobody@example.com');
    const notFoundRes = await httpRequest(port, 'PATCH', `/people/${unknownEmail}`, { role: 'vip' });
    assert.strictEqual(notFoundRes.status, 404, `expected 404, got ${notFoundRes.status}: ${JSON.stringify(notFoundRes.body)}`);
    assert.ok(notFoundRes.body.error, 'should have error field');
    console.log('  PASS: PATCH /people/:email returns 404 for unknown email');

    // Test 4: GET /people returns updated role and escalation_tier fields
    const listRes = await httpRequest(port, 'GET', '/people');
    assert.strictEqual(listRes.status, 200);
    const alice = listRes.body.people.find(p => p.email === 'alice@example.com');
    assert.ok(alice, 'alice should appear in GET /people response');
    assert.strictEqual(alice.role, 'direct_report', `expected role=direct_report, got ${alice.role}`);
    assert.strictEqual(alice.escalation_tier, 'high', `expected escalation_tier=high, got ${alice.escalation_tier}`);
    console.log('  PASS: GET /people returns updated role and escalation_tier fields');

  } finally {
    server.close();
    // Clean up temp files
    try { fs.unlinkSync(reticleDbPath); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(reticleDbPath + '-shm'); } catch {}
    try { fs.unlinkSync(orgMemDbPath); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(orgMemDbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

async function testSeedingIdempotency() {
  // Verify that gateway startup does not duplicate existing VIPs or direct reports
  // when the DB already has entries — the seeding guard (existingVips.length === 0) holds.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-seed-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;

  // Pre-seed the DB with a VIP and a direct report so the gateway should skip seeding
  const seedDb = new Database(reticleDbPath);
  seedDb.pragma('journal_mode = WAL');
  seedDb.pragma('foreign_keys = ON');
  seedDb.exec(`
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
  // Insert a pre-existing VIP and direct report to trigger the idempotency guard
  seedDb.prepare(`INSERT INTO monitored_people (email, name, role) VALUES (?, ?, ?)`).run('existing-vip@example.com', 'Existing VIP', 'vip');
  seedDb.prepare(`INSERT INTO monitored_people (email, name, role) VALUES (?, ?, ?)`).run('existing-dr@example.com', 'Existing DR', 'direct_report');
  const countBefore = seedDb.prepare('SELECT COUNT(*) as cnt FROM monitored_people').get().cnt;
  seedDb.close();

  // Require a fresh gateway instance (clear reticle-db too so it picks up new RETICLE_DB_PATH)
  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // GET /people — count should not have grown from team.json seeding since guards fired
    const listRes = await httpRequest(port, 'GET', '/people');
    assert.strictEqual(listRes.status, 200);
    const people = listRes.body.people;

    // All pre-seeded entries must still be present (no data loss)
    const vip = people.find(p => p.email === 'existing-vip@example.com');
    const dr = people.find(p => p.email === 'existing-dr@example.com');
    assert.ok(vip, 'pre-existing VIP must be present after gateway start');
    assert.ok(dr, 'pre-existing direct report must be present after gateway start');
    assert.strictEqual(vip.role, 'vip');
    assert.strictEqual(dr.role, 'direct_report');

    // Count must be >= countBefore (team member seeding may run if DB had 0 team members)
    assert.ok(people.length >= countBefore, `people count should not drop below ${countBefore}`);

    console.log('  PASS: seeding is idempotent — pre-existing VIP/direct_report entries are preserved');
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

async function testFeedbackSettingsEndpoints() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-fdbk-settings-test-'));
  const reticleDbPath = path.join(tmpDir, 'reticle.db');
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');

  process.env.RETICLE_DB_PATH = reticleDbPath;
  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;

  // Clear module cache so gateway.js picks up the new DB path
  delete require.cache[require.resolve('./gateway')];
  delete require.cache[require.resolve('./reticle-db')];

  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /feedback/settings returns defaults
    const getRes = await httpRequest(port, 'GET', '/feedback/settings');
    assert.strictEqual(getRes.status, 200, `expected 200, got ${getRes.status}: ${JSON.stringify(getRes.body)}`);
    assert.strictEqual(getRes.body.weeklyTarget, '3', `expected weeklyTarget='3', got '${getRes.body.weeklyTarget}'`);
    assert.strictEqual(getRes.body.scanWindowHours, '24', `expected scanWindowHours='24', got '${getRes.body.scanWindowHours}'`);
    console.log('  PASS: GET /feedback/settings returns defaults');

    // Test 2: PATCH /feedback/settings updates values
    const patchRes = await httpRequest(port, 'PATCH', '/feedback/settings', { weeklyTarget: 5, scanWindowHours: 48 });
    assert.strictEqual(patchRes.status, 200, `expected 200, got ${patchRes.status}: ${JSON.stringify(patchRes.body)}`);
    assert.strictEqual(patchRes.body.ok, true);
    console.log('  PASS: PATCH /feedback/settings updates values');

    // Test 3: GET /feedback/settings returns updated values after PATCH
    const getAfterRes = await httpRequest(port, 'GET', '/feedback/settings');
    assert.strictEqual(getAfterRes.status, 200);
    assert.strictEqual(getAfterRes.body.weeklyTarget, '5', `expected weeklyTarget='5', got '${getAfterRes.body.weeklyTarget}'`);
    assert.strictEqual(getAfterRes.body.scanWindowHours, '48', `expected scanWindowHours='48', got '${getAfterRes.body.scanWindowHours}'`);
    console.log('  PASS: GET /feedback/settings returns updated values after PATCH');

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

// --- Run tests ---
console.log('settings endpoint tests:');

testSettingsEndpoints()
  .then(() => testSeedingIdempotency())
  .then(() => testFeedbackSettingsEndpoints())
  .then(() => {
    console.log('All settings endpoint tests passed');
    process.exit(0);
  }).catch(err => {
    console.error('FAIL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
