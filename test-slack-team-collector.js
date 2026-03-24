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
  _userNames: {},

  async listConversations(opts) {
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

  async getUserInfo(userId) {
    return mockSlackReader._userNames[userId] || userId;
  },

  async getConversationInfo(channelId) {
    // Return a simple label for group DMs
    const ch = mockSlackReader._channels.find(c => c.id === channelId);
    return ch?.name || channelId;
  },

  // Search API mock
  _searchResults: {},

  async searchMessages(query, options = {}) {
    // If explicit search results are set for this query, use them
    if (mockSlackReader._searchResults[query]) {
      return mockSlackReader._searchResults[query];
    }

    // Fallback: synthesize search results from _historyByChannel data
    // by parsing the from:<@SLACK_ID> and date filters from the query
    const userMatch = query.match(/from:<@([^>]+)>/);
    if (!userMatch) return [];
    const userId = userMatch[1];

    // Parse date filters (after:YYYY-MM-DD before:YYYY-MM-DD)
    // Slack interprets after: as >= start of day, before: as <= end of day
    const afterMatch = query.match(/after:(\d{4}-\d{2}-\d{2})/);
    const beforeMatch = query.match(/before:(\d{4}-\d{2}-\d{2})/);
    const afterEpoch = afterMatch ? Math.floor(new Date(afterMatch[1]).getTime() / 1000) : 0;
    const beforeEpoch = beforeMatch ? Math.floor(new Date(beforeMatch[1]).getTime() / 1000) + 86400 : Infinity;

    const results = [];
    for (const [channelId, messages] of Object.entries(mockSlackReader._historyByChannel)) {
      const channel = mockSlackReader._channels.find(c => c.id === channelId);
      for (const msg of messages) {
        if (msg.user !== userId) continue;
        const ts = parseFloat(msg.ts);
        if (ts < afterEpoch || ts > beforeEpoch) continue;
        results.push({
          text: msg.text,
          user: msg.user,
          ts: msg.ts,
          channel: { id: channelId, name: channel?.name || channelId },
          permalink: `https://slack.com/archives/${channelId}/p${msg.ts}`,
          bot_id: msg.bot_id,
          subtype: msg.subtype,
        });
      }
    }
    return results;
  },

  searchLimiter: {
    tryAcquire() { return true; },
    async acquire() {}
  },

  reset() {
    mockSlackReader._channels = [];
    mockSlackReader._historyByChannel = {};
    mockSlackReader._userNames = {};
    mockSlackReader._searchResults = {};
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
  assert.ok(aliceMsg.slackId, 'message should have slackId');

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
// TEST 5: Search strategy finds messages from all channels (no stale pre-filter)
// ============================================================
async function testSearchFindsAllChannels() {
  mockSlackReader.reset();
  _resetChannelCache();

  const twoWeeksAgo = now - (14 * 86400);

  mockSlackReader._channels = [
    // Active channel — updated within the week
    { id: 'C_ACTIVE', name: 'eng-active', updated: now - 3600 },
    // Stale channel metadata — but search strategy finds by user, not channel
    { id: 'C_STALE', name: 'eng-stale', updated: twoWeeksAgo },
    // No metadata
    { id: 'C_UNKNOWN', name: 'eng-unknown' },
  ];
  mockSlackReader._historyByChannel = {
    C_ACTIVE: [
      { type: 'message', user: 'U_ALICE', text: 'Alice is working on something important this week', ts: String(now - 3600) }
    ],
    C_STALE: [
      { type: 'message', user: 'U_BOB', text: 'Bob posted in stale channel but search finds it', ts: String(now - 3600) }
    ],
    C_UNKNOWN: [
      { type: 'message', user: 'U_CAROL', text: 'Carol in a channel with no activity metadata available', ts: String(now - 3600) }
    ],
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  // Search strategy finds messages from ALL channels (no stale pre-filter)
  assert.strictEqual(result.messages.length, 3, `Should have 3 messages from all channels, got ${result.messages.length}`);
  const channels = result.messages.map(m => m.channel);
  assert.ok(channels.includes('eng-active'), 'Should include active channel');
  assert.ok(channels.includes('eng-stale'), 'Search should include stale channel too');
  assert.ok(channels.includes('eng-unknown'), 'Should include unknown-activity channel');

  // channelsRead from search = unique channels with messages
  assert.strictEqual(result.channelsRead, 3, 'channelsRead should be 3');
  assert.strictEqual(result.strategy, 'search', 'Should use search strategy');

  console.log('  PASS: search strategy finds messages from all channels');
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
  // With search strategy, channelsRead is based on unique channels in results
  assert.strictEqual(result.channelsRead, 0, 'No messages = no channels read');

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
// TEST 9: DM channel name from search results
// ============================================================
async function testDmLabelResolution() {
  mockSlackReader.reset();
  _resetChannelCache();
  // For search strategy, search results include channel name directly
  // DMs in Slack search results show as the user's display name
  mockSlackReader._channels = [
    { id: 'D_ALICE', name: 'dm-Alice Anderson', is_im: true, user: 'U_ALICE' },
  ];
  mockSlackReader._userNames = {
    U_ALICE: 'Alice Anderson',
  };
  mockSlackReader._historyByChannel = {
    D_ALICE: [
      { type: 'message', user: 'U_ALICE', text: 'Here is my status update for the week overall', ts: String(now - 3600) },
    ]
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.messages[0].channel, 'dm-Alice Anderson');
  assert.strictEqual(result.channelsRead, 1);

  console.log('  PASS: DM channel name from search results');
}

// ============================================================
// TEST 10: Group DM channel name from search results
// ============================================================
async function testGroupDmLabelResolution() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'G_MULTI', name: 'mpdm-alice--bob--carol-1', is_mpim: true },
  ];
  mockSlackReader._historyByChannel = {
    G_MULTI: [
      { type: 'message', user: 'U_BOB', text: 'Group discussion about the project timeline here', ts: String(now - 3600) },
    ]
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.messages[0].channel, 'mpdm-alice--bob--carol-1');
  assert.strictEqual(result.channelsRead, 1);

  console.log('  PASS: group DM channel name from search results');
}

// ============================================================
// TEST 11: Search error for individual member — continues with others
// ============================================================
async function testSearchMemberError() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'C_GOOD', name: 'eng-good' },
  ];
  mockSlackReader._historyByChannel = {
    C_GOOD: [
      { type: 'message', user: 'U_ALICE', text: 'Alice message in a good channel that works fine', ts: String(now - 3600) },
      { type: 'message', user: 'U_BOB', text: 'Bob message in the same good channel working fine', ts: String(now - 3000) },
    ],
  };

  // Override searchMessages to fail for Bob specifically
  const originalSearch = mockSlackReader.searchMessages;
  mockSlackReader.searchMessages = async function (query, opts) {
    if (query.includes('U_BOB')) throw new Error('search_rate_limited');
    return originalSearch.call(this, query, opts);
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  // Should get Alice's message, Bob's search failed silently
  assert.strictEqual(result.messages.length, 1, `Should have 1 message (Alice only), got ${result.messages.length}`);
  assert.ok(result.messages[0].content.includes('Alice'));

  // Restore
  mockSlackReader.searchMessages = originalSearch;

  console.log('  PASS: search error for member — continues with others');
}

// ============================================================
// TEST 12: Background sweep runs and exposes _sweepPromise
// ============================================================
async function testBackgroundSweepRuns() {
  mockSlackReader.reset();
  _resetChannelCache();
  mockSlackReader._channels = [
    { id: 'C_ENG', name: 'eng-platform' },
  ];
  mockSlackReader._historyByChannel = {
    C_ENG: [
      { type: 'message', user: 'U_ALICE', text: 'Alice message appears in both search and sweep', ts: String(now - 3600) },
    ],
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', weekStart, weekEnd);

  // Result should have search results
  assert.strictEqual(result.strategy, 'search');
  assert.strictEqual(result.messages.length, 1);

  // _sweepPromise should be available for callers that want to wait for validation
  assert.ok(result._sweepPromise, 'Should expose _sweepPromise for background validation');
  assert.ok(typeof result._sweepPromise.then === 'function', '_sweepPromise should be a Promise');

  // Await the sweep to verify it completes
  const sweepResult = await result._sweepPromise;
  assert.ok(sweepResult, 'Sweep should complete');

  console.log('  PASS: background sweep runs and exposes _sweepPromise');
}

// ============================================================
// TEST 13: Search strategy — collectViaSearch exists and is used as primary
// ============================================================
async function testSearchStrategyExported() {
  const mod = require('./lib/slack-team-collector');
  assert.strictEqual(typeof mod.collectViaSearch, 'function',
    'collectViaSearch should be exported');

  console.log('  PASS: collectViaSearch — exported as a function');
}

// ============================================================
// TEST 14: Search strategy — returns messages in correct shape
// ============================================================
async function testSearchStrategyReturnsCorrectShape() {
  mockSlackReader.reset();
  _resetChannelCache();

  const startDate = '2026-03-16';
  const endDate = '2026-03-23';
  const searchStart = Math.floor(new Date('2026-03-16').getTime() / 1000);
  const searchEnd = Math.floor(new Date('2026-03-23').getTime() / 1000);

  // Set up search results keyed by query
  const aliceQuery = `from:<@U_ALICE> after:${startDate} before:${endDate}`;
  const bobQuery = `from:<@U_BOB> after:${startDate} before:${endDate}`;
  const carolQuery = `from:<@U_CAROL> after:${startDate} before:${endDate}`;

  mockSlackReader._searchResults[aliceQuery] = [
    {
      text: 'Deployed the new service to production successfully today',
      user: 'U_ALICE',
      ts: String(searchStart + 3600),
      channel: { id: 'C_ENG', name: 'eng-platform' },
      permalink: 'https://slack.com/archives/C_ENG/p1234'
    }
  ];
  mockSlackReader._searchResults[bobQuery] = [
    {
      text: 'Working on the Terraform module for networking setup',
      user: 'U_BOB',
      ts: String(searchStart + 7200),
      channel: { id: 'C_INFRA', name: 'eng-infra' },
      permalink: 'https://slack.com/archives/C_INFRA/p5678'
    }
  ];
  mockSlackReader._searchResults[carolQuery] = [];

  const { collectViaSearch } = require('./lib/slack-team-collector');
  const teamMembers = [
    { name: 'Alice Anderson', team: 'cse', slack_id: 'U_ALICE' },
    { name: 'Bob Baker', team: 'desktop', slack_id: 'U_BOB' },
    { name: 'Carol Chen', team: 'security', slack_id: 'U_CAROL' },
  ];

  const messages = await collectViaSearch(teamMembers, searchStart, searchEnd);

  assert.ok(Array.isArray(messages), 'Should return an array');
  assert.strictEqual(messages.length, 2, `Should have 2 messages, got ${messages.length}`);

  const alice = messages.find(m => m.author === 'Alice Anderson');
  assert.ok(alice, 'Should include Alice');
  assert.strictEqual(alice.authorTeam, 'cse');
  assert.strictEqual(alice.channel, 'eng-platform');
  assert.ok(alice.date.match(/^\d{4}-\d{2}-\d{2}$/), 'date should be YYYY-MM-DD');
  assert.ok(alice.content.includes('Deployed'), 'content should be message text');
  assert.ok(alice.slackId, 'Should have slackId');

  const bob = messages.find(m => m.author === 'Bob Baker');
  assert.ok(bob, 'Should include Bob');
  assert.strictEqual(bob.authorTeam, 'desktop');
  assert.strictEqual(bob.channel, 'eng-infra');

  console.log('  PASS: collectViaSearch — returns messages in correct shape');
}

// ============================================================
// TEST 15: Search strategy — filters trivial and bot messages
// ============================================================
async function testSearchStrategyFiltersTrivialAndBot() {
  mockSlackReader.reset();
  _resetChannelCache();

  const startDate = '2026-03-16';
  const endDate = '2026-03-23';
  const searchStart = Math.floor(new Date('2026-03-16').getTime() / 1000);
  const searchEnd = Math.floor(new Date('2026-03-23').getTime() / 1000);

  const aliceQuery = `from:<@U_ALICE> after:${startDate} before:${endDate}`;

  mockSlackReader._searchResults[aliceQuery] = [
    { text: 'ok', user: 'U_ALICE', ts: String(searchStart + 100), channel: { id: 'C1', name: 'ch1' }, permalink: 'p1' },
    { text: 'thanks', user: 'U_ALICE', ts: String(searchStart + 200), channel: { id: 'C1', name: 'ch1' }, permalink: 'p2' },
    { text: ':+1:', user: 'U_ALICE', ts: String(searchStart + 300), channel: { id: 'C1', name: 'ch1' }, permalink: 'p3' },
    { text: 'Completed the security audit for the quarter deliverables', user: 'U_ALICE', ts: String(searchStart + 400), channel: { id: 'C1', name: 'ch1' }, permalink: 'p4' },
    { text: 'Bot generated notification alert message here', user: 'U_ALICE', bot_id: 'B001', ts: String(searchStart + 500), channel: { id: 'C1', name: 'ch1' }, permalink: 'p5' },
  ];

  const { collectViaSearch } = require('./lib/slack-team-collector');
  const members = [{ name: 'Alice Anderson', team: 'cse', slack_id: 'U_ALICE' }];
  const messages = await collectViaSearch(members, searchStart, searchEnd);

  assert.strictEqual(messages.length, 1, `Should have 1 non-trivial, non-bot message, got ${messages.length}`);
  assert.ok(messages[0].content.includes('security audit'));

  console.log('  PASS: collectViaSearch — filters trivial and bot messages');
}

// ============================================================
// TEST 16: Search strategy — skips members without slack_id
// ============================================================
async function testSearchStrategySkipsMembersWithoutSlackId() {
  mockSlackReader.reset();
  _resetChannelCache();

  const searchStart = Math.floor(new Date('2026-03-16').getTime() / 1000);
  const searchEnd = Math.floor(new Date('2026-03-23').getTime() / 1000);

  // Track whether searchMessages was called
  let searchCallCount = 0;
  const origSearch = mockSlackReader.searchMessages;
  mockSlackReader.searchMessages = async function (query, opts) {
    searchCallCount++;
    return origSearch.call(this, query, opts);
  };

  const { collectViaSearch } = require('./lib/slack-team-collector');
  const members = [
    { name: 'No Slack', team: 'cse', slack_id: null },
    { name: 'Also No Slack', team: 'desktop' },
  ];
  const messages = await collectViaSearch(members, searchStart, searchEnd);

  assert.strictEqual(messages.length, 0);
  assert.strictEqual(searchCallCount, 0, 'Should not call searchMessages for members without slack_id');

  mockSlackReader.searchMessages = origSearch;

  console.log('  PASS: collectViaSearch — skips members without slack_id');
}

// ============================================================
// TEST 17: collectSlackTeamChannels returns search results as primary
// ============================================================
async function testCollectorUsesSearchAsPrimary() {
  mockSlackReader.reset();
  _resetChannelCache();

  const startDate = '2026-03-16';
  const endDate = '2026-03-23';
  const searchStart = Math.floor(new Date('2026-03-16').getTime() / 1000);
  const searchEnd = Math.floor(new Date('2026-03-23').getTime() / 1000);

  // Set up search results
  const aliceQuery = `from:<@U_ALICE> after:${startDate} before:${endDate}`;
  mockSlackReader._searchResults[aliceQuery] = [
    {
      text: 'Alice working on important infrastructure changes now',
      user: 'U_ALICE',
      ts: String(searchStart + 3600),
      channel: { id: 'C_ENG', name: 'eng-platform' },
      permalink: 'https://slack.com/archives/C_ENG/p1234'
    }
  ];

  // Also set up channel sweep data (should be used for validation only)
  mockSlackReader._channels = [
    { id: 'C_ENG', name: 'eng-platform' }
  ];
  mockSlackReader._historyByChannel = {
    C_ENG: [
      { type: 'message', user: 'U_ALICE', text: 'Alice working on important infrastructure changes now', ts: String(searchStart + 3600) },
    ]
  };

  const result = await collectSlackTeamChannels(db, 'xoxb-fake', searchStart, searchEnd);

  // The primary result should come from search
  assert.ok(result.messages.length >= 1, 'Should have at least 1 message from search');
  assert.strictEqual(result.messages[0].author, 'Alice Anderson');
  assert.strictEqual(result.messages[0].channel, 'eng-platform');
  // The result should indicate strategy used
  assert.strictEqual(result.strategy, 'search', 'Should indicate search strategy was used');

  console.log('  PASS: collectSlackTeamChannels — uses search as primary strategy');
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
  await testSearchFindsAllChannels();
  await testMultipleChannels();
  await testEmptyResults();
  await testAuthorTeamMapping();
  await testDmLabelResolution();
  await testGroupDmLabelResolution();
  await testSearchMemberError();
  await testBackgroundSweepRuns();
  await testSearchStrategyExported();
  await testSearchStrategyReturnsCorrectShape();
  await testSearchStrategyFiltersTrivialAndBot();
  await testSearchStrategySkipsMembersWithoutSlackId();
  await testCollectorUsesSearchAsPrimary();
  console.log('\n=== ALL SLACK TEAM COLLECTOR TESTS PASSED ===');
}

runAll().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
