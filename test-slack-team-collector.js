'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

// Use a temp DB for people-store data
const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-team-collector-test-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

// Prevent config.js from crashing on missing secrets
process.env.RETICLE_CONFIG_DIR = path.join(os.tmpdir(), `reticle-team-collector-config-${Date.now()}`);
fs.mkdirSync(process.env.RETICLE_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.RETICLE_CONFIG_DIR, 'secrets.json'), JSON.stringify({
  slackBotToken: 'xoxb-fake',
  slackUserId: 'U000',
  gmailAccount: 'test@example.com'
}));
fs.writeFileSync(path.join(process.env.RETICLE_CONFIG_DIR, 'team.json'), JSON.stringify({}));

// --- Mock slack-reader before requiring the module under test ---
const mockSlackReader = {
  _channels: [],
  _historyByChannel: {},

  async listConversations() {
    return mockSlackReader._channels;
  },

  async getConversationHistory(channelId, oldest, latest) {
    return (mockSlackReader._historyByChannel[channelId] || []).filter(m => {
      const ts = parseFloat(m.ts);
      if (oldest && ts < parseFloat(oldest)) return false;
      if (latest && ts > parseFloat(latest)) return false;
      return true;
    });
  },

  reset() {
    mockSlackReader._channels = [];
    mockSlackReader._historyByChannel = {};
  }
};

// Intercept require('./slack-reader') and require('../lib/slack-reader') etc.
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === './slack-reader' || request === '../slack-reader' || request === '../lib/slack-reader' || request === './lib/slack-reader') {
    // Return a sentinel so we can intercept _cache
    return '__mock_slack_reader__';
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
require.cache['__mock_slack_reader__'] = {
  id: '__mock_slack_reader__',
  filename: '__mock_slack_reader__',
  loaded: true,
  exports: mockSlackReader
};

const reticleDb = require('./reticle-db');
const { addPerson } = require('./lib/people-store');

process.on('exit', () => {
  Module._resolveFilename = originalResolveFilename;
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
  try { fs.rmSync(process.env.RETICLE_CONFIG_DIR, { recursive: true }); } catch {}
});

const db = reticleDb.initDatabase();

// --- Seed team members ---
addPerson(db, { email: 'alice@example.com', name: 'Alice Anderson', role: 'peer', team: 'cse' });
addPerson(db, { email: 'bob@example.com', name: 'Bob Baker', role: 'peer', team: 'desktop' });
addPerson(db, { email: 'carol@example.com', name: 'Carol Chen', role: 'peer', team: 'security' });

// Set Slack IDs for team members
const { updateSlackId } = require('./lib/people-store');
updateSlackId(db, 'alice@example.com', 'U_ALICE');
updateSlackId(db, 'bob@example.com', 'U_BOB');
updateSlackId(db, 'carol@example.com', 'U_CAROL');

// --- Time boundaries ---
const now = Math.floor(Date.now() / 1000);
const weekStart = now - (7 * 86400);
const weekEnd = now;

// --- Require the module under test ---
const { collectSlackTeamChannels, _resetChannelCache } = require('./lib/slack-team-collector');

// ============================================================
// TEST 1: Team member filtering — only team members included
// ============================================================
async function testTeamMemberFiltering() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'C_ENG', name: 'eng-platform' }
  ];
  mockSlackReader._historyByChannel = {
    C_ENG: [
      { type: 'message', user: 'U_ALICE', text: 'Deployed the new pipeline to production successfully', ts: String(now - 3600) },
      { type: 'message', user: 'U_OUTSIDER', text: 'This is from someone not on the team at all', ts: String(now - 3000) },
      { type: 'message', user: 'U_BOB', text: 'Working on the Terraform module for networking', ts: String(now - 2000) },
    ]
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  assert.ok(Array.isArray(result.messages), 'messages should be an array');
  assert.strictEqual(result.messages.length, 2, `Should have 2 team messages, got ${result.messages.length}`);

  const authors = result.messages.map(m => m.author);
  assert.ok(authors.includes('Alice Anderson'), 'Should include Alice');
  assert.ok(authors.includes('Bob Baker'), 'Should include Bob');
  assert.ok(!authors.some(a => a === 'U_OUTSIDER'), 'Should NOT include outsider');

  // Check message shape
  const aliceMsg = result.messages.find(m => m.author === 'Alice Anderson');
  assert.strictEqual(aliceMsg.authorTeam, 'cse');
  assert.strictEqual(aliceMsg.channel, 'eng-platform');
  assert.ok(aliceMsg.date.match(/^\d{4}-\d{2}-\d{2}$/), 'date should be YYYY-MM-DD');
  assert.ok(aliceMsg.content.includes('pipeline'), 'content should be message text');

  console.log('  PASS: team member filtering — only team members included');
}

// ============================================================
// TEST 2: Trivial message filtering
// ============================================================
async function testTrivialMessageFiltering() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'C_ENG', name: 'eng-platform' }
  ];
  mockSlackReader._historyByChannel = {
    C_ENG: [
      { type: 'message', user: 'U_ALICE', text: 'ok', ts: String(now - 5000) },
      { type: 'message', user: 'U_ALICE', text: 'thanks', ts: String(now - 4500) },
      { type: 'message', user: 'U_ALICE', text: 'Thanks!', ts: String(now - 4400) },
      { type: 'message', user: 'U_BOB', text: ':+1:', ts: String(now - 4000) },
      { type: 'message', user: 'U_CAROL', text: 'yes', ts: String(now - 3500) },
      { type: 'message', user: 'U_ALICE', text: 'Completed the security audit for Q3 deliverables', ts: String(now - 3000) },
    ]
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);
  assert.strictEqual(result.messages.length, 1, `Should have 1 non-trivial message, got ${result.messages.length}`);
  assert.ok(result.messages[0].content.includes('security audit'));

  console.log('  PASS: trivial message filtering — emoji, ok, thanks, single-word skipped');
}

// ============================================================
// TEST 3: Bot messages filtered
// ============================================================
async function testBotMessageFiltering() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'C_ENG', name: 'eng-platform' }
  ];
  mockSlackReader._historyByChannel = {
    C_ENG: [
      { type: 'message', user: 'U_ALICE', text: 'Real message from Alice about infrastructure', ts: String(now - 3000) },
      { type: 'message', user: 'U_ALICE', bot_id: 'B001', text: 'Bot message that happens to match a user', ts: String(now - 2500) },
      { type: 'message', subtype: 'bot_message', text: 'Automated deploy notification sent to channel', ts: String(now - 2000) },
    ]
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);
  assert.strictEqual(result.messages.length, 1, `Should have 1 real message, got ${result.messages.length}`);
  assert.ok(result.messages[0].content.includes('infrastructure'));

  console.log('  PASS: bot messages filtered out');
}

// ============================================================
// TEST 4: Date range filtering
// ============================================================
async function testDateRangeFiltering() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'C_ENG', name: 'eng-platform' }
  ];

  const twoWeeksAgo = now - (14 * 86400);
  const nextWeek = now + (7 * 86400);

  mockSlackReader._historyByChannel = {
    C_ENG: [
      { type: 'message', user: 'U_ALICE', text: 'Message from two weeks ago before window', ts: String(twoWeeksAgo) },
      { type: 'message', user: 'U_BOB', text: 'Message from within the current weekly window', ts: String(now - 3600) },
      { type: 'message', user: 'U_CAROL', text: 'Message from future time which should not appear', ts: String(nextWeek) },
    ]
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);
  assert.strictEqual(result.messages.length, 1, `Should have 1 in-range message, got ${result.messages.length}`);
  assert.ok(result.messages[0].content.includes('weekly window'));

  console.log('  PASS: date range filtering — only messages in [weekStart, weekEnd]');
}

// ============================================================
// TEST 5: Missing channel handling
// ============================================================
async function testMissingChannelHandling() {
  mockSlackReader.reset();
  _resetChannelCache();
  // Only one channel exists, but the collector looks for 4
  mockSlackReader._channels = [
    { id: 'C_ENG', name: 'eng-platform' }
  ];
  mockSlackReader._historyByChannel = {
    C_ENG: [
      { type: 'message', user: 'U_ALICE', text: 'Alice is working on something important this week', ts: String(now - 3600) }
    ]
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  // Should still return messages from the found channel
  assert.strictEqual(result.messages.length, 1);

  // Should report warnings for missing channels
  assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
  assert.ok(result.warnings.length >= 3, `Should warn about at least 3 missing channels, got ${result.warnings.length}`);

  // channelsRead should count only successful reads
  assert.strictEqual(result.channelsRead, 1, 'channelsRead should be 1');

  console.log('  PASS: missing channel handling — warns but does not crash');
}

// ============================================================
// TEST 6: Multiple channels aggregated
// ============================================================
async function testMultipleChannels() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'C_DW', name: 'eng-platform' },
    { id: 'C_CSE', name: 'eng-infra' },
    { id: 'C_TF', name: 'project-automation' },
    { id: 'C_GEN', name: 'eng-general' },
  ];
  mockSlackReader._historyByChannel = {
    C_DW: [
      { type: 'message', user: 'U_ALICE', text: 'Message from Alice in the eng-platform channel here', ts: String(now - 5000) }
    ],
    C_CSE: [
      { type: 'message', user: 'U_BOB', text: 'Message from Bob in the eng-infra channel here', ts: String(now - 4000) }
    ],
    C_TF: [
      { type: 'message', user: 'U_CAROL', text: 'Message from Carol in project-automation channel', ts: String(now - 3000) }
    ],
    C_GEN: [
      { type: 'message', user: 'U_ALICE', text: 'Alice again in the eng-general channel now', ts: String(now - 2000) }
    ],
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  assert.strictEqual(result.messages.length, 4, `Should have 4 messages, got ${result.messages.length}`);
  assert.strictEqual(result.channelsRead, 4);
  assert.strictEqual(result.warnings.length, 0);
  assert.strictEqual(result.messagesFound, 4);

  const channels = new Set(result.messages.map(m => m.channel));
  assert.ok(channels.has('eng-platform'));
  assert.ok(channels.has('eng-infra'));
  assert.ok(channels.has('project-automation'));
  assert.ok(channels.has('eng-general'));

  console.log('  PASS: multiple channels aggregated correctly');
}

// ============================================================
// TEST 7: Empty results
// ============================================================
async function testEmptyResults() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'C_ENG', name: 'eng-platform' }
  ];
  mockSlackReader._historyByChannel = {
    C_ENG: []
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  assert.strictEqual(result.messages.length, 0);
  assert.strictEqual(result.messagesFound, 0);
  assert.strictEqual(result.channelsRead, 1);

  console.log('  PASS: empty results — no messages in channel');
}

// ============================================================
// TEST 8: authorTeam mapping
// ============================================================
async function testAuthorTeamMapping() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'C_ENG', name: 'eng-platform' }
  ];
  mockSlackReader._historyByChannel = {
    C_ENG: [
      { type: 'message', user: 'U_ALICE', text: 'Alice from CSE team is working on customer issues', ts: String(now - 5000) },
      { type: 'message', user: 'U_BOB', text: 'Bob from desktop team is fixing UI rendering bugs', ts: String(now - 4000) },
      { type: 'message', user: 'U_CAROL', text: 'Carol from security is reviewing access control policy', ts: String(now - 3000) },
    ]
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  const aliceMsg = result.messages.find(m => m.author === 'Alice Anderson');
  assert.strictEqual(aliceMsg.authorTeam, 'cse');

  const bobMsg = result.messages.find(m => m.author === 'Bob Baker');
  assert.strictEqual(bobMsg.authorTeam, 'desktop');

  const carolMsg = result.messages.find(m => m.author === 'Carol Chen');
  assert.strictEqual(carolMsg.authorTeam, 'security');

  console.log('  PASS: authorTeam mapping from DB');
}

// ============================================================
// Run all tests
// ============================================================
async function runAll() {
  console.log('slack-team-collector tests:');
  await testTeamMemberFiltering();
  await testTrivialMessageFiltering();
  await testBotMessageFiltering();
  await testDateRangeFiltering();
  await testMissingChannelHandling();
  await testMultipleChannels();
  await testEmptyResults();
  await testAuthorTeamMapping();
  console.log('\n=== ALL SLACK TEAM COLLECTOR TESTS PASSED ===');
}

runAll().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
