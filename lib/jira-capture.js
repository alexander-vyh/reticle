'use strict';

const kg = require('./knowledge-graph');

/**
 * Format Jira activity into human-readable content for raw_messages.
 * @param {Object} activity
 * @returns {string}
 */
function formatActivityContent({ issueKey, summary, status, changeType, changeDetail }) {
  const parts = [`[${issueKey}] ${summary} (${status})`];
  if (changeDetail) {
    parts.push(`${changeType}: ${changeDetail}`);
  } else {
    parts.push(changeType);
  }
  return parts.join(' — ');
}

/**
 * Capture a Jira ticket activity into raw_messages for later extraction.
 * Synchronous, testable function. The caller resolves Jira API data before calling.
 *
 * @param {Object} db - better-sqlite3 database instance (org-memory)
 * @param {Object} activity
 * @param {string} activity.issueKey - e.g. 'DWDEV-42'
 * @param {string} activity.summary - Issue summary/title
 * @param {string} activity.status - Current status name
 * @param {string|null} activity.assigneeAccountId - Jira account ID
 * @param {string|null} activity.assigneeName - Display name
 * @param {string} activity.projectKey - e.g. 'DWDEV'
 * @param {number} activity.updatedAt - Epoch seconds
 * @param {string} activity.changeType - e.g. 'status', 'created', 'resolution'
 * @param {string|null} activity.changeDetail - e.g. 'To Do -> In Progress'
 * @returns {Object} Inserted raw_message row
 */
function captureJiraActivity(db, { issueKey, summary, status, assigneeAccountId, assigneeName, projectKey, updatedAt, changeType, changeDetail, changelogId }) {
  const sourceId = `${issueKey}:${changeType}:${updatedAt}`;

  // Resolve assignee to entity ID if identity is known
  const authorEntityId = assigneeAccountId
    ? kg.resolveIdentity(db, 'jira', assigneeAccountId)
    : null;

  const content = formatActivityContent({ issueKey, summary, status, changeType, changeDetail });

  // Map changeType to event_type
  const EVENT_TYPE_MAP = {
    status: 'status_change',
    resolution: 'status_change',
    created: 'created',
    assignee: 'assigned',
    comment: 'comment',
  };
  const eventType = EVENT_TYPE_MAP[changeType] || 'status_change';

  // Parse from/to from changeDetail (format: "From -> To")
  let fromVal = null, toVal = null;
  if (changeDetail && changeDetail.includes(' -> ')) {
    const parts = changeDetail.split(' -> ');
    fromVal = parts[0] || null;
    toVal = parts[1] || null;
  }

  const metadata = {
    event_type: eventType,
    source_msg_id: changelogId || null,
    source_parent_ref: issueKey,
    field: changeType,
    from: fromVal,
    to: toVal,
  };

  return kg.insertRawMessage(db, {
    source: 'jira',
    sourceId,
    channelId: projectKey,
    channelName: projectKey,
    authorExtId: assigneeAccountId || null,
    authorId: authorEntityId,
    authorName: assigneeName || null,
    content,
    threadId: issueKey,
    occurredAt: updatedAt,
    metadata,
  });
}

module.exports = { captureJiraActivity, formatActivityContent };
