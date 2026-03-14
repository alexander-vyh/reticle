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

// --- Run tests ---
console.log('settings endpoint tests:');

testSettingsEndpoints().then(() => {
  console.log('All settings endpoint tests passed');
  process.exit(0);
}).catch(err => {
  console.error('FAIL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
