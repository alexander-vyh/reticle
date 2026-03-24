'use strict';

const assert = require('assert');

function testRateLimiter() {
  const { createRateLimiter } = require('./lib/slack-reader');
  const limiter = createRateLimiter(3, 3);

  assert.strictEqual(limiter.tryAcquire(), true);
  assert.strictEqual(limiter.tryAcquire(), true);
  assert.strictEqual(limiter.tryAcquire(), true);
  assert.strictEqual(limiter.tryAcquire(), false);

  console.log('  PASS: rate limiter — token bucket basics');
}

function testParseSlackMessages() {
  const { parseMessages } = require('./lib/slack-reader');

  const raw = [
    { type: 'message', user: 'U123', text: 'Hello world', ts: '1700000000.000' },
    { type: 'message', subtype: 'channel_join', user: 'U456', text: 'joined', ts: '1700000001.000' },
    { type: 'message', user: 'U789', text: 'ok', ts: '1700000002.000' },
    { type: 'message', bot_id: 'B001', text: 'Automated alert fired', ts: '1700000003.000' },
    { type: 'message', user: 'U123', text: 'The migration is ready for review, tested against staging', ts: '1700000004.000' },
    { type: 'message', user: 'U123', text: 'https://github.com/org/repo/pull/42', ts: '1700000005.000' },
  ];

  const filtered = parseMessages(raw);
  assert.strictEqual(filtered.length, 1);
  assert.ok(filtered[0].text.includes('migration'));

  console.log('  PASS: parseMessages — filters bots, subtypes, short, link-only');
}

function testParseMessagesKeepsThreadInfo() {
  const { parseMessages } = require('./lib/slack-reader');

  const raw = [
    { type: 'message', user: 'U123', text: 'Great work on the deployment pipeline refactor', ts: '1700000000.000', thread_ts: '1699999999.000' }
  ];

  const filtered = parseMessages(raw);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].thread_ts, '1699999999.000');

  console.log('  PASS: parseMessages — preserves thread_ts');
}

function testResolveUserMentions() {
  const { resolveUserMentions } = require('./lib/slack-reader');

  const text = 'Hey <@U123> can you review <@U456>\'s PR?';
  const userCache = new Map([['U123', 'Alice'], ['U456', 'Bob']]);

  const resolved = resolveUserMentions(text, userCache);
  assert.strictEqual(resolved, 'Hey Alice can you review Bob\'s PR?');

  console.log('  PASS: resolveUserMentions — replaces <@ID> with names');
}

function testResolveUserMentionsUnknown() {
  const { resolveUserMentions } = require('./lib/slack-reader');

  const resolved = resolveUserMentions('Check with <@UUNKNOWN>', new Map());
  assert.strictEqual(resolved, 'Check with <@UUNKNOWN>');

  console.log('  PASS: resolveUserMentions — leaves unknown IDs unchanged');
}

function testSearchMessagesExported() {
  const slackReader = require('./lib/slack-reader');

  assert.strictEqual(typeof slackReader.searchMessages, 'function',
    'searchMessages should be exported as a function');

  console.log('  PASS: searchMessages — exported as a function');
}

function testSearchRateLimiterExported() {
  const slackReader = require('./lib/slack-reader');

  // The search rate limiter is separate from the default (Tier 2: 20/min vs Tier 3: 40/min)
  assert.strictEqual(typeof slackReader.searchLimiter, 'object',
    'searchLimiter should be exported');
  assert.strictEqual(typeof slackReader.searchLimiter.acquire, 'function',
    'searchLimiter should have acquire method');

  console.log('  PASS: searchLimiter — exported with acquire method');
}

console.log('slack-reader tests:');
testRateLimiter();
testParseSlackMessages();
testParseMessagesKeepsThreadInfo();
testResolveUserMentions();
testResolveUserMentionsUnknown();
testSearchMessagesExported();
testSearchRateLimiterExported();
console.log('All slack-reader tests passed');
