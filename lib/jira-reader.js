'use strict';

const https = require('https');
const config = require('./config');
const log = require('./logger')('jira-reader');

const JIRA_TOKEN = config.jiraApiToken;
const JIRA_BASE_URL = config.jiraBaseUrl;
const JIRA_USER_EMAIL = config.jiraUserEmail;

function createRateLimiter(maxTokens, refillPerSecond) {
  let tokens = maxTokens;
  let lastRefill = Date.now();

  return {
    tryAcquire() {
      const now = Date.now();
      const elapsed = (now - lastRefill) / 1000;
      tokens = Math.min(maxTokens, tokens + elapsed * refillPerSecond);
      lastRefill = now;
      if (tokens >= 1) { tokens -= 1; return true; }
      return false;
    },
    async acquire() {
      while (!this.tryAcquire()) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  };
}

// Jira Cloud allows ~10 req/s for basic auth
const defaultLimiter = createRateLimiter(10, 10);

function getAuthHeader() {
  if (!JIRA_USER_EMAIL || !JIRA_TOKEN) return null;
  return 'Basic ' + Buffer.from(JIRA_USER_EMAIL + ':' + JIRA_TOKEN).toString('base64');
}

function jiraRequest(method, path, { params, body } = {}) {
  const auth = getAuthHeader();
  if (!auth) return Promise.reject(new Error('Jira credentials not configured'));

  const url = new URL(JIRA_BASE_URL);
  const query = params ? new URLSearchParams(params).toString() : '';
  const fullPath = `/rest/api/3/${path}${query ? '?' + query : ''}`;
  const jsonBody = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': auth,
      'Accept': 'application/json'
    };
    if (jsonBody) headers['Content-Type'] = 'application/json';

    const req = https.request({
      hostname: url.hostname,
      path: fullPath,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Jira API error (${res.statusCode}): ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Jira response parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (jsonBody) req.write(jsonBody);
    req.end();
  });
}

function jiraGet(path, params = {}) {
  return jiraRequest('GET', path, { params });
}

/**
 * Build a JQL query for fetching recent issue activity.
 * @param {Object} opts
 * @param {string[]} opts.projects - Project keys (e.g. ['DWDEV', 'DWS'])
 * @param {string[]} [opts.accountIds] - Jira account IDs to filter by assignee
 * @param {number} opts.sinceDays - Number of days to look back
 * @returns {string} JQL query string
 */
function buildActivityJql({ projects, accountIds, sinceDays }) {
  const clauses = [];
  clauses.push(`project in (${projects.join(', ')})`);

  if (accountIds && accountIds.length > 0) {
    clauses.push(`assignee in (${accountIds.map(id => `"${id}"`).join(', ')})`);
  }

  clauses.push(`updated >= -${sinceDays}d`);

  return clauses.join(' AND ') + ' ORDER BY updated DESC';
}

/**
 * Search for issues using JQL.
 * @param {string} jql - JQL query string
 * @param {Object} [opts]
 * @param {string} [opts.fields] - Comma-separated field names
 * @param {number} [opts.maxResults] - Max results per page (default 50)
 * @returns {Promise<Object[]>} Array of issue objects
 */
async function searchIssues(jql, { fields = 'summary,status,assignee,updated,created,issuetype,priority', maxResults = 50 } = {}) {
  const all = [];
  let nextPageToken = null;

  do {
    await defaultLimiter.acquire();
    const body = {
      jql,
      fields: fields.split(',').map(f => f.trim()),
      maxResults
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await jiraRequest('POST', 'search/jql', { body });
    all.push(...(res.issues || []));
    nextPageToken = res.nextPageToken || null;
  } while (nextPageToken);

  log.info({ count: all.length, jql: jql.slice(0, 100) }, 'Searched issues');
  return all;
}

/**
 * Get the changelog for a specific issue.
 * @param {string} issueKey - e.g. 'ENG-123'
 * @returns {Promise<Object>} Changelog object with .values array
 */
async function getIssueChangelog(issueKey) {
  const allValues = [];
  let startAt = 0;
  let total;

  do {
    await defaultLimiter.acquire();
    const res = await jiraGet(`issue/${issueKey}/changelog`, {
      startAt: String(startAt),
      maxResults: '100'
    });
    allValues.push(...(res.values || []));
    total = res.total;
    startAt += res.values?.length || 100;
  } while (startAt < total);

  return { values: allValues };
}

/**
 * Look up a Jira user by email address.
 * @param {string} email
 * @returns {Promise<Object|null>} User object or null
 */
async function lookupUserByEmail(email) {
  await defaultLimiter.acquire();
  try {
    const results = await jiraGet('user/search', { query: email });
    if (Array.isArray(results) && results.length > 0) {
      return results[0];
    }
    return null;
  } catch (err) {
    log.warn({ err, email }, 'Failed to look up Jira user by email');
    return null;
  }
}

/**
 * Extract structured activity from a Jira issue and its changelog.
 * Pure function — no API calls.
 * @param {Object} issue - Jira issue object from search
 * @param {Object} changelog - Changelog object with .values array
 * @returns {Object} Structured activity entry
 */
function parseIssueActivity(issue, changelog) {
  const fields = issue.fields || {};
  const changes = [];

  for (const entry of (changelog.values || [])) {
    for (const item of (entry.items || [])) {
      changes.push({
        field: item.field,
        from: item.fromString || null,
        to: item.toString || null,
        author: entry.author?.displayName || null,
        authorAccountId: entry.author?.accountId || null,
        timestamp: entry.created,
        changelogId: entry.id || null,
      });
    }
  }

  return {
    key: issue.key,
    summary: fields.summary || null,
    status: fields.status?.name || null,
    issueType: fields.issuetype?.name || null,
    priority: fields.priority?.name || null,
    assignee: fields.assignee?.displayName || null,
    assigneeAccountId: fields.assignee?.accountId || null,
    updated: fields.updated || null,
    created: fields.created || null,
    changes
  };
}

/**
 * Format a single changelog change entry as readable text.
 * Pure function.
 * @param {Object} entry - Change entry from parseIssueActivity
 * @returns {string} Human-readable description
 */
function formatChangelogEntry(entry) {
  const { field, from, to, author, timestamp } = entry;
  const byAuthor = author ? ` by ${author}` : '';
  const ts = timestamp ? ` at ${timestamp}` : '';

  if (from && to) {
    return `${field}: ${from} -> ${to}${byAuthor}${ts}`;
  } else if (!from && to) {
    return `${field}: set to ${to}${byAuthor}${ts}`;
  } else if (from && !to) {
    return `${field}: cleared (was ${from})${byAuthor}${ts}`;
  }
  return `${field}: changed${byAuthor}${ts}`;
}

module.exports = {
  createRateLimiter,
  jiraGet,
  jiraRequest,
  buildActivityJql,
  searchIssues,
  getIssueChangelog,
  lookupUserByEmail,
  parseIssueActivity,
  formatChangelogEntry
};
