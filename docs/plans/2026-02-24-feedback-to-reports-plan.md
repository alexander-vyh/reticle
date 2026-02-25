# Feedback-to-Reports Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface feedback-worthy moments from Slack public channels involving direct reports, draft "When you [behavior], [impact]" feedback, deliver in the daily digest with Delivered/Skip tracking, and show per-report metrics in the tray dashboard.

**Architecture:** New feedback collector plugs into the existing three-layer digest pipeline. A shared `lib/slack-reader.js` (also needed by weekly-summary) provides rate-limited Slack API access. AI assessment and drafting use Haiku via the existing `lib/ai.js` client. Button actions log to the existing `action_log` table. The tray app reads `action_log` to render a feedback dashboard.

**Tech Stack:** Node.js, better-sqlite3, Anthropic SDK (Claude Haiku 4.5), Slack Web API (`conversations.list`, `conversations.history`, `users.info`), Electron (tray app)

**Design Doc:** `docs/plans/2026-02-24-feedback-to-reports-design.md`

---

### Task 1: Slack Reader — Rate Limiter and API Helper

Shared infrastructure for reading Slack message history. This module is also needed by the weekly-summary-slack feature, so build it as a general-purpose Slack API reading library.

**Context:**
- Existing `lib/slack.js` only has `sendSlackDM` and `sendSlackMessage` (write-only, lines 1-67)
- `lib/config.js` exports `slackBotToken` (line 33) — this is the bot token with `channels:history`, `channels:read`, `users:read` scopes
- Slack Web API Tier 3 rate limit: 50 req/min. We use 40 req/min token bucket with headroom
- Weekly-summary design doc (`docs/plans/2026-02-23-weekly-summary-slack-design.md`, lines 40-50) specifies the same functions

**Files:**
- Create: `lib/slack-reader.js`
- Create: `test-slack-reader.js`

**Step 1: Write the failing tests**

```javascript
// test-slack-reader.js
'use strict';

const assert = require('assert');

// We test the rate limiter and response parser — not live API calls
// Live API calls are integration-tested manually

// --- Rate limiter ---

function testRateLimiter() {
  // The rate limiter should allow N requests per minute
  // We test with a tight bucket: 3 tokens, refill 3/sec for fast tests
  const { createRateLimiter } = require('./lib/slack-reader');
  const limiter = createRateLimiter(3, 3); // 3 tokens, 3/sec refill

  // Should allow 3 immediate requests
  assert.strictEqual(limiter.tryAcquire(), true, 'First acquire should succeed');
  assert.strictEqual(limiter.tryAcquire(), true, 'Second acquire should succeed');
  assert.strictEqual(limiter.tryAcquire(), true, 'Third acquire should succeed');
  assert.strictEqual(limiter.tryAcquire(), false, 'Fourth acquire should fail (bucket empty)');

  console.log('  PASS: rate limiter — token bucket basics');
}

// --- Response parsing ---

function testParseSlackMessages() {
  const { parseMessages } = require('./lib/slack-reader');

  const raw = [
    { type: 'message', user: 'U123', text: 'Hello world', ts: '1700000000.000' },
    { type: 'message', subtype: 'channel_join', user: 'U456', text: 'joined', ts: '1700000001.000' },
    { type: 'message', user: 'U789', text: 'ok', ts: '1700000002.000' }, // too short
    { type: 'message', bot_id: 'B001', text: 'Automated alert fired', ts: '1700000003.000' },
    { type: 'message', user: 'U123', text: 'The migration is ready for review, tested against staging', ts: '1700000004.000' },
    { type: 'message', user: 'U123', text: 'https://github.com/org/repo/pull/42', ts: '1700000005.000' }, // link-only
  ];

  const filtered = parseMessages(raw);

  // Should keep: 'Hello world' (>20 chars? No, 11 chars — should be skipped)
  // Actually "Hello world" is 11 chars, under 20 threshold
  // Should keep: 'The migration is ready for review, tested against staging' (56 chars, no subtype, no bot)
  // Should skip: channel_join subtype, 'ok' too short, bot_id present, link-only

  assert.strictEqual(filtered.length, 1, `Expected 1 message, got ${filtered.length}`);
  assert.strictEqual(filtered[0].user, 'U123');
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

// --- User mention resolution ---

function testResolveUserMentions() {
  const { resolveUserMentions } = require('./lib/slack-reader');

  const text = 'Hey <@U123> can you review <@U456>\'s PR?';
  const userCache = new Map([
    ['U123', 'Alice'],
    ['U456', 'Bob']
  ]);

  const resolved = resolveUserMentions(text, userCache);
  assert.strictEqual(resolved, 'Hey Alice can you review Bob\'s PR?');

  console.log('  PASS: resolveUserMentions — replaces <@ID> with names');
}

function testResolveUserMentionsUnknown() {
  const { resolveUserMentions } = require('./lib/slack-reader');

  const text = 'Check with <@UUNKNOWN>';
  const userCache = new Map();

  const resolved = resolveUserMentions(text, userCache);
  assert.strictEqual(resolved, 'Check with <@UUNKNOWN>');

  console.log('  PASS: resolveUserMentions — leaves unknown IDs unchanged');
}

// --- Run ---

console.log('slack-reader tests:');
testRateLimiter();
testParseSlackMessages();
testParseMessagesKeepsThreadInfo();
testResolveUserMentions();
testResolveUserMentionsUnknown();
console.log('All slack-reader tests passed');
```

**Step 2: Run tests to verify they fail**

Run: `node test-slack-reader.js`
Expected: FAIL with `Cannot find module './lib/slack-reader'`

**Step 3: Implement `lib/slack-reader.js`**

```javascript
// lib/slack-reader.js
'use strict';

const https = require('https');
const config = require('./config');
const log = require('./logger')('slack-reader');

const SLACK_TOKEN = config.slackBotToken;

// --- Token Bucket Rate Limiter ---

function createRateLimiter(maxTokens, refillPerSecond) {
  let tokens = maxTokens;
  let lastRefill = Date.now();

  return {
    tryAcquire() {
      const now = Date.now();
      const elapsed = (now - lastRefill) / 1000;
      tokens = Math.min(maxTokens, tokens + elapsed * refillPerSecond);
      lastRefill = now;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },

    async acquire() {
      while (!this.tryAcquire()) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  };
}

// Default: 40 tokens, refill 40/60s ≈ 0.667/s
const defaultLimiter = createRateLimiter(40, 40 / 60);

// --- Slack API Call ---

function slackGet(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const fullPath = query ? `${path}?${query}` : path;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${fullPath}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.ok) reject(new Error(`Slack API error: ${parsed.error}`));
          else resolve(parsed);
        } catch (e) {
          reject(new Error(`Slack response parse error: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- Public Functions ---

async function listConversations({ types = 'public_channel' } = {}) {
  const all = [];
  let cursor;

  do {
    await defaultLimiter.acquire();
    const params = { types, limit: '200', exclude_archived: 'true' };
    if (cursor) params.cursor = cursor;

    const res = await slackGet('conversations.list', params);
    all.push(...(res.channels || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  log.info({ count: all.length, types }, 'Listed conversations');
  return all;
}

async function getConversationHistory(channelId, oldest, latest) {
  const all = [];
  let cursor;

  do {
    await defaultLimiter.acquire();
    const params = { channel: channelId, limit: '200' };
    if (oldest) params.oldest = String(oldest);
    if (latest) params.latest = String(latest);
    if (cursor) params.cursor = cursor;

    const res = await slackGet('conversations.history', params);
    all.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  return all;
}

// In-memory user cache (per process lifetime)
const userCache = new Map();

async function getUserInfo(userId) {
  if (userCache.has(userId)) return userCache.get(userId);

  await defaultLimiter.acquire();
  try {
    const res = await slackGet('users.info', { user: userId });
    const name = res.user?.real_name || res.user?.name || userId;
    userCache.set(userId, name);
    return name;
  } catch (err) {
    log.warn({ err, userId }, 'Failed to resolve user');
    userCache.set(userId, userId); // Cache the failure to avoid retries
    return userId;
  }
}

// In-memory channel cache (per process lifetime)
const channelCache = new Map();

async function getConversationInfo(channelId) {
  if (channelCache.has(channelId)) return channelCache.get(channelId);

  await defaultLimiter.acquire();
  try {
    const res = await slackGet('conversations.info', { channel: channelId });
    const name = res.channel?.name || channelId;
    channelCache.set(channelId, name);
    return name;
  } catch (err) {
    log.warn({ err, channelId }, 'Failed to resolve channel');
    channelCache.set(channelId, channelId);
    return channelId;
  }
}

// --- Message Filtering ---

const LINK_ONLY_PATTERN = /^<https?:\/\/[^>]+>$/;
const SUBTYPES_TO_SKIP = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'channel_archive', 'channel_unarchive',
  'group_join', 'group_leave', 'group_topic', 'group_purpose',
  'bot_message', 'me_message', 'reminder_add', 'pinned_item', 'unpinned_item'
]);
const MIN_MESSAGE_LENGTH = 20;

function parseMessages(rawMessages) {
  return rawMessages.filter(msg => {
    if (msg.type !== 'message') return false;
    if (msg.subtype && SUBTYPES_TO_SKIP.has(msg.subtype)) return false;
    if (msg.bot_id) return false;
    if (!msg.text || msg.text.length < MIN_MESSAGE_LENGTH) return false;
    if (LINK_ONLY_PATTERN.test(msg.text.trim())) return false;
    return true;
  });
}

// --- User Mention Resolution ---

function resolveUserMentions(text, cache) {
  return text.replace(/<@(U[A-Z0-9]+)>/g, (match, userId) => {
    return cache.get(userId) || match;
  });
}

module.exports = {
  createRateLimiter,
  listConversations,
  getConversationHistory,
  getUserInfo,
  getConversationInfo,
  parseMessages,
  resolveUserMentions,
  // Exposed for testing
  userCache,
  channelCache
};
```

**Step 4: Run tests to verify they pass**

Run: `node test-slack-reader.js`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add lib/slack-reader.js test-slack-reader.js
git commit -m "feat: add Slack reader with rate limiter, message filtering, and user resolution"
```

---

### Task 2: Feedback Collector — Message Collection (Step 1 of 3)

The feedback collector has three steps: collect messages, AI assessment, draft feedback. This task implements step 1 only: scanning Slack public channels and filtering to messages involving direct reports.

**Context:**
- `config.directReports` (from `lib/config.js:43`) is an array of `{ email, name }` objects
- We need to add `slackId` to each direct report in team.json for reliable matching
- Slack user IDs look like `U01ABC123` — we map these to report names
- The collector function returns candidate objects (not DigestItems yet — that happens after AI assessment in Task 3)

**Files:**
- Create: `lib/feedback-collector.js`
- Create: `test-feedback-collector.js`

**Step 1: Write the failing tests**

```javascript
// test-feedback-collector.js
'use strict';

const assert = require('assert');

// --- filterToReportMessages ---

function testFilterToReportMessages() {
  const { filterToReportMessages } = require('./lib/feedback-collector');

  const messages = [
    { user: 'U_MARCUS', text: 'Pushed the migration with rollback support and tested staging', ts: '1700000001.000', channelId: 'C01', channelName: 'platform-eng' },
    { user: 'U_OUTSIDER', text: 'Has anyone tried the new deployment pipeline yet?', ts: '1700000002.000', channelId: 'C01', channelName: 'platform-eng' },
    { user: 'U_PRIYA', text: 'I fixed the flaky test in CI by adding a retry', ts: '1700000003.000', channelId: 'C02', channelName: 'incidents' },
    { user: 'U_OUTSIDER', text: 'Great work <@U_MARCUS> on the migration script', ts: '1700000004.000', channelId: 'C01', channelName: 'platform-eng' },
  ];

  const reportSlackIds = new Map([
    ['U_MARCUS', 'Marcus Chen'],
    ['U_PRIYA', 'Priya Patel']
  ]);

  const candidates = filterToReportMessages(messages, reportSlackIds);

  // Should match: Marcus authored (1), Priya authored (3), Marcus mentioned (4)
  // Should not match: outsider authored and no report mentioned (2)
  assert.strictEqual(candidates.length, 3, `Expected 3 candidates, got ${candidates.length}`);

  // Check first candidate (Marcus authored)
  assert.strictEqual(candidates[0].reportName, 'Marcus Chen');
  assert.strictEqual(candidates[0].messageType, 'authored');

  // Check third candidate (Marcus mentioned by outsider)
  assert.strictEqual(candidates[2].reportName, 'Marcus Chen');
  assert.strictEqual(candidates[2].messageType, 'mentioned');

  console.log('  PASS: filterToReportMessages — authored and mentioned');
}

function testFilterToReportMessagesNoDuplicates() {
  const { filterToReportMessages } = require('./lib/feedback-collector');

  // If a report both authored AND is mentioned in the same message, only one candidate
  const messages = [
    { user: 'U_MARCUS', text: 'I (<@U_MARCUS>) just pushed the fix', ts: '1700000001.000', channelId: 'C01', channelName: 'general' }
  ];

  const reportSlackIds = new Map([['U_MARCUS', 'Marcus Chen']]);
  const candidates = filterToReportMessages(messages, reportSlackIds);

  assert.strictEqual(candidates.length, 1, 'Should not duplicate when author is also mentioned');
  assert.strictEqual(candidates[0].messageType, 'authored'); // authored takes priority

  console.log('  PASS: filterToReportMessages — no duplicates');
}

function testBuildReportSlackIdMap() {
  const { buildReportSlackIdMap } = require('./lib/feedback-collector');

  const directReports = [
    { name: 'Marcus Chen', email: 'marcus@co.com', slackId: 'U_MARCUS' },
    { name: 'Priya Patel', email: 'priya@co.com', slackId: 'U_PRIYA' },
    { name: 'No Slack', email: 'noslack@co.com' } // missing slackId
  ];

  const map = buildReportSlackIdMap(directReports);
  assert.strictEqual(map.size, 2, 'Should skip reports without slackId');
  assert.strictEqual(map.get('U_MARCUS'), 'Marcus Chen');
  assert.strictEqual(map.get('U_PRIYA'), 'Priya Patel');

  console.log('  PASS: buildReportSlackIdMap — maps IDs, skips missing');
}

// --- Run ---

console.log('feedback-collector tests:');
testFilterToReportMessages();
testFilterToReportMessagesNoDuplicates();
testBuildReportSlackIdMap();
console.log('All feedback-collector tests passed');
```

**Step 2: Run tests to verify they fail**

Run: `node test-feedback-collector.js`
Expected: FAIL with `Cannot find module './lib/feedback-collector'`

**Step 3: Implement the collection functions**

```javascript
// lib/feedback-collector.js
'use strict';

const log = require('./logger')('feedback-collector');

// --- Report Matching ---

function buildReportSlackIdMap(directReports) {
  const map = new Map();
  for (const report of directReports) {
    if (report.slackId) {
      map.set(report.slackId, report.name);
    }
  }
  return map;
}

function filterToReportMessages(messages, reportSlackIds) {
  const candidates = [];
  const USER_MENTION_PATTERN = /<@(U[A-Z0-9_]+)>/g;

  for (const msg of messages) {
    const authorName = reportSlackIds.get(msg.user);
    let added = false;

    // Check if authored by a report
    if (authorName) {
      candidates.push({
        reportName: authorName,
        reportSlackId: msg.user,
        channelName: msg.channelName,
        channelId: msg.channelId,
        messageText: msg.text,
        timestamp: msg.ts,
        threadTs: msg.thread_ts || null,
        messageType: 'authored'
      });
      added = true;
    }

    // Check if a report is mentioned (skip if already added as author)
    if (!added) {
      let match;
      USER_MENTION_PATTERN.lastIndex = 0;
      while ((match = USER_MENTION_PATTERN.exec(msg.text)) !== null) {
        const mentionedId = match[1];
        const mentionedName = reportSlackIds.get(mentionedId);
        if (mentionedName) {
          candidates.push({
            reportName: mentionedName,
            reportSlackId: mentionedId,
            channelName: msg.channelName,
            channelId: msg.channelId,
            messageText: msg.text,
            timestamp: msg.ts,
            threadTs: msg.thread_ts || null,
            messageType: 'mentioned'
          });
          break; // One candidate per message even if multiple reports mentioned
        }
      }
    }
  }

  return candidates;
}

module.exports = {
  buildReportSlackIdMap,
  filterToReportMessages
};
```

**Step 4: Run tests to verify they pass**

Run: `node test-feedback-collector.js`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add lib/feedback-collector.js test-feedback-collector.js
git commit -m "feat(feedback): add message collection with report filtering"
```

---

### Task 3: Feedback Collector — AI Assessment (Step 2 of 3)

Add AI assessment to the feedback collector. Sends candidate messages to Claude Haiku in batches and classifies each as affirming, adjusting, or skip.

**Context:**
- `lib/ai.js:55-58` — `getClient()` returns an Anthropic SDK client (or null if no credentials)
- `lib/ai.js:107-128` — pattern for calling `messages.create()` with JSON parsing and markdown fence cleanup
- Assessment must NOT label behavior as "poor" or "excellent" (PRD Section 4.2)
- Only high/medium confidence results proceed; low confidence is dropped

**Files:**
- Modify: `lib/feedback-collector.js`
- Modify: `test-feedback-collector.js`

**Step 1: Write the failing tests**

Add to `test-feedback-collector.js`:

```javascript
function testParseAssessmentResponse() {
  const { parseAssessmentResponse } = require('./lib/feedback-collector');

  const raw = `\`\`\`json
[
  {"index": 0, "category": "affirming", "behavior": "Added rollback support to migration", "context": "Reduced deployment risk", "confidence": "high"},
  {"index": 1, "category": "skip", "behavior": "", "context": "", "confidence": "high"},
  {"index": 2, "category": "adjusting", "behavior": "Posted error message without context", "context": "Made debugging harder for on-call", "confidence": "low"}
]
\`\`\``;

  const results = parseAssessmentResponse(raw);

  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].category, 'affirming');
  assert.strictEqual(results[0].confidence, 'high');
  assert.strictEqual(results[1].category, 'skip');
  assert.strictEqual(results[2].confidence, 'low');

  console.log('  PASS: parseAssessmentResponse — parses JSON with markdown fences');
}

function testFilterByConfidence() {
  const { filterByConfidence } = require('./lib/feedback-collector');

  const assessed = [
    { index: 0, category: 'affirming', confidence: 'high' },
    { index: 1, category: 'skip', confidence: 'high' },
    { index: 2, category: 'adjusting', confidence: 'low' },
    { index: 3, category: 'affirming', confidence: 'medium' }
  ];

  const kept = filterByConfidence(assessed);

  // Keep: index 0 (affirming, high), index 3 (affirming, medium)
  // Drop: index 1 (skip), index 2 (low confidence)
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(kept[0].index, 0);
  assert.strictEqual(kept[1].index, 3);

  console.log('  PASS: filterByConfidence — keeps high/medium non-skip, drops low and skip');
}
```

Add these calls to the test runner at the bottom of the file:

```javascript
testParseAssessmentResponse();
testFilterByConfidence();
```

**Step 2: Run tests to verify they fail**

Run: `node test-feedback-collector.js`
Expected: FAIL — `parseAssessmentResponse is not a function` (not exported yet)

**Step 3: Implement assessment functions**

Add to `lib/feedback-collector.js`:

```javascript
const ai = require('./ai');

const ASSESSMENT_SYSTEM = `You are a feedback opportunity detector for a people manager.

For each Slack message, classify whether it represents a feedback-worthy moment:
- "affirming": The person did something well (shipped work, helped someone, good communication, initiative, collaboration)
- "adjusting": An opportunity for constructive feedback (missed context, unclear communication, could have handled differently)
- "skip": Not feedback-worthy (routine status update, factual question, casual chat, noise)

Rules:
- Describe behaviors factually. Never use quality labels like "poor", "excellent", "bad", "great".
- Focus on observable actions and their impact, not personality traits.
- When uncertain, classify as "skip" with low confidence.
- "context" should explain why this matters or what it signals for the team/project.

Respond with a JSON array. Each element:
{"index": <number>, "category": "affirming"|"adjusting"|"skip", "behavior": "<factual description>", "context": "<why it matters>", "confidence": "high"|"medium"|"low"}`;

function parseAssessmentResponse(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function filterByConfidence(assessed) {
  return assessed.filter(a =>
    a.category !== 'skip' &&
    (a.confidence === 'high' || a.confidence === 'medium')
  );
}

async function assessCandidates(candidates) {
  const client = ai.getClient();
  if (!client) {
    log.warn('AI client unavailable — skipping feedback assessment');
    return [];
  }

  // Build user message with indexed candidates
  const numbered = candidates.map((c, i) =>
    `[${i}] #${c.channelName} | ${c.reportName} (${c.messageType}): "${c.messageText}"`
  ).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: ASSESSMENT_SYSTEM,
      messages: [{ role: 'user', content: `Classify these Slack messages:\n\n${numbered}` }]
    });

    const text = response.content[0]?.text;
    log.info({
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      candidateCount: candidates.length
    }, 'Feedback assessment complete');

    if (!text) return [];

    const assessed = parseAssessmentResponse(text);
    return filterByConfidence(assessed);
  } catch (err) {
    log.error({ err }, 'Feedback assessment failed');
    return [];
  }
}
```

Update `module.exports`:

```javascript
module.exports = {
  buildReportSlackIdMap,
  filterToReportMessages,
  parseAssessmentResponse,
  filterByConfidence,
  assessCandidates,
  ASSESSMENT_SYSTEM
};
```

**Step 4: Run tests to verify they pass**

Run: `node test-feedback-collector.js`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add lib/feedback-collector.js test-feedback-collector.js
git commit -m "feat(feedback): add AI assessment with confidence filtering"
```

---

### Task 4: Feedback Collector — Draft Feedback and DigestItem Creation (Step 3 of 3)

Add the "When you [behavior], [impact]" draft generation and convert assessed candidates into DigestItems with full explainability fields.

**Context:**
- `lib/digest-item.js:11-38` — `createDigestItem()` requires: collector, observation, reason, authority, consequence, sourceType, category, priority, observedAt
- DigestItem also accepts optional: counterparty, entityId, sourceUrl, ageSeconds
- We add custom metadata fields: `feedbackDraft`, `rawArtifact`, `feedbackType`
- These extra fields ride along on the DigestItem object but are not validated by `createDigestItem`

**Files:**
- Modify: `lib/feedback-collector.js`
- Modify: `test-feedback-collector.js`

**Step 1: Write the failing tests**

Add to `test-feedback-collector.js`:

```javascript
function testBuildFeedbackDraftPrompt() {
  const { buildFeedbackDraftPrompt } = require('./lib/feedback-collector');

  const candidate = {
    reportName: 'Marcus Chen',
    channelName: 'platform-eng',
    messageText: 'Pushed the migration with rollback support and tested staging',
    messageType: 'authored'
  };
  const assessment = {
    category: 'affirming',
    behavior: 'Added rollback support to migration script and tested against staging',
    context: 'Reduced deployment risk for the team'
  };

  const prompt = buildFeedbackDraftPrompt(candidate, assessment);

  assert.ok(prompt.system.includes('When you'), 'System prompt should reference the format');
  assert.ok(prompt.user.includes('Marcus Chen'), 'User prompt should include report name');
  assert.ok(prompt.user.includes('affirming'), 'User prompt should include category');

  console.log('  PASS: buildFeedbackDraftPrompt — constructs prompt with context');
}

function testCreateFeedbackDigestItem() {
  const { createFeedbackDigestItem } = require('./lib/feedback-collector');

  const candidate = {
    reportName: 'Marcus Chen',
    reportSlackId: 'U_MARCUS',
    channelName: 'platform-eng',
    channelId: 'C01',
    messageText: 'Pushed the migration with rollback support',
    timestamp: '1700000001.000',
    messageType: 'authored'
  };
  const assessment = {
    category: 'affirming',
    behavior: 'Added rollback support to migration',
    context: 'Reduced deployment risk'
  };
  const draft = 'When you added rollback support to the migration script, it reduced deployment risk for the whole team.';

  const item = createFeedbackDigestItem(candidate, assessment, draft);

  assert.strictEqual(item.collector, 'feedback');
  assert.strictEqual(item.sourceType, 'slack-public');
  assert.strictEqual(item.category, 'affirming');
  assert.strictEqual(item.counterparty, 'Marcus Chen');
  assert.strictEqual(item.entityId, 'C01:1700000001.000');
  assert.strictEqual(item.priority, 'normal'); // affirming = normal
  assert.strictEqual(item.feedbackDraft, draft);
  assert.ok(item.rawArtifact.includes('Pushed the migration'));
  assert.ok(item.authority.includes('#platform-eng'));

  console.log('  PASS: createFeedbackDigestItem — all fields populated');
}

function testCreateFeedbackDigestItemAdjusting() {
  const { createFeedbackDigestItem } = require('./lib/feedback-collector');

  const candidate = {
    reportName: 'Priya Patel',
    reportSlackId: 'U_PRIYA',
    channelName: 'incidents',
    channelId: 'C02',
    messageText: 'The alert fired but I could not find the runbook',
    timestamp: '1700000002.000',
    messageType: 'authored'
  };
  const assessment = { category: 'adjusting', behavior: 'Runbook not found', context: 'Incident response delayed' };
  const draft = 'When the runbook was not discoverable during the incident...';

  const item = createFeedbackDigestItem(candidate, assessment, draft);

  assert.strictEqual(item.priority, 'high'); // adjusting = high
  assert.strictEqual(item.category, 'adjusting');

  console.log('  PASS: createFeedbackDigestItem — adjusting gets high priority');
}
```

Add calls to the test runner.

**Step 2: Run tests to verify they fail**

Run: `node test-feedback-collector.js`
Expected: FAIL — `buildFeedbackDraftPrompt is not a function`

**Step 3: Implement draft and DigestItem creation**

Add to `lib/feedback-collector.js`:

```javascript
const { createDigestItem } = require('./digest-item');

const DRAFT_SYSTEM = `You write feedback drafts for a people manager using the "When you [behavior], [impact]" format.

Rules:
- Start with "When you" followed by a specific, observable behavior.
- Follow with the impact on the team, project, or outcome.
- Keep it to 1-2 sentences.
- Be factual and specific. No vague praise or criticism.
- For affirming feedback: name the positive impact clearly.
- For adjusting feedback: name the consequence and leave space for discussion.
- Never use words like "great", "poor", "excellent", "bad".
- The manager will rewrite this — it's a starting point, not final.`;

function buildFeedbackDraftPrompt(candidate, assessment) {
  return {
    system: DRAFT_SYSTEM,
    user: `Report: ${candidate.reportName}
Channel: #${candidate.channelName}
Type: ${assessment.category}
Behavior observed: ${assessment.behavior}
Context: ${assessment.context}
Original message: "${candidate.messageText}"

Write a "When you [behavior], [impact]" feedback draft.`
  };
}

async function draftFeedback(candidate, assessment) {
  const client = ai.getClient();
  if (!client) return null;

  const prompt = buildFeedbackDraftPrompt(candidate, assessment);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }]
    });

    log.info({
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    }, 'Feedback draft complete');

    return response.content[0]?.text || null;
  } catch (err) {
    log.warn({ err }, 'Feedback draft failed');
    return null;
  }
}

function createFeedbackDigestItem(candidate, assessment, draft) {
  const item = createDigestItem({
    collector: 'feedback',
    observation: assessment.behavior,
    reason: `Feedback opportunity detected in #${candidate.channelName} (${assessment.context})`,
    authority: `Public channel message in #${candidate.channelName} at ${new Date(parseFloat(candidate.timestamp) * 1000).toLocaleTimeString()}`,
    consequence: assessment.context,
    sourceType: 'slack-public',
    category: assessment.category,
    priority: assessment.category === 'adjusting' ? 'high' : 'normal',
    counterparty: candidate.reportName,
    entityId: `${candidate.channelId}:${candidate.timestamp}`,
    observedAt: Math.floor(parseFloat(candidate.timestamp))
  });

  // Attach feedback-specific metadata
  item.feedbackDraft = draft;
  item.rawArtifact = `#${candidate.channelName} — ${candidate.reportName}: "${candidate.messageText}"`;
  item.feedbackType = assessment.category;

  return item;
}
```

Update `module.exports` to include the new functions.

**Step 4: Run tests to verify they pass**

Run: `node test-feedback-collector.js`
Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add lib/feedback-collector.js test-feedback-collector.js
git commit -m "feat(feedback): add draft generation and DigestItem creation"
```

---

### Task 5: Feedback Collector — Orchestrator Function

Wire the three steps together into a single `collectFeedback()` function that the daily digest can call. This is the top-level entry point.

**Context:**
- `digest-daily.js:45-76` — collectors are called as `{ name: 'followup', fn: () => collectFollowups(db, accountId) }`
- The feedback collector is different: it's async (API calls + AI) while existing collectors are sync (DB queries)
- `digest-daily.js` will need to await the feedback collector separately from the sync ones

**Files:**
- Modify: `lib/feedback-collector.js`
- Modify: `test-feedback-collector.js`

**Step 1: Write the failing test**

Add to `test-feedback-collector.js`:

```javascript
function testCollectFeedbackSignature() {
  const { collectFeedback } = require('./lib/feedback-collector');

  // Verify the function exists and returns a promise
  assert.strictEqual(typeof collectFeedback, 'function');

  console.log('  PASS: collectFeedback — function exists');
}
```

**Step 2: Run test to verify it fails**

Run: `node test-feedback-collector.js`
Expected: FAIL — `collectFeedback is not a function`

**Step 3: Implement the orchestrator**

Add to `lib/feedback-collector.js`:

```javascript
const slackReader = require('./slack-reader');

async function collectFeedback(directReports, { scanWindowHours = 24 } = {}) {
  const reportMap = buildReportSlackIdMap(directReports);
  if (reportMap.size === 0) {
    log.warn('No direct reports with slackId configured — skipping feedback collection');
    return [];
  }

  // Step 1: Collect messages from all public channels
  log.info({ reportCount: reportMap.size, windowHours: scanWindowHours }, 'Starting feedback collection');
  const oldest = Math.floor(Date.now() / 1000) - (scanWindowHours * 3600);

  let channels;
  try {
    channels = await slackReader.listConversations({ types: 'public_channel' });
  } catch (err) {
    log.error({ err }, 'Failed to list Slack channels');
    return [];
  }

  // Filter to channels with recent activity
  const activeChannels = channels.filter(ch => {
    const lastTs = parseFloat(ch.latest?.ts || '0');
    return lastTs >= oldest;
  });
  log.info({ total: channels.length, active: activeChannels.length }, 'Channels filtered by activity');

  // Fetch history and filter to report messages
  const allCandidates = [];
  for (const ch of activeChannels) {
    try {
      const rawMessages = await slackReader.getConversationHistory(ch.id, oldest);
      const filtered = slackReader.parseMessages(rawMessages);

      // Annotate messages with channel info
      const annotated = filtered.map(msg => ({
        ...msg,
        channelId: ch.id,
        channelName: ch.name
      }));

      const candidates = filterToReportMessages(annotated, reportMap);
      allCandidates.push(...candidates);
    } catch (err) {
      log.warn({ err, channel: ch.name }, 'Failed to fetch channel history — skipping');
    }
  }

  log.info({ candidateCount: allCandidates.length }, 'Messages involving reports collected');

  if (allCandidates.length === 0) return [];

  // Step 2: AI assessment
  const assessed = await assessCandidates(allCandidates);
  log.info({ assessedCount: assessed.length }, 'Assessment complete — high/medium confidence only');

  if (assessed.length === 0) return [];

  // Step 3: Draft feedback for each assessed candidate
  const items = [];
  for (const result of assessed) {
    const candidate = allCandidates[result.index];
    if (!candidate) continue;

    const draft = await draftFeedback(candidate, result);
    const item = createFeedbackDigestItem(
      candidate,
      result,
      draft || `When you ${result.behavior}, ${result.context}.`
    );
    items.push(item);
  }

  log.info({ feedbackItemCount: items.length }, 'Feedback collection complete');
  return items;
}
```

Update `module.exports` to include `collectFeedback`.

**Step 4: Run tests to verify they pass**

Run: `node test-feedback-collector.js`
Expected: All 9 tests PASS

**Step 5: Commit**

```bash
git add lib/feedback-collector.js test-feedback-collector.js
git commit -m "feat(feedback): add collectFeedback orchestrator function"
```

---

### Task 6: Integrate Feedback Collector into Daily Digest

Modify `digest-daily.js` to call the feedback collector alongside existing collectors.

**Context:**
- Existing collectors are synchronous (DB queries). The feedback collector is async (API calls + AI).
- `digest-daily.js:81-90` — collector loop calls `collector.fn()` synchronously
- We need to run the feedback collector separately, before or after the sync loop
- The feedback collector can fail without taking down the rest of the digest

**Files:**
- Modify: `digest-daily.js`

**Step 1: Read the current file (already read above)**

The key section is lines 44-90 where collectors are defined and invoked.

**Step 2: Modify `digest-daily.js`**

Add the import at the top (after line 11):

```javascript
const { collectFeedback } = require('./lib/feedback-collector');
```

After the sync collector loop (after line 90), add the async feedback collection:

```javascript
  // Feedback collector (async — separate from sync collectors)
  try {
    const feedbackItems = await collectFeedback(config.directReports, {
      scanWindowHours: 24
    });
    allItems.push(...feedbackItems);
    log.info({ count: feedbackItems.length }, 'Feedback collector completed');
  } catch (err) {
    log.error({ err }, 'Feedback collector failed');
    failedCollectors.push('feedback');
  }
```

**Step 3: Verify syntax**

Run: `node -c digest-daily.js`
Expected: No errors

**Step 4: Commit**

```bash
git add digest-daily.js
git commit -m "feat(digest): integrate feedback collector into daily digest pipeline"
```

---

### Task 7: Feedback Tracker — DB Helpers

Create the feedback tracker module that reads/writes the `action_log` table for feedback delivery tracking.

**Context:**
- `claudia-db.js:165-182` — `action_log` table schema with indexes on `action`, `entity_type`, `entity_id`, `account_id`
- `claudia-db.js:310-337` — `logAction()` and `getRecentActions()` already exist
- We build on top of these, adding feedback-specific query functions
- Actions: `feedback_delivered`, `feedback_skipped`
- Entity type: `feedback`
- Context JSON: `{ report, feedbackType }`

**Files:**
- Create: `lib/feedback-tracker.js`
- Create: `test-feedback-tracker.js`

**Step 1: Write the failing tests**

```javascript
// test-feedback-tracker.js
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

// Use in-memory DB for testing
function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE action_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      account_id  TEXT,
      actor       TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      action      TEXT NOT NULL,
      context     TEXT,
      outcome     TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX idx_action_type ON action_log(action);
    CREATE INDEX idx_action_account ON action_log(account_id, timestamp);
  `);
  return db;
}

function testLogFeedbackAction() {
  const { logFeedbackAction, getWeeklyCountsByReport } = require('./lib/feedback-tracker');
  const db = setupTestDb();
  const now = Math.floor(Date.now() / 1000);

  logFeedbackAction(db, 'acct1', {
    reportName: 'Marcus Chen',
    feedbackType: 'affirming',
    action: 'feedback_delivered',
    entityId: 'C01:1700000001.000'
  });

  logFeedbackAction(db, 'acct1', {
    reportName: 'Marcus Chen',
    feedbackType: 'adjusting',
    action: 'feedback_skipped',
    entityId: 'C01:1700000002.000'
  });

  logFeedbackAction(db, 'acct1', {
    reportName: 'Priya Patel',
    feedbackType: 'affirming',
    action: 'feedback_delivered',
    entityId: 'C02:1700000003.000'
  });

  // Query weekly counts
  const weekStart = now - (7 * 86400);
  const counts = getWeeklyCountsByReport(db, 'acct1', weekStart);

  assert.strictEqual(counts['Marcus Chen'].delivered, 1);
  assert.strictEqual(counts['Marcus Chen'].skipped, 1);
  assert.strictEqual(counts['Priya Patel'].delivered, 1);
  assert.strictEqual(counts['Priya Patel'].skipped, 0);

  console.log('  PASS: logFeedbackAction + getWeeklyCountsByReport');
}

function testGetRatioByReport() {
  const { logFeedbackAction, getRatioByReport } = require('./lib/feedback-tracker');
  const db = setupTestDb();
  const now = Math.floor(Date.now() / 1000);

  // 3 affirming, 1 adjusting for Marcus
  for (let i = 0; i < 3; i++) {
    logFeedbackAction(db, 'acct1', {
      reportName: 'Marcus Chen', feedbackType: 'affirming',
      action: 'feedback_delivered', entityId: `C01:${i}.000`
    });
  }
  logFeedbackAction(db, 'acct1', {
    reportName: 'Marcus Chen', feedbackType: 'adjusting',
    action: 'feedback_delivered', entityId: 'C01:99.000'
  });

  const since = now - (30 * 86400);
  const ratios = getRatioByReport(db, 'acct1', since);

  assert.strictEqual(ratios['Marcus Chen'].affirming, 3);
  assert.strictEqual(ratios['Marcus Chen'].adjusting, 1);
  assert.strictEqual(ratios['Marcus Chen'].total, 4);

  console.log('  PASS: getRatioByReport');
}

function testGetSkipPatterns() {
  const { logFeedbackAction, getSkipPatterns } = require('./lib/feedback-tracker');
  const db = setupTestDb();
  const now = Math.floor(Date.now() / 1000);

  // Marcus: 2 delivered, 0 skipped
  for (let i = 0; i < 2; i++) {
    logFeedbackAction(db, 'acct1', {
      reportName: 'Marcus Chen', feedbackType: 'affirming',
      action: 'feedback_delivered', entityId: `C01:${i}.000`
    });
  }

  // Priya: 1 delivered, 3 skipped
  logFeedbackAction(db, 'acct1', {
    reportName: 'Priya Patel', feedbackType: 'affirming',
    action: 'feedback_delivered', entityId: 'C02:0.000'
  });
  for (let i = 1; i <= 3; i++) {
    logFeedbackAction(db, 'acct1', {
      reportName: 'Priya Patel', feedbackType: 'affirming',
      action: 'feedback_skipped', entityId: `C02:${i}.000`
    });
  }

  const since = now - (30 * 86400);
  const patterns = getSkipPatterns(db, 'acct1', since);

  // Priya has highest skip rate (75%)
  assert.ok(patterns.length > 0);
  assert.strictEqual(patterns[0].reportName, 'Priya Patel');
  assert.strictEqual(patterns[0].skipped, 3);

  console.log('  PASS: getSkipPatterns — highest skip rate first');
}

// --- Run ---

console.log('feedback-tracker tests:');
testLogFeedbackAction();
testGetRatioByReport();
testGetSkipPatterns();
console.log('All feedback-tracker tests passed');
```

**Step 2: Run tests to verify they fail**

Run: `node test-feedback-tracker.js`
Expected: FAIL with `Cannot find module './lib/feedback-tracker'`

**Step 3: Implement `lib/feedback-tracker.js`**

```javascript
// lib/feedback-tracker.js
'use strict';

function logFeedbackAction(db, accountId, { reportName, feedbackType, action, entityId }) {
  db.prepare(`INSERT INTO action_log (account_id, actor, entity_type, entity_id, action, context)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    'system',
    'feedback',
    entityId,
    action,
    JSON.stringify({ report: reportName, feedbackType })
  );
}

function getWeeklyCountsByReport(db, accountId, weekStart) {
  const rows = db.prepare(`
    SELECT context, action, COUNT(*) as cnt
    FROM action_log
    WHERE account_id = ? AND entity_type = 'feedback'
      AND action IN ('feedback_delivered', 'feedback_skipped')
      AND timestamp >= ?
    GROUP BY context, action
  `).all(accountId, weekStart);

  const counts = {};
  for (const row of rows) {
    const ctx = JSON.parse(row.context);
    const name = ctx.report;
    if (!counts[name]) counts[name] = { delivered: 0, skipped: 0 };
    if (row.action === 'feedback_delivered') counts[name].delivered = row.cnt;
    if (row.action === 'feedback_skipped') counts[name].skipped = row.cnt;
  }
  return counts;
}

function getMonthlyCountsByReport(db, accountId, monthStart) {
  // Same query, different time range
  return getWeeklyCountsByReport(db, accountId, monthStart);
}

function getRatioByReport(db, accountId, since) {
  const rows = db.prepare(`
    SELECT context, COUNT(*) as cnt
    FROM action_log
    WHERE account_id = ? AND entity_type = 'feedback'
      AND action = 'feedback_delivered'
      AND timestamp >= ?
    GROUP BY context
  `).all(accountId, since);

  const ratios = {};
  for (const row of rows) {
    const ctx = JSON.parse(row.context);
    const name = ctx.report;
    const type = ctx.feedbackType;
    if (!ratios[name]) ratios[name] = { affirming: 0, adjusting: 0, total: 0 };
    ratios[name][type] = (ratios[name][type] || 0) + row.cnt;
    ratios[name].total += row.cnt;
  }
  return ratios;
}

function getSkipPatterns(db, accountId, since) {
  const rows = db.prepare(`
    SELECT context, action, COUNT(*) as cnt
    FROM action_log
    WHERE account_id = ? AND entity_type = 'feedback'
      AND action IN ('feedback_delivered', 'feedback_skipped')
      AND timestamp >= ?
    GROUP BY context, action
  `).all(accountId, since);

  const byReport = {};
  for (const row of rows) {
    const ctx = JSON.parse(row.context);
    const name = ctx.report;
    if (!byReport[name]) byReport[name] = { delivered: 0, skipped: 0 };
    if (row.action === 'feedback_delivered') byReport[name].delivered += row.cnt;
    if (row.action === 'feedback_skipped') byReport[name].skipped += row.cnt;
  }

  return Object.entries(byReport)
    .map(([reportName, counts]) => ({
      reportName,
      ...counts,
      total: counts.delivered + counts.skipped,
      skipRate: counts.skipped / (counts.delivered + counts.skipped)
    }))
    .filter(p => p.skipped > 0)
    .sort((a, b) => b.skipRate - a.skipRate);
}

module.exports = {
  logFeedbackAction,
  getWeeklyCountsByReport,
  getMonthlyCountsByReport,
  getRatioByReport,
  getSkipPatterns
};
```

**Step 4: Run tests to verify they pass**

Run: `node test-feedback-tracker.js`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add lib/feedback-tracker.js test-feedback-tracker.js
git commit -m "feat(feedback): add feedback tracker with per-report metrics queries"
```

---

### Task 8: Button Handlers — Delivered/Skip Actions in Slack Events Monitor

Add handlers for the `feedback_delivered` and `feedback_skipped` button actions to `slack-events-monitor.js`.

**Context:**
- `slack-events-monitor.js:880-913` — existing action handler switch/case pattern
- Each case handles an action_id, does work, returns `{ success, message }`
- The message is posted back to Slack as an ephemeral update
- We also need to update the original Slack message to disable the buttons (show confirmed state)
- `claudia-db.js` is available as `followupsDbConn` in the event handler scope

**Files:**
- Modify: `slack-events-monitor.js`

**Step 1: Add the case handlers**

After the existing `mark_no_response_needed` case (around line 913), add:

```javascript
        case 'feedback_delivered':
        case 'feedback_skipped': {
          const feedbackTracker = require('./lib/feedback-tracker');
          if (followupsDbConn) {
            const reportName = action.value ? JSON.parse(action.value).report : 'unknown';
            const feedbackType = action.value ? JSON.parse(action.value).feedbackType : 'unknown';
            feedbackTracker.logFeedbackAction(followupsDbConn, primaryAccountId, {
              reportName,
              feedbackType,
              action: actionId,
              entityId: action.value ? JSON.parse(action.value).entityId : ''
            });
          }
          const label = actionId === 'feedback_delivered' ? 'Delivered' : 'Skipped';
          result = { success: true, message: `✓ Feedback marked as ${label.toLowerCase()}` };
          break;
        }
```

**Step 2: Verify syntax**

Run: `node -c slack-events-monitor.js`
Expected: No errors

**Step 3: Commit**

```bash
git add slack-events-monitor.js
git commit -m "feat(feedback): add Delivered/Skip button handlers to Slack events monitor"
```

---

### Task 9: Feedback Section in Digest Narration

Enhance the daily digest narration to render feedback items with raw artifact + draft + action buttons as Block Kit blocks, rather than plain narration.

**Context:**
- `lib/digest-narration.js:78-81` — `narrateDaily()` sends all items to AI for narration
- Feedback items should NOT go through AI narration — they have their own format (raw artifact + draft + buttons)
- Instead, we split items: non-feedback items go through narration as before; feedback items are rendered as Block Kit blocks
- `lib/slack.js:16-17` — `sendSlackDM(message, blocks)` supports Block Kit blocks as second parameter
- `digest-daily.js:139` — currently calls `sendSlackDM(message)` without blocks

**Files:**
- Create: `lib/feedback-blocks.js`
- Create: `test-feedback-blocks.js`
- Modify: `digest-daily.js`

**Step 1: Write the failing tests**

```javascript
// test-feedback-blocks.js
'use strict';

const assert = require('assert');

function testBuildFeedbackBlocks() {
  const { buildFeedbackBlocks } = require('./lib/feedback-blocks');

  const feedbackItems = [
    {
      counterparty: 'Marcus Chen',
      category: 'affirming',
      rawArtifact: '#platform-eng — Marcus Chen: "Pushed the migration with rollback support"',
      feedbackDraft: 'When you added rollback support, it reduced risk for the team.',
      entityId: 'C01:1700000001.000',
      feedbackType: 'affirming'
    }
  ];

  const blocks = buildFeedbackBlocks(feedbackItems);

  // Should have: header, divider, then per-item: context, quote, draft, actions
  assert.ok(blocks.length >= 4, `Expected at least 4 blocks, got ${blocks.length}`);

  // First block should be a header
  assert.strictEqual(blocks[0].type, 'header');
  assert.ok(blocks[0].text.text.includes('Feedback'));

  // Find the actions block
  const actionsBlock = blocks.find(b => b.type === 'actions');
  assert.ok(actionsBlock, 'Should have an actions block');
  assert.strictEqual(actionsBlock.elements.length, 2); // Delivered + Skip

  // Check button action_ids
  const actionIds = actionsBlock.elements.map(e => e.action_id);
  assert.ok(actionIds.includes('feedback_delivered'));
  assert.ok(actionIds.includes('feedback_skipped'));

  // Check button values contain report info
  const deliveredBtn = actionsBlock.elements.find(e => e.action_id === 'feedback_delivered');
  const value = JSON.parse(deliveredBtn.value);
  assert.strictEqual(value.report, 'Marcus Chen');
  assert.strictEqual(value.feedbackType, 'affirming');

  console.log('  PASS: buildFeedbackBlocks — header, quote, draft, buttons');
}

function testBuildFeedbackBlocksEmpty() {
  const { buildFeedbackBlocks } = require('./lib/feedback-blocks');

  const blocks = buildFeedbackBlocks([]);
  assert.strictEqual(blocks.length, 0, 'Empty items should produce no blocks');

  console.log('  PASS: buildFeedbackBlocks — empty input');
}

function testBuildFeedbackBlocksMultiple() {
  const { buildFeedbackBlocks } = require('./lib/feedback-blocks');

  const feedbackItems = [
    {
      counterparty: 'Marcus Chen', category: 'affirming',
      rawArtifact: '#eng — Marcus: "Did thing"', feedbackDraft: 'When you did thing...',
      entityId: 'C01:1.000', feedbackType: 'affirming'
    },
    {
      counterparty: 'Priya Patel', category: 'adjusting',
      rawArtifact: '#incidents — Priya: "Missed runbook"', feedbackDraft: 'When the runbook...',
      entityId: 'C02:2.000', feedbackType: 'adjusting'
    }
  ];

  const blocks = buildFeedbackBlocks(feedbackItems);

  // Should have 2 action blocks (one per item)
  const actionBlocks = blocks.filter(b => b.type === 'actions');
  assert.strictEqual(actionBlocks.length, 2, 'Should have 2 action blocks');

  console.log('  PASS: buildFeedbackBlocks — multiple items');
}

// --- Run ---

console.log('feedback-blocks tests:');
testBuildFeedbackBlocks();
testBuildFeedbackBlocksEmpty();
testBuildFeedbackBlocksMultiple();
console.log('All feedback-blocks tests passed');
```

**Step 2: Run tests to verify they fail**

Run: `node test-feedback-blocks.js`
Expected: FAIL with `Cannot find module './lib/feedback-blocks'`

**Step 3: Implement `lib/feedback-blocks.js`**

```javascript
// lib/feedback-blocks.js
'use strict';

const TYPE_EMOJI = { affirming: ':large_green_circle:', adjusting: ':large_yellow_circle:' };

function buildFeedbackBlocks(feedbackItems) {
  if (feedbackItems.length === 0) return [];

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Feedback Opportunities', emoji: true }
    },
    { type: 'divider' }
  ];

  for (const item of feedbackItems) {
    const emoji = TYPE_EMOJI[item.category] || ':white_circle:';

    // Context line: emoji + name + type
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${emoji} *${item.counterparty}* — ${item.category}`
      }]
    });

    // Raw artifact (blockquote)
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `> ${item.rawArtifact.replace(/\n/g, '\n> ')}` }
    });

    // Draft
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Draft:* ${item.feedbackDraft}` }
    });

    // Action buttons
    const valuePayload = JSON.stringify({
      report: item.counterparty,
      feedbackType: item.feedbackType,
      entityId: item.entityId
    });

    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Delivered', emoji: true },
          action_id: 'feedback_delivered',
          value: valuePayload,
          style: 'primary'
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip', emoji: true },
          action_id: 'feedback_skipped',
          value: valuePayload
        }
      ]
    });

    blocks.push({ type: 'divider' });
  }

  return blocks;
}

module.exports = { buildFeedbackBlocks };
```

**Step 4: Run tests to verify they pass**

Run: `node test-feedback-blocks.js`
Expected: All 3 tests PASS

**Step 5: Modify `digest-daily.js` to use blocks**

After narration (around line 130), add:

```javascript
  // Separate feedback items from regular items for Block Kit rendering
  const { buildFeedbackBlocks } = require('./lib/feedback-blocks');
  const feedbackItems = allItems.filter(i => i.collector === 'feedback');
  const regularItems = allItems.filter(i => i.collector !== 'feedback');
```

Change the narration call to use only regular items:

```javascript
  // Layer 3: AI narration (regular items only — feedback items use Block Kit)
  let message;
  try {
    message = await narrateDaily(regularItems);
  } catch (err) {
    // ... existing retry logic ...
  }
```

Change the delivery call to include blocks:

```javascript
  // Build feedback blocks
  const feedbackBlocks = buildFeedbackBlocks(feedbackItems);

  // Deliver
  try {
    await sendSlackDM(message, feedbackBlocks.length > 0 ? feedbackBlocks : null);
    log.info({ regularCount: regularItems.length, feedbackCount: feedbackItems.length }, 'Daily digest delivered');
  } catch (err) {
    // ... existing error handling ...
  }
```

**Step 6: Verify syntax**

Run: `node -c digest-daily.js`
Expected: No errors

**Step 7: Commit**

```bash
git add lib/feedback-blocks.js test-feedback-blocks.js digest-daily.js
git commit -m "feat(feedback): add Block Kit rendering with Delivered/Skip buttons"
```

---

### Task 10: Tray App — Feedback Dashboard

Add a "Feedback" section to the Electron tray app menu showing per-report delivery counts and the affirming:adjusting ratio.

**Context:**
- `tray/main.js:50-134` — `buildMenu(statuses)` constructs the entire tray menu
- `tray/main.js:100-133` — menu template with service items, Start/Stop All, Logs, Quit
- The tray app is Electron; it can require Node.js modules including `better-sqlite3`
- `claudia-db.js` can be required from the tray app — the DB path is `~/.claudia/data/claudia.db`
- `tray/service-manager.js` is already required; we add a new require for feedback-tracker

**Files:**
- Modify: `tray/main.js`

**Step 1: Add feedback imports and data loading**

At the top of `tray/main.js`, after existing requires, add:

```javascript
const feedbackTracker = require('../lib/feedback-tracker');
const claudiaDb = require('../claudia-db');
```

**Step 2: Add a `getFeedbackMenu` function**

```javascript
function getFeedbackMenu() {
  try {
    const db = claudiaDb.initDatabase();
    const primaryAccount = claudiaDb.getPrimaryAccount(db);
    if (!primaryAccount) return [];

    const now = Math.floor(Date.now() / 1000);
    const weekStart = now - (7 * 86400);
    const monthStart = now - (30 * 86400);

    const weekly = feedbackTracker.getWeeklyCountsByReport(db, primaryAccount.id, weekStart);
    const ratios = feedbackTracker.getRatioByReport(db, primaryAccount.id, monthStart);

    const config = require('../lib/config');
    const target = config.feedback?.weeklyTarget || 3;

    const items = [];
    const reports = config.directReports || [];

    for (const report of reports) {
      const name = report.name;
      const w = weekly[name] || { delivered: 0, skipped: 0 };
      const bar = '█'.repeat(Math.min(w.delivered, target)) + '─'.repeat(Math.max(0, target - w.delivered));
      const warning = w.delivered < Math.floor(target / 2) ? '  ⚠️' : '';
      items.push({ label: `  ${name}  ${bar} ${w.delivered}/${target}${warning}`, enabled: false });
    }

    // Monthly summary
    let totalDelivered = 0;
    let totalSkipped = 0;
    let totalAffirming = 0;
    let totalAdjusting = 0;

    for (const counts of Object.values(weekly)) {
      totalDelivered += counts.delivered;
      totalSkipped += counts.skipped;
    }
    for (const r of Object.values(ratios)) {
      totalAffirming += r.affirming || 0;
      totalAdjusting += r.adjusting || 0;
    }

    const totalRatio = totalAffirming + totalAdjusting;
    const affirmingPct = totalRatio > 0 ? Math.round(totalAffirming / totalRatio * 100) : 0;

    items.push({ type: 'separator' });
    items.push({ label: `  This week: ${totalDelivered} delivered, ${totalSkipped} skipped`, enabled: false });
    if (totalRatio > 0) {
      items.push({ label: `  Ratio: ${affirmingPct}% affirming, ${100 - affirmingPct}% adjusting`, enabled: false });
    }

    return items;
  } catch (err) {
    return [{ label: '  Feedback data unavailable', enabled: false }];
  }
}
```

**Step 3: Add the feedback section to `buildMenu`**

In the `buildMenu` function's template (around line 100), add the feedback section after the service items and before Start/Stop All:

```javascript
    { type: 'separator' },
    { label: '── Feedback ──', enabled: false },
    ...getFeedbackMenu(),
```

**Step 4: Verify syntax**

Run: `node -c tray/main.js`
Expected: No errors (may warn about Electron not being available in plain Node, that's fine)

**Step 5: Commit**

```bash
git add tray/main.js
git commit -m "feat(tray): add feedback dashboard with per-report counts and ratio"
```

---

### Task 11: Config — Add slackId to Direct Reports and Feedback Config

Update the config to support the new `slackId` field on direct reports and the `feedback` config section.

**Context:**
- `lib/config.js:43` — `directReports: team.directReports || []`
- Currently direct reports have `{ email, name }` — we add `slackId`
- New `feedback` config section for `weeklyTarget`, `scanScope`, `scanWindowHours`
- Config lives in `~/.config/claudia/team.json` (user-managed, NOT in repo)

**Files:**
- Modify: `lib/config.js`

**Step 1: Add feedback config export**

After line 43 (`directReports: team.directReports || [],`), add:

```javascript
  feedback: team.feedback || { weeklyTarget: 3, scanScope: 'public_channels', scanWindowHours: 24 },
```

**Step 2: Document the team.json format**

The user needs to update their `~/.claudia/config/team.json` to add `slackId` fields to each direct report and a `feedback` section. This is a manual step — document it in the commit message.

**Step 3: Verify syntax**

Run: `node -c lib/config.js`
Expected: No errors

**Step 4: Commit**

```bash
git add lib/config.js
git commit -m "feat(config): add feedback config and slackId support for direct reports

Users must update ~/.claudia/config/team.json:
- Add 'slackId' field to each direct report object
- Add 'feedback' section: { weeklyTarget: 3, scanScope: 'public_channels', scanWindowHours: 24 }"
```

---

### Task 12: Update Test Runner

Add the new test files to the test script in `package.json`.

**Context:**
- `package.json` test script currently runs: `node test-digest-item.js && node test-digest-collectors.js && node test-digest-patterns.js && node test-digest-narration.js`
- Add: `node test-slack-reader.js && node test-feedback-collector.js && node test-feedback-tracker.js && node test-feedback-blocks.js`

**Files:**
- Modify: `package.json`

**Step 1: Update the test script**

Add the 4 new test files to the existing `&&`-chained test command.

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add feedback tests to test runner"
```

---

### Task 13: End-to-End Verification

Verify all files exist, all tests pass, and the file inventory matches the design doc.

**Steps:**

1. Run `npm test` — all tests pass
2. Verify file inventory:
   - `lib/slack-reader.js` — exists
   - `lib/feedback-collector.js` — exists
   - `lib/feedback-tracker.js` — exists
   - `lib/feedback-blocks.js` — exists
   - `test-slack-reader.js` — exists
   - `test-feedback-collector.js` — exists
   - `test-feedback-tracker.js` — exists
   - `test-feedback-blocks.js` — exists
   - `digest-daily.js` — modified (imports feedback collector, splits items, sends blocks)
   - `slack-events-monitor.js` — modified (feedback button handlers)
   - `tray/main.js` — modified (feedback dashboard)
   - `lib/config.js` — modified (feedback config)
   - `package.json` — modified (test runner)
3. Verify syntax of all modified files: `node -c <file>`
4. Review commit log for clean history
