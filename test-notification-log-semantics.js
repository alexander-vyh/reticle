'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-notif-semantics-test-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

const reticleDb = require('./reticle-db');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = reticleDb.initDatabase();
const acct = reticleDb.upsertAccount(db, {
  email: 'test@example.com',
  provider: 'gmail',
  display_name: 'Test',
  is_primary: 1
});

const now = Math.floor(Date.now() / 1000);
const FIVE_HOURS_AGO = now - (5 * 3600);

// Insert 100 pending conversations
for (let i = 0; i < 100; i++) {
  db.prepare(`
    INSERT INTO conversations (id, account_id, type, from_user, from_name, state, waiting_for, first_seen, last_activity)
    VALUES (?, ?, ?, ?, ?, 'active', 'my-response', ?, ?)
  `).run(
    `slack:mention:C${String(i).padStart(3, '0')}-test`, acct.id,
    i < 5 ? 'slack-dm' : 'slack-mention',
    `user${i}`, `User ${i}`,
    FIVE_HOURS_AGO, FIVE_HOURS_AGO
  );
}


// --- TEST: logNotification with metadata ---
// The new behavior: one log row per batch with metadata
reticleDb.logNotification(db, acct.id, 'slack:mention:C000-test', '4h-batch', 'slack', {
  batchSize: 100,
  dms: 5,
  mentions: 95
});

const logRow = db.prepare(
  'SELECT * FROM notification_log WHERE account_id = ? ORDER BY id DESC LIMIT 1'
).get(acct.id);
assert.ok(logRow, 'notification row should exist');
assert.strictEqual(logRow.notification_type, '4h-batch');

const meta = JSON.parse(logRow.metadata);
assert.strictEqual(meta.batchSize, 100, 'metadata should contain batch size');
assert.strictEqual(meta.dms, 5, 'metadata should contain DM count');
assert.strictEqual(meta.mentions, 95, 'metadata should contain mention count');
console.log('PASS: logNotification stores metadata with batch counts');


// --- TEST: Only 1 log row per batch, not 100 ---
// Clear the log
db.prepare('DELETE FROM notification_log').run();

// Simulate the NEW check4Hour behavior: log once per batch
const pending = reticleDb.getPendingResponses(db, acct.id, {});
assert.ok(pending.length >= 100, 'Should have 100+ pending conversations');

// New behavior: ONE log row
reticleDb.logNotification(db, acct.id, pending[0].id, '4h-batch', 'slack', {
  batchSize: pending.length,
  dms: pending.filter(c => c.type === 'slack-dm').length,
  mentions: pending.filter(c => c.type === 'slack-mention').length
});

const logCount = db.prepare('SELECT COUNT(*) as c FROM notification_log').get().c;
assert.strictEqual(logCount, 1, 'Should have exactly 1 log row per batch, not 100');
console.log('PASS: one log row per batch notification');


// --- TEST: markNotified should still be called per-conversation for dedup ---
pending.forEach(conv => reticleDb.markNotified(db, conv.id));
const refetched = reticleDb.getPendingResponses(db, acct.id, {});
const allNotified = refetched.every(c => c.notified_at !== null);
assert.ok(allNotified, 'All conversations should have notified_at set');
console.log('PASS: markNotified still sets per-conversation notified_at for dedup');


// --- TEST: daily digest should also markNotified (prevents double-notification) ---
// Reset notified_at to simulate fresh state
db.prepare("UPDATE conversations SET notified_at = NULL WHERE account_id = ?").run(acct.id);

// Simulate daily digest: mark notified on all pending
const dailyPending = reticleDb.getPendingResponses(db, acct.id, {});
dailyPending.forEach(conv => reticleDb.markNotified(db, conv.id));

// Now check: conversations should not re-qualify for 4h-batch immediately
const recheck = reticleDb.getPendingResponses(db, acct.id, {
  olderThan: 4 * 3600
}).filter(conv => !conv.notified_at || (now - conv.notified_at) > 4 * 3600);

assert.strictEqual(recheck.length, 0, 'After daily digest marks notified, no conversations should re-qualify for 4h-batch');
console.log('PASS: daily digest markNotified prevents immediate 4h-batch re-notification');


console.log('\n✅ All notification log semantics tests passed');
db.close();
