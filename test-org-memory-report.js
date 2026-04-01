#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// --- Test helpers ---

function tmpDbPath() {
  return path.join(os.tmpdir(), `test-org-memory-report-${crypto.randomUUID()}.db`);
}

function createTestDb() {
  const dbPath = tmpDbPath();
  const { initDatabase } = require('./lib/org-memory-db');
  return { db: initDatabase(dbPath), dbPath };
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

const NOW = Math.floor(Date.now() / 1000);
const ONE_DAY = 24 * 60 * 60;
const ONE_WEEK = 7 * ONE_DAY;

// --- Tests ---

async function testGenerateWeeklyOrgReport_emptyDb() {
  console.log('  test: generateWeeklyOrgReport returns empty report for empty DB');
  const { db, dbPath } = createTestDb();
  try {
    const { generateWeeklyOrgReport } = require('./lib/org-memory-report');
    const report = generateWeeklyOrgReport(db, { now: NOW });

    assert.ok(report, 'report should exist');
    assert.deepStrictEqual(report.commitments, []);
    assert.deepStrictEqual(report.decisions, []);
    assert.deepStrictEqual(report.risks, []);
    assert.deepStrictEqual(report.staleCommitments, []);
    assert.deepStrictEqual(report.stateChanges, []);
    assert.deepStrictEqual(report.entityActivity, []);
    assert.strictEqual(report.periodStart > 0, true);
    assert.strictEqual(report.periodEnd > 0, true);
  } finally {
    cleanup(dbPath);
  }
}

async function testGenerateWeeklyOrgReport_categorizesFacts() {
  console.log('  test: generateWeeklyOrgReport categorizes facts by attribute');
  const { db, dbPath } = createTestDb();
  const kg = require('./lib/knowledge-graph');

  try {
    // Create an entity
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });

    // Add facts within the past week
    const threeDaysAgo = NOW - (3 * ONE_DAY);

    // Commitment
    kg.addFact(db, {
      entityId: entity.id,
      attribute: 'committed_to',
      value: 'Deliver the Q4 report by Friday',
      factType: 'event',
      validFrom: threeDaysAgo,
      extractedAt: threeDaysAgo,
      resolution: 'open',
    });

    // Decision
    kg.addFact(db, {
      entityId: entity.id,
      attribute: 'decided',
      value: 'Use PostgreSQL for the new service',
      factType: 'event',
      validFrom: threeDaysAgo,
      extractedAt: threeDaysAgo,
    });

    // Risk
    kg.addFact(db, {
      entityId: entity.id,
      attribute: 'raised_risk',
      value: 'Database migration might take longer than estimated',
      factType: 'event',
      validFrom: threeDaysAgo,
      extractedAt: threeDaysAgo,
    });

    const { generateWeeklyOrgReport } = require('./lib/org-memory-report');
    const report = generateWeeklyOrgReport(db, { now: NOW });

    assert.strictEqual(report.commitments.length, 1);
    assert.strictEqual(report.commitments[0].value, 'Deliver the Q4 report by Friday');
    assert.strictEqual(report.commitments[0].entityName, 'Alice');

    assert.strictEqual(report.decisions.length, 1);
    assert.strictEqual(report.decisions[0].value, 'Use PostgreSQL for the new service');

    assert.strictEqual(report.risks.length, 1);
    assert.strictEqual(report.risks[0].value, 'Database migration might take longer than estimated');
  } finally {
    cleanup(dbPath);
  }
}

async function testGenerateWeeklyOrgReport_staleCommitments() {
  console.log('  test: generateWeeklyOrgReport identifies stale commitments (>7 days, still open)');
  const { db, dbPath } = createTestDb();
  const kg = require('./lib/knowledge-graph');

  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Bob' });

    // Open commitment from 10 days ago (stale)
    kg.addFact(db, {
      entityId: entity.id,
      attribute: 'committed_to',
      value: 'Fix the login bug',
      factType: 'event',
      validFrom: NOW - (10 * ONE_DAY),
      extractedAt: NOW - (10 * ONE_DAY),
      resolution: 'open',
    });

    // Open commitment from 2 days ago (not stale)
    kg.addFact(db, {
      entityId: entity.id,
      attribute: 'committed_to',
      value: 'Update the docs',
      factType: 'event',
      validFrom: NOW - (2 * ONE_DAY),
      extractedAt: NOW - (2 * ONE_DAY),
      resolution: 'open',
    });

    // Resolved commitment from 10 days ago (should not appear as stale)
    kg.addFact(db, {
      entityId: entity.id,
      attribute: 'committed_to',
      value: 'Deploy the hotfix',
      factType: 'event',
      validFrom: NOW - (10 * ONE_DAY),
      extractedAt: NOW - (10 * ONE_DAY),
      resolution: 'completed',
    });

    const { generateWeeklyOrgReport } = require('./lib/org-memory-report');
    const report = generateWeeklyOrgReport(db, { now: NOW });

    assert.strictEqual(report.staleCommitments.length, 1);
    assert.strictEqual(report.staleCommitments[0].value, 'Fix the login bug');
    assert.strictEqual(report.staleCommitments[0].entityName, 'Bob');
  } finally {
    cleanup(dbPath);
  }
}

async function testGenerateWeeklyOrgReport_stateChanges() {
  console.log('  test: generateWeeklyOrgReport detects state fact changes this week');
  const { db, dbPath } = createTestDb();
  const kg = require('./lib/knowledge-graph');

  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Carol' });

    // State fact confirmed this week
    const twoDaysAgo = NOW - (2 * ONE_DAY);
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'role',
      value: 'Tech Lead',
      factType: 'state',
      now: twoDaysAgo,
    });

    // State fact from long ago, not changed this week
    const thirtyDaysAgo = NOW - (30 * ONE_DAY);
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'team',
      value: 'Platform',
      factType: 'state',
      now: thirtyDaysAgo,
    });

    const { generateWeeklyOrgReport } = require('./lib/org-memory-report');
    const report = generateWeeklyOrgReport(db, { now: NOW });

    assert.strictEqual(report.stateChanges.length, 1);
    assert.strictEqual(report.stateChanges[0].attribute, 'role');
    assert.strictEqual(report.stateChanges[0].value, 'Tech Lead');
    assert.strictEqual(report.stateChanges[0].entityName, 'Carol');
  } finally {
    cleanup(dbPath);
  }
}

async function testGenerateWeeklyOrgReport_entityActivity() {
  console.log('  test: generateWeeklyOrgReport tracks entity activity levels');
  const { db, dbPath } = createTestDb();
  const kg = require('./lib/knowledge-graph');

  try {
    const alice = kg.createEntity(db, { entityType: 'person', canonicalName: 'Alice' });
    const bob = kg.createEntity(db, { entityType: 'person', canonicalName: 'Bob' });

    const threeDaysAgo = NOW - (3 * ONE_DAY);

    // Alice has 3 facts this week
    for (let i = 0; i < 3; i++) {
      kg.addFact(db, {
        entityId: alice.id,
        attribute: 'committed_to',
        value: `Task ${i}`,
        factType: 'event',
        validFrom: threeDaysAgo + i,
        extractedAt: threeDaysAgo + i,
        resolution: 'open',
      });
    }

    // Bob has 1 fact this week
    kg.addFact(db, {
      entityId: bob.id,
      attribute: 'decided',
      value: 'Some decision',
      factType: 'event',
      validFrom: threeDaysAgo,
      extractedAt: threeDaysAgo,
    });

    const { generateWeeklyOrgReport } = require('./lib/org-memory-report');
    const report = generateWeeklyOrgReport(db, { now: NOW });

    assert.strictEqual(report.entityActivity.length, 2);
    // Sorted by count descending
    assert.strictEqual(report.entityActivity[0].entityName, 'Alice');
    assert.strictEqual(report.entityActivity[0].factCount, 3);
    assert.strictEqual(report.entityActivity[1].entityName, 'Bob');
    assert.strictEqual(report.entityActivity[1].factCount, 1);
  } finally {
    cleanup(dbPath);
  }
}

async function testGenerateWeeklyOrgReport_deferredFacts() {
  console.log('  test: generateWeeklyOrgReport includes deferred (unattributed) facts');
  const { db, dbPath } = createTestDb();
  const kg = require('./lib/knowledge-graph');

  try {
    const threeDaysAgo = NOW - (3 * ONE_DAY);

    // Deferred fact (entity_id is NULL, has mentioned_name)
    kg.addFact(db, {
      entityId: null,
      mentionedName: 'Dave',
      attribute: 'committed_to',
      value: 'Review the PR by EOD',
      factType: 'event',
      validFrom: threeDaysAgo,
      extractedAt: threeDaysAgo,
      resolution: 'open',
    });

    const { generateWeeklyOrgReport } = require('./lib/org-memory-report');
    const report = generateWeeklyOrgReport(db, { now: NOW });

    assert.strictEqual(report.commitments.length, 1);
    assert.strictEqual(report.commitments[0].entityName, 'Dave');
    assert.strictEqual(report.commitments[0].value, 'Review the PR by EOD');
  } finally {
    cleanup(dbPath);
  }
}

async function testFormatOrgReportFallback() {
  console.log('  test: formatOrgReportFallback produces Slack mrkdwn from report data');
  const { formatOrgReportFallback } = require('./lib/org-memory-report');

  const report = {
    periodStart: NOW - ONE_WEEK,
    periodEnd: NOW,
    commitments: [
      { entityName: 'Alice', attribute: 'committed_to', value: 'Ship feature X', validFrom: NOW - ONE_DAY },
    ],
    decisions: [
      { entityName: 'Bob', attribute: 'decided', value: 'Use Kafka', validFrom: NOW - (2 * ONE_DAY) },
    ],
    risks: [],
    staleCommitments: [
      { entityName: 'Carol', attribute: 'committed_to', value: 'Fix bug Y', validFrom: NOW - (14 * ONE_DAY), daysSinceCreation: 14 },
    ],
    stateChanges: [],
    entityActivity: [
      { entityName: 'Alice', factCount: 5 },
      { entityName: 'Bob', factCount: 2 },
    ],
  };

  const text = formatOrgReportFallback(report);
  assert.ok(text.includes('Alice'), 'should mention Alice');
  assert.ok(text.includes('Ship feature X'), 'should mention the commitment');
  assert.ok(text.includes('Use Kafka'), 'should mention the decision');
  assert.ok(text.includes('Carol'), 'should mention Carol in stale section');
  assert.ok(text.includes('Fix bug Y'), 'should mention the stale commitment');
  assert.ok(text.includes('14'), 'should mention days stale');
}

async function testFormatOrgReportFallback_emptyReport() {
  console.log('  test: formatOrgReportFallback handles empty report');
  const { formatOrgReportFallback } = require('./lib/org-memory-report');

  const report = {
    periodStart: NOW - ONE_WEEK,
    periodEnd: NOW,
    commitments: [],
    decisions: [],
    risks: [],
    staleCommitments: [],
    stateChanges: [],
    entityActivity: [],
  };

  const text = formatOrgReportFallback(report);
  assert.ok(text.includes('No significant org-memory activity'), 'should indicate no activity');
}

async function testBuildOrgReportPrompt() {
  console.log('  test: buildOrgReportPrompt creates valid AI prompt');
  const { buildOrgReportPrompt } = require('./lib/org-memory-report');

  const report = {
    periodStart: NOW - ONE_WEEK,
    periodEnd: NOW,
    commitments: [
      { entityName: 'Alice', attribute: 'committed_to', value: 'Ship feature X', validFrom: NOW - ONE_DAY },
    ],
    decisions: [],
    risks: [],
    staleCommitments: [],
    stateChanges: [],
    entityActivity: [
      { entityName: 'Alice', factCount: 3 },
    ],
  };

  const prompt = buildOrgReportPrompt(report);
  assert.ok(prompt.system, 'should have system prompt');
  assert.ok(prompt.user, 'should have user prompt');
  assert.ok(prompt.system.includes('knowledge graph'), 'system prompt should reference knowledge graph');
  assert.ok(prompt.user.includes('Alice'), 'user prompt should include report data');
}

// --- Run all tests ---
async function main() {
  console.log('test-org-memory-report.js');

  await testGenerateWeeklyOrgReport_emptyDb();
  await testGenerateWeeklyOrgReport_categorizesFacts();
  await testGenerateWeeklyOrgReport_staleCommitments();
  await testGenerateWeeklyOrgReport_stateChanges();
  await testGenerateWeeklyOrgReport_entityActivity();
  await testGenerateWeeklyOrgReport_deferredFacts();
  await testFormatOrgReportFallback();
  await testFormatOrgReportFallback_emptyReport();
  await testBuildOrgReportPrompt();

  console.log('\nAll tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
