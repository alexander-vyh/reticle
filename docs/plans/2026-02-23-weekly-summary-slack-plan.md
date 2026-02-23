# Weekly Summary Slack Collection & Synthesis — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Collect Slack messages from all channels/DMs weekly, summarize per-channel with Haiku, synthesize into a Digital Workplace weekly report draft with Sonnet, and deliver via Slack DM every Friday.

**Architecture:** Two-phase pipeline — a collector fetches and stores raw messages as JSON files, then a synthesizer runs two-tier AI (Haiku per-channel → Sonnet final) to produce the report draft. Both are launchd-scheduled services with CLI fallback.

**Tech Stack:** Node.js, raw HTTPS (Slack Web API), `@anthropic-ai/sdk` (Claude API via `lib/ai.js` pattern), `fs` for intermediate storage, launchd `StartCalendarInterval` for scheduling.

---

## Task 1: Slack Reader Module — Rate Limiter + API Helper

**Files:**
- Create: `lib/slack-reader.js`
- Create: `test-slack-reader.js`

**Step 1: Write the failing test for rate limiter**

Create `test-slack-reader.js`:

```javascript
// test-slack-reader.js
'use strict';

const assert = require('assert');

// --- Test 1: Rate limiter spaces requests correctly ---
// We test the rate limiter in isolation before testing API calls
const { _rateLimiter } = require('./lib/slack-reader');

const start = Date.now();
let callCount = 0;

async function testRateLimiter() {
  // Fire 5 rapid requests through the limiter
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(_rateLimiter.acquire().then(() => { callCount++; }));
  }
  await Promise.all(promises);

  const elapsed = Date.now() - start;
  assert.strictEqual(callCount, 5, 'all 5 calls should complete');
  // 5 calls at 40/min = 1 every 1500ms. First is instant, so 4 gaps = 6000ms minimum.
  // Allow some tolerance.
  assert.ok(elapsed >= 5000, `should take >=5000ms for 5 rate-limited calls, took ${elapsed}ms`);
  console.log(`PASS: rate limiter spaced 5 calls over ${elapsed}ms`);
}

testRateLimiter().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
```

**Step 2: Run test to verify it fails**

Run: `node test-slack-reader.js`
Expected: FAIL with `Cannot find module './lib/slack-reader'`

**Step 3: Write the slack-reader module with rate limiter and API helper**

Create `lib/slack-reader.js`:

```javascript
// lib/slack-reader.js
'use strict';

const https = require('https');
const config = require('./config');
const log = require('./logger')('slack-reader');

const SLACK_TOKEN = config.slackBotToken;

// --- Rate Limiter (token bucket, 40 req/min) ---
const RATE_LIMIT = 40;                         // requests per minute
const INTERVAL = Math.ceil(60000 / RATE_LIMIT); // ms between requests (~1500ms)
let lastRequestTime = 0;

const _rateLimiter = {
  acquire() {
    return new Promise(resolve => {
      const now = Date.now();
      const wait = Math.max(0, lastRequestTime + INTERVAL - now);
      lastRequestTime = now + wait;
      if (wait === 0) resolve();
      else setTimeout(resolve, wait);
    });
  }
};

// --- Core API helper ---

/**
 * Call a Slack Web API method with rate limiting.
 * @param {string} method - API method (e.g. 'conversations.list')
 * @param {object} params - Query/body params
 * @returns {Promise<object>} Parsed API response
 */
async function slackGet(method, params = {}) {
  await _rateLimiter.acquire();

  const query = new URLSearchParams(params).toString();
  const urlPath = `/api/${method}${query ? '?' + query : ''}`;

  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'slack.com',
      path: urlPath,
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.ok) {
            // Handle rate limit response from Slack
            if (data.error === 'ratelimited') {
              const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
              log.warn({ method, retryAfter }, 'Slack rate limited, retrying');
              setTimeout(() => {
                slackGet(method, params).then(resolve).catch(reject);
              }, retryAfter * 1000);
              return;
            }
            reject(new Error(`Slack API ${method}: ${data.error}`));
          } else {
            resolve(data);
          }
        } catch (e) {
          reject(new Error(`Slack response parse error for ${method}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
  });
}

module.exports = { slackGet, _rateLimiter };
```

**Step 4: Run test to verify it passes**

Run: `node test-slack-reader.js`
Expected: PASS (takes ~6-7 seconds due to rate limiting)

**Step 5: Commit**

```bash
git add lib/slack-reader.js test-slack-reader.js
git commit -m "feat(slack-reader): add rate-limited Slack API helper"
```

---

## Task 2: Slack Reader — Conversation Listing with Pagination

**Files:**
- Modify: `lib/slack-reader.js`
- Modify: `test-slack-reader.js`

**Step 1: Add test for listConversations pagination assembly**

Append to `test-slack-reader.js` (inside the async function, after the rate limiter test):

```javascript
// --- Test 2: listConversations returns channels ---
// This is a live integration test — requires valid Slack token
const { listConversations } = require('./lib/slack-reader');

async function testListConversations() {
  const conversations = await listConversations();
  assert.ok(Array.isArray(conversations), 'should return an array');
  assert.ok(conversations.length > 0, 'should have at least one conversation');

  // Each should have id, name (or is_im), and last_activity
  const first = conversations[0];
  assert.ok(first.id, 'conversation should have id');
  assert.ok(first.type, 'conversation should have type');
  console.log(`PASS: listConversations returned ${conversations.length} conversations`);
}
```

**Step 2: Run test to verify it fails**

Run: `node test-slack-reader.js`
Expected: FAIL with `listConversations is not a function`

**Step 3: Implement listConversations in slack-reader.js**

Add to `lib/slack-reader.js` before `module.exports`:

```javascript
// --- In-memory caches ---
const userCache = new Map();
const channelCache = new Map();

/**
 * List all conversations the bot user is a member of.
 * Handles pagination. Returns normalized conversation objects.
 * @returns {Promise<Array<{id, name, type, lastActivity}>>}
 */
async function listConversations() {
  const all = [];
  let cursor = '';

  do {
    const params = {
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: 'true',
      limit: '200'
    };
    if (cursor) params.cursor = cursor;

    const data = await slackGet('conversations.list', params);
    for (const ch of (data.channels || [])) {
      let type = 'public_channel';
      if (ch.is_im) type = 'im';
      else if (ch.is_mpim) type = 'mpim';
      else if (ch.is_private) type = 'private_channel';

      all.push({
        id: ch.id,
        name: ch.name || ch.id,
        type,
        userId: ch.user || null,  // For IMs, the other user's ID
        lastActivity: ch.updated || 0
      });
    }

    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);

  log.info({ count: all.length }, 'Listed conversations');
  return all;
}
```

Update `module.exports`:

```javascript
module.exports = { slackGet, listConversations, _rateLimiter };
```

**Step 4: Run test to verify it passes**

Run: `node test-slack-reader.js`
Expected: PASS for both tests (rate limiter + listConversations)

**Step 5: Commit**

```bash
git add lib/slack-reader.js test-slack-reader.js
git commit -m "feat(slack-reader): add listConversations with pagination"
```

---

## Task 3: Slack Reader — Conversation History + User/Channel Resolution

**Files:**
- Modify: `lib/slack-reader.js`
- Modify: `test-slack-reader.js`

**Step 1: Add test for getConversationHistory**

Append to `test-slack-reader.js`:

```javascript
const { getConversationHistory, getUserDisplayName, getConversationName } = require('./lib/slack-reader');

async function testGetHistory() {
  // Get first conversation from the list
  const convos = await listConversations();
  const target = convos.find(c => c.type === 'public_channel') || convos[0];

  const oneWeekAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const now = Math.floor(Date.now() / 1000);

  const messages = await getConversationHistory(target.id, oneWeekAgo, now);
  assert.ok(Array.isArray(messages), 'should return an array');
  console.log(`PASS: getConversationHistory returned ${messages.length} messages from #${target.name}`);
}

async function testUserResolution() {
  // Resolve the bot's own user ID
  const name = await getUserDisplayName(config.slackUserId);
  assert.ok(typeof name === 'string' && name.length > 0, 'should resolve to a name');
  console.log(`PASS: getUserDisplayName resolved to "${name}"`);
}
```

**Step 2: Run test to verify it fails**

Run: `node test-slack-reader.js`
Expected: FAIL with `getConversationHistory is not a function`

**Step 3: Implement history, user resolution, and channel name resolution**

Add to `lib/slack-reader.js` before `module.exports`:

```javascript
/**
 * Fetch message history for a conversation within a time range.
 * Handles pagination for channels with 1000+ messages.
 * @param {string} channelId
 * @param {number} oldest - Unix timestamp (seconds)
 * @param {number} latest - Unix timestamp (seconds)
 * @returns {Promise<Array<{ts, user, text, subtype}>>}
 */
async function getConversationHistory(channelId, oldest, latest) {
  const all = [];
  let cursor = '';

  do {
    const params = {
      channel: channelId,
      oldest: String(oldest),
      latest: String(latest),
      limit: '200',
      inclusive: 'true'
    };
    if (cursor) params.cursor = cursor;

    const data = await slackGet('conversations.history', params);
    for (const msg of (data.messages || [])) {
      all.push({
        ts: msg.ts,
        user: msg.user || msg.bot_id || 'unknown',
        text: msg.text || '',
        subtype: msg.subtype || null
      });
    }

    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);

  // Slack returns newest-first; reverse to chronological order
  all.reverse();
  return all;
}

/**
 * Resolve a Slack user ID to a display name. Cached.
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function getUserDisplayName(userId) {
  if (userCache.has(userId)) return userCache.get(userId);

  try {
    const data = await slackGet('users.info', { user: userId });
    const name = data.user?.profile?.real_name || data.user?.name || userId;
    userCache.set(userId, name);
    return name;
  } catch (err) {
    log.warn({ userId, err: err.message }, 'Failed to resolve user');
    userCache.set(userId, userId); // Cache the ID to avoid re-fetching
    return userId;
  }
}

/**
 * Resolve a conversation ID to a human-readable name. Cached.
 * For IMs, resolves to the other user's display name.
 * @param {string} channelId
 * @param {string|null} userId - For IMs, the other user's ID
 * @returns {Promise<string>}
 */
async function getConversationName(channelId, userId = null) {
  if (channelCache.has(channelId)) return channelCache.get(channelId);

  // For IMs, resolve via user name
  if (userId) {
    const name = await getUserDisplayName(userId);
    const dmName = `dm-${name.toLowerCase().replace(/\s+/g, '-')}`;
    channelCache.set(channelId, dmName);
    return dmName;
  }

  try {
    const data = await slackGet('conversations.info', { channel: channelId });
    const name = data.channel?.name || channelId;
    channelCache.set(channelId, name);
    return name;
  } catch (err) {
    log.warn({ channelId, err: err.message }, 'Failed to resolve conversation');
    channelCache.set(channelId, channelId);
    return channelId;
  }
}
```

Update `module.exports`:

```javascript
module.exports = {
  slackGet, listConversations, getConversationHistory,
  getUserDisplayName, getConversationName, _rateLimiter
};
```

**Step 4: Run test to verify it passes**

Run: `node test-slack-reader.js`
Expected: PASS for all tests

**Step 5: Commit**

```bash
git add lib/slack-reader.js test-slack-reader.js
git commit -m "feat(slack-reader): add history fetching and user/channel resolution"
```

---

## Task 4: Weekly Summary Collector

**Files:**
- Create: `weekly-summary-collector.js`

**Step 1: Write the collector service**

Create `weekly-summary-collector.js`:

```javascript
#!/usr/bin/env node
/**
 * Claudia Weekly Summary Collector
 * Fetches Slack messages from all channels/DMs for the past 7 days
 * and stores them as JSON files for the synthesizer.
 *
 * Usage: node weekly-summary-collector.js [--force]
 * Scheduled: Fridays at 3:00 PM via launchd
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  listConversations, getConversationHistory,
  getUserDisplayName, getConversationName
} = require('./lib/slack-reader');
const { sendSlackDM } = require('./lib/slack');
const log = require('./lib/logger')('weekly-collector');

const DATA_DIR = process.env.CLAUDIA_DATA_DIR || path.join(os.homedir(), '.claudia', 'data');
const RETENTION_WEEKS = 4;

/**
 * Resolve all <@U1234> user mentions in a text string to display names.
 */
async function resolveUserMentions(text) {
  const mentionRegex = /<@(U[A-Z0-9]+)>/g;
  const matches = [...text.matchAll(mentionRegex)];
  let resolved = text;
  for (const match of matches) {
    const name = await getUserDisplayName(match[1]);
    resolved = resolved.replace(match[0], `@${name}`);
  }
  return resolved;
}

/**
 * Filter out noise messages (bots, join/leave, reactions, very short messages).
 */
function isSignalMessage(msg) {
  // Skip system subtypes
  const noiseSubtypes = [
    'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
    'channel_name', 'bot_message', 'file_comment', 'pinned_item',
    'unpinned_item', 'group_join', 'group_leave'
  ];
  if (msg.subtype && noiseSubtypes.includes(msg.subtype)) return false;

  // Skip very short messages (reactions, "ok", "ty", emoji-only)
  if (!msg.text || msg.text.trim().length < 5) return false;

  return true;
}

/**
 * Collect messages from all active conversations for the past 7 days.
 */
async function collect() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const outputDir = path.join(DATA_DIR, 'weekly-summary', today);
  const channelsDir = path.join(outputDir, 'channels');

  const forceRecollect = process.argv.includes('--force') || process.env.FORCE_RECOLLECT === '1';

  // Idempotency check
  if (fs.existsSync(outputDir) && !forceRecollect) {
    log.info({ outputDir }, 'Collection already exists for today, skipping (use --force to override)');
    return;
  }

  fs.mkdirSync(channelsDir, { recursive: true });

  const now = Math.floor(Date.now() / 1000);
  const oneWeekAgo = now - (7 * 24 * 60 * 60);

  log.info('Starting weekly Slack collection...');

  // Step 1: List all conversations
  const conversations = await listConversations();
  log.info({ total: conversations.length }, 'Found conversations');

  // Step 2: Filter to recently active conversations
  // lastActivity from conversations.list is the channel's `updated` timestamp (seconds)
  const active = conversations.filter(c => c.lastActivity >= oneWeekAgo);
  log.info({ active: active.length, skipped: conversations.length - active.length }, 'Filtered to active conversations');

  let totalMessages = 0;
  let channelCount = 0;
  const errors = [];

  // Step 3: Fetch history for each active channel
  for (const conv of active) {
    try {
      const messages = await getConversationHistory(conv.id, oneWeekAgo, now);
      const filtered = messages.filter(isSignalMessage);

      if (filtered.length === 0) continue; // Skip empty channels

      // Resolve user names and mentions
      const resolved = [];
      for (const msg of filtered) {
        const userName = await getUserDisplayName(msg.user);
        const text = await resolveUserMentions(msg.text);
        resolved.push({ ts: msg.ts, user: userName, text });
      }

      const channelName = await getConversationName(conv.id, conv.userId);

      const channelData = {
        channelId: conv.id,
        channelName,
        channelType: conv.type,
        messageCount: resolved.length,
        messages: resolved
      };

      // Sanitize channel name for filename
      const safeName = channelName.replace(/[^a-z0-9_-]/gi, '_').substring(0, 50);
      const filename = `${conv.id}-${safeName}.json`;
      fs.writeFileSync(
        path.join(channelsDir, filename),
        JSON.stringify(channelData, null, 2)
      );

      totalMessages += resolved.length;
      channelCount++;
      log.debug({ channel: channelName, messages: resolved.length }, 'Collected');

    } catch (err) {
      log.warn({ channelId: conv.id, err: err.message }, 'Failed to collect channel');
      errors.push({ channelId: conv.id, error: err.message });
    }
  }

  // Step 4: Write metadata
  const metadata = {
    collectedAt: new Date().toISOString(),
    dateRange: {
      from: new Date(oneWeekAgo * 1000).toISOString(),
      to: new Date(now * 1000).toISOString()
    },
    totalConversations: conversations.length,
    activeConversations: active.length,
    channelsWithMessages: channelCount,
    totalMessages,
    errors
  };

  fs.writeFileSync(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  log.info({
    channels: channelCount,
    messages: totalMessages,
    errors: errors.length
  }, 'Collection complete');

  // Step 5: Cleanup old collections
  cleanupOldCollections();

  return metadata;
}

/**
 * Remove collection directories older than RETENTION_WEEKS.
 */
function cleanupOldCollections() {
  const summaryDir = path.join(DATA_DIR, 'weekly-summary');
  if (!fs.existsSync(summaryDir)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (RETENTION_WEEKS * 7));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const entries = fs.readdirSync(summaryDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name < cutoffStr) {
      const dirPath = path.join(summaryDir, entry.name);
      log.info({ dir: entry.name }, 'Removing old collection');
      fs.rmSync(dirPath, { recursive: true });
    }
  }
}

// --- Main ---
collect()
  .then(metadata => {
    if (metadata) {
      console.log(`Collection complete: ${metadata.channelsWithMessages} channels, ${metadata.totalMessages} messages`);
    }
  })
  .catch(async (err) => {
    log.error({ err }, 'Collection failed');
    try {
      await sendSlackDM(`Weekly summary collection failed: ${err.message}`);
    } catch {}
    process.exit(1);
  });
```

**Step 2: Test the collector manually**

Run: `node weekly-summary-collector.js`
Expected: Creates `~/.claudia/data/weekly-summary/2026-02-23/` with channel JSON files and `metadata.json`. Logs show channel counts and message counts. Takes 3-5 minutes.

**Step 3: Verify output structure**

Run: `ls ~/.claudia/data/weekly-summary/2026-02-23/channels/ | head -10`
Expected: JSON files named like `C01ABC-general.json`

Run: `cat ~/.claudia/data/weekly-summary/2026-02-23/metadata.json`
Expected: Valid JSON with collection stats

**Step 4: Commit**

```bash
git add weekly-summary-collector.js
git commit -m "feat: add weekly summary Slack collector service"
```

---

## Task 5: Weekly Summary Synthesizer — AI Integration

**Files:**
- Create: `weekly-summary-synthesizer.js`

**Step 1: Write the synthesizer service**

This module needs a new general-purpose AI call function. Rather than modifying `lib/ai.js` (which is tightly coupled to email triage), the synthesizer calls the Anthropic SDK directly using the same `getClient()` pattern.

Create `weekly-summary-synthesizer.js`:

```javascript
#!/usr/bin/env node
/**
 * Claudia Weekly Summary Synthesizer
 * Reads collected Slack messages, summarizes per-channel with Haiku,
 * then produces a final DW weekly report with Sonnet.
 *
 * Usage: node weekly-summary-synthesizer.js [YYYY-MM-DD]
 * Scheduled: Fridays at 3:30 PM via launchd
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');
const { execSync } = require('child_process');
const { sendSlackDM } = require('./lib/slack');
const config = require('./lib/config');
const log = require('./lib/logger')('weekly-synthesizer');

const DATA_DIR = process.env.CLAUDIA_DATA_DIR || path.join(os.homedir(), '.claudia', 'data');

// --- AI Client (reuses keychain pattern from lib/ai.js) ---
let cachedToken = null;
let client = null;

function getClient() {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const data = JSON.parse(raw);
    const token = data.claudeAiOauth?.accessToken;
    if (!token) return null;
    if (data.claudeAiOauth?.expiresAt && Date.now() > data.claudeAiOauth.expiresAt) return null;

    if (token !== cachedToken) {
      cachedToken = token;
      client = new Anthropic({
        authToken: token,
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' }
      });
    }
    return client;
  } catch {
    // Fallback to env var
    if (!client) {
      try { client = new Anthropic(); } catch { return null; }
    }
    return client;
  }
}

// --- Per-channel summarization prompt ---
const CHANNEL_SUMMARY_PROMPT = `You are summarizing Slack messages for a Director of Digital Workplace and Security at an ad-tech company.

Extract from the conversation:
- Decisions made
- Action items assigned or completed
- Notable updates, changes, or announcements
- Blockers or risks mentioned
- Cross-team coordination

Ignore: casual chat, greetings, "thanks", emoji reactions, GIFs, off-topic banter.

Output: 3-5 bullet points maximum. Each bullet should be a concise, factual statement.
If the conversation contains nothing notable or actionable, respond with exactly: "No notable activity."`;

// --- Final synthesis prompt ---
function buildSynthesisPrompt(teamStructure) {
  return `You are writing a Digital Workplace weekly summary for a Director reporting to a VP of Infrastructure Operations at an ad-tech company (Example.co).

Team structure:
${teamStructure}

Instructions:
- Write in passive/impersonal voice (e.g., "Validated and corrected..." not "The team validated...")
- Focus on business outcomes, not ticket numbers or individual names
- Group accomplishments by team
- For each team section, write 2-5 bullet points covering the most significant work
- Include hiring/pipeline updates if mentioned in conversations
- The Executive Summary should be 2-3 sentences about overall stability, key themes, and risk posture

Output format (use this exact structure):

Digital Workplace

Executive Summary

[2-3 sentences]

---

Team Notes

Corporate Systems Engineering
[bullet points]

Desktop Support
[bullet points]

Security
[bullet points]`;
}

/**
 * Summarize a single channel's messages using Haiku.
 */
async function summarizeChannel(channelData) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('No AI credentials available');

  // Skip channels with very few messages
  if (channelData.messageCount < 5) {
    return 'No notable activity.';
  }

  // Format messages for the prompt
  const formatted = channelData.messages
    .map(m => `[${m.user}]: ${m.text}`)
    .join('\n');

  // Truncate if too long (Haiku context is 200K but let's stay reasonable)
  const truncated = formatted.length > 80000
    ? formatted.substring(0, 80000) + '\n\n[... truncated]'
    : formatted;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: CHANNEL_SUMMARY_PROMPT,
    messages: [{
      role: 'user',
      content: `Channel: #${channelData.channelName} (${channelData.channelType})\nMessages from the past week:\n\n${truncated}`
    }]
  });

  log.info({
    channel: channelData.channelName,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens
  }, 'Channel summarized');

  return response.content[0]?.text || 'No notable activity.';
}

/**
 * Produce the final weekly report from all channel summaries.
 */
async function synthesizeReport(channelSummaries) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('No AI credentials available');

  const teamStructure = [
    'Corporate Systems Engineering (CSE): Gandalf Grey, Samwise Brown, Aragorn King',
    '  - Focus: Identity/access management (Okta), automation, integrations, IaC',
    'Desktop Support: Faramir Guard, Eowyn Rider',
    '  - Focus: Device management, employee support tickets, hardware lifecycle',
    'Security: Legolas Wood, Gimli Stone',
    '  - Focus: Endpoint security, macOS enrollment, security monitoring, incident response'
  ].join('\n');

  // Format all channel summaries
  const summaryText = channelSummaries
    .filter(s => s.summary !== 'No notable activity.')
    .map(s => `### #${s.channelName} (${s.channelType})\n${s.summary}`)
    .join('\n\n');

  if (!summaryText) {
    return 'No notable activity across any channels this week.';
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20241022',
    max_tokens: 2000,
    system: buildSynthesisPrompt(teamStructure),
    messages: [{
      role: 'user',
      content: `Here are summaries from all active Slack channels this past week:\n\n${summaryText}\n\nPlease synthesize this into the Digital Workplace weekly summary.`
    }]
  });

  log.info({
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens
  }, 'Final synthesis complete');

  return response.content[0]?.text || '';
}

/**
 * Main synthesis pipeline.
 */
async function synthesize() {
  // Determine which date to process
  const dateArg = process.argv[2]; // Optional: YYYY-MM-DD
  const today = dateArg || new Date().toISOString().slice(0, 10);
  const collectionDir = path.join(DATA_DIR, 'weekly-summary', today);
  const channelsDir = path.join(collectionDir, 'channels');
  const summariesDir = path.join(collectionDir, 'summaries');

  // Check collector has run
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 5 * 60 * 1000; // 5 minutes

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (fs.existsSync(channelsDir)) break;
    if (attempt === MAX_RETRIES) {
      const msg = `Weekly summary synthesizer: no collection found at ${channelsDir} after ${MAX_RETRIES} retries`;
      log.error(msg);
      await sendSlackDM(msg);
      process.exit(1);
    }
    log.warn({ attempt: attempt + 1 }, 'Collection not found yet, waiting 5 minutes...');
    await new Promise(r => setTimeout(r, RETRY_DELAY));
  }

  fs.mkdirSync(summariesDir, { recursive: true });

  // Step 1: Per-channel summarization
  const channelFiles = fs.readdirSync(channelsDir).filter(f => f.endsWith('.json'));
  log.info({ channels: channelFiles.length }, 'Starting per-channel summarization');

  const channelSummaries = [];

  for (const file of channelFiles) {
    const channelData = JSON.parse(fs.readFileSync(path.join(channelsDir, file), 'utf8'));

    try {
      const summary = await summarizeChannel(channelData);

      channelSummaries.push({
        channelId: channelData.channelId,
        channelName: channelData.channelName,
        channelType: channelData.channelType,
        messageCount: channelData.messageCount,
        summary
      });

      // Write individual summary
      const summaryFile = file.replace('.json', '.txt');
      fs.writeFileSync(path.join(summariesDir, summaryFile), summary);

    } catch (err) {
      log.warn({ channel: channelData.channelName, err: err.message }, 'Failed to summarize channel');
      channelSummaries.push({
        channelId: channelData.channelId,
        channelName: channelData.channelName,
        channelType: channelData.channelType,
        messageCount: channelData.messageCount,
        summary: 'Summary unavailable.'
      });
    }
  }

  // Step 2: Final synthesis
  log.info('Starting final synthesis...');
  const report = await synthesizeReport(channelSummaries);

  // Write the draft
  const draftPath = path.join(collectionDir, 'draft.md');
  fs.writeFileSync(draftPath, report);
  log.info({ draftPath }, 'Draft written');

  // Step 3: Deliver via Slack DM
  const slackMessage = `*Weekly Summary Draft (${today})*\n\n${report}\n\n_This is an AI-generated draft from Slack activity. Review and edit before distributing._`;
  await sendSlackDM(slackMessage);

  log.info('Draft delivered to Slack DM');
  return { draftPath, channelsSummarized: channelSummaries.length };
}

// --- Main ---
synthesize()
  .then(result => {
    console.log(`Synthesis complete: ${result.channelsSummarized} channels → ${result.draftPath}`);
  })
  .catch(async (err) => {
    log.error({ err }, 'Synthesis failed');
    try {
      await sendSlackDM(`Weekly summary synthesis failed: ${err.message}`);
    } catch {}
    process.exit(1);
  });
```

**Step 2: Test the synthesizer manually**

First ensure the collector has run (Task 4). Then:

Run: `node weekly-summary-synthesizer.js`
Expected: Creates `~/.claudia/data/weekly-summary/2026-02-23/summaries/` with per-channel `.txt` files and `~/.claudia/data/weekly-summary/2026-02-23/draft.md`. Sends the draft to your Slack DM.

**Step 3: Review the draft quality**

Run: `cat ~/.claudia/data/weekly-summary/2026-02-23/draft.md`
Expected: A draft in the Digital Workplace weekly summary format, grouped by team.

**Step 4: Commit**

```bash
git add weekly-summary-synthesizer.js
git commit -m "feat: add weekly summary synthesizer with two-tier AI"
```

---

## Task 6: Deploy Integration — Launchd Plists + Tray

**Files:**
- Modify: `bin/deploy` (line 109-114, add scheduled services)
- Modify: `tray/service-manager.js` (line 20-27, add to SERVICES array)

**Step 1: Add scheduled services to bin/deploy**

In `bin/deploy`, after the existing `SERVICES` array (line 114), add a new `SCHEDULED_SERVICES` array and a second plist generation loop:

```bash
# Scheduled service definitions: label|js_file|weekday|hour|minute
SCHEDULED_SERVICES=(
  "weekly-collector|weekly-summary-collector.js|5|15|0"
  "weekly-synthesizer|weekly-summary-synthesizer.js|5|15|30"
)

for svc in "${SCHEDULED_SERVICES[@]}"; do
  IFS='|' read -r label jsfile weekday hour minute <<< "$svc"
  plist_label="ai.claudia.$label"
  plist_path="$PLIST_DIR/$plist_label.plist"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$plist_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$CLAUDIA_HOME/app/$jsfile</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>$weekday</integer>
    <key>Hour</key><integer>$hour</integer>
    <key>Minute</key><integer>$minute</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$CLAUDIA_HOME/logs/$label.log</string>
  <key>StandardErrorPath</key>
  <string>$CLAUDIA_HOME/logs/$label-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST
done
```

Also add the scheduled services to the launchctl load/status loops (Steps 9 and 10 in deploy).

**Step 2: Add to tray service-manager.js**

In `tray/service-manager.js`, add to the SERVICES array (after line 26):

```javascript
  { label: 'Weekly Collector',   launchdLabel: 'ai.claudia.weekly-collector' },
  { label: 'Weekly Synthesizer', launchdLabel: 'ai.claudia.weekly-synthesizer' },
```

**Step 3: Test deploy**

Run: `bin/deploy --skip-pull`
Expected: New plists generated at `~/Library/LaunchAgents/ai.claudia.weekly-collector.plist` and `ai.claudia.weekly-synthesizer.plist`. Status shows them as loaded.

**Step 4: Verify plist scheduling**

Run: `plutil -lint ~/Library/LaunchAgents/ai.claudia.weekly-collector.plist`
Expected: OK

Run: `launchctl list | grep weekly`
Expected: Two entries for `ai.claudia.weekly-collector` and `ai.claudia.weekly-synthesizer`

**Step 5: Commit**

```bash
git add bin/deploy tray/service-manager.js
git commit -m "feat(deploy): add weekly summary services to launchd and tray"
```

---

## Task 7: End-to-End Test

**Files:** None (manual verification)

**Step 1: Run the full pipeline manually**

```bash
# Collect
node weekly-summary-collector.js --force

# Verify collection
cat ~/.claudia/data/weekly-summary/$(date +%Y-%m-%d)/metadata.json

# Synthesize
node weekly-summary-synthesizer.js

# Verify draft
cat ~/.claudia/data/weekly-summary/$(date +%Y-%m-%d)/draft.md
```

**Step 2: Verify Slack DM delivery**

Check your Slack DMs for the draft message from Claudia.

**Step 3: Verify draft quality**

Review the draft against your actual weekly summary format. Check:
- Correct team grouping (CSE, Desktop Support, Security)
- Passive/impersonal voice
- Business outcome focus
- No hallucinated information

**Step 4: Final commit with any adjustments**

```bash
git add -A
git commit -m "feat: complete weekly summary Slack collection and synthesis pipeline"
```

---

## Testing Checklist

After implementation, verify:

- [ ] `lib/slack-reader.js` rate limiter spaces requests correctly
- [ ] `listConversations()` returns all channel types (public, private, DMs, group DMs)
- [ ] `getConversationHistory()` paginates correctly for large channels
- [ ] `getUserDisplayName()` resolves and caches user names
- [ ] Collector skips channels with no recent activity
- [ ] Collector filters bot messages and noise
- [ ] Collector resolves `<@U1234>` mentions to names
- [ ] Collector writes valid JSON files per channel
- [ ] Collector is idempotent (second run skips if output exists)
- [ ] Collector cleans up collections older than 4 weeks
- [ ] Synthesizer Haiku calls produce per-channel summaries
- [ ] Synthesizer Sonnet call produces formatted DW report
- [ ] Synthesizer retries if collection isn't ready
- [ ] Draft delivered to Slack DM
- [ ] Both services visible in tray app
- [ ] Launchd plists generate correctly via `bin/deploy`

## Rollback Plan

1. Stop scheduled services:
```bash
launchctl bootout gui/$(id -u)/ai.claudia.weekly-collector 2>/dev/null
launchctl bootout gui/$(id -u)/ai.claudia.weekly-synthesizer 2>/dev/null
```

2. Remove plists:
```bash
rm ~/Library/LaunchAgents/ai.claudia.weekly-collector.plist
rm ~/Library/LaunchAgents/ai.claudia.weekly-synthesizer.plist
```

3. Revert code changes:
```bash
git revert HEAD~N  # however many commits
```

Existing services are unaffected — the weekly summary is fully additive.
