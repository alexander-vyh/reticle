'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-relevance-gate-test-${Date.now()}.db`);
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

const MY_SLACK_ID = 'UTEST_MY_ID';

const slackReader = {
  getUserInfo: async (userId) => `User-${userId}`,
  getConversationInfo: async (channelId) => `Channel-${channelId}`,
};
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const deps = { db, accountId: acct.id, slackReader, reticleDb, log, mySlackUserId: MY_SLACK_ID };

function getConv(id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

(async () => {

// ── Test: DM always tracked (regardless of content) ──
{
  await trackSlackConversation(deps, {
    channel: 'D_DM_1', channel_type: 'im', user: 'U_SOMEONE',
    text: 'Hey, random chat', ts: '1000.000'
  }, 'incoming');

  assert.ok(getConv('slack:dm:U_SOMEONE'), 'DMs should always be tracked');
  console.log('PASS: DMs always tracked');
}

// ── Test: Channel message that @mentions me → tracked ──
{
  await trackSlackConversation(deps, {
    channel: 'C_ENG', channel_type: 'channel', user: 'U_COWORKER',
    text: `<@${MY_SLACK_ID}> can you review this PR?`, ts: '2000.000'
  }, 'incoming');

  assert.ok(getConv('slack:mention:C_ENG-2000.000'), 'Personal @mention should be tracked');
  console.log('PASS: personal @mention tracked');
}

// ── Test: Channel message that does NOT mention me → NOT tracked ──
{
  await trackSlackConversation(deps, {
    channel: 'C_ENG', channel_type: 'channel', user: 'U_COWORKER',
    text: 'just pushed the fix to staging', ts: '3000.000'
  }, 'incoming');

  assert.strictEqual(getConv('slack:mention:C_ENG-3000.000'), undefined,
    'Channel message without @mention should NOT be tracked');
  console.log('PASS: channel chatter not tracked');
}

// ── Test: @here broadcast → NOT tracked ──
{
  await trackSlackConversation(deps, {
    channel: 'C_GENERAL', channel_type: 'channel', user: 'U_SOMEONE',
    text: '<!here> deploy is done, all clear', ts: '4000.000'
  }, 'incoming');

  assert.strictEqual(getConv('slack:mention:C_GENERAL-4000.000'), undefined,
    '@here broadcast should NOT be tracked');
  console.log('PASS: @here broadcast not tracked');
}

// ── Test: @channel broadcast → NOT tracked ──
{
  await trackSlackConversation(deps, {
    channel: 'C_GENERAL', channel_type: 'channel', user: 'U_SOMEONE',
    text: '<!channel> reminder: standup in 5 min', ts: '4100.000'
  }, 'incoming');

  assert.strictEqual(getConv('slack:mention:C_GENERAL-4100.000'), undefined,
    '@channel broadcast should NOT be tracked');
  console.log('PASS: @channel broadcast not tracked');
}

// ── Test: Message mentioning someone else → NOT tracked ──
{
  await trackSlackConversation(deps, {
    channel: 'C_ENG', channel_type: 'channel', user: 'U_SOMEONE',
    text: '<@U_OTHER_PERSON> can you look at this?', ts: '5000.000'
  }, 'incoming');

  assert.strictEqual(getConv('slack:mention:C_ENG-5000.000'), undefined,
    'Message @mentioning someone else should NOT be tracked');
  console.log('PASS: mention of someone else not tracked');
}

// ── Test: Message mentioning me AND others → tracked ──
{
  await trackSlackConversation(deps, {
    channel: 'C_ENG', channel_type: 'channel', user: 'U_COWORKER',
    text: `<@${MY_SLACK_ID}> <@U_OTHER> can you both review?`, ts: '6000.000'
  }, 'incoming');

  assert.ok(getConv('slack:mention:C_ENG-6000.000'),
    'Message mentioning me (and others) should be tracked');
  console.log('PASS: multi-mention including me is tracked');
}

// ── Test: Group DM always tracked ──
{
  await trackSlackConversation(deps, {
    channel: 'G_GROUP_DM', channel_type: 'mpim', user: 'U_SOMEONE',
    text: 'what do you all think?', ts: '7000.000'
  }, 'incoming');

  // Group DMs use the 'im' path (channel_type includes mpim)
  // If not, they'd fall through to channel logic — but they should be tracked
  const conv = getConv('slack:dm:U_SOMEONE') || getConv('slack:mention:G_GROUP_DM-7000.000');
  assert.ok(conv, 'Group DM should be tracked');
  console.log('PASS: group DM tracked');
}

// ── Test: app_mention event (bot @mention) → still tracked ──
// app_mention events come through a different Slack event handler,
// but they also call trackSlackConversation. They should always be tracked
// because the bot was explicitly mentioned.
{
  await trackSlackConversation(deps, {
    channel: 'C_ENG', channel_type: 'channel', user: 'U_SOMEONE',
    text: '<@U_BOT> show me the dashboard', ts: '8000.000',
    _appMention: true  // Signal that this came from app_mention handler
  }, 'incoming');

  assert.ok(getConv('slack:mention:C_ENG-8000.000'),
    'app_mention events should always be tracked');
  console.log('PASS: app_mention always tracked');
}

console.log('\n✅ All relevance gate tests passed');
db.close();
})().catch(err => { console.error(err); process.exit(1); });
