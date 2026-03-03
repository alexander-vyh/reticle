'use strict';

/**
 * Feedback tracker — reads/writes the action_log table for feedback delivery tracking.
 *
 * Uses entity_type = 'feedback' and stores report name + feedback type in the
 * context JSON column: { report: "Marcus Chen", feedbackType: "affirming" }
 *
 * JSON.stringify produces deterministic output for the same inputs, so GROUP BY
 * on the context column correctly groups rows by (report, feedbackType).
 */

function logFeedbackAction(db, accountId, { reportName, feedbackType, action, entityId }) {
  db.prepare(`
    INSERT INTO action_log (account_id, actor, entity_type, entity_id, action, context)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, 'system', 'feedback', entityId, action,
    JSON.stringify({ report: reportName, feedbackType }));
}

function getWeeklyCountsByReport(db, accountId, weekStart) {
  const rows = db.prepare(`
    SELECT context, action, COUNT(*) as cnt
    FROM action_log
    WHERE account_id = ? AND entity_type = 'feedback'
      AND action IN ('feedback_delivered', 'feedback_skipped')
      AND timestamp >= ?
    GROUP BY context, action
  `).all(accountId, weekStart);

  const counts = {};
  for (const row of rows) {
    const { report } = JSON.parse(row.context);
    if (!counts[report]) counts[report] = { delivered: 0, skipped: 0 };
    if (row.action === 'feedback_delivered') counts[report].delivered = row.cnt;
    if (row.action === 'feedback_skipped') counts[report].skipped = row.cnt;
  }
  return counts;
}

function getMonthlyCountsByReport(db, accountId, monthStart) {
  return getWeeklyCountsByReport(db, accountId, monthStart);
}

function getRatioByReport(db, accountId, since) {
  const rows = db.prepare(`
    SELECT context, COUNT(*) as cnt
    FROM action_log
    WHERE account_id = ? AND entity_type = 'feedback'
      AND action = 'feedback_delivered' AND timestamp >= ?
    GROUP BY context
  `).all(accountId, since);

  const ratios = {};
  for (const row of rows) {
    const { report, feedbackType } = JSON.parse(row.context);
    if (!ratios[report]) ratios[report] = { affirming: 0, adjusting: 0, total: 0 };
    ratios[report][feedbackType] = (ratios[report][feedbackType] || 0) + row.cnt;
    ratios[report].total += row.cnt;
  }
  return ratios;
}

module.exports = {
  logFeedbackAction,
  getWeeklyCountsByReport,
  getMonthlyCountsByReport,
  getRatioByReport
};
