#!/usr/bin/env node
/**
 * Org-Memory Weekly Report — scheduled service.
 *
 * Queries the org-memory knowledge graph for facts from the past 7 days,
 * groups by entity and category (commitments, decisions, risks, stale items),
 * narrates via AI, and delivers to Slack DM.
 *
 * Schedule: Friday at 2:00 PM (before the weekly digest at 4:00 PM)
 */
'use strict';

const log = require('./lib/logger')('org-memory-report');
const heartbeat = require('./lib/heartbeat');
const { initDatabase, DB_PATH } = require('./lib/org-memory-db');
const { validatePrerequisites } = require('./lib/startup-validation');
const { sendSlackDM } = require('./lib/slack');
const { generateWeeklyOrgReport, narrateOrgReport, formatOrgReportFallback } = require('./lib/org-memory-report');

const SERVICE_NAME = 'org-memory-report';

async function main() {
  log.info('Org-memory weekly report starting');

  // Startup validation
  const validation = validatePrerequisites(SERVICE_NAME, [
    { type: 'database', path: DB_PATH, description: 'Org-memory database' },
  ]);
  if (validation.errors.length > 0) {
    log.fatal({ errors: validation.errors }, 'Startup validation failed');
    process.exit(1);
  }

  const db = initDatabase();

  // Generate structured report
  const report = generateWeeklyOrgReport(db);
  const totalItems =
    report.commitments.length +
    report.decisions.length +
    report.risks.length +
    report.staleCommitments.length +
    report.stateChanges.length;

  log.info({
    commitments: report.commitments.length,
    decisions: report.decisions.length,
    risks: report.risks.length,
    staleCommitments: report.staleCommitments.length,
    stateChanges: report.stateChanges.length,
    entityActivity: report.entityActivity.length,
    totalItems,
  }, 'Report generated');

  // If nothing to report, still deliver a message and exit clean
  if (totalItems === 0 && report.entityActivity.length === 0) {
    const emptyMessage = 'No significant org-memory activity this week.';
    log.info('No activity — sending empty report');
    try {
      await sendSlackDM(emptyMessage);
    } catch (err) {
      log.error({ err }, 'Failed to deliver empty report to Slack');
    }
    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'ok',
      metrics: { totalItems: 0, narrated: false },
    });
    process.exit(0);
  }

  // Narrate via AI (with deterministic fallback)
  let message;
  let narrated = false;
  try {
    message = await narrateOrgReport(report);
    if (message && message !== formatOrgReportFallback(report)) {
      narrated = true;
    }
  } catch (err) {
    log.warn({ err }, 'Narration failed — using fallback');
    message = formatOrgReportFallback(report);
  }

  if (!message) {
    message = formatOrgReportFallback(report);
  }

  // Deliver to Slack
  try {
    await sendSlackDM(message);
    log.info({ narrated }, 'Org-memory report delivered');
  } catch (err) {
    log.error({ err }, 'Failed to deliver report to Slack');
    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'degraded',
      errors: {
        lastError: `Slack delivery failed: ${err.message}`,
        lastErrorAt: Date.now(),
        countSinceStart: 1,
      },
    });
    process.exit(1);
  }

  heartbeat.write(SERVICE_NAME, {
    checkInterval: 0,
    status: 'ok',
    metrics: {
      totalItems,
      commitments: report.commitments.length,
      decisions: report.decisions.length,
      risks: report.risks.length,
      staleCommitments: report.staleCommitments.length,
      stateChanges: report.stateChanges.length,
      narrated,
    },
  });

  process.exit(0);
}

main().catch(err => {
  log.fatal({ err }, 'Org-memory report crashed');
  process.exit(1);
});
