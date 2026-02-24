'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB_PATH = path.join(os.tmpdir(), `claudia-patterns-test-${Date.now()}.db`);
process.env.CLAUDIA_DB_PATH = TEST_DB_PATH;

const claudiaDb = require('./claudia-db');
const { detectPatterns } = require('./lib/digest-patterns');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = claudiaDb.initDatabase();
const acct = claudiaDb.upsertAccount(db, {
  email: 'test@example.com', provider: 'gmail',
  display_name: 'Test', is_primary: 1
});

// --- Seed 4 weeks of snapshot data ---
// Week 1 (3 weeks ago): fast reply times
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-02',
  cadence: 'daily',
  items: [
    { category: 'unreplied', ageSeconds: 4 * 3600, counterparty: 'Alice' },
    { category: 'unreplied', ageSeconds: 6 * 3600, counterparty: 'Bob' },
    { category: 'unreplied', ageSeconds: 2 * 3600, counterparty: 'Charlie' },
    { category: 'resolved-today', counterparty: 'Dave' },
    { category: 'resolved-today', counterparty: 'Eve' }
  ]
});

// Week 2: slightly slower
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-09',
  cadence: 'daily',
  items: [
    { category: 'unreplied', ageSeconds: 8 * 3600, counterparty: 'Alice' },
    { category: 'unreplied', ageSeconds: 10 * 3600, counterparty: 'Bob' },
    { category: 'resolved-today', counterparty: 'Charlie' }
  ]
});

// Week 3: much slower (>25% increase = moderate)
claudiaDb.saveSnapshot(db, acct.id, {
  snapshotDate: '2026-02-16',
  cadence: 'daily',
  items: [
    { category: 'unreplied', ageSeconds: 14 * 3600, counterparty: 'Alice' },
    { category: 'unreplied', ageSeconds: 18 * 3600, counterparty: 'Alice' },
    { category: 'unreplied', ageSeconds: 12 * 3600, counterparty: 'Bob' }
  ]
});

// This week: current items
const thisWeekItems = [
  { category: 'unreplied', ageSeconds: 20 * 3600, counterparty: 'Alice' },
  { category: 'unreplied', ageSeconds: 16 * 3600, counterparty: 'Alice' },
  { category: 'unreplied', ageSeconds: 22 * 3600, counterparty: 'Bob' }
];

const insights = detectPatterns(db, acct.id, thisWeekItems, '2026-02-23');

assert.ok(Array.isArray(insights));

// Should detect reply latency trend
const latencyTrend = insights.find(i => i.id && i.observation.toLowerCase().includes('reply'));
assert.ok(latencyTrend, 'Should detect reply latency trend');
assert.ok(['moderate', 'notable'].includes(latencyTrend.significance),
  `Significance should be moderate or notable, got: ${latencyTrend.significance}`);
assert.ok(latencyTrend.evidence, 'Should include evidence');
assert.ok(latencyTrend.reason, 'Must have reason');
assert.ok(latencyTrend.authority, 'Must have authority');
console.log('PASS: reply latency trend detected');

// Should detect recurring counterparty (Alice appears in every week)
const recurringAlice = insights.find(
  i => i.observation.toLowerCase().includes('alice') && i.type === 'recurring'
);
assert.ok(recurringAlice, 'Should flag Alice as recurring counterparty');
console.log('PASS: recurring counterparty detected');

// All insights should have the PatternInsight shape
for (const insight of insights) {
  assert.ok(insight.id, 'Missing id');
  assert.ok(insight.observation, 'Missing observation');
  assert.ok(insight.reason, 'Missing reason');
  assert.ok(insight.authority, 'Missing authority');
  assert.ok(insight.consequence, 'Missing consequence');
}
console.log('PASS: all insights have valid shape');

// --- Test: close rate with zero resolved (division by zero guard) ---
const acct2 = claudiaDb.upsertAccount(db, {
  email: 'zero-rate@example.com', provider: 'gmail',
  display_name: 'Zero Rate Test', is_primary: 0
});

// Week with only unreplied items (0 resolved → rate = 0)
claudiaDb.saveSnapshot(db, acct2.id, {
  snapshotDate: '2026-02-09',
  cadence: 'daily',
  items: [
    { category: 'unreplied', ageSeconds: 3600, counterparty: 'Zara' },
    { category: 'unreplied', ageSeconds: 7200, counterparty: 'Zed' }
  ]
});

// Another week also with 0 resolved
claudiaDb.saveSnapshot(db, acct2.id, {
  snapshotDate: '2026-02-16',
  cadence: 'daily',
  items: [
    { category: 'unreplied', ageSeconds: 5400, counterparty: 'Zara' }
  ]
});

// Current items have a resolved item (rate > 0), but last week's rate was 0
const zeroRateCurrentItems = [
  { category: 'unreplied', ageSeconds: 3600, counterparty: 'Zara' },
  { category: 'resolved-today', counterparty: 'Zed' }
];

const zeroRateInsights = detectPatterns(db, acct2.id, zeroRateCurrentItems, '2026-02-23');
assert.ok(Array.isArray(zeroRateInsights), 'Should return array when recent rate is zero');
// Ensure no insight has NaN in its observation or reason
for (const insight of zeroRateInsights) {
  assert.ok(!String(insight.observation).includes('NaN'),
    `Observation should not contain NaN: ${insight.observation}`);
  assert.ok(!String(insight.reason).includes('NaN'),
    `Reason should not contain NaN: ${insight.reason}`);
}
console.log('PASS: close rate handles zero-resolved week without NaN');

// --- Test: no patterns when insufficient history ---
const emptyInsights = detectPatterns(db, acct.id, thisWeekItems, '2025-01-01');
// With date far in the past, no snapshots in range
// detectPatterns should handle this gracefully
assert.ok(Array.isArray(emptyInsights));
console.log('PASS: handles insufficient history gracefully');

console.log('\n=== PATTERN DETECTION TESTS PASSED ===');
