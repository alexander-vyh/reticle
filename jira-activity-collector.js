#!/usr/bin/env node
/**
 * Jira Activity Collector — polls Jira for recent DW team activity,
 * captures into org-memory raw_messages via jira-capture.
 *
 * Scheduled daily at 5:00 PM via launchd.
 * Supports DRY_RUN=1 to fetch and log without DB writes.
 * Supports manual invocation: node jira-activity-collector.js
 */
'use strict';

const { captureJiraActivity } = require('./lib/jira-capture');
const { parseIssueActivity, formatChangelogEntry, buildActivityJql, searchIssues, getIssueChangelog } = require('./lib/jira-reader');

const SERVICE_NAME = 'jira-activity-collector';

/**
 * Get Jira account IDs for all team members from the identity_map.
 * @param {Object} db - org-memory database
 * @returns {string[]} Array of Jira external_ids
 */
function getTeamAccountIds(db) {
  const rows = db.prepare(
    "SELECT external_id FROM identity_map WHERE source = 'jira'"
  ).all();
  return rows.map(r => r.external_id);
}

/**
 * Parse a Jira ISO timestamp to epoch seconds.
 * @param {string} isoString - e.g. '2026-03-09T10:00:00.000+0000'
 * @returns {number} Epoch seconds
 */
function jiraTimestampToEpoch(isoString) {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

/**
 * Core collection logic — testable with injected API functions.
 *
 * @param {Object} db - org-memory database
 * @param {Object} opts
 * @param {Function} opts.searchIssuesFn - async (jql, opts) => issues[]
 * @param {Function} opts.getIssueChangelogFn - async (issueKey) => changelog
 * @param {string[]} opts.projects - Jira project keys
 * @param {string[]} opts.accountIds - Jira account IDs to filter by
 * @param {number} opts.sinceDays - Days to look back
 * @param {boolean} [opts.dryRun=false] - If true, log but don't write to DB
 * @param {Object} [opts.log] - Logger (defaults to console-compatible no-op)
 * @returns {Promise<{captured: number, skipped: number}>}
 */
async function collectAndCapture(db, { searchIssuesFn, getIssueChangelogFn, projects, accountIds, sinceDays, dryRun = false, log = null }) {
  const logger = log || { info() {}, warn() {}, debug() {} };
  const accountIdSet = new Set(accountIds);

  const jql = buildActivityJql({ projects, accountIds, sinceDays });
  logger.info({ jql }, 'Searching Jira issues');

  const issues = await searchIssuesFn(jql, {});
  logger.info({ issueCount: issues.length }, 'Found issues');

  let captured = 0;
  let skipped = 0;

  for (const issue of issues) {
    const changelog = await getIssueChangelogFn(issue.key);
    const activity = parseIssueActivity(issue, changelog);

    for (const change of activity.changes) {
      // Only capture changes made by known team members
      if (!change.authorAccountId || !accountIdSet.has(change.authorAccountId)) {
        continue;
      }

      const updatedAt = jiraTimestampToEpoch(change.timestamp);
      const changeDetail = formatChangelogEntry(change);

      if (dryRun) {
        logger.info({ issueKey: activity.key, changeType: change.field, changeDetail }, 'DRY RUN: would capture');
        skipped++;
        continue;
      }

      captureJiraActivity(db, {
        issueKey: activity.key,
        summary: activity.summary,
        status: activity.status,
        assigneeAccountId: change.authorAccountId,
        assigneeName: change.author,
        projectKey: issue.key.split('-')[0],
        updatedAt,
        changeType: change.field,
        changeDetail,
        changelogId: change.changelogId || null,
      });
      captured++;
    }
  }

  logger.info({ captured, skipped }, 'Collection complete');
  return { captured, skipped };
}

// --- Main entry point (only runs when invoked directly) ---
async function main() {
  // Lazy-load config and logger to avoid config requirement during testing
  const config = require('./lib/config');
  const log = require('./lib/logger')(SERVICE_NAME);
  const heartbeat = require('./lib/heartbeat');
  const { validatePrerequisites } = require('./lib/startup-validation');
  const { initDatabase } = require('./lib/org-memory-db');

  const dryRun = process.env.DRY_RUN === '1';
  if (dryRun) log.info('DRY_RUN mode enabled — no DB writes');

  // Validate Jira credentials
  if (!config.jiraApiToken || !config.jiraBaseUrl || !config.jiraUserEmail) {
    log.fatal('Jira credentials not configured in secrets.json (jiraApiToken, jiraBaseUrl, jiraUserEmail)');
    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'startup-failed',
      errors: { lastError: 'Missing Jira credentials', lastErrorAt: Date.now(), countSinceStart: 1 }
    });
    process.exit(1);
  }

  const db = initDatabase();
  const accountIds = getTeamAccountIds(db);

  if (accountIds.length === 0) {
    log.warn('No Jira identities found in identity_map — nothing to collect');
    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'ok',
      metrics: { captured: 0, skipped: 0, teamSize: 0 }
    });
    process.exit(0);
  }

  log.info({ teamSize: accountIds.length }, 'Loaded team Jira account IDs');

  try {
    const { captured, skipped } = await collectAndCapture(db, {
      searchIssuesFn: searchIssues,
      getIssueChangelogFn: getIssueChangelog,
      projects: ['ENG', 'ENGSUP'],
      accountIds,
      sinceDays: 1,
      dryRun,
      log,
    });

    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'ok',
      metrics: { captured, skipped, teamSize: accountIds.length }
    });

    log.info({ captured, skipped }, 'Jira activity collection complete');
  } catch (err) {
    log.error({ err }, 'Collection failed');
    heartbeat.write(SERVICE_NAME, {
      checkInterval: 0,
      status: 'error',
      errors: { lastError: err.message, lastErrorAt: Date.now(), countSinceStart: 1 }
    });
    process.exit(1);
  }
}

// Run main only when invoked directly
if (require.main === module) {
  main();
}

module.exports = { collectAndCapture, getTeamAccountIds, jiraTimestampToEpoch };
