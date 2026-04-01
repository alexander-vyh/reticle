'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-slack-closure-test-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

const reticleDb = require('./reticle-db');
const { trackSlackConversation } = require('./lib/conversation-tracker');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = reticleDb.initDatabase();
const acct = reticleDb.upsertAccount(db, {
  email: 'test@example.com', provider: 'gmail', display_name: 'Test', is_primary: 1
});
const accountId = acct.id;

const slackReader = {
  getUserInfo: async (userId) => `User-${userId}`,
  getConversationInfo: async (channelId) => `Channel-${channelId}`,
};
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const deps = { db, accountId, slackReader, reticleDb, log };

// ── Test: DM reply flips existing conversation to their-response ──

async function testDmReplyFlips() {
  // Someone DMs Alexander
  await trackSlackConversation(deps, {
    channel: 'D_DM_CHAN_1', channel_type: 'im', user: 'U_OTHER',
    text: 'Hey can you check the deploy?', ts: '1000.000'
  }, 'incoming');

  let conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('slack:dm:U_OTHER');
  assert.strictEqual(conv.waiting_for, 'my-response');
  assert.strictEqual(conv.channel_id, 'D_DM_CHAN_1');

  // Alexander replies in the same DM channel
  await trackSlackConversation(deps, {
    channel: 'D_DM_CHAN_1', channel_type: 'im', user: 'U_ALEXANDER',
    text: 'Done, just deployed it', ts: '1001.000'
  }, 'outgoing');

  // The ORIGINAL conversation (slack:dm:U_OTHER) should be flipped
  conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('slack:dm:U_OTHER');
  assert.strictEqual(conv.waiting_for, 'their-response', 'DM reply should flip original conversation to their-response');
  assert.strictEqual(conv.state, 'active', 'DM should stay active (ongoing conversation)');

  // No spurious slack:dm:U_ALEXANDER record should exist
  const spurious = db.prepare('SELECT * FROM conversations WHERE id = ?').get('slack:dm:U_ALEXANDER');
  assert.strictEqual(spurious, undefined, 'Should NOT create a separate conversation for Alexander');
  console.log('PASS: DM reply flips original conversation, no spurious record');
}

// ── Test: Channel mention reply auto-resolves ──

async function testChannelMentionReplyResolves() {
  await trackSlackConversation(deps, {
    channel: 'C_GENERAL', channel_type: 'channel', user: 'U_OTHER',
    text: '<@U_ALEXANDER> can you review PR #42?', ts: '2000.000'
  }, 'incoming');

  const mentionId = 'slack:mention:C_GENERAL-2000.000';
  let conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(mentionId);
  assert.strictEqual(conv.waiting_for, 'my-response');
  assert.strictEqual(conv.state, 'active');

  // Alexander replies in the same thread
  await trackSlackConversation(deps, {
    channel: 'C_GENERAL', channel_type: 'channel', user: 'U_ALEXANDER',
    text: 'LGTM, approved', ts: '2001.000', thread_ts: '2000.000'
  }, 'outgoing');

  conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(mentionId);
  assert.strictEqual(conv.state, 'resolved', 'Channel mention should auto-resolve when Alexander replies in thread');
  assert.ok(conv.resolved_at, 'resolved_at should be set');
  console.log('PASS: channel mention auto-resolves on thread reply');
}

// ── Test: Top-level channel message does NOT resolve mentions ──

async function testTopLevelChannelMessageNoResolve() {
  await trackSlackConversation(deps, {
    channel: 'C_DEV', channel_type: 'channel', user: 'U_OTHER',
    text: '<@U_ALEXANDER> deploy broke', ts: '3000.000'
  }, 'incoming');

  // Alexander posts a top-level message (no thread_ts)
  await trackSlackConversation(deps, {
    channel: 'C_DEV', channel_type: 'channel', user: 'U_ALEXANDER',
    text: 'Starting the release', ts: '3001.000'
  }, 'outgoing');

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?')
    .get('slack:mention:C_DEV-3000.000');
  assert.strictEqual(conv.state, 'active');
  assert.strictEqual(conv.waiting_for, 'my-response');
  console.log('PASS: top-level channel message does not resolve mentions');
}

// ── Test: Reply in wrong thread does NOT resolve unrelated mention ──

async function testWrongThreadNoResolve() {
  await trackSlackConversation(deps, {
    channel: 'C_GENERAL', channel_type: 'channel', user: 'U_OTHER2',
    text: '<@U_ALEXANDER> budget question', ts: '4000.000'
  }, 'incoming');

  // Alexander replies in a DIFFERENT thread
  await trackSlackConversation(deps, {
    channel: 'C_GENERAL', channel_type: 'channel', user: 'U_ALEXANDER',
    text: 'Sounds good', ts: '4500.000', thread_ts: '3500.000'
  }, 'outgoing');

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?')
    .get('slack:mention:C_GENERAL-4000.000');
  assert.strictEqual(conv.state, 'active');
  console.log('PASS: reply in different thread does not resolve unrelated mention');
}

// ── Test: Already-resolved mention unaffected by subsequent reply ──

async function testAlreadyResolvedUnaffected() {
  await trackSlackConversation(deps, {
    channel: 'C_OPS', channel_type: 'channel', user: 'U_OTHER',
    text: '<@U_ALEXANDER> incident resolved', ts: '5000.000'
  }, 'incoming');

  const mentionId = 'slack:mention:C_OPS-5000.000';
  reticleDb.resolveConversation(db, mentionId);

  let conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(mentionId);
  const originalResolvedAt = conv.resolved_at;

  await trackSlackConversation(deps, {
    channel: 'C_OPS', channel_type: 'channel', user: 'U_ALEXANDER',
    text: 'Thanks for handling it', ts: '5001.000', thread_ts: '5000.000'
  }, 'outgoing');

  conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(mentionId);
  assert.strictEqual(conv.state, 'resolved');
  assert.strictEqual(conv.resolved_at, originalResolvedAt, 'resolved_at should not be overwritten');
  console.log('PASS: already-resolved mention unaffected');
}

// ── Test: Multiple pending DMs in same channel — reply resolves latest ──

async function testMultipleDmsSameChannel() {
  // U_MULTI sends two messages
  await trackSlackConversation(deps, {
    channel: 'D_MULTI_CHAN', channel_type: 'im', user: 'U_MULTI',
    text: 'First question', ts: '6000.000'
  }, 'incoming');
  await trackSlackConversation(deps, {
    channel: 'D_MULTI_CHAN', channel_type: 'im', user: 'U_MULTI',
    text: 'Second question', ts: '6001.000'
  }, 'incoming');

  // Both messages upsert the SAME conversation (slack:dm:U_MULTI)
  let conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('slack:dm:U_MULTI');
  assert.strictEqual(conv.waiting_for, 'my-response');

  // Alexander replies
  await trackSlackConversation(deps, {
    channel: 'D_MULTI_CHAN', channel_type: 'im', user: 'U_ALEXANDER',
    text: 'Here you go', ts: '6002.000'
  }, 'outgoing');

  conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('slack:dm:U_MULTI');
  assert.strictEqual(conv.waiting_for, 'their-response');
  console.log('PASS: DM reply flips conversation from same user');
}

(async () => {
  await testDmReplyFlips();
  await testChannelMentionReplyResolves();
  await testTopLevelChannelMessageNoResolve();
  await testWrongThreadNoResolve();
  await testAlreadyResolvedUnaffected();
  await testMultipleDmsSameChannel();
  console.log('\n✅ All Slack reply closure tests passed');
  db.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
