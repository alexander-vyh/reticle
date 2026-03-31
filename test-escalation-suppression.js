'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests
const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-escalation-test-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

const reticleDb = require('./reticle-db');

// Cleanup on exit
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

// Helper: insert a conversation with specific timestamps
function insertConversation(id, type, lastActivity, notifiedAt = null) {
  db.prepare(`
    INSERT INTO conversations (id, account_id, type, from_user, from_name, state, waiting_for, first_seen, last_activity, notified_at)
    VALUES (?, ?, ?, 'someone', 'Someone', 'active', 'my-response', ?, ?, ?)
  `).run(id, acct.id, type, lastActivity, lastActivity, notifiedAt);
}

const now = Math.floor(Date.now() / 1000);
const EIGHT_DAYS_AGO = now - (8 * 24 * 3600);  // Well past 7-day slack-mention escalation threshold
const THREE_SECONDS_AGO = now - 3;               // Simulates check4Hour() just ran

// --- TEST: Escalation fires for old conversation with no prior notification ---
insertConversation('slack:mention:C123-old-clean', 'slack-mention', EIGHT_DAYS_AGO, null);

const pending1 = reticleDb.getPendingResponses(db, acct.id);
const conv1 = pending1.find(c => c.id === 'slack:mention:C123-old-clean');
assert.ok(conv1, 'Conversation should be in pending responses');

const age1 = now - conv1.last_activity;
const threshold = 7 * 24 * 3600; // 1 week for slack-mention
assert.ok(age1 > threshold, 'Conversation should be older than escalation threshold');
// With no notified_at, escalation should fire
assert.strictEqual(conv1.notified_at, null, 'notified_at should be null');
console.log('PASS: old conversation with no notified_at is eligible for escalation');


// --- TEST: The bug — escalation suppressed after check4Hour marks notified ---
// Simulate what happens in production:
// 1. check4Hour() runs and calls markNotified() on the conversation
// 2. checkEscalations() runs immediately after and checks conv.notified_at
insertConversation('slack:mention:C456-old-suppressed', 'slack-mention', EIGHT_DAYS_AGO, null);

// Step 1: Simulate check4Hour() calling markNotified
reticleDb.markNotified(db, 'slack:mention:C456-old-suppressed');

// Step 2: Re-fetch and check escalation eligibility (same logic as checkEscalations)
const pending2 = reticleDb.getPendingResponses(db, acct.id);
const conv2 = pending2.find(c => c.id === 'slack:mention:C456-old-suppressed');
const age2 = now - conv2.last_activity;
const lastEscalation2 = conv2.notified_at;

// The escalation check from followup-checker.js line 390-392:
// if (age > threshold) { return !lastEscalation || (now - lastEscalation) > 86400; }
const wouldEscalate = age2 > threshold && (!lastEscalation2 || (now - lastEscalation2) > 86400);

// THIS IS THE BUG: wouldEscalate should be true (8 days old!), but markNotified
// just set notified_at to now, so (now - lastEscalation) is ~0, which is < 86400
assert.strictEqual(wouldEscalate, false, 'BUG CONFIRMED: markNotified from 4h-batch suppresses escalation');
console.log('PASS: bug confirmed — markNotified from 4h-batch suppresses escalation');


// --- TEST: escalated_at column exists and is independent of notified_at ---
const cols = db.pragma('table_info(conversations)').map(c => c.name);
assert.ok(cols.includes('escalated_at'), 'conversations table should have escalated_at column');
console.log('PASS: escalated_at column exists');


// --- TEST: markEscalated sets escalated_at independently ---
insertConversation('slack:mention:C789-escalation-test', 'slack-mention', EIGHT_DAYS_AGO, null);

// Mark notified (simulating 4h-batch)
reticleDb.markNotified(db, 'slack:mention:C789-escalation-test');

// Mark escalated should set escalated_at, not touch notified_at timing
reticleDb.markEscalated(db, 'slack:mention:C789-escalation-test');

const conv3 = db.prepare('SELECT notified_at, escalated_at FROM conversations WHERE id = ?')
  .get('slack:mention:C789-escalation-test');
assert.ok(conv3.notified_at, 'notified_at should be set');
assert.ok(conv3.escalated_at, 'escalated_at should be set');
console.log('PASS: markEscalated sets escalated_at independently of notified_at');


// --- TEST: Escalation uses escalated_at, not notified_at, for re-escalation check ---
insertConversation('slack:mention:C999-reescalation', 'slack-mention', EIGHT_DAYS_AGO, null);

// Simulate: 4h-batch just notified (notified_at = now)
reticleDb.markNotified(db, 'slack:mention:C999-reescalation');

// No prior escalation — escalated_at is null
const conv4 = db.prepare('SELECT notified_at, escalated_at FROM conversations WHERE id = ?')
  .get('slack:mention:C999-reescalation');

const age4 = now - EIGHT_DAYS_AGO;
const lastEscalatedAt = conv4.escalated_at;

// New escalation logic: check escalated_at, not notified_at
const wouldEscalateFixed = age4 > threshold && (!lastEscalatedAt || (now - lastEscalatedAt) > 86400);
assert.strictEqual(wouldEscalateFixed, true, 'Escalation should fire when using escalated_at (null = never escalated)');
console.log('PASS: escalation fires correctly when checking escalated_at instead of notified_at');


// --- TEST: Re-escalation suppressed within 24h of last escalation ---
insertConversation('slack:mention:C000-no-reescalate', 'slack-mention', EIGHT_DAYS_AGO, null);
reticleDb.markEscalated(db, 'slack:mention:C000-no-reescalate');

const conv5 = db.prepare('SELECT escalated_at FROM conversations WHERE id = ?')
  .get('slack:mention:C000-no-reescalate');
const lastEscalated5 = conv5.escalated_at;
const wouldReEscalate = (now - EIGHT_DAYS_AGO) > threshold && (!lastEscalated5 || (now - lastEscalated5) > 86400);
assert.strictEqual(wouldReEscalate, false, 'Should NOT re-escalate within 24h of last escalation');
console.log('PASS: re-escalation correctly suppressed within 24h');


console.log('\n✅ All escalation suppression tests passed');
db.close();
