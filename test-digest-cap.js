'use strict';

const assert = require('assert');

// Test the ranking function directly — no DB needed
const { rankConversations, MAX_SURFACED } = require('./lib/conversation-ranker');

// ── Test: ranking order — DMs first, then mentions, then email ──
{
  const convs = [
    { id: 'email:1', type: 'email', last_activity: 100 },
    { id: 'slack:mention:C-1', type: 'slack-mention', last_activity: 200 },
    { id: 'slack:dm:U1', type: 'slack-dm', last_activity: 300 },
    { id: 'email:2', type: 'email', last_activity: 50 },
    { id: 'slack:dm:U2', type: 'slack-dm', last_activity: 100 },
  ];

  const ranked = rankConversations(convs);
  // DMs first (oldest first within type), then mentions, then emails
  assert.strictEqual(ranked[0].id, 'slack:dm:U2', 'Oldest DM should be first');
  assert.strictEqual(ranked[1].id, 'slack:dm:U1', 'Second DM');
  assert.strictEqual(ranked[2].id, 'slack:mention:C-1', 'Mention after DMs');
  assert.strictEqual(ranked[3].id, 'email:2', 'Oldest email');
  assert.strictEqual(ranked[4].id, 'email:1', 'Newer email last');
  console.log('PASS: ranking order is DMs > mentions > email, oldest first');
}

// ── Test: MAX_SURFACED is 15 ──
{
  assert.strictEqual(MAX_SURFACED, 15);
  console.log('PASS: MAX_SURFACED is 15');
}

// ── Test: rankConversations caps at MAX_SURFACED ──
{
  const many = [];
  for (let i = 0; i < 50; i++) {
    many.push({ id: `slack:dm:U${i}`, type: 'slack-dm', last_activity: 1000 - i });
  }
  const ranked = rankConversations(many);
  assert.strictEqual(ranked.length, MAX_SURFACED, 'Should cap at MAX_SURFACED');
  // Oldest (lowest last_activity) should be first
  assert.strictEqual(ranked[0].last_activity, 951, 'Oldest item should be first');
  console.log('PASS: caps at 15 items');
}

// ── Test: empty input ──
{
  assert.deepStrictEqual(rankConversations([]), []);
  console.log('PASS: empty input returns empty');
}

// ── Test: fewer than MAX_SURFACED returns all ──
{
  const few = [
    { id: 'a', type: 'slack-dm', last_activity: 100 },
    { id: 'b', type: 'email', last_activity: 200 },
  ];
  assert.strictEqual(rankConversations(few).length, 2);
  console.log('PASS: fewer than 15 returns all');
}

// ── Test: mixed types — DMs always prioritized even if newer ──
{
  const mixed = [];
  // 20 old emails
  for (let i = 0; i < 20; i++) {
    mixed.push({ id: `email:${i}`, type: 'email', last_activity: 100 + i });
  }
  // 3 newer DMs
  mixed.push({ id: 'slack:dm:U1', type: 'slack-dm', last_activity: 500 });
  mixed.push({ id: 'slack:dm:U2', type: 'slack-dm', last_activity: 600 });
  mixed.push({ id: 'slack:dm:U3', type: 'slack-dm', last_activity: 700 });

  const ranked = rankConversations(mixed);
  assert.strictEqual(ranked.length, 15);
  // All 3 DMs should be in the result even though they're newer
  const dmIds = ranked.filter(c => c.type === 'slack-dm').map(c => c.id);
  assert.deepStrictEqual(dmIds, ['slack:dm:U1', 'slack:dm:U2', 'slack:dm:U3'],
    'All DMs should make the cut even when emails are older');
  console.log('PASS: DMs prioritized over older emails');
}

console.log('\n✅ All digest cap tests passed');
