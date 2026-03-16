'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================================
// UNIT TESTS — DB layer: getLatestSnapshot, getSnapshotHistory, narration col
// ============================================================================

function setupTestDb() {
  const tmpPath = path.join(os.tmpdir(), `reticle-digest-api-test-${Date.now()}.db`);
  process.env.RETICLE_DB_PATH = tmpPath;

  // Clear module cache to pick up new DB path
  for (const mod of ['./reticle-db']) {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
  }

  const reticleDb = require('./reticle-db');
  const db = reticleDb.initDatabase();

  // Create an account for testing
  const acct = reticleDb.upsertAccount(db, {
    email: 'test@example.com',
    provider: 'gmail',
    display_name: 'Test',
    is_primary: 1
  });

  return { db, reticleDb, acct, tmpPath };
}

function cleanupDb(tmpPath) {
  try { fs.unlinkSync(tmpPath); } catch {}
  try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
  try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
}

// --- Test: narration column exists in digest_snapshots ---
function testNarrationColumnExists() {
  const { db, tmpPath } = setupTestDb();
  try {
    const cols = db.prepare("PRAGMA table_info(digest_snapshots)").all();
    const narrationCol = cols.find(c => c.name === 'narration');
    assert.ok(narrationCol, 'digest_snapshots should have a narration column');
    assert.strictEqual(narrationCol.notnull, 0, 'narration column should be nullable');
    console.log('  PASS: narration column exists in digest_snapshots');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: saveSnapshot stores narration text ---
function testSaveSnapshotWithNarration() {
  const { db, reticleDb, acct, tmpPath } = setupTestDb();
  try {
    reticleDb.saveSnapshot(db, acct.id, {
      snapshotDate: '2026-03-16',
      cadence: 'daily',
      items: [{ id: 'item-1', observation: 'test' }],
      narration: 'This is the narrated digest text.'
    });

    const row = db.prepare(
      "SELECT narration FROM digest_snapshots WHERE account_id = ? AND snapshot_date = ? AND cadence = ?"
    ).get(acct.id, '2026-03-16', 'daily');
    assert.strictEqual(row.narration, 'This is the narrated digest text.');
    console.log('  PASS: saveSnapshot stores narration text');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: saveSnapshot works without narration (backward compat) ---
function testSaveSnapshotWithoutNarration() {
  const { db, reticleDb, acct, tmpPath } = setupTestDb();
  try {
    reticleDb.saveSnapshot(db, acct.id, {
      snapshotDate: '2026-03-16',
      cadence: 'daily',
      items: [{ id: 'item-1' }]
    });

    const row = db.prepare(
      "SELECT narration FROM digest_snapshots WHERE account_id = ? AND snapshot_date = ? AND cadence = ?"
    ).get(acct.id, '2026-03-16', 'daily');
    assert.strictEqual(row.narration, null, 'narration should be null when not provided');
    console.log('  PASS: saveSnapshot without narration (backward compat)');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: getLatestSnapshot returns most recent for cadence ---
function testGetLatestSnapshot() {
  const { db, reticleDb, acct, tmpPath } = setupTestDb();
  try {
    reticleDb.saveSnapshot(db, acct.id, {
      snapshotDate: '2026-03-14',
      cadence: 'weekly',
      items: [{ id: 'old' }],
      narration: 'old narration'
    });
    reticleDb.saveSnapshot(db, acct.id, {
      snapshotDate: '2026-03-15',
      cadence: 'daily',
      items: [{ id: 'daily-item' }],
      narration: 'daily narration'
    });
    reticleDb.saveSnapshot(db, acct.id, {
      snapshotDate: '2026-03-16',
      cadence: 'weekly',
      items: [{ id: 'new' }],
      narration: 'new narration'
    });

    const latest = reticleDb.getLatestSnapshot(db, 'weekly');
    assert.ok(latest, 'Should return a snapshot');
    assert.strictEqual(latest.snapshot_date, '2026-03-16');
    assert.strictEqual(latest.narration, 'new narration');
    assert.ok(Array.isArray(latest.items), 'items should be parsed from JSON');
    assert.strictEqual(latest.items[0].id, 'new');
    console.log('  PASS: getLatestSnapshot returns most recent for cadence');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: getLatestSnapshot returns undefined when no snapshots ---
function testGetLatestSnapshotEmpty() {
  const { db, reticleDb, tmpPath } = setupTestDb();
  try {
    const result = reticleDb.getLatestSnapshot(db, 'weekly');
    assert.strictEqual(result, undefined, 'Should return undefined when no snapshots exist');
    console.log('  PASS: getLatestSnapshot returns undefined for empty');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: getSnapshotHistory returns last N rows ---
function testGetSnapshotHistory() {
  const { db, reticleDb, acct, tmpPath } = setupTestDb();
  try {
    for (let i = 1; i <= 6; i++) {
      reticleDb.saveSnapshot(db, acct.id, {
        snapshotDate: `2026-03-${String(i).padStart(2, '0')}`,
        cadence: 'daily',
        items: [{ id: `item-${i}` }],
        narration: `narration ${i}`
      });
    }

    const history = reticleDb.getSnapshotHistory(db, 'daily', 4);
    assert.strictEqual(history.length, 4, 'Should return 4 rows');
    // Most recent first
    assert.strictEqual(history[0].snapshot_date, '2026-03-06');
    assert.strictEqual(history[3].snapshot_date, '2026-03-03');
    // Items parsed
    assert.ok(Array.isArray(history[0].items));
    // Narration present
    assert.strictEqual(history[0].narration, 'narration 6');
    console.log('  PASS: getSnapshotHistory returns last N rows');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: getSnapshotHistory default limit ---
function testGetSnapshotHistoryDefaultLimit() {
  const { db, reticleDb, acct, tmpPath } = setupTestDb();
  try {
    for (let i = 1; i <= 6; i++) {
      reticleDb.saveSnapshot(db, acct.id, {
        snapshotDate: `2026-03-${String(i).padStart(2, '0')}`,
        cadence: 'daily',
        items: [{ id: `item-${i}` }]
      });
    }

    const history = reticleDb.getSnapshotHistory(db, 'daily');
    assert.strictEqual(history.length, 4, 'Default limit should be 4');
    console.log('  PASS: getSnapshotHistory default limit is 4');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: getSnapshotHistory caps at 12 ---
function testGetSnapshotHistoryMaxLimit() {
  const { db, reticleDb, acct, tmpPath } = setupTestDb();
  try {
    for (let i = 1; i <= 15; i++) {
      reticleDb.saveSnapshot(db, acct.id, {
        snapshotDate: `2026-03-${String(i).padStart(2, '0')}`,
        cadence: 'daily',
        items: [{ id: `item-${i}` }]
      });
    }

    const history = reticleDb.getSnapshotHistory(db, 'daily', 50);
    assert.strictEqual(history.length, 12, 'Max limit should be 12');
    console.log('  PASS: getSnapshotHistory caps at 12');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// ============================================================================
// INTEGRATION TESTS — Gateway digest endpoints (HTTP-level)
// ============================================================================

function httpRequest(port, method, urlPath) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path: urlPath, method };
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(chunks) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function clearGatewayCache() {
  for (const mod of ['./gateway', './lib/org-memory-db', './reticle-db']) {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
  }
}

async function testDigestEndpoints() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticle-digest-gw-test-'));
  const orgMemDbPath = path.join(tmpDir, 'org-memory.db');
  const reticleDbPath = path.join(tmpDir, 'reticle.db');

  process.env.ORG_MEMORY_DB_PATH = orgMemDbPath;
  process.env.RETICLE_DB_PATH = reticleDbPath;

  // Initialize org-memory DB (gateway needs it)
  const { initDatabase: initOrgMemory } = require('./lib/org-memory-db');
  initOrgMemory(orgMemDbPath);

  clearGatewayCache();

  // Initialize reticle DB and seed snapshots
  const reticleDb = require('./reticle-db');
  const db = reticleDb.initDatabase();
  const acct = reticleDb.upsertAccount(db, {
    email: 'test@example.com',
    provider: 'gmail',
    display_name: 'Test',
    is_primary: 1
  });

  // Seed snapshots
  reticleDb.saveSnapshot(db, acct.id, {
    snapshotDate: '2026-03-03',
    cadence: 'weekly',
    items: [{ id: 'w1' }],
    narration: 'Week 1 narration'
  });
  reticleDb.saveSnapshot(db, acct.id, {
    snapshotDate: '2026-03-10',
    cadence: 'weekly',
    items: [{ id: 'w2' }],
    narration: 'Week 2 narration'
  });
  // 6 daily snapshots: 2026-03-10 through 2026-03-15
  for (let i = 10; i <= 15; i++) {
    reticleDb.saveSnapshot(db, acct.id, {
      snapshotDate: `2026-03-${i}`,
      cadence: 'daily',
      items: [{ id: `d${i}` }],
      narration: i === 15 ? 'Latest daily narration' : null
    });
  }

  clearGatewayCache();
  const app = require('./gateway');
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Test 1: GET /api/digest/latest?cadence=weekly
    const latestWeekly = await httpRequest(port, 'GET', '/api/digest/latest?cadence=weekly');
    assert.strictEqual(latestWeekly.status, 200);
    assert.ok(latestWeekly.body.snapshot, 'Response should have snapshot');
    assert.strictEqual(latestWeekly.body.snapshot.snapshotDate, '2026-03-10');
    assert.strictEqual(latestWeekly.body.snapshot.narration, 'Week 2 narration');
    assert.ok(Array.isArray(latestWeekly.body.snapshot.items), 'items should be an array');
    console.log('  PASS: GET /api/digest/latest?cadence=weekly returns most recent');

    // Test 2: GET /api/digest/latest?cadence=daily
    const latestDaily = await httpRequest(port, 'GET', '/api/digest/latest?cadence=daily');
    assert.strictEqual(latestDaily.status, 200);
    assert.strictEqual(latestDaily.body.snapshot.snapshotDate, '2026-03-15');
    assert.strictEqual(latestDaily.body.snapshot.narration, 'Latest daily narration');
    console.log('  PASS: GET /api/digest/latest?cadence=daily returns most recent');

    // Test 3: GET /api/digest/latest without cadence returns 400
    const noCadence = await httpRequest(port, 'GET', '/api/digest/latest');
    assert.strictEqual(noCadence.status, 400);
    assert.ok(noCadence.body.error);
    console.log('  PASS: GET /api/digest/latest without cadence returns 400');

    // Test 4: GET /api/digest/latest for nonexistent cadence returns empty
    const noData = await httpRequest(port, 'GET', '/api/digest/latest?cadence=monthly');
    assert.strictEqual(noData.status, 200);
    assert.strictEqual(noData.body.snapshot, null);
    console.log('  PASS: GET /api/digest/latest for empty cadence returns null');

    // Test 5: GET /api/digest/history?cadence=weekly&limit=4
    const histWeekly = await httpRequest(port, 'GET', '/api/digest/history?cadence=weekly&limit=4');
    assert.strictEqual(histWeekly.status, 200);
    assert.ok(Array.isArray(histWeekly.body.snapshots), 'Response should have snapshots array');
    assert.strictEqual(histWeekly.body.snapshots.length, 2);
    assert.strictEqual(histWeekly.body.snapshots[0].snapshotDate, '2026-03-10');
    assert.strictEqual(histWeekly.body.snapshots[1].snapshotDate, '2026-03-03');
    console.log('  PASS: GET /api/digest/history?cadence=weekly returns ordered list');

    // Test 6: GET /api/digest/history?cadence=daily (default limit=4)
    const histDaily = await httpRequest(port, 'GET', '/api/digest/history?cadence=daily');
    assert.strictEqual(histDaily.status, 200);
    assert.strictEqual(histDaily.body.snapshots.length, 4, 'Default limit should be 4');
    console.log('  PASS: GET /api/digest/history default limit is 4');

    // Test 7: GET /api/digest/history without cadence returns 400
    const histNoCadence = await httpRequest(port, 'GET', '/api/digest/history');
    assert.strictEqual(histNoCadence.status, 400);
    assert.ok(histNoCadence.body.error);
    console.log('  PASS: GET /api/digest/history without cadence returns 400');

    // Test 8: GET /api/digest/history with limit > 12 caps at 12
    const histBigLimit = await httpRequest(port, 'GET', '/api/digest/history?cadence=daily&limit=50');
    assert.strictEqual(histBigLimit.status, 200);
    // We have 6 daily snapshots (d1 + d11-d15), so limited by available data
    assert.ok(histBigLimit.body.snapshots.length <= 12, 'Limit should be capped at 12');
    assert.strictEqual(histBigLimit.body.snapshots.length, 6, 'Should return all 6 daily snapshots');
    console.log('  PASS: GET /api/digest/history caps limit at 12');

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

// --- Run all tests ---

console.log('digest API tests:');

// Unit tests (sync)
testNarrationColumnExists();
testSaveSnapshotWithNarration();
testSaveSnapshotWithoutNarration();
testGetLatestSnapshot();
testGetLatestSnapshotEmpty();
testGetSnapshotHistory();
testGetSnapshotHistoryDefaultLimit();
testGetSnapshotHistoryMaxLimit();

// Integration tests (async)
testDigestEndpoints()
  .then(() => {
    console.log('All digest API tests passed');
    process.exit(0);
  })
  .catch(err => {
    console.error('FAIL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
