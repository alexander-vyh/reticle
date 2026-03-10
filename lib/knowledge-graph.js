'use strict';

const crypto = require('crypto');

// --- Entity operations ---

function createEntity(db, { entityType, canonicalName }) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO entities (id, entity_type, canonical_name, is_active, created_at)
     VALUES (?, ?, ?, 1, ?)`
  ).run(id, entityType, canonicalName, now);
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
}

function getEntity(db, id) {
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id) || null;
}

function getActiveEntities(db, { types, limit } = {}) {
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(', ');
    const sql = `SELECT * FROM entities WHERE is_active = 1 AND entity_type IN (${placeholders})
                 ORDER BY created_at DESC${limit ? ' LIMIT ?' : ''}`;
    const params = limit ? [...types, limit] : types;
    return db.prepare(sql).all(...params);
  }
  const sql = `SELECT * FROM entities WHERE is_active = 1
               ORDER BY created_at DESC${limit ? ' LIMIT ?' : ''}`;
  return limit ? db.prepare(sql).all(limit) : db.prepare(sql).all();
}

function deactivateEntity(db, id) {
  db.prepare('UPDATE entities SET is_active = 0 WHERE id = ?').run(id);
}

// --- Fact operations ---

function addFact(db, { entityId, attribute, value, factType = 'state', validFrom, confidence, sourceMessageId, extractedAt, resolution }) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO facts (id, entity_id, attribute, value, fact_type, valid_from, confidence, source_message_id, extracted_at, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, entityId, attribute, value, factType,
    validFrom || now,
    confidence != null ? confidence : 1.0,
    sourceMessageId || null,
    extractedAt || now,
    resolution || null
  );
  return db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
}

/**
 * Smart upsert with state/event awareness.
 *
 * State facts: re-confirm if same value, close-and-open if different value.
 * Event facts: deduplicate if an open event with same entity+attribute+value exists.
 */
function upsertFact(db, { entityId, attribute, value, factType, sourceMessageId, now, resolution }) {
  const ts = now || Math.floor(Date.now() / 1000);

  if (factType === 'state') {
    return _upsertStateFact(db, { entityId, attribute, value, sourceMessageId, ts });
  } else if (factType === 'event') {
    return _upsertEventFact(db, { entityId, attribute, value, sourceMessageId, ts, resolution });
  }
  throw new Error(`Unknown factType: "${factType}"`);
}

function _upsertStateFact(db, { entityId, attribute, value, sourceMessageId, ts }) {
  const existing = db.prepare(
    `SELECT * FROM facts
     WHERE entity_id = ? AND attribute = ? AND fact_type = 'state' AND valid_to IS NULL`
  ).get(entityId, attribute);

  if (existing) {
    if (existing.value === value) {
      // Re-confirmation: same value seen again — just bump timestamps
      db.prepare(
        `UPDATE facts SET last_confirmed_at = ?, last_confirmed_source = ? WHERE id = ?`
      ).run(ts, sourceMessageId, existing.id);
      return db.prepare('SELECT * FROM facts WHERE id = ?').get(existing.id);
    }
    // Value changed: close the old fact
    db.prepare('UPDATE facts SET valid_to = ? WHERE id = ?').run(ts, existing.id);
  }

  // Insert new state fact
  return addFact(db, {
    entityId, attribute, value, factType: 'state',
    validFrom: ts, sourceMessageId, extractedAt: ts
  });
}

function _upsertEventFact(db, { entityId, attribute, value, sourceMessageId, ts, resolution }) {
  // Check for existing open event with same entity+attribute+value
  const existing = db.prepare(
    `SELECT * FROM facts
     WHERE entity_id = ? AND attribute = ? AND value = ?
       AND fact_type = 'event' AND resolution = 'open'`
  ).get(entityId, attribute, value);

  if (existing) {
    // Deduplicate: open event already exists, skip
    return existing;
  }

  return addFact(db, {
    entityId, attribute, value, factType: 'event',
    validFrom: ts, sourceMessageId, extractedAt: ts,
    resolution: resolution || 'open'
  });
}

function resolveEvent(db, { entityId, attribute, resolution, resolvedAt }) {
  const ts = resolvedAt || Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE facts SET resolution = ?, resolved_at = ?
     WHERE entity_id = ? AND attribute = ? AND fact_type = 'event' AND resolution = 'open'`
  ).run(resolution, ts, entityId, attribute);
}

function getCurrentState(db, entityId) {
  const rows = db.prepare(
    `SELECT attribute, value FROM facts
     WHERE entity_id = ? AND fact_type = 'state' AND valid_to IS NULL`
  ).all(entityId);
  const state = {};
  for (const row of rows) {
    state[row.attribute] = row.value;
  }
  return state;
}

function getEntityFacts(db, entityId, { attribute, since } = {}) {
  let sql = 'SELECT * FROM facts WHERE entity_id = ?';
  const params = [entityId];
  if (attribute) {
    sql += ' AND attribute = ?';
    params.push(attribute);
  }
  if (since) {
    sql += ' AND valid_from >= ?';
    params.push(since);
  }
  sql += ' ORDER BY valid_from DESC';
  return db.prepare(sql).all(...params);
}

// --- Identity operations ---

function addIdentity(db, { entityId, source, externalId, displayName, jiraId }) {
  db.prepare(
    `INSERT OR IGNORE INTO identity_map (entity_id, source, external_id, display_name, jira_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(entityId, source, externalId, displayName || null, jiraId || null);
}

function resolveIdentity(db, source, externalId) {
  const row = db.prepare(
    'SELECT entity_id FROM identity_map WHERE source = ? AND external_id = ?'
  ).get(source, externalId);
  return row ? row.entity_id : null;
}

// --- Raw message operations ---

function insertRawMessage(db, { source, sourceId, channelId, channelName, authorExtId, authorId, authorName, content, threadId, occurredAt, metadata }) {
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  // Upsert on source+source_id: try insert, on conflict return existing
  const existing = db.prepare(
    'SELECT * FROM raw_messages WHERE source = ? AND source_id = ?'
  ).get(source, sourceId);

  if (existing) {
    return existing;
  }

  db.prepare(
    `INSERT INTO raw_messages (id, source, source_id, channel_id, channel_name,
      author_ext_id, author_id, author_name, content, thread_id, occurred_at, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, source, sourceId, channelId || null, channelName || null,
    authorExtId || null, authorId || null, authorName || null, content, threadId || null,
    occurredAt || now, metadata ? JSON.stringify(metadata) : null, now
  );
  return db.prepare('SELECT * FROM raw_messages WHERE id = ?').get(id);
}

function getUnextractedMessages(db, { limit, since } = {}) {
  let sql = 'SELECT * FROM raw_messages WHERE extracted = 0';
  const params = [];
  if (since) {
    sql += ' AND occurred_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY occurred_at ASC';
  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  return db.prepare(sql).all(...params);
}

function markExtracted(db, messageIds) {
  if (!messageIds || messageIds.length === 0) return;
  const placeholders = messageIds.map(() => '?').join(', ');
  db.prepare(`UPDATE raw_messages SET extracted = 1 WHERE id IN (${placeholders})`)
    .run(...messageIds);
}

module.exports = {
  // Entities
  createEntity,
  getEntity,
  getActiveEntities,
  deactivateEntity,
  // Facts
  addFact,
  upsertFact,
  resolveEvent,
  getCurrentState,
  getEntityFacts,
  // Identity
  addIdentity,
  resolveIdentity,
  // Raw messages
  insertRawMessage,
  getUnextractedMessages,
  markExtracted,
};
