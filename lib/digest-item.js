// lib/digest-item.js
'use strict';

const crypto = require('crypto');

const VALID_PRIORITIES = ['low', 'normal', 'high', 'critical'];
const VALID_SIGNIFICANCE = ['minor', 'moderate', 'notable'];
const REQUIRED_ITEM_FIELDS = ['collector', 'observation', 'reason', 'authority', 'consequence', 'sourceType', 'category', 'priority', 'observedAt'];
const REQUIRED_INSIGHT_FIELDS = ['type', 'observation', 'evidence', 'significance', 'reason', 'authority', 'consequence'];

function createDigestItem(fields) {
  for (const field of REQUIRED_ITEM_FIELDS) {
    if (!fields[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  if (!VALID_PRIORITIES.includes(fields.priority)) {
    throw new Error(`Invalid priority: ${fields.priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }

  return {
    id: `digest-${fields.collector}-${crypto.randomBytes(6).toString('hex')}`,
    collector: fields.collector,
    observation: fields.observation,
    reason: fields.reason,
    authority: fields.authority,
    consequence: fields.consequence,
    sourceUrl: fields.sourceUrl || null,
    sourceType: fields.sourceType,
    category: fields.category,
    priority: fields.priority,
    ageSeconds: fields.ageSeconds || null,
    counterparty: fields.counterparty || null,
    entityId: fields.entityId || null,
    observedAt: fields.observedAt,
    collectedAt: Math.floor(Date.now() / 1000)
  };
}

function createPatternInsight(fields) {
  for (const field of REQUIRED_INSIGHT_FIELDS) {
    if (fields[field] === undefined || fields[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  if (!VALID_SIGNIFICANCE.includes(fields.significance)) {
    throw new Error(`Invalid significance: ${fields.significance}`);
  }

  return {
    id: `pattern-${crypto.randomBytes(6).toString('hex')}`,
    type: fields.type,
    observation: fields.observation,
    evidence: fields.evidence,
    significance: fields.significance,
    reason: fields.reason,
    authority: fields.authority,
    consequence: fields.consequence
  };
}

function deduplicateItems(items) {
  const priorityRank = { low: 0, normal: 1, high: 2, critical: 3 };
  const seen = new Map();

  for (const item of items) {
    if (!item.entityId) {
      seen.set(item.id, item);
      continue;
    }

    const key = `${item.sourceType}:${item.entityId}`;
    const existing = seen.get(key);

    if (!existing || priorityRank[item.priority] > priorityRank[existing.priority]) {
      seen.set(key, item);
    }
  }

  return Array.from(seen.values());
}

module.exports = { createDigestItem, createPatternInsight, deduplicateItems, VALID_PRIORITIES };
