'use strict';

const assert = require('node:assert');
const { buildActivityJql, parseIssueActivity, formatChangelogEntry } = require('./lib/jira-reader');

// --- buildActivityJql tests ---

// Test: basic project filter with sinceDays
{
  const jql = buildActivityJql({ projects: ['ENG', 'ENGSUP'], sinceDays: 7 });
  assert.ok(jql.includes('project in (ENG, ENGSUP)'), 'should include project filter');
  assert.ok(jql.includes('updated >= -7d'), 'should include updated filter');
  assert.ok(jql.includes('ORDER BY updated DESC'), 'should order by updated desc');
  assert.ok(!jql.includes('assignee'), 'should not include assignee when no accountIds');
}

// Test: with accountIds
{
  const jql = buildActivityJql({
    projects: ['ENG', 'ENGSUP'],
    accountIds: ['abc123', 'def456'],
    sinceDays: 7
  });
  assert.ok(jql.includes('project in (ENG, ENGSUP)'), 'should include project filter');
  assert.ok(jql.includes('abc123'), 'should include first accountId');
  assert.ok(jql.includes('def456'), 'should include second accountId');
  assert.ok(jql.includes('assignee in'), 'should include assignee filter');
}

// Test: single project, no accountIds
{
  const jql = buildActivityJql({ projects: ['ENG'], sinceDays: 14 });
  assert.ok(jql.includes('project in (ENG)'), 'should include single project');
  assert.ok(jql.includes('updated >= -14d'), 'should use 14 day window');
  assert.ok(!jql.includes('assignee'), 'should not include assignee filter');
}

// Test: empty accountIds array treated as no filter
{
  const jql = buildActivityJql({ projects: ['ENG'], accountIds: [], sinceDays: 7 });
  assert.ok(!jql.includes('assignee'), 'empty accountIds should not add assignee filter');
}

// --- parseIssueActivity tests ---

// Test: extracts activity from issue with changelog
{
  const issue = {
    key: 'ENG-123',
    fields: {
      summary: 'Fix login bug',
      status: { name: 'In Progress' },
      assignee: { displayName: 'Alice', accountId: 'alice123' },
      updated: '2026-03-08T10:00:00.000+0000',
      created: '2026-03-07T09:00:00.000+0000',
      issuetype: { name: 'Bug' },
      priority: { name: 'High' }
    }
  };
  const changelog = {
    values: [
      {
        id: '100',
        author: { displayName: 'Alice', accountId: 'alice123' },
        created: '2026-03-08T10:00:00.000+0000',
        items: [
          { field: 'status', fromString: 'To Do', toString: 'In Progress' }
        ]
      }
    ]
  };

  const activity = parseIssueActivity(issue, changelog);
  assert.strictEqual(activity.key, 'ENG-123');
  assert.strictEqual(activity.summary, 'Fix login bug');
  assert.strictEqual(activity.status, 'In Progress');
  assert.strictEqual(activity.issueType, 'Bug');
  assert.strictEqual(activity.priority, 'High');
  assert.strictEqual(activity.assignee, 'Alice');
  assert.strictEqual(activity.changes.length, 1);
  assert.strictEqual(activity.changes[0].field, 'status');
  assert.strictEqual(activity.changes[0].from, 'To Do');
  assert.strictEqual(activity.changes[0].to, 'In Progress');
  assert.strictEqual(activity.changes[0].author, 'Alice');
}

// Test: issue with empty changelog
{
  const issue = {
    key: 'ENGSUP-45',
    fields: {
      summary: 'Support request',
      status: { name: 'Open' },
      assignee: null,
      updated: '2026-03-08T10:00:00.000+0000',
      created: '2026-03-08T09:00:00.000+0000',
      issuetype: { name: 'Task' },
      priority: { name: 'Medium' }
    }
  };
  const changelog = { values: [] };

  const activity = parseIssueActivity(issue, changelog);
  assert.strictEqual(activity.key, 'ENGSUP-45');
  assert.strictEqual(activity.assignee, null);
  assert.strictEqual(activity.changes.length, 0);
}

// Test: changelog entry with multiple items
{
  const issue = {
    key: 'ENG-200',
    fields: {
      summary: 'Refactor module',
      status: { name: 'Done' },
      assignee: { displayName: 'Bob', accountId: 'bob456' },
      updated: '2026-03-08T12:00:00.000+0000',
      created: '2026-03-06T09:00:00.000+0000',
      issuetype: { name: 'Story' },
      priority: { name: 'Low' }
    }
  };
  const changelog = {
    values: [
      {
        id: '200',
        author: { displayName: 'Bob', accountId: 'bob456' },
        created: '2026-03-08T11:00:00.000+0000',
        items: [
          { field: 'status', fromString: 'In Progress', toString: 'Done' },
          { field: 'resolution', fromString: null, toString: 'Done' }
        ]
      }
    ]
  };

  const activity = parseIssueActivity(issue, changelog);
  assert.strictEqual(activity.changes.length, 2);
  assert.strictEqual(activity.changes[0].field, 'status');
  assert.strictEqual(activity.changes[1].field, 'resolution');
}

// --- formatChangelogEntry tests ---

// Test: basic status change
{
  const entry = {
    field: 'status',
    from: 'To Do',
    to: 'In Progress',
    author: 'Alice',
    timestamp: '2026-03-08T10:00:00.000+0000'
  };
  const formatted = formatChangelogEntry(entry);
  assert.ok(formatted.includes('status'), 'should mention field name');
  assert.ok(formatted.includes('To Do'), 'should mention from value');
  assert.ok(formatted.includes('In Progress'), 'should mention to value');
  assert.ok(formatted.includes('Alice'), 'should mention author');
}

// Test: field change with null from (newly set)
{
  const entry = {
    field: 'assignee',
    from: null,
    to: 'Bob',
    author: 'Alice',
    timestamp: '2026-03-08T10:00:00.000+0000'
  };
  const formatted = formatChangelogEntry(entry);
  assert.ok(formatted.includes('assignee'), 'should mention field name');
  assert.ok(formatted.includes('Bob'), 'should mention new value');
  assert.ok(!formatted.includes('null'), 'should not show literal null');
}

// Test: field change with null to (cleared)
{
  const entry = {
    field: 'assignee',
    from: 'Bob',
    to: null,
    author: 'Alice',
    timestamp: '2026-03-08T10:00:00.000+0000'
  };
  const formatted = formatChangelogEntry(entry);
  assert.ok(formatted.includes('assignee'), 'should mention field name');
  assert.ok(formatted.includes('cleared') || formatted.includes('removed'), 'should indicate removal');
}

console.log('PASS: jira-reader tests');
