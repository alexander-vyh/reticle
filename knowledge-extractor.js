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
const _log = require('./lib/logger')('knowledge-extractor');

// --- Valid attributes and fact types (per design doc taxonomy) ---
const VALID_ATTRIBUTES = new Set([
  'committed_to', 'asked_to', 'decided', 'raised_risk',
  'status_update', 'completion_signal', 'role', 'team',
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
- Status updates (someone reports progress, not completion)
- Completion signals (someone confirms a prior commitment or task is done)

For each fact, return:
- entity: the person's name (who the fact is about)
- attribute: one of committed_to, asked_to, decided, raised_risk, status_update, completion_signal, role, team
- value: what specifically (one sentence)
- fact_type: "event" or "state"
- confidence: 0.0-1.0
- source_message_id: the message id it came from

Use completion_signal (not status_update) when someone confirms a task is finished, shipped, merged, done, or closed. Use status_update for progress reports that do NOT indicate completion.

If OPEN COMMITMENTS are listed below, check whether any message resolves one. When a message confirms an open commitment is done, return a completion_signal fact with an additional field:
- resolves: "attribute:value" — the exact attribute and value text of the open commitment being resolved

Only set resolves when you are confident (>=0.9) the message genuinely indicates completion of that specific commitment. Do not guess.

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
 * Fetch open commitments for entities that appear in this batch of messages.
 * Returns formatted text to inject into the system prompt.
 * @param {Object} db - org-memory database
 * @param {Object[]} messages - Messages in the batch (to extract author names)
 * @returns {string} Formatted open commitments block, or empty string if none
 */
function getOpenCommitmentsContext(db, messages) {
  // Collect unique author names from this batch
  const authorNames = new Set();
  for (const m of messages) {
    if (m.author_name) authorNames.add(m.author_name);
  }
  if (authorNames.size === 0) return '';

  const placeholders = [...authorNames].map(() => '?').join(', ');

  // Query both entity-linked and deferred (entity_id IS NULL) open commitments
  const entityRows = db.prepare(`
    SELECT e.canonical_name, f.attribute, f.value, f.valid_from
    FROM facts f
    JOIN entities e ON e.id = f.entity_id
    WHERE e.canonical_name IN (${placeholders})
      AND f.fact_type = 'event'
      AND f.resolution = 'open'
      AND f.attribute IN ('committed_to', 'asked_to')
    ORDER BY e.canonical_name, f.valid_from DESC
  `).all(...authorNames);

  const deferredRows = db.prepare(`
    SELECT f.mentioned_name AS canonical_name, f.attribute, f.value, f.valid_from
    FROM facts f
    WHERE f.entity_id IS NULL
      AND f.mentioned_name IN (${placeholders})
      AND f.fact_type = 'event'
      AND f.resolution = 'open'
      AND f.attribute IN ('committed_to', 'asked_to')
    ORDER BY f.mentioned_name, f.valid_from DESC
  `).all(...authorNames);

  const rows = [...entityRows, ...deferredRows];
  if (rows.length === 0) return '';

  // Cap at 10 per person to avoid prompt bloat
  const byPerson = new Map();
  for (const r of rows) {
    if (!byPerson.has(r.canonical_name)) byPerson.set(r.canonical_name, []);
    const list = byPerson.get(r.canonical_name);
    if (list.length < 10) list.push(r);
  }

  const lines = [];
  for (const [name, commitments] of byPerson) {
    for (const c of commitments) {
      const d = new Date(c.valid_from * 1000).toISOString().split('T')[0];
      lines.push(`- ${name}: "${c.value}" (${c.attribute}, from ${d})`);
    }
  }

  return `\n\nOPEN COMMITMENTS (from prior messages — check if any are resolved by the messages below):\n${lines.join('\n')}`;
}

/**
 * Store parsed facts into the knowledge graph using deferred attribution.
 * Facts are stored with entity_id = NULL and mentioned_name set.
 * No person entities are created from extracted text.
 * Resolution of open commitments still works by looking up existing entities.
 * @param {Object} db - org-memory database
 * @param {Object[]} facts - Parsed fact objects from AI
 * @returns {{ stored: number, skipped: number }}
 */
function storeFacts(db, facts) {
  let stored = 0;
  let skipped = 0;

  for (const fact of facts) {
    const name = fact.entity.trim().normalize('NFC');

    try {
      if (fact.resolves) {
        // Resolution fact: find the open commitment and resolve it
        const [targetAttr, ...valueParts] = fact.resolves.split(':');
        const targetValue = valueParts.join(':');

        // Try to find open commitment by entity canonical_name (read-only lookup)
        let target;
        const existingEntity = db.prepare(
          "SELECT id FROM entities WHERE entity_type = 'person' AND canonical_name = ?"
        ).get(name);

        if (existingEntity) {
          target = db.prepare(
            `SELECT id FROM facts
             WHERE entity_id = ? AND attribute = ? AND value = ?
               AND fact_type = 'event' AND resolution = 'open'`
          ).get(existingEntity.id, targetAttr, targetValue);
        }

        // Also check deferred facts (entity_id IS NULL, matched by mentioned_name)
        if (!target) {
          target = db.prepare(
            `SELECT id FROM facts
             WHERE entity_id IS NULL AND mentioned_name = ? AND attribute = ? AND value = ?
               AND fact_type = 'event' AND resolution = 'open'`
          ).get(name, targetAttr, targetValue);
        }

        if (target) {
          kg.resolveEvent(db, {
            factId: target.id,
            entityId: existingEntity ? existingEntity.id : null,
            attribute: targetAttr,
            resolution: 'completed',
            confidence: fact.confidence,
            sourceMessageId: fact.source_message_id || null,
            rationale: fact.value,
          });
        }

        // Store the completion_signal fact with deferred attribution
        kg.upsertFact(db, {
          entityId: null,
          mentionedName: name,
          attribute: fact.attribute,
          value: fact.value,
          factType: fact.fact_type,
          sourceMessageId: fact.source_message_id || null,
        });
      } else {
        // Normal fact: store with deferred attribution
        kg.upsertFact(db, {
          entityId: null,
          mentionedName: name,
          attribute: fact.attribute,
          value: fact.value,
          factType: fact.fact_type,
          sourceMessageId: fact.source_message_id || null,
        });
      }
      stored++;
    } catch (err) {
      _log.warn({ err: err.message, entity: fact.entity, attribute: fact.attribute, value: fact.value?.substring(0, 60) }, 'Fact skipped — storage error');
      skipped++;
    }
  }

  return { stored, skipped };
}

/**
 * Resolution sweep: attribute deferred facts (entity_id IS NULL) to known entities.
 *
 * Path A (author attribution): For facts with a source_message_id, resolve the
 * message author's external ID to an entity via identity_map. Only attribute if
 * the fact's mentioned_name matches one of the author entity's aliases.
 *
 * Path B (mention attribution): Exact match on entity_aliases.alias (case-insensitive).
 * Only matches anchored entities (the alias table enforces this).
 *
 * @param {Object} db - org-memory database
 * @param {Object} [opts]
 * @param {Object} [opts.log] - Logger
 * @returns {{ sweepAvailableNullFacts, sweepPathAMatched, sweepPathBMatched, sweepKnownNamesUnattributed }}
 */
function runSweep(db, { log } = {}) {
  const logger = log || { info() {}, warn() {}, debug() {} };

  const nullFacts = db.prepare(`
    SELECT f.id, f.mentioned_name, f.source_message_id
    FROM facts f
    WHERE f.entity_id IS NULL
  `).all();

  const metrics = {
    sweepAvailableNullFacts: nullFacts.length,
    sweepPathAMatched: 0,
    sweepPathBMatched: 0,
    sweepKnownNamesUnattributed: 0,
  };

  if (nullFacts.length === 0) {
    logger.debug('Sweep: no unattributed facts');
    return metrics;
  }

  logger.info({ count: nullFacts.length }, 'Sweep: processing unattributed facts');

  for (const fact of nullFacts) {
    let attributed = false;

    // Path A: Author attribution (self-referencing facts)
    if (fact.source_message_id && fact.mentioned_name) {
      const msg = db.prepare(
        'SELECT source, author_ext_id FROM raw_messages WHERE id = ?'
      ).get(fact.source_message_id);

      if (msg && msg.author_ext_id) {
        const authorEntityId = kg.resolveIdentity(db, msg.source, msg.author_ext_id);
        if (authorEntityId) {
          const aliasMatch = db.prepare(
            'SELECT 1 FROM entity_aliases WHERE entity_id = ? AND LOWER(alias) = LOWER(?)'
          ).get(authorEntityId, fact.mentioned_name);

          if (aliasMatch) {
            db.prepare('UPDATE facts SET entity_id = ? WHERE id = ?')
              .run(authorEntityId, fact.id);
            metrics.sweepPathAMatched++;
            attributed = true;
            logger.debug({ factId: fact.id, mentionedName: fact.mentioned_name, path: 'A' }, 'Sweep: attributed');
          }
        }
      }
    }

    // Path B: Mention attribution (alias table lookup)
    if (!attributed && fact.mentioned_name) {
      const matches = db.prepare(
        'SELECT entity_id FROM entity_aliases WHERE LOWER(alias) = LOWER(?)'
      ).all(fact.mentioned_name);

      if (matches.length === 1) {
        db.prepare('UPDATE facts SET entity_id = ? WHERE id = ?')
          .run(matches[0].entity_id, fact.id);
        metrics.sweepPathBMatched++;
        logger.debug({ factId: fact.id, mentionedName: fact.mentioned_name, path: 'B' }, 'Sweep: attributed');
      } else if (matches.length > 1) {
        logger.warn({ mentionedName: fact.mentioned_name, matchCount: matches.length },
          'Sweep: ambiguous alias match — skipping');
      }
    }
  }

  // Observable failure signal: known aliases remain unattributed
  const knownUnattributed = db.prepare(`
    SELECT COUNT(*) as c FROM facts f
    WHERE f.entity_id IS NULL
      AND EXISTS (
        SELECT 1 FROM entity_aliases ea
        WHERE LOWER(ea.alias) = LOWER(f.mentioned_name)
      )
  `).get();
  metrics.sweepKnownNamesUnattributed = knownUnattributed.c;

  logger.info(metrics, 'Sweep complete');
  return metrics;
}

/**
 * Run extraction on a batch of messages via the Anthropic API.
 * @param {Object} client - Anthropic client
 * @param {Object[]} messages - Messages to extract from
 * @param {Object} [opts]
 * @param {string} [opts.model='claude-sonnet-4-20250514'] - Model to use
 * @returns {Promise<Object[]>} Parsed facts
 */
async function extractBatch(client, messages, { model = 'claude-sonnet-4-20250514', openCommitmentsContext = '' } = {}) {
  const userContent = formatBatchForPrompt(messages);
  const systemPrompt = EXTRACTION_SYSTEM_PROMPT + openCommitmentsContext;

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system: systemPrompt,
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

    const openCommitmentsContext = getOpenCommitmentsContext(db, batch.messages);
    const { facts, inputTokens, outputTokens } = await extractBatch(client, batch.messages, { openCommitmentsContext });
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

  // Run resolution sweep after extraction
  let sweepMetrics = { sweepAvailableNullFacts: 0, sweepPathAMatched: 0, sweepPathBMatched: 0, sweepKnownNamesUnattributed: 0 };
  if (!dryRun) {
    sweepMetrics = runSweep(db, { log: logger });

    // Vacuous success guard: warn if facts were stored but none are deferred
    if (totalStored > 0 && sweepMetrics.sweepAvailableNullFacts === 0) {
      logger.warn('Sweep vacuous success: facts were stored but none had entity_id IS NULL — possible regression to old entity-creation behavior');
    }
  }

  return {
    messagesProcessed: humanMessages.length,
    factsStored: totalStored,
    factsSkipped: totalSkipped,
    totalInputTokens,
    totalOutputTokens,
    batchCount: batches.length,
    ...sweepMetrics,
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
      status: stats.sweepKnownNamesUnattributed > 0 ? 'sweep-alert' : 'ok',
      metrics: stats,
    });

    log.info(stats, 'Extraction complete');
    console.log(`\nExtraction complete:
  Messages processed: ${stats.messagesProcessed}
  Facts stored: ${stats.factsStored}
  Facts skipped: ${stats.factsSkipped}
  Batches: ${stats.batchCount}
  Tokens: ${stats.totalInputTokens} in / ${stats.totalOutputTokens} out
  Sweep: ${stats.sweepAvailableNullFacts} null facts, ${stats.sweepPathAMatched} Path A, ${stats.sweepPathBMatched} Path B, ${stats.sweepKnownNamesUnattributed} known unattributed`);

    // Observable failure signal: exit non-zero if known aliases remain unattributed
    if (stats.sweepKnownNamesUnattributed > 0) {
      log.error({ count: stats.sweepKnownNamesUnattributed },
        'Known aliases remain unattributed after sweep');
      process.exit(2);
    }
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
  getOpenCommitmentsContext,
  storeFacts,
  runSweep,
  extractBatch,
  runExtraction,
  isLikelyBot,
  EXTRACTION_SYSTEM_PROMPT,
};
