#!/usr/bin/env node
/**
 * Knowledge Extractor — reads unextracted raw_messages, sends batches
 * to Sonnet for fact extraction, stores structured facts in the
 * knowledge graph, and marks messages as extracted.
 *
 * Skeleton deliverable for the Fact Extraction Pipeline.
 * Design: docs/plans/2026-03-10-fact-extraction-pipeline-design.md
 */
'use strict';

const kg = require('./lib/knowledge-graph');

// --- Valid attributes and fact types (per design doc taxonomy) ---
const VALID_ATTRIBUTES = new Set([
  'committed_to', 'asked_to', 'decided', 'raised_risk',
  'status_update', 'role', 'team',
]);
const VALID_FACT_TYPES = new Set(['event', 'state']);

// --- Bot detection ---
const BOT_NAMES = new Set([
  'assist', 'slackbot', 'okta service', 'jellyfish',
  'jira cloud', 'github', 'pagerduty', 'datadog',
]);
const BOT_EXT_ID_PREFIXES = ['B0', 'USLACKBOT'];

function isLikelyBot(msg) {
  const name = (msg.author_name || '').toLowerCase().trim();
  if (BOT_NAMES.has(name)) return true;
  for (const prefix of BOT_EXT_ID_PREFIXES) {
    if (msg.author_ext_id && msg.author_ext_id.startsWith(prefix)) return true;
  }
  return false;
}

// --- Extraction prompt ---
const EXTRACTION_SYSTEM_PROMPT = `You are extracting structured facts from workplace messages for a knowledge graph. For each message, identify:
- Commitments (someone promises to do something)
- Action items (someone is asked to do something)
- Decisions (a choice is made)
- Risks (a concern is raised about something that could go wrong)
- Status updates (someone reports what they're working on or their role)

For each fact, return:
- entity: the person's name (who the fact is about)
- attribute: one of committed_to, asked_to, decided, raised_risk, status_update, role, team
- value: what specifically (one sentence)
- fact_type: "event" or "state"
- confidence: 0.0-1.0
- source_message_id: the message id it came from

Note: Jira description or comment changes may contain embedded action items (e.g. "please investigate...", "reach out to..."). Extract those as asked_to facts.

Jira ticket assignments represent work assigned — use asked_to (not role) for ticket assignments.

Skip: greetings, small talk, emoji reactions, bot notifications, messages that don't contain extractable facts.

Return JSON array. Empty array if no facts found.`;

/**
 * Parse AI response text into validated fact objects.
 * @param {string} text - Raw AI response (may include code fences)
 * @param {Object} [opts]
 * @param {number} [opts.minConfidence=0.5] - Filter facts below this confidence
 * @returns {Object[]} Array of validated fact objects
 */
function parseAiResponse(text, { minConfidence = 0.5 } = {}) {
  if (!text) return [];

  // Strip markdown code fences
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (!cleaned) return [];

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.filter(f => {
    if (!f.entity || typeof f.entity !== 'string' || !f.entity.trim()) return false;
    if (!f.attribute || !VALID_ATTRIBUTES.has(f.attribute)) return false;
    if (!f.value || typeof f.value !== 'string') return false;
    if (!f.fact_type || !VALID_FACT_TYPES.has(f.fact_type)) return false;
    if (typeof f.confidence !== 'number' || f.confidence < minConfidence) return false;
    return true;
  });
}

/**
 * Group messages into batches by channel for context-aware extraction.
 * @param {Object[]} messages - Raw message rows
 * @param {Object} [opts]
 * @param {number} [opts.batchSize=30] - Max messages per batch
 * @returns {Object[]} Array of { channel, messages }
 */
function buildBatches(messages, { batchSize = 30 } = {}) {
  // Group by channel
  const byChannel = new Map();
  for (const msg of messages) {
    const ch = msg.channel_name || '_unknown';
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(msg);
  }

  const batches = [];
  for (const [channel, msgs] of byChannel) {
    // Sort by time within channel
    msgs.sort((a, b) => a.occurred_at - b.occurred_at);
    // Split into size-limited batches
    for (let i = 0; i < msgs.length; i += batchSize) {
      batches.push({
        channel,
        messages: msgs.slice(i, i + batchSize),
      });
    }
  }

  return batches;
}

/**
 * Format a batch of messages for the extraction prompt.
 * @param {Object[]} messages - Messages in the batch
 * @returns {string} Formatted user content
 */
function formatBatchForPrompt(messages) {
  return messages.map(m => {
    const thread = m.thread_id ? ' (thread)' : '';
    return `[${m.id}] #${m.channel_name || 'unknown'} — ${m.author_name || 'unknown'}${thread}:\n${m.content}`;
  }).join('\n\n');
}

/**
 * Store parsed facts into the knowledge graph.
 * Resolves entity names to existing entities or creates new ones.
 * @param {Object} db - org-memory database
 * @param {Object[]} facts - Parsed fact objects from AI
 * @returns {{ stored: number, skipped: number }}
 */
function storeFacts(db, facts) {
  let stored = 0;
  let skipped = 0;

  // Cache entity lookups within this batch
  const entityCache = new Map();

  for (const fact of facts) {
    const name = fact.entity.trim();

    let entityId = entityCache.get(name);
    if (!entityId) {
      // Try to find existing entity by canonical name
      const existing = db.prepare(
        "SELECT id FROM entities WHERE entity_type = 'person' AND canonical_name = ?"
      ).get(name);

      if (existing) {
        entityId = existing.id;
      } else {
        // Create new person entity
        const created = kg.createEntity(db, { entityType: 'person', canonicalName: name });
        entityId = created.id;
      }
      entityCache.set(name, entityId);
    }

    try {
      kg.upsertFact(db, {
        entityId,
        attribute: fact.attribute,
        value: fact.value,
        factType: fact.fact_type,
        sourceMessageId: fact.source_message_id || null,
      });
      stored++;
    } catch (err) {
      skipped++;
    }
  }

  return { stored, skipped };
}

/**
 * Run extraction on a batch of messages via the Anthropic API.
 * @param {Object} client - Anthropic client
 * @param {Object[]} messages - Messages to extract from
 * @param {Object} [opts]
 * @param {string} [opts.model='claude-sonnet-4-20250514'] - Model to use
 * @returns {Promise<Object[]>} Parsed facts
 */
async function extractBatch(client, messages, { model = 'claude-sonnet-4-20250514' } = {}) {
  const userContent = formatBatchForPrompt(messages);

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content[0]?.text || '';
  const usage = response.usage || {};

  return {
    facts: parseAiResponse(text),
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
  };
}

/**
 * Main extraction pipeline: fetch unextracted messages, batch, extract, store.
 * @param {Object} db - org-memory database
 * @param {Object} client - Anthropic client
 * @param {Object} [opts]
 * @param {number} [opts.limit] - Max messages to process
 * @param {number} [opts.since] - Only process messages after this epoch timestamp
 * @param {number} [opts.batchSize=30] - Messages per API call
 * @param {boolean} [opts.dryRun=false] - If true, extract but don't store/mark
 * @param {Object} [opts.log] - Logger
 * @returns {Promise<Object>} Stats: { messagesProcessed, factsStored, factsSkipped, totalInputTokens, totalOutputTokens, batchCount }
 */
async function runExtraction(db, client, { limit, since, batchSize = 30, dryRun = false, log = null } = {}) {
  const logger = log || { info() {}, warn() {}, debug() {} };

  // Fetch unextracted messages
  const allMessages = kg.getUnextractedMessages(db, { limit, since });
  logger.info({ count: allMessages.length }, 'Fetched unextracted messages');

  if (allMessages.length === 0) {
    return { messagesProcessed: 0, factsStored: 0, factsSkipped: 0, totalInputTokens: 0, totalOutputTokens: 0, batchCount: 0 };
  }

  // Filter out bots
  const humanMessages = allMessages.filter(m => !isLikelyBot(m));
  const botCount = allMessages.length - humanMessages.length;
  logger.info({ humanCount: humanMessages.length, botCount }, 'Filtered bot messages');

  // Mark bot messages as extracted (nothing to extract)
  if (!dryRun && botCount > 0) {
    const botIds = allMessages.filter(m => isLikelyBot(m)).map(m => m.id);
    kg.markExtracted(db, botIds);
  }

  // Build batches
  const batches = buildBatches(humanMessages, { batchSize });
  logger.info({ batchCount: batches.length }, 'Built extraction batches');

  let totalStored = 0;
  let totalSkipped = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logger.info({ batch: i + 1, channel: batch.channel, messageCount: batch.messages.length }, 'Processing batch');

    const { facts, inputTokens, outputTokens } = await extractBatch(client, batch.messages);
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

    logger.info({ factsFound: facts.length, inputTokens, outputTokens }, 'Batch extraction complete');

    if (!dryRun) {
      const { stored, skipped } = storeFacts(db, facts);
      totalStored += stored;
      totalSkipped += skipped;

      // Mark batch messages as extracted
      const msgIds = batch.messages.map(m => m.id);
      kg.markExtracted(db, msgIds);
    } else {
      // In dry run, just log the facts
      for (const f of facts) {
        logger.info({ entity: f.entity, attribute: f.attribute, value: f.value, confidence: f.confidence }, 'DRY RUN fact');
      }
      totalStored += facts.length;
    }
  }

  return {
    messagesProcessed: humanMessages.length,
    factsStored: totalStored,
    factsSkipped: totalSkipped,
    totalInputTokens,
    totalOutputTokens,
    batchCount: batches.length,
  };
}

// --- Main entry point ---
async function main() {
  const config = require('./lib/config');
  const log = require('./lib/logger')('knowledge-extractor');
  const heartbeat = require('./lib/heartbeat');
  const { initDatabase } = require('./lib/org-memory-db');
  const { getClient } = require('./lib/ai');

  const SERVICE_NAME = 'knowledge-extractor';
  const dryRun = process.env.DRY_RUN === '1';
  const limit = process.env.EXTRACT_LIMIT ? parseInt(process.env.EXTRACT_LIMIT, 10) : undefined;
  const sinceDays = process.env.EXTRACT_SINCE_DAYS ? parseInt(process.env.EXTRACT_SINCE_DAYS, 10) : undefined;
  const since = sinceDays ? Math.floor(Date.now() / 1000) - (sinceDays * 24 * 3600) : undefined;

  if (dryRun) log.info('DRY_RUN mode — no DB writes');
  if (limit) log.info({ limit }, 'Limiting extraction batch');
  if (sinceDays) log.info({ sinceDays, since: new Date(since * 1000).toISOString() }, 'Filtering to recent messages');

  const client = getClient();
  if (!client) {
    log.fatal('No AI credentials available');
    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'startup-failed',
      errors: { lastError: 'No AI credentials', lastErrorAt: Date.now(), countSinceStart: 1 },
    });
    process.exit(1);
  }

  const db = initDatabase();

  // Pre-extraction backup
  const backupPath = `${process.env.HOME}/.reticle/data/org-memory-backup-${Date.now()}.db`;
  try {
    db.exec(`VACUUM INTO '${backupPath}'`);
    log.info({ backupPath }, 'Pre-extraction backup complete');
  } catch (err) {
    log.warn({ err }, 'Backup failed — proceeding anyway');
  }

  try {
    const stats = await runExtraction(db, client, { limit, since, dryRun, log });

    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'ok',
      metrics: stats,
    });

    log.info(stats, 'Extraction complete');
    console.log(`\nExtraction complete:
  Messages processed: ${stats.messagesProcessed}
  Facts stored: ${stats.factsStored}
  Facts skipped: ${stats.factsSkipped}
  Batches: ${stats.batchCount}
  Tokens: ${stats.totalInputTokens} in / ${stats.totalOutputTokens} out`);
  } catch (err) {
    log.error({ err }, 'Extraction failed');
    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'error',
      errors: { lastError: err.message, lastErrorAt: Date.now(), countSinceStart: 1 },
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseAiResponse,
  buildBatches,
  formatBatchForPrompt,
  storeFacts,
  extractBatch,
  runExtraction,
  isLikelyBot,
  EXTRACTION_SYSTEM_PROMPT,
};
