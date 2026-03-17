'use strict';

const { searchIssues } = require('./jira-reader');
const { listTeamMembers } = require('./people-store');
const log = require('./logger')('jira-collector');

// --- Classification patterns ---

const KTLO_SUMMARY_PATTERNS = [
  /access request/i,
  /provisioning/i,
  /onboarding:/i,
  /offboarding:/i,
  /send hardware/i,
  /order hardware/i,
  /desk issue/i,
  /login issue/i,
  /password reset/i,
  /okta.*issue/i,
  /new hire/i,
  /badge/i,
  /license/i,
  /deprovision/i,
  /phone.*issue/i,
];

const KTLO_ISSUE_TYPES = ['Service Request', 'Support'];

const CAPABILITY_SUMMARY_PATTERNS = [
  /terraform/i,
  /sso/i,
  /automation/i,
  /import/i,
  /deploy/i,
  /configure/i,
  /implement/i,
  /migrate/i,
  /integrate/i,
  /drift/i,
  /manifest/i,
];

/**
 * Convert epoch seconds to YYYY-MM-DD string (UTC).
 * @param {number} epochSeconds
 * @returns {string}
 */
function epochToDateStr(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Classify a Jira ticket as 'capability' or 'ktlo'.
 * @param {Object} issue - Jira issue from searchIssues
 * @returns {'capability'|'ktlo'}
 */
function classifyTicket(issue) {
  const fields = issue.fields || {};
  const summary = fields.summary || '';
  const issueType = fields.issuetype?.name || '';

  // KTLO by issue type
  if (KTLO_ISSUE_TYPES.includes(issueType)) {
    return 'ktlo';
  }

  // KTLO by summary pattern
  for (const pattern of KTLO_SUMMARY_PATTERNS) {
    if (pattern.test(summary)) {
      return 'ktlo';
    }
  }

  // Capability: ENG project is almost always capability
  if (issue.key && issue.key.startsWith('ENG-')) {
    return 'capability';
  }

  // Capability by summary pattern
  for (const pattern of CAPABILITY_SUMMARY_PATTERNS) {
    if (pattern.test(summary)) {
      return 'capability';
    }
  }

  // Default: not matched as KTLO, classify as capability
  return 'capability';
}

/**
 * Collect resolved Jira tickets for a given week and classify them.
 *
 * @param {Object} db - SQLite database instance
 * @param {string} jiraToken - Jira API token (unused — jira-reader uses config)
 * @param {number} weekStart - Epoch seconds for week start
 * @param {number} weekEnd - Epoch seconds for week end
 * @returns {Promise<{tickets: Object[], ktloCount: number, warnings: string[], totalResolved: number}>}
 */
async function collectJiraResolved(db, jiraToken, weekStart, weekEnd) {
  // 1. Get team members and build jira_id → { name, team } mapping
  const members = listTeamMembers(db);
  const jiraIdMap = new Map();
  for (const m of members) {
    if (m.jira_id) {
      jiraIdMap.set(m.jira_id, { name: m.name, team: m.team });
    }
  }

  // 2. Build JQL for resolved tickets in date range
  const startDate = epochToDateStr(weekStart);
  const endDate = epochToDateStr(weekEnd);
  const jql = `project in (ENG, ENGSUP) AND resolved >= "${startDate}" AND resolved <= "${endDate}" ORDER BY resolved DESC`;

  // 3. Query Jira
  let issues;
  try {
    issues = await searchIssues(jql, {
      fields: 'summary,assignee,status,components,issuetype',
    });
  } catch (err) {
    log.warn({ err: err.message }, 'Jira API unavailable');
    return {
      tickets: [],
      ktloCount: 0,
      warnings: [`Jira API unavailable: ${err.message}`],
      totalResolved: 0,
    };
  }

  // 4. Classify and map each ticket
  const capabilityTickets = [];
  let ktloCount = 0;

  for (const issue of issues) {
    const fields = issue.fields || {};
    const assigneeId = fields.assignee?.accountId || null;
    const assigneeName = fields.assignee?.displayName || null;

    // Map assignee to team
    const teamInfo = assigneeId ? jiraIdMap.get(assigneeId) : null;
    const team = teamInfo ? teamInfo.team : null;

    const category = classifyTicket(issue);

    if (category === 'ktlo') {
      ktloCount++;
      continue;
    }

    capabilityTickets.push({
      key: issue.key,
      summary: fields.summary || null,
      assignee: assigneeName,
      team,
      category,
    });
  }

  log.info({
    totalResolved: issues.length,
    capability: capabilityTickets.length,
    ktlo: ktloCount,
    dateRange: `${startDate} to ${endDate}`,
  }, 'Collected Jira resolved tickets');

  return {
    tickets: capabilityTickets,
    ktloCount,
    warnings: [],
    totalResolved: issues.length,
  };
}

module.exports = { collectJiraResolved, classifyTicket, epochToDateStr };
