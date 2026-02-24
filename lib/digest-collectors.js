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

function collectEmail(db, accountId, { vipEmails = [] } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(startOfDay.getTime() / 1000);
  const items = [];

  // Email volume today
  const received = db.prepare(
    'SELECT COUNT(*) as c FROM emails WHERE account_id = ? AND date >= ? AND direction = ?'
  ).get(accountId, dayStart, 'inbound');
  const sent = db.prepare(
    'SELECT COUNT(*) as c FROM emails WHERE account_id = ? AND date >= ? AND direction = ?'
  ).get(accountId, dayStart, 'outbound');

  items.push(createDigestItem({
    collector: 'email',
    observation: `Email today: ${received.c} received, ${sent.c} sent`,
    reason: 'Daily email volume summary',
    authority: 'Auto-capture: email activity tracking',
    consequence: 'Informational context for patterns.',
    sourceType: 'email',
    category: 'email-volume',
    priority: 'low',
    observedAt: now
  }));

  // VIP unreplied — check for VIP emails that are in unreplied conversations
  if (vipEmails.length > 0) {
    const pending = claudiaDb.getPendingResponses(db, accountId, { type: 'email' });
    for (const conv of pending) {
      const fromAddr = (conv.from_user || '').toLowerCase();
      if (vipEmails.includes(fromAddr)) {
        const age = now - conv.last_activity;
        items.push(createDigestItem({
          collector: 'email',
          observation: `VIP unreplied: ${conv.from_name || conv.from_user}${conv.subject ? ` — "${conv.subject}"` : ''} (${formatAge(age)})`,
          reason: `Unreplied email from VIP sender for ${formatAge(age)}`,
          authority: 'Auto-capture: VIP sender list',
          consequence: 'VIP messages are high priority. Consider responding promptly.',
          sourceType: 'email',
          category: 'vip-unreplied',
          priority: 'high',
          ageSeconds: age,
          counterparty: conv.from_name || conv.from_user,
          entityId: conv.id,
          observedAt: conv.last_activity
        }));
      }
    }
  }

  // Commitments logged today
  const commitments = db.prepare(`
    SELECT * FROM action_log
    WHERE account_id = ? AND actor = 'user' AND action = 'commitment'
      AND timestamp >= ?
    ORDER BY timestamp DESC
  `).all(accountId, dayStart);

  for (const entry of commitments) {
    const ctx = entry.context ? JSON.parse(entry.context) : {};
    items.push(createDigestItem({
      collector: 'email',
      observation: `You committed: "${ctx.text || 'commitment recorded'}"`,
      reason: 'Explicit commitment logged today',
      authority: 'Auto-capture: explicit commitment by user',
      consequence: 'Will be tracked for follow-through in future digests.',
      sourceType: 'email',
      category: 'commitment',
      priority: 'normal',
      entityId: entry.entity_id,
      observedAt: entry.timestamp
    }));
  }

  return items;
}

function collectO3(db, accountId) {
  const now = Math.floor(Date.now() / 1000);
  const items = [];

  // Week boundaries
  const weekStart = now - (7 * 86400);
  const nextWeekEnd = now + (7 * 86400);

  // Incomplete O3s this week (happened but not logged in Lattice)
  const thisWeekSessions = claudiaDb.getWeeklyO3Summary(db, weekStart, now)
    .filter(s => s.account_id === accountId);
  for (const session of thisWeekSessions) {
    if (!session.lattice_logged) {
      const daysAgo = Math.round((now - session.scheduled_start) / 86400);
      items.push(createDigestItem({
        collector: 'o3',
        observation: `You had a 1:1 with ${session.report_name} ${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago but haven't logged it in Lattice`,
        reason: `O3 session completed ${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago without Lattice entry`,
        authority: 'Auto-capture: O3 accountability tracking',
        consequence: 'Will appear in weekly digest pattern section. Consider logging before Friday.',
        sourceType: 'o3',
        category: 'o3-incomplete',
        priority: 'high',
        counterparty: session.report_name,
        entityId: `${session.id}:incomplete`,
        observedAt: session.scheduled_start
      }));
    }

    // Prep gap: meeting happened but no prep was sent
    if (!session.prep_sent_before && !session.prep_sent_afternoon) {
      items.push(createDigestItem({
        collector: 'o3',
        observation: `1:1 with ${session.report_name} occurred without prep reminder`,
        reason: 'No prep notification was sent before this O3',
        authority: 'Auto-capture: O3 prep tracking',
        consequence: 'Retrospective note. Check if meeting-alert-monitor is running.',
        sourceType: 'o3',
        category: 'o3-prep-gap',
        priority: 'normal',
        counterparty: session.report_name,
        entityId: `${session.id}:prep-gap`,
        observedAt: session.scheduled_start
      }));
    }
  }

  // Upcoming O3s (next 7 days)
  const upcomingSessions = claudiaDb.getWeeklyO3Summary(db, now, nextWeekEnd)
    .filter(s => s.account_id === accountId);
  for (const session of upcomingSessions) {
    const hoursUntil = Math.round((session.scheduled_start - now) / 3600);
    const label = hoursUntil < 24 ? 'tomorrow' : `in ${Math.round(hoursUntil / 24)} days`;

    items.push(createDigestItem({
      collector: 'o3',
      observation: `1:1 with ${session.report_name} ${label}`,
      reason: 'Upcoming O3 session',
      authority: 'Auto-capture: calendar-based O3 detection',
      consequence: 'Prep reminder will fire before the meeting.',
      sourceType: 'o3',
      category: 'o3-upcoming',
      priority: 'normal',
      counterparty: session.report_name,
      entityId: session.id,
      observedAt: session.scheduled_start
    }));
  }

  return items;
}

module.exports = { collectFollowups, collectEmail, collectO3 };
