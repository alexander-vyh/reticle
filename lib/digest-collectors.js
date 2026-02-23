'use strict';

const claudiaDb = require('../claudia-db');
const { createDigestItem } = require('./digest-item');

function formatAge(seconds) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

function unrepliedPriority(ageSeconds) {
  if (ageSeconds > 72 * 3600) return 'critical';
  if (ageSeconds > 48 * 3600) return 'high';
  if (ageSeconds > 24 * 3600) return 'normal';
  return 'low';
}

function awaitingPriority(ageSeconds) {
  if (ageSeconds > 7 * 86400) return 'high';
  if (ageSeconds > 3 * 86400) return 'normal';
  return 'low';
}

function collectFollowups(db, accountId) {
  const now = Math.floor(Date.now() / 1000);
  const items = [];

  // Unreplied conversations (waiting for my response)
  const pending = claudiaDb.getPendingResponses(db, accountId, {});
  for (const conv of pending) {
    const age = now - conv.last_activity;
    const priority = unrepliedPriority(age);
    const name = conv.from_name || conv.from_user;
    const typeLabel = conv.type === 'email' ? 'emailed' : conv.type === 'slack-dm' ? 'sent you a DM' : 'mentioned you';

    items.push(createDigestItem({
      collector: 'followup',
      observation: `${name} ${typeLabel}${conv.subject ? ` about "${conv.subject}"` : ''} ${formatAge(age)} ago`,
      reason: `Unreplied for ${formatAge(age)}`,
      authority: 'Auto-capture: hygiene obligation (unreplied message)',
      consequence: priority === 'low'
        ? 'Under 24h. Will not appear unless it ages further.'
        : 'Will appear in tomorrow\'s digest if still unreplied. No enforcement configured.',
      sourceType: conv.type,
      category: 'unreplied',
      priority,
      ageSeconds: age,
      counterparty: name,
      entityId: conv.id,
      observedAt: conv.last_activity
    }));
  }

  // Awaiting replies (waiting for their response)
  const awaiting = claudiaDb.getAwaitingReplies(db, accountId, {});
  for (const conv of awaiting) {
    const age = now - conv.last_activity;
    const priority = awaitingPriority(age);
    const name = conv.from_name || conv.from_user;

    items.push(createDigestItem({
      collector: 'followup',
      observation: `You ${conv.type === 'email' ? 'emailed' : 'messaged'} ${name}${conv.subject ? ` about "${conv.subject}"` : ''} ${formatAge(age)} ago — no reply yet`,
      reason: `Awaiting reply for ${formatAge(age)}`,
      authority: 'Auto-capture: you initiated this thread',
      consequence: 'Informational. No action required unless you want to follow up.',
      sourceType: conv.type,
      category: 'awaiting',
      priority,
      ageSeconds: age,
      counterparty: name,
      entityId: conv.id,
      observedAt: conv.last_activity
    }));
  }

  // Stale conversations (active but no activity for 7+ days)
  const allActive = db.prepare(`
    SELECT * FROM conversations
    WHERE account_id = ? AND state = 'active' AND last_activity < ?
    ORDER BY last_activity ASC
  `).all(accountId, now - (7 * 86400));

  for (const conv of allActive) {
    // Skip if already captured as unreplied or awaiting
    if (items.some(i => i.entityId === conv.id)) continue;

    const age = now - conv.last_activity;
    const name = conv.from_name || conv.from_user;

    items.push(createDigestItem({
      collector: 'followup',
      observation: `Conversation with ${name}${conv.subject ? ` about "${conv.subject}"` : ''} has been inactive for ${formatAge(age)}`,
      reason: 'No activity for 7+ days on an open conversation',
      authority: 'Auto-capture: stale conversation detection',
      consequence: 'Consider resolving or following up.',
      sourceType: conv.type,
      category: 'stale',
      priority: 'normal',
      ageSeconds: age,
      counterparty: name,
      entityId: conv.id,
      observedAt: conv.last_activity
    }));
  }

  // Resolved today (positive signal)
  const resolved = claudiaDb.getResolvedToday(db, accountId);
  for (const conv of resolved) {
    // Skip if already captured in another category (getResolvedToday may
    // return active awaiting-reply conversations whose updated_at is today)
    if (items.some(i => i.entityId === conv.id)) continue;

    const name = conv.from_name || conv.from_user;

    items.push(createDigestItem({
      collector: 'followup',
      observation: `Resolved: conversation with ${name}${conv.subject ? ` about "${conv.subject}"` : ''}`,
      reason: 'Resolved or responded to today',
      authority: 'Auto-capture: resolution tracking',
      consequence: 'No action needed. Positive signal for weekly patterns.',
      sourceType: conv.type,
      category: 'resolved-today',
      priority: 'low',
      ageSeconds: 0,
      counterparty: name,
      entityId: conv.id,
      observedAt: conv.resolved_at || Math.floor(Date.now() / 1000)
    }));
  }

  return items;
}

module.exports = { collectFollowups };
