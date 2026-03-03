# Feedback-to-Reports Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface feedback-worthy moments from Slack involving monitored people, draft "When you [behavior], [impact]" feedback, expose via gateway API, surface in Reticle (Swift macOS app) for review/edit/copy, with lightweight digest mention and Slack quick-action buttons as secondary paths.

**Architecture:** Node.js backend (scanner + AI + DB) → gateway API → three surfaces: Reticle (Swift), Slack digest, Electron tray.

**Tech Stack:** Node.js, better-sqlite3, Anthropic SDK (Claude Haiku 4.5), Slack Web API, SwiftUI (macOS), URLSession, Express (existing gateway)

**Design Doc:** `docs/plans/2026-02-24-feedback-to-reports-design.md`

---

## Phase 1: Node.js Backend

### Task 1: Slack Reader — Rate Limiter and API Helper

Shared infrastructure for reading Slack message history.

**Files:**
- Create: `lib/slack-reader.js`
- Create: `test-slack-reader.js`

**Step 1: Write the failing tests**

```javascript
// test-slack-reader.js
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

console.log('slack-reader tests:');
testRateLimiter();
testParseSlackMessages();
testParseMessagesKeepsThreadInfo();
testResolveUserMentions();
testResolveUserMentionsUnknown();
console.log('All slack-reader tests passed');
```

**Step 2: Run tests — expect FAIL** (`Cannot find module './lib/slack-reader'`)

**Step 3: Implement `lib/slack-reader.js`**

```javascript
// lib/slack-reader.js
'use strict';

const https = require('https');
const config = require('./config');
const log = require('./logger')('slack-reader');

const SLACK_TOKEN = config.slackBotToken;

function createRateLimiter(maxTokens, refillPerSecond) {
  let tokens = maxTokens;
  let lastRefill = Date.now();

  return {
    tryAcquire() {
      const now = Date.now();
      const elapsed = (now - lastRefill) / 1000;
      tokens = Math.min(maxTokens, tokens + elapsed * refillPerSecond);
      lastRefill = now;
      if (tokens >= 1) { tokens -= 1; return true; }
      return false;
    },
    async acquire() {
      while (!this.tryAcquire()) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  };
}

const defaultLimiter = createRateLimiter(40, 40 / 60);

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
  log.info({ count: all.length }, 'Listed conversations');
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
    userCache.set(userId, userId);
    return userId;
  }
}

async function lookupUserByEmail(email) {
  await defaultLimiter.acquire();
  try {
    const res = await slackGet('users.lookupByEmail', { email });
    return res.user?.id || null;
  } catch (err) {
    log.warn({ err, email }, 'Failed to look up user by email');
    return null;
  }
}

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
  lookupUserByEmail,
  getConversationInfo,
  parseMessages,
  resolveUserMentions,
  userCache,
  channelCache
};
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**
```bash
git add lib/slack-reader.js test-slack-reader.js
git commit -m "feat: add Slack reader with rate limiter, message filtering, and identity lookup"
```

---

### Task 2: People Store — Identity Resolution

People are stored in the DB by email. On first use, their Slack ID is resolved via `users.lookupByEmail`.

**Files:**
- Create: `lib/people-store.js`
- Create: `test-people-store.js`

**Step 1: Write the failing tests**

```javascript
// test-people-store.js
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE monitored_people (
      id          TEXT PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      name        TEXT,
      slack_id    TEXT,
      jira_id     TEXT,
      resolved_at INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  return db;
}

function testAddPerson() {
  const { addPerson, listPeople } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  const people = listPeople(db);

  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].email, 'alex@co.com');
  assert.strictEqual(people[0].name, 'Alex Johnson');
  assert.strictEqual(people[0].slack_id, null);

  console.log('  PASS: addPerson + listPeople');
}

function testAddPersonDuplicate() {
  const { addPerson, listPeople } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson Updated' }); // upsert

  const people = listPeople(db);
  assert.strictEqual(people.length, 1);

  console.log('  PASS: addPerson — upsert on duplicate email');
}

function testUpdateSlackId() {
  const { addPerson, updateSlackId, listPeople } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  updateSlackId(db, 'alex@co.com', 'U01ABC123');

  const people = listPeople(db);
  assert.strictEqual(people[0].slack_id, 'U01ABC123');

  console.log('  PASS: updateSlackId');
}

function testRemovePerson() {
  const { addPerson, removePerson, listPeople } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  removePerson(db, 'alex@co.com');

  assert.strictEqual(listPeople(db).length, 0);

  console.log('  PASS: removePerson');
}

function testGetSlackIdMap() {
  const { addPerson, updateSlackId, getSlackIdMap } = require('./lib/people-store');
  const db = setupTestDb();

  addPerson(db, { email: 'alex@co.com', name: 'Alex Johnson' });
  addPerson(db, { email: 'priya@co.com', name: 'Priya Patel' });
  addPerson(db, { email: 'noslack@co.com', name: 'No Slack' });
  updateSlackId(db, 'alex@co.com', 'U_ALEX');
  updateSlackId(db, 'priya@co.com', 'U_PRIYA');

  const map = getSlackIdMap(db);
  assert.strictEqual(map.size, 2);
  assert.strictEqual(map.get('U_ALEX'), 'Alex Johnson');
  assert.strictEqual(map.get('U_PRIYA'), 'Priya Patel');

  console.log('  PASS: getSlackIdMap — only resolved people');
}

console.log('people-store tests:');
testAddPerson();
testAddPersonDuplicate();
testUpdateSlackId();
testRemovePerson();
testGetSlackIdMap();
console.log('All people-store tests passed');
```

**Step 2: Run tests — expect FAIL**

**Step 3: Add `monitored_people` table to claudia-db.js**

In `claudia-db.js`, inside the `initDatabase()` function, add after existing CREATE TABLE statements:

```javascript
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitored_people (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      email       TEXT UNIQUE NOT NULL,
      name        TEXT,
      slack_id    TEXT,
      jira_id     TEXT,
      resolved_at INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
```

**Step 4: Implement `lib/people-store.js`**

```javascript
// lib/people-store.js
'use strict';

function addPerson(db, { email, name = null }) {
  db.prepare(`
    INSERT INTO monitored_people (email, name)
    VALUES (?, ?)
    ON CONFLICT(email) DO UPDATE SET name = excluded.name
  `).run(email, name);
}

function removePerson(db, email) {
  db.prepare('DELETE FROM monitored_people WHERE email = ?').run(email);
}

function listPeople(db) {
  return db.prepare('SELECT * FROM monitored_people ORDER BY name').all();
}

function updateSlackId(db, email, slackId) {
  db.prepare(`
    UPDATE monitored_people
    SET slack_id = ?, resolved_at = strftime('%s','now')
    WHERE email = ?
  `).run(slackId, email);
}

function updateJiraId(db, email, jiraId) {
  db.prepare(`
    UPDATE monitored_people SET jira_id = ? WHERE email = ?
  `).run(jiraId, email);
}

function getSlackIdMap(db) {
  const rows = db.prepare(
    'SELECT slack_id, name FROM monitored_people WHERE slack_id IS NOT NULL'
  ).all();
  return new Map(rows.map(r => [r.slack_id, r.name]));
}

module.exports = {
  addPerson,
  removePerson,
  listPeople,
  updateSlackId,
  updateJiraId,
  getSlackIdMap
};
```

Also add `monitored_people`-related exports to `claudia-db.js` `module.exports`.

**Step 5: Run tests — expect PASS**

**Step 6: Commit**
```bash
git add lib/people-store.js test-people-store.js claudia-db.js
git commit -m "feat: add monitored_people table and people-store DB helpers"
```

---

### Task 3: Feedback Collector — Message Collection

**Files:**
- Create: `lib/feedback-collector.js`
- Create: `test-feedback-collector.js`

**Step 1: Write the failing tests**

```javascript
// test-feedback-collector.js
'use strict';

const assert = require('assert');

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
  assert.strictEqual(candidates.length, 3);
  assert.strictEqual(candidates[0].reportName, 'Marcus Chen');
  assert.strictEqual(candidates[0].messageType, 'authored');
  assert.strictEqual(candidates[2].reportName, 'Marcus Chen');
  assert.strictEqual(candidates[2].messageType, 'mentioned');

  console.log('  PASS: filterToReportMessages — authored and mentioned');
}

function testFilterToReportMessagesNoDuplicates() {
  const { filterToReportMessages } = require('./lib/feedback-collector');

  const messages = [
    { user: 'U_MARCUS', text: 'I (<@U_MARCUS>) just pushed the fix', ts: '1700000001.000', channelId: 'C01', channelName: 'general' }
  ];

  const candidates = filterToReportMessages(messages, new Map([['U_MARCUS', 'Marcus Chen']]));
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].messageType, 'authored');

  console.log('  PASS: filterToReportMessages — no duplicates');
}

console.log('feedback-collector tests:');
testFilterToReportMessages();
testFilterToReportMessagesNoDuplicates();
console.log('All feedback-collector tests passed');
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement `lib/feedback-collector.js` (collection only)**

```javascript
// lib/feedback-collector.js
'use strict';

const log = require('./logger')('feedback-collector');

function filterToReportMessages(messages, reportSlackIds) {
  const candidates = [];
  const USER_MENTION_PATTERN = /<@(U[A-Z0-9_]+)>/g;

  for (const msg of messages) {
    const authorName = reportSlackIds.get(msg.user);
    let added = false;

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

    if (!added) {
      let match;
      USER_MENTION_PATTERN.lastIndex = 0;
      while ((match = USER_MENTION_PATTERN.exec(msg.text)) !== null) {
        const mentionedName = reportSlackIds.get(match[1]);
        if (mentionedName) {
          candidates.push({
            reportName: mentionedName,
            reportSlackId: match[1],
            channelName: msg.channelName,
            channelId: msg.channelId,
            messageText: msg.text,
            timestamp: msg.ts,
            threadTs: msg.thread_ts || null,
            messageType: 'mentioned'
          });
          break;
        }
      }
    }
  }

  return candidates;
}

module.exports = { filterToReportMessages };
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**
```bash
git add lib/feedback-collector.js test-feedback-collector.js
git commit -m "feat(feedback): add message collection with report filtering"
```

---

### Task 4: Feedback Collector — AI Assessment + Draft

Add AI assessment and "When you [behavior], [impact]" draft generation.

**Files:** Modify `lib/feedback-collector.js`, `test-feedback-collector.js`

**Step 1: Add tests**

```javascript
function testParseAssessmentResponse() {
  const { parseAssessmentResponse } = require('./lib/feedback-collector');

  const raw = `\`\`\`json
[
  {"index": 0, "category": "affirming", "behavior": "Added rollback support", "context": "Reduced deployment risk", "confidence": "high"},
  {"index": 1, "category": "skip", "behavior": "", "context": "", "confidence": "high"},
  {"index": 2, "category": "adjusting", "behavior": "Posted error without context", "context": "Made debugging harder", "confidence": "low"}
]
\`\`\``;

  const results = parseAssessmentResponse(raw);
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].category, 'affirming');
  assert.strictEqual(results[2].confidence, 'low');

  console.log('  PASS: parseAssessmentResponse');
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
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(kept[0].index, 0);
  assert.strictEqual(kept[1].index, 3);

  console.log('  PASS: filterByConfidence — keeps high/medium non-skip');
}
```

**Step 2: Run tests — expect FAIL**

**Step 3: Add to `lib/feedback-collector.js`**

```javascript
const ai = require('./ai');
const { createDigestItem } = require('./digest-item');

const ASSESSMENT_SYSTEM = `You are a feedback opportunity detector for a people manager.

For each Slack message, classify whether it represents a feedback-worthy moment:
- "affirming": The person did something well (shipped work, helped someone, good communication, initiative)
- "adjusting": An opportunity for constructive feedback (missed context, unclear communication)
- "skip": Not feedback-worthy (routine update, factual question, casual chat)

Rules:
- Describe behaviors factually. Never use labels like "poor", "excellent", "bad", "great".
- Focus on observable actions and their impact, not personality.
- When uncertain, classify as "skip" with low confidence.

Respond with a JSON array:
[{"index": <n>, "category": "affirming"|"adjusting"|"skip", "behavior": "<factual description>", "context": "<why it matters>", "confidence": "high"|"medium"|"low"}]`;

const DRAFT_SYSTEM = `You write feedback drafts for a people manager using these principles:
- Start with "When you" followed by a specific, observable behavior
- Follow with the impact on the team, project, or outcome
- 1-2 sentences, factual and specific
- Never use "great", "poor", "excellent", "bad"
- This is a starting point — the manager rewrites it before sending`;

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
  if (!client) { log.warn('AI client unavailable'); return []; }

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

    log.info({
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      candidateCount: candidates.length
    }, 'Assessment complete');

    const text = response.content[0]?.text;
    if (!text) return [];
    return filterByConfidence(parseAssessmentResponse(text));
  } catch (err) {
    log.error({ err }, 'Assessment failed');
    return [];
  }
}

async function draftFeedback(candidate, assessment) {
  const client = ai.getClient();
  if (!client) return null;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: DRAFT_SYSTEM,
      messages: [{
        role: 'user',
        content: `Report: ${candidate.reportName}
Channel: #${candidate.channelName}
Type: ${assessment.category}
Behavior: ${assessment.behavior}
Context: ${assessment.context}
Original: "${candidate.messageText}"

Write a "When you [behavior], [impact]" draft.`
      }]
    });

    log.info({
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    }, 'Draft complete');

    return response.content[0]?.text || null;
  } catch (err) {
    log.warn({ err }, 'Draft failed');
    return null;
  }
}

function createFeedbackDigestItem(candidate, assessment, draft) {
  const item = createDigestItem({
    collector: 'feedback',
    observation: assessment.behavior,
    reason: `Feedback opportunity in #${candidate.channelName} (${assessment.context})`,
    authority: `Public channel #${candidate.channelName}`,
    consequence: assessment.context,
    sourceType: 'slack-public',
    category: assessment.category,
    priority: assessment.category === 'adjusting' ? 'high' : 'normal',
    counterparty: candidate.reportName,
    entityId: `${candidate.channelId}:${candidate.timestamp}`,
    observedAt: Math.floor(parseFloat(candidate.timestamp))
  });

  item.feedbackDraft = draft;
  item.rawArtifact = `#${candidate.channelName} — ${candidate.reportName}: "${candidate.messageText}"`;
  item.feedbackType = assessment.category;

  return item;
}
```

Update `module.exports` to include all new functions.

**Step 4: Run tests — expect PASS**

**Step 5: Commit**
```bash
git add lib/feedback-collector.js test-feedback-collector.js
git commit -m "feat(feedback): add AI assessment and draft generation"
```

---

### Task 5: Feedback Collector — Orchestrator

**Files:** Modify `lib/feedback-collector.js`, `test-feedback-collector.js`

**Step 1: Add test**

```javascript
function testCollectFeedbackSignature() {
  const { collectFeedback } = require('./lib/feedback-collector');
  assert.strictEqual(typeof collectFeedback, 'function');
  console.log('  PASS: collectFeedback — function exists');
}
```

**Step 2: Run test — expect FAIL**

**Step 3: Add to `lib/feedback-collector.js`**

```javascript
const slackReader = require('./slack-reader');

async function collectFeedback(slackIdMap, { scanWindowHours = 24 } = {}) {
  if (slackIdMap.size === 0) {
    log.warn('No monitored people with Slack IDs — skipping');
    return [];
  }

  const oldest = Math.floor(Date.now() / 1000) - (scanWindowHours * 3600);
  log.info({ count: slackIdMap.size, windowHours: scanWindowHours }, 'Starting feedback collection');

  let channels;
  try {
    channels = await slackReader.listConversations({ types: 'public_channel' });
  } catch (err) {
    log.error({ err }, 'Failed to list channels');
    return [];
  }

  const activeChannels = channels.filter(ch => {
    const lastTs = parseFloat(ch.latest?.ts || '0');
    return lastTs >= oldest;
  });

  const allCandidates = [];
  for (const ch of activeChannels) {
    try {
      const rawMessages = await slackReader.getConversationHistory(ch.id, oldest);
      const filtered = slackReader.parseMessages(rawMessages);
      const annotated = filtered.map(msg => ({ ...msg, channelId: ch.id, channelName: ch.name }));
      allCandidates.push(...filterToReportMessages(annotated, slackIdMap));
    } catch (err) {
      log.warn({ err, channel: ch.name }, 'Failed to fetch channel — skipping');
    }
  }

  log.info({ count: allCandidates.length }, 'Candidates collected');
  if (allCandidates.length === 0) return [];

  const assessed = await assessCandidates(allCandidates);
  if (assessed.length === 0) return [];

  const items = [];
  for (const result of assessed) {
    const candidate = allCandidates[result.index];
    if (!candidate) continue;
    const draft = await draftFeedback(candidate, result);
    items.push(createFeedbackDigestItem(
      candidate, result,
      draft || `When you ${result.behavior}, ${result.context}.`
    ));
  }

  log.info({ count: items.length }, 'Feedback collection complete');
  return items;
}
```

Update `module.exports` to include `collectFeedback`.

**Step 4: Run tests — expect PASS**

**Step 5: Commit**
```bash
git add lib/feedback-collector.js test-feedback-collector.js
git commit -m "feat(feedback): add collectFeedback orchestrator"
```

---

### Task 6: Feedback Tracker — DB Helpers

**Files:**
- Create: `lib/feedback-tracker.js`
- Create: `test-feedback-tracker.js`

**Step 1: Write tests**

```javascript
// test-feedback-tracker.js
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

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
  `);
  return db;
}

function testLogAndQuery() {
  const { logFeedbackAction, getWeeklyCountsByReport } = require('./lib/feedback-tracker');
  const db = setupTestDb();
  const now = Math.floor(Date.now() / 1000);

  logFeedbackAction(db, 'acct1', { reportName: 'Marcus Chen', feedbackType: 'affirming', action: 'feedback_delivered', entityId: 'C01:1.000' });
  logFeedbackAction(db, 'acct1', { reportName: 'Marcus Chen', feedbackType: 'adjusting', action: 'feedback_skipped', entityId: 'C01:2.000' });
  logFeedbackAction(db, 'acct1', { reportName: 'Priya Patel', feedbackType: 'affirming', action: 'feedback_delivered', entityId: 'C02:3.000' });

  const counts = getWeeklyCountsByReport(db, 'acct1', now - 86400);
  assert.strictEqual(counts['Marcus Chen'].delivered, 1);
  assert.strictEqual(counts['Marcus Chen'].skipped, 1);
  assert.strictEqual(counts['Priya Patel'].delivered, 1);

  console.log('  PASS: logFeedbackAction + getWeeklyCountsByReport');
}

function testGetRatioByReport() {
  const { logFeedbackAction, getRatioByReport } = require('./lib/feedback-tracker');
  const db = setupTestDb();
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < 3; i++) {
    logFeedbackAction(db, 'acct1', { reportName: 'Marcus Chen', feedbackType: 'affirming', action: 'feedback_delivered', entityId: `C01:${i}.000` });
  }
  logFeedbackAction(db, 'acct1', { reportName: 'Marcus Chen', feedbackType: 'adjusting', action: 'feedback_delivered', entityId: 'C01:99.000' });

  const ratios = getRatioByReport(db, 'acct1', now - 86400 * 30);
  assert.strictEqual(ratios['Marcus Chen'].affirming, 3);
  assert.strictEqual(ratios['Marcus Chen'].adjusting, 1);

  console.log('  PASS: getRatioByReport');
}

console.log('feedback-tracker tests:');
testLogAndQuery();
testGetRatioByReport();
console.log('All feedback-tracker tests passed');
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement `lib/feedback-tracker.js`**

```javascript
// lib/feedback-tracker.js
'use strict';

function logFeedbackAction(db, accountId, { reportName, feedbackType, action, entityId }) {
  db.prepare(`
    INSERT INTO action_log (account_id, actor, entity_type, entity_id, action, context)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, 'system', 'feedback', entityId, action,
    JSON.stringify({ report: reportName, feedbackType }));
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
    const { report } = JSON.parse(row.context);
    if (!counts[report]) counts[report] = { delivered: 0, skipped: 0 };
    if (row.action === 'feedback_delivered') counts[report].delivered = row.cnt;
    if (row.action === 'feedback_skipped') counts[report].skipped = row.cnt;
  }
  return counts;
}

function getMonthlyCountsByReport(db, accountId, monthStart) {
  return getWeeklyCountsByReport(db, accountId, monthStart);
}

function getRatioByReport(db, accountId, since) {
  const rows = db.prepare(`
    SELECT context, COUNT(*) as cnt
    FROM action_log
    WHERE account_id = ? AND entity_type = 'feedback'
      AND action = 'feedback_delivered' AND timestamp >= ?
    GROUP BY context
  `).all(accountId, since);

  const ratios = {};
  for (const row of rows) {
    const { report, feedbackType } = JSON.parse(row.context);
    if (!ratios[report]) ratios[report] = { affirming: 0, adjusting: 0, total: 0 };
    ratios[report][feedbackType] = (ratios[report][feedbackType] || 0) + row.cnt;
    ratios[report].total += row.cnt;
  }
  return ratios;
}

module.exports = {
  logFeedbackAction,
  getWeeklyCountsByReport,
  getMonthlyCountsByReport,
  getRatioByReport
};
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**
```bash
git add lib/feedback-tracker.js test-feedback-tracker.js
git commit -m "feat(feedback): add feedback tracker with per-report metrics"
```

---

### Task 7: Slack Button Handlers + Block Kit Blocks

The Slack digest includes Block Kit buttons as a quick path (Delivered/Skip without opening Reticle).

**Files:**
- Create: `lib/feedback-blocks.js`
- Create: `test-feedback-blocks.js`
- Modify: `slack-events-monitor.js`
- Modify: `digest-daily.js`

**Step 1: Write feedback-blocks tests**

```javascript
// test-feedback-blocks.js
'use strict';

const assert = require('assert');

function testBuildFeedbackBlocks() {
  const { buildFeedbackBlocks } = require('./lib/feedback-blocks');

  const items = [{
    counterparty: 'Marcus Chen',
    category: 'affirming',
    rawArtifact: '#platform-eng — Marcus: "Pushed migration with rollback"',
    feedbackDraft: 'When you added rollback support, it reduced risk.',
    entityId: 'C01:1.000',
    feedbackType: 'affirming'
  }];

  const blocks = buildFeedbackBlocks(items);

  assert.ok(blocks.length >= 4);
  assert.strictEqual(blocks[0].type, 'header');

  const actionsBlock = blocks.find(b => b.type === 'actions');
  assert.ok(actionsBlock);
  assert.strictEqual(actionsBlock.elements.length, 2);

  const ids = actionsBlock.elements.map(e => e.action_id);
  assert.ok(ids.includes('feedback_delivered'));
  assert.ok(ids.includes('feedback_skipped'));

  const btn = actionsBlock.elements.find(e => e.action_id === 'feedback_delivered');
  const val = JSON.parse(btn.value);
  assert.strictEqual(val.report, 'Marcus Chen');

  console.log('  PASS: buildFeedbackBlocks — header, quote, draft, buttons');
}

function testBuildFeedbackBlocksEmpty() {
  const { buildFeedbackBlocks } = require('./lib/feedback-blocks');
  assert.strictEqual(buildFeedbackBlocks([]).length, 0);
  console.log('  PASS: buildFeedbackBlocks — empty input');
}

console.log('feedback-blocks tests:');
testBuildFeedbackBlocks();
testBuildFeedbackBlocksEmpty();
console.log('All feedback-blocks tests passed');
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement `lib/feedback-blocks.js`**

```javascript
// lib/feedback-blocks.js
'use strict';

const TYPE_EMOJI = { affirming: ':large_green_circle:', adjusting: ':large_yellow_circle:' };

function buildFeedbackBlocks(feedbackItems) {
  if (feedbackItems.length === 0) return [];

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Feedback Opportunities (${feedbackItems.length})`, emoji: true } },
    { type: 'divider' }
  ];

  for (const item of feedbackItems) {
    const emoji = TYPE_EMOJI[item.category] || ':white_circle:';
    const valuePayload = JSON.stringify({ report: item.counterparty, feedbackType: item.feedbackType, entityId: item.entityId });

    blocks.push(
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${emoji} *${item.counterparty}* — ${item.category}` }] },
      { type: 'section', text: { type: 'mrkdwn', text: `> ${item.rawArtifact}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Draft:* ${item.feedbackDraft}` } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Delivered', emoji: true }, action_id: 'feedback_delivered', value: valuePayload, style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: 'Skip', emoji: true }, action_id: 'feedback_skipped', value: valuePayload }
        ]
      },
      { type: 'divider' }
    );
  }

  return blocks;
}

module.exports = { buildFeedbackBlocks };
```

**Step 4: Add button handlers to `slack-events-monitor.js`**

After the last existing case (around line 913), add:

```javascript
        case 'feedback_delivered':
        case 'feedback_skipped': {
          const feedbackTracker = require('./lib/feedback-tracker');
          if (followupsDbConn) {
            const val = action.value ? JSON.parse(action.value) : {};
            feedbackTracker.logFeedbackAction(followupsDbConn, primaryAccountId, {
              reportName: val.report || 'unknown',
              feedbackType: val.feedbackType || 'unknown',
              action: actionId,
              entityId: val.entityId || ''
            });
          }
          const label = actionId === 'feedback_delivered' ? 'delivered' : 'skipped';
          result = { success: true, message: `✓ Feedback marked as ${label}` };
          break;
        }
```

**Step 5: Integrate lightweight mention into `digest-daily.js`**

Add import:
```javascript
const { collectFeedback } = require('./lib/feedback-collector');
const { buildFeedbackBlocks } = require('./lib/feedback-blocks');
const peopleStore = require('./lib/people-store');
```

After sync collectors, add:
```javascript
  // Feedback collector (async)
  let feedbackItems = [];
  try {
    const slackIdMap = peopleStore.getSlackIdMap(db);
    feedbackItems = await collectFeedback(slackIdMap, { scanWindowHours: 24 });
    log.info({ count: feedbackItems.length }, 'Feedback collector complete');
  } catch (err) {
    log.error({ err }, 'Feedback collector failed');
    failedCollectors.push('feedback');
  }
```

Modify the narration/delivery section:
```javascript
  // Feedback items use Block Kit — exclude from AI narration
  const regularItems = allItems.filter(i => i.collector !== 'feedback');

  // ... existing narration call on regularItems ...

  // Append lightweight mention to narrated message
  if (feedbackItems.length > 0) {
    message += `\n\n:pencil: *${feedbackItems.length} feedback candidate${feedbackItems.length > 1 ? 's' : ''} waiting* — open Reticle to review`;
  }

  // Send with Block Kit buttons as secondary quick path
  const feedbackBlocks = buildFeedbackBlocks(feedbackItems);
  await sendSlackDM(message, feedbackBlocks.length > 0 ? feedbackBlocks : null);
```

**Step 6: Verify syntax**
```bash
node -c lib/feedback-blocks.js
node -c slack-events-monitor.js
node -c digest-daily.js
```

**Step 7: Run all tests — expect PASS**

**Step 8: Commit**
```bash
git add lib/feedback-blocks.js test-feedback-blocks.js slack-events-monitor.js digest-daily.js
git commit -m "feat(feedback): add Block Kit blocks, Slack button handlers, and digest integration"
```

---

## Phase 2: Gateway API

### Task 8: Gateway — People Endpoints

Expose people management via the gateway so Reticle and the tray can read/write.

**Context:** Read the existing gateway to understand the Express router pattern before adding routes.

**Files:** Modify `gateway.js` (or wherever routes are defined — check first)

**Step 1: Read the gateway to understand the route pattern**

Run: `node -e "const g = require('./gateway'); console.log(Object.keys(g))"` or read the file directly.

**Step 2: Add people routes**

```javascript
const peopleStore = require('./lib/people-store');
const slackReader = require('./lib/slack-reader');

// GET /people — list all monitored people
app.get('/people', (req, res) => {
  const db = getDb(); // use existing DB accessor pattern
  const people = peopleStore.listPeople(db);
  res.json({ people });
});

// POST /people — add person by email (triggers Slack resolution)
app.post('/people', async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const db = getDb();
  peopleStore.addPerson(db, { email, name });

  // Resolve Slack ID in background
  slackReader.lookupUserByEmail(email).then(slackId => {
    if (slackId) peopleStore.updateSlackId(db, email, slackId);
  }).catch(() => {});

  res.json({ ok: true, email });
});

// DELETE /people/:email — remove person
app.delete('/people/:email', (req, res) => {
  const db = getDb();
  peopleStore.removePerson(db, decodeURIComponent(req.params.email));
  res.json({ ok: true });
});
```

**Step 3: Verify syntax and restart gateway to test manually**

```bash
node -c gateway.js
curl http://localhost:<gateway_port>/people
```

**Step 4: Commit**
```bash
git add gateway.js
git commit -m "feat(gateway): add people management endpoints"
```

---

### Task 9: Gateway — Feedback Endpoints

Expose feedback candidates and stats via gateway.

**Files:** Modify `gateway.js`

**Context:** Feedback candidates are generated by the collector and need to be persisted temporarily between digest run and user review. Store in a simple in-memory cache or a `feedback_candidates` table.

**Step 1: Add `feedback_candidates` table to `claudia-db.js`**

```javascript
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_candidates (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      account_id  TEXT,
      report_name TEXT NOT NULL,
      channel     TEXT,
      raw_artifact TEXT NOT NULL,
      draft       TEXT,
      feedback_type TEXT,
      entity_id   TEXT,
      status      TEXT NOT NULL DEFAULT 'pending'
    );
  `);
```

**Step 2: Save candidates after collection in `digest-daily.js`**

After `collectFeedback()`, persist items:
```javascript
  for (const item of feedbackItems) {
    db.prepare(`
      INSERT OR IGNORE INTO feedback_candidates
        (account_id, report_name, channel, raw_artifact, draft, feedback_type, entity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, item.counterparty, item.authority,
        item.rawArtifact, item.feedbackDraft, item.feedbackType, item.entityId);
  }
```

**Step 3: Add feedback routes to gateway**

```javascript
const feedbackTracker = require('./lib/feedback-tracker');

// GET /feedback/candidates — pending candidates
app.get('/feedback/candidates', (req, res) => {
  const db = getDb();
  const candidates = db.prepare(
    `SELECT * FROM feedback_candidates WHERE status = 'pending' ORDER BY created_at DESC`
  ).all();
  res.json({ candidates });
});

// POST /feedback/candidates/:id/delivered
app.post('/feedback/candidates/:id/delivered', (req, res) => {
  const db = getDb();
  const candidate = db.prepare('SELECT * FROM feedback_candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'not found' });

  db.prepare(`UPDATE feedback_candidates SET status = 'delivered' WHERE id = ?`).run(req.params.id);
  feedbackTracker.logFeedbackAction(db, candidate.account_id, {
    reportName: candidate.report_name,
    feedbackType: candidate.feedback_type,
    action: 'feedback_delivered',
    entityId: candidate.entity_id
  });
  res.json({ ok: true });
});

// POST /feedback/candidates/:id/skipped
app.post('/feedback/candidates/:id/skipped', (req, res) => {
  const db = getDb();
  const candidate = db.prepare('SELECT * FROM feedback_candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'not found' });

  db.prepare(`UPDATE feedback_candidates SET status = 'skipped' WHERE id = ?`).run(req.params.id);
  feedbackTracker.logFeedbackAction(db, candidate.account_id, {
    reportName: candidate.report_name,
    feedbackType: candidate.feedback_type,
    action: 'feedback_skipped',
    entityId: candidate.entity_id
  });
  res.json({ ok: true });
});

// GET /feedback/stats
app.get('/feedback/stats', (req, res) => {
  const db = getDb();
  const accountId = getPrimaryAccountId(db);
  const now = Math.floor(Date.now() / 1000);
  const weekly = feedbackTracker.getWeeklyCountsByReport(db, accountId, now - 7 * 86400);
  const monthly = feedbackTracker.getMonthlyCountsByReport(db, accountId, now - 30 * 86400);
  const ratios = feedbackTracker.getRatioByReport(db, accountId, now - 30 * 86400);
  res.json({ weekly, monthly, ratios });
});
```

**Step 4: Commit**
```bash
git add gateway.js claudia-db.js
git commit -m "feat(gateway): add feedback candidate and stats endpoints"
```

---

### Task 10: Config + Tray Updates

**Files:** Modify `lib/config.js`, `tray/main.js`, `package.json`

**Step 1: Add feedback config to `lib/config.js`**

After existing exports, add:
```javascript
  feedback: team.feedback || { weeklyTarget: 3, scanWindowHours: 24 },
```

Note: `directReports` in team.json still works for backward compatibility. People in `monitored_people` table are the new source of truth. The gateway seeds from `directReports` on first run if desired.

**Step 2: Simplify tray feedback section to use gateway**

In `tray/main.js`, replace the `getFeedbackMenu` function with a gateway call:

```javascript
async function getFeedbackMenu() {
  try {
    const gatewayPort = config.gatewayPort || 3001;
    const res = await fetch(`http://localhost:${gatewayPort}/feedback/stats`);
    const { weekly, ratios } = await res.json();

    const items = [];
    const now = Math.floor(Date.now() / 1000);
    const weekStart = now - 7 * 86400;

    const target = config.feedback?.weeklyTarget || 3;
    const allNames = Object.keys(weekly);

    for (const name of allNames) {
      const w = weekly[name] || { delivered: 0 };
      const bar = '█'.repeat(Math.min(w.delivered, target)) + '─'.repeat(Math.max(0, target - w.delivered));
      items.push({ label: `  ${name}  ${bar} ${w.delivered}/${target}`, enabled: false });
    }

    items.push({ type: 'separator' });
    items.push({ label: '  Open Reticle', click: () => { /* shell open Reticle app */ } });

    return items;
  } catch {
    return [{ label: '  Feedback unavailable', enabled: false }];
  }
}
```

**Step 3: Update test runner in `package.json`**

Add new test files to the test script:
```
&& node test-slack-reader.js && node test-people-store.js && node test-feedback-collector.js && node test-feedback-tracker.js && node test-feedback-blocks.js
```

**Step 4: Run full test suite**
```bash
npm test
```
Expected: All tests PASS

**Step 5: Commit**
```bash
git add lib/config.js tray/main.js package.json
git commit -m "feat: update config, tray, and test runner for feedback feature"
```

---

## Phase 3: Swift App (Reticle)

### Task 11: Xcode Project Setup

**Step 1: Create the Xcode project**

In Xcode: File → New → Project → macOS → App
- Product Name: Reticle
- Interface: SwiftUI
- Language: Swift
- Bundle ID: `ai.openclaw.reticle`
- Save to: `reticle/` in repo root

**Step 2: Configure the project**

- Set minimum deployment target: macOS 14.0 (Sonoma)
- Remove default ContentView boilerplate
- Add `Info.plist` entry: `NSAppTransportSecurity` → `NSAllowsLocalNetworking: YES` (for gateway calls)

**Step 3: Add to `.gitignore`**

Add to root `.gitignore`:
```
reticle/DerivedData/
reticle/*.xcuserdata/
reticle/Reticle.xcodeproj/project.xcworkspace/xcuserdata/
```

**Step 4: Commit the empty project skeleton**
```bash
git add reticle/
git commit -m "feat(reticle): add SwiftUI Xcode project skeleton"
```

---

### Task 12: Gateway API Client (Swift)

Create a Swift service layer that wraps all gateway API calls.

**File:** `reticle/Reticle/Services/GatewayClient.swift`

```swift
import Foundation

struct Person: Codable, Identifiable {
    let id: String?
    let email: String
    let name: String?
    let slackId: String?
    let jiraId: String?
    let resolvedAt: Int?

    enum CodingKeys: String, CodingKey {
        case id, email, name
        case slackId = "slack_id"
        case jiraId = "jira_id"
        case resolvedAt = "resolved_at"
    }
}

struct FeedbackCandidate: Codable, Identifiable {
    let id: String
    let reportName: String
    let channel: String?
    let rawArtifact: String
    let draft: String?
    let feedbackType: String?
    let status: String
    let createdAt: Int

    enum CodingKeys: String, CodingKey {
        case id, channel, status, draft
        case reportName = "report_name"
        case rawArtifact = "raw_artifact"
        case feedbackType = "feedback_type"
        case createdAt = "created_at"
    }
}

struct FeedbackStats: Codable {
    let weekly: [String: ReportCounts]
    let monthly: [String: ReportCounts]
    let ratios: [String: ReportRatio]
}

struct ReportCounts: Codable {
    let delivered: Int
    let skipped: Int
}

struct ReportRatio: Codable {
    let affirming: Int
    let adjusting: Int
    let total: Int
}

@MainActor
class GatewayClient: ObservableObject {
    private let baseURL: String

    init(port: Int = 3001) {
        self.baseURL = "http://localhost:\(port)"
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        guard let url = URL(string: baseURL + path) else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body = body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func listPeople() async throws -> [Person] {
        struct Response: Decodable { let people: [Person] }
        let res: Response = try await request("/people")
        return res.people
    }

    func addPerson(email: String, name: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/people", method: "POST", body: ["email": email, "name": name])
    }

    func removePerson(email: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let encoded = email.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? email
        let _: Response = try await request("/people/\(encoded)", method: "DELETE")
    }

    func listCandidates() async throws -> [FeedbackCandidate] {
        struct Response: Decodable { let candidates: [FeedbackCandidate] }
        let res: Response = try await request("/feedback/candidates")
        return res.candidates
    }

    func markDelivered(id: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/feedback/candidates/\(id)/delivered", method: "POST")
    }

    func markSkipped(id: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/feedback/candidates/\(id)/skipped", method: "POST")
    }

    func fetchStats() async throws -> FeedbackStats {
        return try await request("/feedback/stats")
    }
}
```

**Commit:**
```bash
git add reticle/
git commit -m "feat(reticle): add gateway API client with People and Feedback models"
```

---

### Task 13: Reticle App Structure + Navigation

**File:** `reticle/Reticle/ReticleApp.swift`, `reticle/Reticle/ContentView.swift`

```swift
// ReticleApp.swift
import SwiftUI

@main
struct ReticleApp: App {
    @StateObject private var gateway = GatewayClient()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(gateway)
                .frame(minWidth: 800, minHeight: 500)
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
```

```swift
// ContentView.swift
import SwiftUI

enum Section: String, CaseIterable, Identifiable {
    case people = "People"
    case feedback = "Feedback"
    case messages = "Messages"
    case todos = "To-dos"
    case goals = "Goals"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .people: return "person.2"
        case .feedback: return "bubble.left.and.bubble.right"
        case .messages: return "envelope"
        case .todos: return "checklist"
        case .goals: return "target"
        }
    }

    var isAvailable: Bool {
        switch self {
        case .people, .feedback: return true
        default: return false
        }
    }
}

struct ContentView: View {
    @State private var selectedSection: Section = .feedback

    var body: some View {
        NavigationSplitView {
            List(Section.allCases, selection: $selectedSection) { section in
                Label(section.rawValue, systemImage: section.icon)
                    .foregroundStyle(section.isAvailable ? .primary : .tertiary)
                    .tag(section)
            }
            .navigationSplitViewColumnWidth(160)
        } detail: {
            switch selectedSection {
            case .people:
                PeopleView()
            case .feedback:
                FeedbackView()
            default:
                ContentUnavailableView(
                    "\(selectedSection.rawValue) Coming Soon",
                    systemImage: selectedSection.icon,
                    description: Text("This section is under construction.")
                )
            }
        }
        .navigationTitle("Reticle")
    }
}
```

**Commit:**
```bash
git add reticle/
git commit -m "feat(reticle): add app structure and NavigationSplitView with section nav"
```

---

### Task 14: People Section (SwiftUI)

**File:** `reticle/Reticle/Views/PeopleView.swift`

```swift
import SwiftUI

struct PeopleView: View {
    @EnvironmentObject var gateway: GatewayClient
    @State private var people: [Person] = []
    @State private var newEmail = ""
    @State private var newName = ""
    @State private var isAdding = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            List {
                ForEach(people) { person in
                    PersonRow(person: person)
                }
                .onDelete { offsets in
                    for index in offsets {
                        let email = people[index].email
                        Task {
                            try? await gateway.removePerson(email: email)
                            await loadPeople()
                        }
                    }
                }
            }

            Divider()

            HStack {
                TextField("Name", text: $newName)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 150)
                TextField("Email address", text: $newEmail)
                    .textFieldStyle(.roundedBorder)
                Button("Add") {
                    guard !newEmail.isEmpty else { return }
                    Task {
                        try? await gateway.addPerson(email: newEmail, name: newName)
                        newEmail = ""
                        newName = ""
                        await loadPeople()
                    }
                }
                .disabled(newEmail.isEmpty)
            }
            .padding()
        }
        .navigationTitle("People")
        .task { await loadPeople() }
    }

    func loadPeople() async {
        people = (try? await gateway.listPeople()) ?? []
    }
}

struct PersonRow: View {
    let person: Person

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(person.name ?? person.email)
                .font(.headline)
            Text(person.email)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                IdentityBadge(label: "Slack", value: person.slackId)
                IdentityBadge(label: "Jira", value: person.jiraId)
                IdentityBadge(label: "Gmail", value: person.email)
            }
        }
        .padding(.vertical, 4)
    }
}

struct IdentityBadge: View {
    let label: String
    let value: String?

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: value != nil ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(value != nil ? .green : .secondary)
                .imageScale(.small)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
```

**Commit:**
```bash
git add reticle/
git commit -m "feat(reticle): add People section with add/remove and identity resolution status"
```

---

### Task 15: Feedback Section (SwiftUI)

**File:** `reticle/Reticle/Views/FeedbackView.swift`

```swift
import SwiftUI

struct FeedbackView: View {
    @EnvironmentObject var gateway: GatewayClient
    @State private var candidates: [FeedbackCandidate] = []
    @State private var selected: FeedbackCandidate?
    @State private var editedDraft = ""
    @State private var copied = false

    var body: some View {
        HSplitView {
            // Left: candidate list
            List(candidates, selection: $selected) { candidate in
                CandidateRow(candidate: candidate)
                    .tag(candidate)
            }
            .frame(minWidth: 220, maxWidth: 280)
            .onChange(of: selected) { _, newValue in
                editedDraft = newValue?.draft ?? ""
                copied = false
            }

            // Right: detail panel
            if let candidate = selected {
                FeedbackDetailView(
                    candidate: candidate,
                    editedDraft: $editedDraft,
                    copied: $copied,
                    onDelivered: {
                        Task {
                            try? await gateway.markDelivered(id: candidate.id)
                            await loadCandidates()
                            selected = nil
                        }
                    },
                    onSkipped: {
                        Task {
                            try? await gateway.markSkipped(id: candidate.id)
                            await loadCandidates()
                            selected = nil
                        }
                    }
                )
            } else {
                ContentUnavailableView(
                    "No Candidate Selected",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Select a feedback candidate to review.")
                )
            }
        }
        .navigationTitle("Feedback")
        .toolbar {
            ToolbarItem {
                Button(action: { Task { await loadCandidates() } }) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .task { await loadCandidates() }
    }

    func loadCandidates() async {
        candidates = (try? await gateway.listCandidates()) ?? []
    }
}

struct CandidateRow: View {
    let candidate: FeedbackCandidate

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Circle()
                    .fill(candidate.feedbackType == "affirming" ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                Text(candidate.reportName)
                    .font(.headline)
            }
            Text(candidate.channel ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

struct FeedbackDetailView: View {
    let candidate: FeedbackCandidate
    @Binding var editedDraft: String
    @Binding var copied: Bool
    let onDelivered: () -> Void
    let onSkipped: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Header
                VStack(alignment: .leading, spacing: 4) {
                    Text(candidate.reportName)
                        .font(.title2).bold()
                    Text(candidate.channel ?? "")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Divider()

                // Raw artifact
                GroupBox("Observed") {
                    Text(candidate.rawArtifact)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                // Editable draft
                GroupBox("Draft (edit before sending)") {
                    TextEditor(text: $editedDraft)
                        .font(.body)
                        .frame(minHeight: 80)
                }

                // Actions
                HStack {
                    Button(copied ? "Copied!" : "Copy to clipboard") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(editedDraft, forType: .string)
                        copied = true
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(editedDraft.isEmpty)

                    Button("Mark Delivered") {
                        onDelivered()
                    }
                    .disabled(!copied)

                    Spacer()

                    Button("Skip") {
                        onSkipped()
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .padding()
        }
        .frame(minWidth: 400)
    }
}
```

**Note on UX:** "Mark Delivered" is only enabled after copying — this enforces that the manager has actually taken the draft before logging delivery.

**Commit:**
```bash
git add reticle/
git commit -m "feat(reticle): add Feedback section with candidate list, detail panel, and copy workflow"
```

---

## Phase 4: End-to-End Verification

### Task 16: End-to-End Verification

**Steps:**

1. **Run full test suite:** `npm test` — all tests pass

2. **Verify Node.js file inventory:**
   - `lib/slack-reader.js` ✓
   - `lib/people-store.js` ✓
   - `lib/feedback-collector.js` ✓
   - `lib/feedback-tracker.js` ✓
   - `lib/feedback-blocks.js` ✓
   - `test-slack-reader.js` ✓
   - `test-people-store.js` ✓
   - `test-feedback-collector.js` ✓
   - `test-feedback-tracker.js` ✓
   - `test-feedback-blocks.js` ✓
   - `claudia-db.js` — `monitored_people` + `feedback_candidates` tables ✓
   - `gateway.js` — people + feedback routes ✓
   - `digest-daily.js` — feedback collector + lightweight mention ✓
   - `slack-events-monitor.js` — Delivered/Skip button handlers ✓
   - `tray/main.js` — counts via gateway ✓
   - `lib/config.js` — feedback config ✓

3. **Verify Swift app builds:** Open `reticle/Reticle.xcodeproj` in Xcode, build for macOS (Cmd+B) — no errors

4. **Manual flow test:**
   - Start gateway + digest services
   - Add a person via Reticle People section or `POST /people`
   - Verify Slack ID resolves in People view
   - Run `node digest-daily.js` manually
   - Check `GET /feedback/candidates` returns candidates
   - Open Reticle Feedback section, verify candidates appear
   - Edit draft, copy, mark delivered
   - Verify `GET /feedback/stats` reflects the delivery

5. **Review commit log** — clean history, one commit per task

6. **Update team.json documentation** — note that `directReports` entries can now optionally include `slackId` for backward compat, but the new `monitored_people` table is the source of truth managed via Reticle.
