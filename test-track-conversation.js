'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests
const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-test-track-conv-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

const reticleDb = require('./reticle-db');

// Cleanup on exit
process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = reticleDb.initDatabase();

// --- Test: trackConversation works with a valid accountId ---
const acct = reticleDb.upsertAccount(db, {
  email: 'test@example.com',
  provider: 'gmail',
  display_name: 'Test User',
  is_primary: 1
});
assert.ok(acct.id, 'Account should have an id');

const now = Math.floor(Date.now() / 1000);
assert.doesNotThrow(() => {
  reticleDb.trackConversation(db, acct.id, {
    id: 'slack:dm:U12345',
    type: 'slack-dm',
    subject: 'Test conversation',
    from_user: 'U12345',
    from_name: 'testuser',
    last_activity: now,
    waiting_for: 'my-response',
    first_seen: now
  });
}, 'trackConversation should not throw with valid accountId');
console.log('PASS: trackConversation works with valid accountId');

// --- Test: trackConversation fails with null accountId (the bug) ---
assert.throws(() => {
  reticleDb.trackConversation(db, null, {
    id: 'slack:dm:U99999',
    type: 'slack-dm',
    subject: 'Null account test',
    from_user: 'U99999',
    from_name: 'nulluser',
    last_activity: now,
    waiting_for: 'my-response',
    first_seen: now
  });
}, /NOT NULL constraint failed/, 'trackConversation should throw with null accountId');
console.log('PASS: trackConversation correctly rejects null accountId');

// --- Test: upsertAccount with undefined email fails (the root cause) ---
assert.throws(() => {
  reticleDb.upsertAccount(db, {
    email: undefined,
    provider: 'gmail',
    display_name: 'Primary',
    is_primary: 1
  });
}, /NOT NULL constraint/, 'upsertAccount should throw with undefined email');
console.log('PASS: upsertAccount correctly rejects undefined email');

// --- Test: CONFIG.gmailAccount vs config.gmailAccount simulation ---
// This simulates the bug: using a property from wrong object
const CONFIG = {
  appToken: 'xapp-test',
  botToken: 'xoxb-test',
};
assert.strictEqual(CONFIG.gmailAccount, undefined,
  'CONFIG (uppercase) should not have gmailAccount');
console.log('PASS: CONFIG.gmailAccount is undefined (confirms bug source)');

console.log('\nAll trackConversation tests passed!');
