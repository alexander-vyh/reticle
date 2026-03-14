'use strict';

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests (file-based, not :memory:, per project convention)
const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-settings-migration-test-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

const reticleDb = require('./reticle-db');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

// --- Test: monitored_people has all new columns ---
{
  const db = reticleDb.initDatabase();

  const cols = db.pragma('table_info(monitored_people)').map(c => c.name);

  assert.ok(cols.includes('role'), `missing column: role (got: ${cols.join(', ')})`);
  assert.ok(cols.includes('escalation_tier'), `missing column: escalation_tier`);
  assert.ok(cols.includes('title'), `missing column: title`);
  assert.ok(cols.includes('team'), `missing column: team`);

  console.log('PASS: monitored_people has role, escalation_tier, title, team columns');
  db.close();
}

// --- Test: role defaults to 'peer' ---
{
  // Re-use same DB path (already initialized above — test migration path)
  const db = reticleDb.initDatabase();

  db.prepare(`INSERT INTO monitored_people (email, name) VALUES (?, ?)`).run('test@example.com', 'Test User');
  const row = db.prepare(`SELECT * FROM monitored_people WHERE email = ?`).get('test@example.com');

  assert.strictEqual(row.role, 'peer', `expected role='peer', got '${row.role}'`);
  console.log("PASS: role defaults to 'peer'");
  db.close();
}

// --- Test: escalation_tier defaults to NULL ---
{
  const db = reticleDb.initDatabase();

  const row = db.prepare(`SELECT * FROM monitored_people WHERE email = ?`).get('test@example.com');

  assert.strictEqual(row.escalation_tier, null, `expected escalation_tier=null, got '${row.escalation_tier}'`);
  console.log('PASS: escalation_tier defaults to NULL');
  db.close();
}

// --- Test: title and team default to NULL ---
{
  const db = reticleDb.initDatabase();

  const row = db.prepare(`SELECT * FROM monitored_people WHERE email = ?`).get('test@example.com');

  assert.strictEqual(row.title, null, `expected title=null, got '${row.title}'`);
  assert.strictEqual(row.team, null, `expected team=null, got '${row.team}'`);
  console.log('PASS: title and team default to NULL');
  db.close();
}

console.log('\nAll settings migration tests passed.');
