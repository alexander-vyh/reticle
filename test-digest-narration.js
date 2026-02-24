'use strict';

const assert = require('assert');

const { buildDailyPrompt, buildWeeklyPrompt, formatFallback } = require('./lib/digest-narration');

// --- Test: buildDailyPrompt ---
const items = [
  {
    id: 'test-1', collector: 'followup', priority: 'high',
    observation: 'Sarah emailed you 52h ago', reason: 'Unreplied >48h',
    authority: 'Auto-capture: hygiene', consequence: 'Will escalate.',
    sourceType: 'email', category: 'unreplied'
  },
  {
    id: 'test-2', collector: 'calendar', priority: 'low',
    observation: '5 meetings (4.5h)', reason: 'Calendar density',
    authority: 'Auto-capture', consequence: 'Informational.',
    sourceType: 'calendar', category: 'meeting-density'
  }
];

const dailyPrompt = buildDailyPrompt(items);
assert.ok(dailyPrompt.system, 'Should have system prompt');
assert.ok(dailyPrompt.user, 'Should have user message');
assert.ok(dailyPrompt.system.includes('calm'), 'System prompt should mention tone');
assert.ok(dailyPrompt.system.includes('Do not add information'), 'Should include grounding rule');
assert.ok(dailyPrompt.user.includes('Sarah emailed'), 'User message should contain item data');
console.log('PASS: buildDailyPrompt');

// --- Test: buildWeeklyPrompt ---
const patterns = [
  {
    id: 'pattern-1', type: 'trend', significance: 'moderate',
    observation: 'Reply time increased 8h to 14h',
    evidence: {}, reason: 'trend', authority: 'computed', consequence: 'info'
  }
];

const weeklyPrompt = buildWeeklyPrompt(items, patterns);
assert.ok(weeklyPrompt.system.includes('reflection'), 'Weekly should mention reflection');
assert.ok(weeklyPrompt.user.includes('Reply time increased'), 'Should include patterns');
console.log('PASS: buildWeeklyPrompt');

// --- Test: formatFallback ---
const fallback = formatFallback(items);
assert.ok(fallback.includes('Sarah emailed'), 'Fallback should list observations');
assert.ok(fallback.includes('high'), 'Fallback should show priority');
console.log('PASS: formatFallback');

// --- Test: empty items ---
const emptyDaily = buildDailyPrompt([]);
assert.ok(emptyDaily.user.includes('no items') || emptyDaily.user.includes('[]'),
  'Empty items should be handled');
console.log('PASS: empty items handled');

console.log('\n=== NARRATION TESTS PASSED ===');
