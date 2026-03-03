'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE action_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      account_id  TEXT,
      actor       TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      action      TEXT NOT NULL,
      context     TEXT,
      outcome     TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  return db;
}

function testLogAndQuery() {
  const { logFeedbackAction, getWeeklyCountsByReport } = require('./lib/feedback-tracker');
  const db = setupTestDb();
  const now = Math.floor(Date.now() / 1000);

  logFeedbackAction(db, 'acct1', { reportName: 'Marcus Chen', feedbackType: 'affirming', action: 'feedback_delivered', entityId: 'C01:1.000' });
  logFeedbackAction(db, 'acct1', { reportName: 'Marcus Chen', feedbackType: 'adjusting', action: 'feedback_skipped', entityId: 'C01:2.000' });
  logFeedbackAction(db, 'acct1', { reportName: 'Priya Patel', feedbackType: 'affirming', action: 'feedback_delivered', entityId: 'C02:3.000' });

  const counts = getWeeklyCountsByReport(db, 'acct1', now - 86400);
  assert.strictEqual(counts['Marcus Chen'].delivered, 1);
  assert.strictEqual(counts['Marcus Chen'].skipped, 1);
  assert.strictEqual(counts['Priya Patel'].delivered, 1);

  console.log('  PASS: logFeedbackAction + getWeeklyCountsByReport');
}

function testGetRatioByReport() {
  const { logFeedbackAction, getRatioByReport } = require('./lib/feedback-tracker');
  const db = setupTestDb();
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < 3; i++) {
    logFeedbackAction(db, 'acct1', { reportName: 'Marcus Chen', feedbackType: 'affirming', action: 'feedback_delivered', entityId: `C01:${i}.000` });
  }
  logFeedbackAction(db, 'acct1', { reportName: 'Marcus Chen', feedbackType: 'adjusting', action: 'feedback_delivered', entityId: 'C01:99.000' });

  const ratios = getRatioByReport(db, 'acct1', now - 86400 * 30);
  assert.strictEqual(ratios['Marcus Chen'].affirming, 3);
  assert.strictEqual(ratios['Marcus Chen'].adjusting, 1);

  console.log('  PASS: getRatioByReport');
}

console.log('feedback-tracker tests:');
testLogAndQuery();
testGetRatioByReport();
console.log('All feedback-tracker tests passed');
