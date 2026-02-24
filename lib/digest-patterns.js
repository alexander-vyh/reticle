'use strict';

const claudiaDb = require('../claudia-db');
const { createPatternInsight } = require('./digest-item');

function detectPatterns(db, accountId, currentItems, currentDate) {
  // Get 4 weeks of snapshot history
  const endDate = currentDate;
  const startDate = new Date(currentDate);
  startDate.setUTCDate(startDate.getUTCDate() - 28);
  const startStr = startDate.toISOString().split('T')[0];

  const snapshots = claudiaDb.getSnapshotsForRange(db, accountId, startStr, endDate);

  if (snapshots.length < 2) {
    // Not enough history for patterns
    return [];
  }

  const insights = [];

  // Group snapshots by week
  const weeks = groupByWeek(snapshots);

  // Detector 1: Reply latency trend
  const latencyInsight = detectReplyLatencyTrend(weeks, currentItems);
  if (latencyInsight) insights.push(latencyInsight);

  // Detector 2: Follow-up close rate
  const closeRateInsight = detectCloseRateTrend(weeks, currentItems);
  if (closeRateInsight) insights.push(closeRateInsight);

  // Detector 3: Recurring counterparties
  const recurringInsights = detectRecurringCounterparties(weeks, currentItems);
  insights.push(...recurringInsights);

  return insights;
}

function groupByWeek(snapshots) {
  const weeks = new Map();
  for (const snap of snapshots) {
    const date = new Date(snap.snapshot_date);
    // ISO week start (Monday)
    const weekStart = new Date(date);
    const day = date.getUTCDay();
    // getUTCDay(): 0=Sun, 1=Mon ... 6=Sat. For ISO weeks, Monday=1.
    // Shift so Monday is day 0: (day + 6) % 7
    const daysFromMonday = (day + 6) % 7;
    weekStart.setUTCDate(date.getUTCDate() - daysFromMonday);
    const key = weekStart.toISOString().split('T')[0];

    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(...snap.items);
  }
  // Return sorted by week key (oldest first)
  return Array.from(weeks.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekKey, items]) => ({ weekKey, items }));
}

function avgReplyAge(items) {
  const unreplied = items.filter(i => i.category === 'unreplied' && i.ageSeconds);
  if (unreplied.length === 0) return null;
  const total = unreplied.reduce((sum, i) => sum + i.ageSeconds, 0);
  return { avg: total / unreplied.length, count: unreplied.length };
}

function detectReplyLatencyTrend(weeks, currentItems) {
  if (weeks.length < 2) return null;

  const currentAvg = avgReplyAge(currentItems);
  if (!currentAvg) return null;

  const weeklyAvgs = weeks.map(w => ({
    week: w.weekKey,
    ...avgReplyAge(w.items)
  })).filter(w => w.avg !== null);

  if (weeklyAvgs.length < 2) return null;

  // Compare current to oldest available
  const oldest = weeklyAvgs[0];
  const percentChange = ((currentAvg.avg - oldest.avg) / oldest.avg) * 100;

  let significance = null;
  if (percentChange > 50) significance = 'notable';
  else if (percentChange > 25) significance = 'moderate';

  if (!significance) return null;

  const currentHours = Math.round(currentAvg.avg / 3600);
  const oldestHours = Math.round(oldest.avg / 3600);

  return createPatternInsight({
    type: 'trend',
    observation: `Your average reply time increased from ${oldestHours}h to ${currentHours}h over the last ${weeklyAvgs.length + 1} weeks`,
    evidence: {
      thisWeek: { avgReplyHours: currentHours, sampleSize: currentAvg.count },
      history: weeklyAvgs.map(w => ({
        week: w.week,
        avgReplyHours: Math.round(w.avg / 3600),
        sampleSize: w.count
      }))
    },
    significance,
    reason: `${Math.round(percentChange)}% increase in reply latency over ${weeklyAvgs.length + 1} weeks`,
    authority: 'Pattern detection: computed from digest snapshots',
    consequence: 'Informational. No enforcement configured.'
  });
}

function detectCloseRateTrend(weeks, currentItems) {
  if (weeks.length < 2) return null;

  const closeRate = (items) => {
    const resolved = items.filter(i => i.category === 'resolved-today').length;
    const total = items.filter(i =>
      i.category === 'unreplied' || i.category === 'awaiting' || i.category === 'resolved-today'
    ).length;
    if (total === 0) return null;
    return { rate: resolved / total, resolved, total };
  };

  const currentRate = closeRate(currentItems);
  if (!currentRate) return null;

  const weeklyRates = weeks.map(w => ({
    week: w.weekKey,
    ...closeRate(w.items)
  })).filter(w => w.rate !== null);

  if (weeklyRates.length < 2) return null;

  const recentRate = weeklyRates[weeklyRates.length - 1];
  if (recentRate.rate === 0) return null;  // Can't measure a drop from zero
  const percentDrop = ((recentRate.rate - currentRate.rate) / recentRate.rate) * 100;

  if (percentDrop < 15) return null;

  return createPatternInsight({
    type: 'trend',
    observation: `Follow-up close rate dropped from ${Math.round(recentRate.rate * 100)}% to ${Math.round(currentRate.rate * 100)}%`,
    evidence: {
      thisWeek: currentRate,
      lastWeek: recentRate
    },
    significance: 'moderate',
    reason: `${Math.round(percentDrop)}% decrease in close rate`,
    authority: 'Pattern detection: computed from digest snapshots',
    consequence: 'More items are being carried forward without resolution.'
  });
}

function detectRecurringCounterparties(weeks, currentItems) {
  // Count appearances across weeks
  const allItems = [...weeks.flatMap(w => w.items), ...currentItems];
  const weeklyAppearances = new Map(); // counterparty -> Set of week keys

  for (const week of weeks) {
    for (const item of week.items) {
      if (item.category !== 'unreplied' || !item.counterparty) continue;
      if (!weeklyAppearances.has(item.counterparty)) {
        weeklyAppearances.set(item.counterparty, new Set());
      }
      weeklyAppearances.get(item.counterparty).add(week.weekKey);
    }
  }

  // Add current week
  const currentWeekKey = 'current';
  for (const item of currentItems) {
    if (item.category !== 'unreplied' || !item.counterparty) continue;
    if (!weeklyAppearances.has(item.counterparty)) {
      weeklyAppearances.set(item.counterparty, new Set());
    }
    weeklyAppearances.get(item.counterparty).add(currentWeekKey);
  }

  const insights = [];
  for (const [name, weekSet] of weeklyAppearances) {
    const totalCount = allItems.filter(
      i => i.category === 'unreplied' && i.counterparty === name
    ).length;

    if (weekSet.size < 2 || totalCount < 3) continue;

    let significance = 'minor';
    if (totalCount >= 5) significance = 'moderate';

    insights.push(createPatternInsight({
      type: 'recurring',
      observation: `${name} has appeared in unreplied items across ${weekSet.size} weeks (${totalCount} total occurrences)`,
      evidence: {
        counterparty: name,
        weeksPresent: weekSet.size,
        totalOccurrences: totalCount
      },
      significance,
      reason: `Recurring unreplied items with the same person across ${weekSet.size} weeks`,
      authority: 'Pattern detection: computed from digest snapshots',
      consequence: 'Consider whether this relationship needs a different communication pattern.'
    }));
  }

  return insights;
}

module.exports = { detectPatterns };
