'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests
const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-test-conv-tracker-${Date.now()}.db`);
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
  email: 'tracker-test@example.com',
  provider: 'gmail',
  display_name: 'Tracker Test',
  is_primary: 1
});

// --- Mock slackReader ---
function mockSlackReader({ users = {}, channels = {} } = {}) {
  const calls = { getUserInfo: [], getConversationInfo: [] };
  return {
    calls,
    async getUserInfo(userId) {
      calls.getUserInfo.push(userId);
      return users[userId] || userId;
    },
    async getConversationInfo(channelId) {
      calls.getConversationInfo.push(channelId);
      return channels[channelId] || channelId;
    }
  };
}

// Stub logger
const log = {
  debug() {},
  warn() {},
  error() {}
};

(async () => {

// --- Test: DM stores resolved user name ---
{
  const reader = mockSlackReader({ users: { 'U09FA2P72F9': 'Daniel Sherr' } });
  const { trackSlackConversation } = require('./lib/conversation-tracker');

  await trackSlackConversation({
    db, accountId: acct.id, slackReader: reader, reticleDb, log
  }, {
    user: 'U09FA2P72F9',
    channel: 'D12345',
    channel_type: 'im',
    text: 'Hey, got a minute?',
    ts: '1711300000.000001'
  }, 'incoming');

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('slack:dm:U09FA2P72F9');
  assert.strictEqual(conv.from_name, 'Daniel Sherr', 'DM should store resolved user name');
  assert.strictEqual(conv.waiting_for, 'my-response');
  assert.deepStrictEqual(reader.calls.getUserInfo, ['U09FA2P72F9'], 'Should call getUserInfo');
  assert.deepStrictEqual(reader.calls.getConversationInfo, [], 'Should NOT call getConversationInfo for DMs');
  console.log('PASS: DM stores resolved user name');
}

// --- Test: Mention stores resolved channel name and user name ---
{
  const reader = mockSlackReader({
    users: { 'U04LCV7A8': 'Mike Johnson' },
    channels: { 'C0ENGINEERING': 'engineering' }
  });
  const { trackSlackConversation } = require('./lib/conversation-tracker');

  await trackSlackConversation({
    db, accountId: acct.id, slackReader: reader, reticleDb, log
  }, {
    user: 'U04LCV7A8',
    channel: 'C0ENGINEERING',
    channel_type: 'channel',
    text: 'Hey @reticle check this out',
    ts: '1711300100.000001'
  }, 'incoming');

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('slack:mention:C0ENGINEERING-1711300100.000001');
  assert.strictEqual(conv.from_name, 'Mike Johnson', 'Mention should store resolved user name');
  assert.strictEqual(conv.channel_name, 'engineering', 'Mention should store resolved channel name');
  assert.strictEqual(conv.channel_id, 'C0ENGINEERING', 'Should store channel_id');
  assert.deepStrictEqual(reader.calls.getUserInfo, ['U04LCV7A8']);
  assert.deepStrictEqual(reader.calls.getConversationInfo, ['C0ENGINEERING']);
  console.log('PASS: Mention stores resolved channel name and user name');
}

// --- Test: Outgoing DM flips existing conversation ---
{
  const reader = mockSlackReader({ users: { 'UOTHER': 'Other Person' } });
  const { trackSlackConversation } = require('./lib/conversation-tracker');

  // First: incoming DM creates a conversation waiting for my-response
  await trackSlackConversation({
    db, accountId: acct.id, slackReader: reader, reticleDb, log
  }, {
    user: 'UOTHER',
    channel: 'D99999',
    channel_type: 'im',
    text: 'Hey, got a question',
    ts: '1711300100.000001'
  }, 'incoming');

  const before = db.prepare('SELECT * FROM conversations WHERE channel_id = ? AND type = ?').get('D99999', 'slack-dm');
  assert.strictEqual(before.waiting_for, 'my-response', 'Incoming should set waiting_for=my-response');

  // Then: outgoing reply flips to their-response
  await trackSlackConversation({
    db, accountId: acct.id, slackReader: reader, reticleDb, log
  }, {
    user: 'UMYSELF',
    channel: 'D99999',
    channel_type: 'im',
    text: 'Sure, what is it?',
    ts: '1711300200.000001'
  }, 'outgoing');

  const after = db.prepare('SELECT * FROM conversations WHERE channel_id = ? AND type = ?').get('D99999', 'slack-dm');
  assert.strictEqual(after.waiting_for, 'their-response', 'Outgoing reply should flip to their-response');
  console.log('PASS: Outgoing DM flips existing conversation');
}

// --- Test: getUserInfo failure degrades gracefully ---
{
  const failReader = {
    calls: { getUserInfo: [], getConversationInfo: [] },
    async getUserInfo(userId) {
      failReader.calls.getUserInfo.push(userId);
      throw new Error('Slack API down');
    },
    async getConversationInfo(channelId) {
      failReader.calls.getConversationInfo.push(channelId);
      return 'general';
    }
  };
  const { trackSlackConversation } = require('./lib/conversation-tracker');

  await trackSlackConversation({
    db, accountId: acct.id, slackReader: failReader, reticleDb, log
  }, {
    user: 'UFAILUSER',
    channel: 'CFAILCHAN',
    channel_type: 'channel',
    text: 'This should still be tracked',
    ts: '1711300300.000001'
  }, 'incoming');

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('slack:mention:CFAILCHAN-1711300300.000001');
  assert.ok(conv, 'Conversation should still be tracked despite API failure');
  assert.strictEqual(conv.from_name, null, 'from_name should be null when getUserInfo fails');
  assert.strictEqual(conv.channel_name, 'general', 'channel_name should still resolve when only getUserInfo fails');
  console.log('PASS: getUserInfo failure degrades gracefully');
}

// --- Test: null DB is handled safely ---
{
  const reader = mockSlackReader({ users: { 'UTEST': 'Test' } });
  const { trackSlackConversation } = require('./lib/conversation-tracker');
  const warnCalls = [];
  const warnLog = { ...log, warn(msg) { warnCalls.push(msg); } };

  await trackSlackConversation({
    db: null, accountId: acct.id, slackReader: reader, reticleDb, log: warnLog
  }, {
    user: 'UTEST',
    channel: 'D00000',
    channel_type: 'im',
    text: 'ignored',
    ts: '1711300400.000001'
  }, 'incoming');

  assert.deepStrictEqual(reader.calls.getUserInfo, [], 'Should not call Slack API when db is null');
  assert.ok(warnCalls.length > 0, 'Should log a warning when db is null');
  console.log('PASS: null DB handled safely without API calls');
}

console.log('\n=== ALL CONVERSATION TRACKER TESTS PASSED ===');

})();
