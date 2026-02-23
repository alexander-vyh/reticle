'use strict';

const assert = require('assert');

// This will fail until we create the module
const { createDigestItem, createPatternInsight, deduplicateItems } = require('./lib/digest-item');

// --- Test: createDigestItem with all required fields ---
const item = createDigestItem({
  collector: 'followup',
  observation: 'Sarah Chen emailed you about "Q3 Budget Review" 52 hours ago',
  reason: 'Unreplied email older than 48 hours',
  authority: 'Auto-capture: hygiene obligation',
  consequence: 'Will appear in tomorrow\'s digest if still unreplied.',
  sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/abc123',
  sourceType: 'email',
  category: 'unreplied',
  priority: 'high',
  ageSeconds: 187200,
  counterparty: 'Sarah Chen',
  observedAt: 1740300000
});

assert.ok(item.id, 'Should auto-generate an id');
assert.ok(item.id.startsWith('digest-followup-'), 'Id should be prefixed with collector name');
assert.strictEqual(item.collector, 'followup');
assert.strictEqual(item.priority, 'high');
assert.ok(item.collectedAt, 'Should auto-set collectedAt');
console.log('PASS: createDigestItem with all fields');

// --- Test: createDigestItem rejects missing required fields ---
assert.throws(() => {
  createDigestItem({ collector: 'test' }); // missing observation, reason, etc.
}, /Missing required field/);
console.log('PASS: createDigestItem rejects missing fields');

// --- Test: createDigestItem rejects invalid priority ---
assert.throws(() => {
  createDigestItem({
    collector: 'test',
    observation: 'test',
    reason: 'test',
    authority: 'test',
    consequence: 'test',
    sourceType: 'email',
    category: 'unreplied',
    priority: 'EXTREME',
    observedAt: 1740300000
  });
}, /Invalid priority/);
console.log('PASS: createDigestItem rejects invalid priority');

// --- Test: createPatternInsight ---
const insight = createPatternInsight({
  type: 'trend',
  observation: 'Reply time increased from 8h to 14h over 3 weeks',
  evidence: { thisWeek: { avgReplyHours: 14 }, lastWeek: { avgReplyHours: 11 } },
  significance: 'moderate',
  reason: '3-week upward trend',
  authority: 'Pattern detection: computed from digest snapshots',
  consequence: 'Informational.'
});

assert.ok(insight.id.startsWith('pattern-'));
assert.strictEqual(insight.type, 'trend');
assert.strictEqual(insight.significance, 'moderate');
console.log('PASS: createPatternInsight');

// --- Test: deduplicateItems ---
const items = [
  createDigestItem({
    collector: 'followup',
    observation: 'Unreplied email from Sarah',
    reason: 'r', authority: 'a', consequence: 'c',
    sourceType: 'email', sourceUrl: 'https://mail.google.com/abc',
    category: 'unreplied', priority: 'normal',
    observedAt: 1740300000,
    entityId: 'thread-abc'
  }),
  createDigestItem({
    collector: 'email',
    observation: 'VIP unreplied: Sarah',
    reason: 'r', authority: 'a', consequence: 'c',
    sourceType: 'email', sourceUrl: 'https://mail.google.com/abc',
    category: 'vip-unreplied', priority: 'high',
    observedAt: 1740300000,
    entityId: 'thread-abc'
  }),
  createDigestItem({
    collector: 'calendar',
    observation: 'Meeting tomorrow',
    reason: 'r', authority: 'a', consequence: 'c',
    sourceType: 'calendar',
    category: 'meeting-with-open-followups', priority: 'high',
    observedAt: 1740300000,
    entityId: 'cal-event-1'
  })
];

const deduped = deduplicateItems(items);
assert.strictEqual(deduped.length, 2, 'Should remove duplicate email item');
// The high-priority version should win
const emailItem = deduped.find(i => i.sourceType === 'email');
assert.strictEqual(emailItem.priority, 'high', 'Higher priority should win dedup');
assert.strictEqual(emailItem.collector, 'email', 'Higher priority collector should win');
console.log('PASS: deduplicateItems keeps higher priority');

console.log('\n=== ALL DIGEST-ITEM TESTS PASSED ===');
