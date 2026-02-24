'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB
const TEST_DB_PATH = path.join(os.tmpdir(), `claudia-collector-test-${Date.now()}.db`);
process.env.CLAUDIA_DB_PATH = TEST_DB_PATH;

const claudiaDb = require('./claudia-db');
const { collectFollowups } = require('./lib/digest-collectors');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = claudiaDb.initDatabase();
const acct = claudiaDb.upsertAccount(db, {
  email: 'test@example.com', provider: 'gmail',
  display_name: 'Test User', is_primary: 1
});

// --- Seed test data ---
const now = Math.floor(Date.now() / 1000);

// Unreplied email: 52 hours old (should be high priority)
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:old-unreplied',
  type: 'email',
  subject: 'Q3 Budget Review',
  from_user: 'sarah@example.com',
  from_name: 'Sarah Chen',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now - (52 * 3600)
});

// Unreplied DM: 2 hours old (collected as low priority — under 24h threshold)
claudiaDb.trackConversation(db, acct.id, {
  id: 'slack-dm:recent',
  type: 'slack-dm',
  subject: 'Quick question',
  from_user: 'U12345',
  from_name: 'Dev Teammate',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now - (2 * 3600)
});

// Awaiting reply: 5 days old
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:awaiting-old',
  type: 'email',
  subject: 'Vendor Contract',
  from_user: 'me@example.com',
  from_name: 'Me',
  last_sender: 'me',
  waiting_for: 'their-response',
  last_activity: now - (5 * 86400)
});

// Resolved today
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:resolved-today',
  type: 'email',
  subject: 'Resolved Issue',
  from_user: 'boss@example.com',
  from_name: 'Boss',
  last_sender: 'them',
  waiting_for: 'my-response'
});
claudiaDb.resolveConversation(db, 'email:resolved-today');

// Stale conversation: 10 days inactive, not waiting for anyone
claudiaDb.trackConversation(db, acct.id, {
  id: 'slack-dm:stale-convo',
  type: 'slack-dm',
  subject: 'Old Discussion',
  from_user: 'U99999',
  from_name: 'Colleague',
  last_sender: 'them',
  waiting_for: null,
  last_activity: now - (10 * 86400)
});

// --- Test: collectFollowups ---
const items = collectFollowups(db, acct.id);

assert.ok(Array.isArray(items), 'Should return an array');
assert.ok(items.length >= 4, `Should have at least 4 items, got ${items.length}`);

// Check the old unreplied email is high priority
const oldUnreplied = items.find(i => i.entityId === 'email:old-unreplied');
assert.ok(oldUnreplied, 'Should include 52h unreplied email');
assert.strictEqual(oldUnreplied.priority, 'high', '48-72h unreplied should be high');
assert.strictEqual(oldUnreplied.category, 'unreplied');
assert.strictEqual(oldUnreplied.collector, 'followup');
assert.ok(oldUnreplied.observation.includes('Sarah Chen'), 'Observation should name the counterparty');
assert.ok(oldUnreplied.reason, 'Must have a reason');
assert.ok(oldUnreplied.authority, 'Must have authority');
assert.ok(oldUnreplied.consequence, 'Must have consequence');
console.log('PASS: old unreplied email is high priority with full explainability');

// Check awaiting reply
const awaitingItem = items.find(i => i.entityId === 'email:awaiting-old');
assert.ok(awaitingItem, 'Should include 5-day awaiting reply');
assert.strictEqual(awaitingItem.category, 'awaiting');
assert.strictEqual(awaitingItem.priority, 'normal', '3-7d awaiting should be normal');
console.log('PASS: awaiting reply item with correct priority');

// Check resolved today (low priority positive signal)
const resolvedItem = items.find(i => i.entityId === 'email:resolved-today');
assert.ok(resolvedItem, 'Should include resolved-today');
assert.strictEqual(resolvedItem.category, 'resolved-today');
assert.strictEqual(resolvedItem.priority, 'low');
console.log('PASS: resolved-today is low priority positive signal');

// Check stale conversation
const staleItem = items.find(i => i.entityId === 'slack-dm:stale-convo');
assert.ok(staleItem, 'Should include 10-day stale conversation');
assert.strictEqual(staleItem.category, 'stale');
assert.strictEqual(staleItem.priority, 'normal', 'Stale items should be normal priority');
console.log('PASS: stale conversation detected with normal priority');

// All items should have the DigestItem shape
for (const item of items) {
  assert.ok(item.id, `Item missing id: ${JSON.stringify(item)}`);
  assert.ok(item.observation, `Item missing observation: ${item.id}`);
  assert.ok(item.reason, `Item missing reason: ${item.id}`);
  assert.ok(item.authority, `Item missing authority: ${item.id}`);
  assert.ok(item.consequence, `Item missing consequence: ${item.id}`);
}
console.log('PASS: all items have full DigestItem shape');

console.log('\n=== FOLLOW-UP COLLECTOR TESTS PASSED ===');

// ============================================================
// EMAIL COLLECTOR TESTS
// ============================================================

const { collectEmail } = require('./lib/digest-collectors');

// --- Seed email data ---
claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: 'gmail-001', thread_id: 'thread-001',
  from_addr: 'vip@example.com', from_name: 'VIP Boss',
  subject: 'Urgent request', date: now - 3600,
  direction: 'inbound'
});
claudiaDb.upsertEmail(db, acct.id, {
  gmail_id: 'gmail-002', thread_id: 'thread-002',
  from_addr: 'test@example.com', to_addrs: ['someone@example.com'],
  subject: 'Sent by me', date: now - 7200,
  direction: 'outbound'
});

// Log a commitment action
claudiaDb.logAction(db, {
  accountId: acct.id, actor: 'user', entityType: 'email', entityId: 'gmail-001',
  action: 'commitment', context: { text: 'I will review the RFC by Friday' }
});

const vipEmails = ['vip@example.com'];

// Seed a conversation for the VIP email so vip-unreplied path is exercised
claudiaDb.trackConversation(db, acct.id, {
  id: 'email:vip-unreplied',
  type: 'email',
  subject: 'Urgent request',
  from_user: 'vip@example.com',
  from_name: 'VIP Boss',
  last_sender: 'them',
  waiting_for: 'my-response',
  last_activity: now - (6 * 3600)
});

const emailItems = collectEmail(db, acct.id, { vipEmails });

assert.ok(Array.isArray(emailItems));

// Should have volume item
const volumeItem = emailItems.find(i => i.category === 'email-volume');
assert.ok(volumeItem, 'Should include email volume');
assert.strictEqual(volumeItem.priority, 'low');
console.log('PASS: email volume item');

// Should have commitment item
const commitItem = emailItems.find(i => i.category === 'commitment');
assert.ok(commitItem, 'Should include commitment from action log');
assert.ok(commitItem.observation.includes('review the RFC'), 'Should include commitment text');
console.log('PASS: commitment item');

// Should have VIP unreplied item
const vipItem = emailItems.find(i => i.category === 'vip-unreplied');
assert.ok(vipItem, 'Should include VIP unreplied item');
assert.strictEqual(vipItem.priority, 'high');
assert.ok(vipItem.observation.includes('VIP unreplied'), 'Should indicate VIP status');
console.log('PASS: VIP unreplied item');

console.log('\n=== EMAIL COLLECTOR TESTS PASSED ===');

// ============================================================
// O3 COLLECTOR TESTS
// ============================================================

const { collectO3 } = require('./lib/digest-collectors');

// --- Seed O3 data ---
claudiaDb.upsertO3Session(db, acct.id, {
  id: 'cal-o3-1',
  report_name: 'Jane Smith',
  report_email: 'jane@example.com',
  scheduled_start: now - (2 * 86400), // 2 days ago
  scheduled_end: now - (2 * 86400) + 1800,
  created_at: now - (3 * 86400)
});
// This O3 happened but Lattice not logged
claudiaDb.markO3Notified(db, 'cal-o3-1', 'prep_sent_before');

// Upcoming O3: tomorrow
claudiaDb.upsertO3Session(db, acct.id, {
  id: 'cal-o3-2',
  report_name: 'Dev Reyes',
  report_email: 'dev@example.com',
  scheduled_start: now + 86400,
  scheduled_end: now + 86400 + 1800,
  created_at: now
});

const o3Items = collectO3(db, acct.id);

assert.ok(Array.isArray(o3Items));

// Should flag the incomplete O3
const incomplete = o3Items.find(i => i.category === 'o3-incomplete');
assert.ok(incomplete, 'Should flag O3 without Lattice entry');
assert.strictEqual(incomplete.priority, 'high');
assert.ok(incomplete.observation.includes('Jane Smith'), 'Should name the report');
console.log('PASS: O3 incomplete flagged');

// Should show upcoming O3
const upcoming = o3Items.find(i => i.category === 'o3-upcoming');
assert.ok(upcoming, 'Should show upcoming O3');
assert.ok(upcoming.observation.includes('Dev Reyes'));
console.log('PASS: O3 upcoming shown');

console.log('\n=== O3 COLLECTOR TESTS PASSED ===');
