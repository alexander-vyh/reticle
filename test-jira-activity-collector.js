'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase } = require('./lib/org-memory-db');
const kg = require('./lib/knowledge-graph');

// We test the pure collection logic, not the live API polling.
// The collector module exports collectAndCapture(db, { searchIssues, getIssueChangelog }) for testability.
const { collectAndCapture, getTeamAccountIds } = require('./jira-activity-collector');

function tmpDb() {
  const p = path.join(os.tmpdir(), `test-jira-collector-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = initDatabase(p);
  return { db, path: p };
}

function cleanup(dbPath) {
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
}

// --- Test: getTeamAccountIds reads jira identities from identity_map ---
{
  const { db, path: p } = tmpDb();
  try {
    const entity1 = kg.createEntity(db, { entityType: 'person', canonicalName: 'Jane Doe' });
    kg.addIdentity(db, { entityId: entity1.id, source: 'jira', externalId: 'jira-001', displayName: 'Jane Doe' });

    const entity2 = kg.createEntity(db, { entityType: 'person', canonicalName: 'John Smith' });
    kg.addIdentity(db, { entityId: entity2.id, source: 'jira', externalId: 'jira-002', displayName: 'John Smith' });

    // Also add a slack identity — should NOT appear in jira account IDs
    kg.addIdentity(db, { entityId: entity2.id, source: 'slack', externalId: 'U12345', displayName: 'John Smith' });

    const ids = getTeamAccountIds(db);
    assert.deepStrictEqual(ids.sort(), ['jira-001', 'jira-002'].sort());
    console.log('PASS: getTeamAccountIds reads jira identities from identity_map');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: collectAndCapture processes issues into raw_messages ---
{
  const { db, path: p } = tmpDb();
  try {
    // Seed an identity so we can verify resolution
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Jane Doe' });
    kg.addIdentity(db, { entityId: entity.id, source: 'jira', externalId: 'jira-001', displayName: 'Jane Doe' });

    // Mock Jira API
    const mockIssues = [
      {
        key: 'ENG-10',
        fields: {
          summary: 'Build the feature',
          status: { name: 'In Progress' },
          assignee: { displayName: 'Jane Doe', accountId: 'jira-001' },
          updated: '2026-03-09T10:00:00.000+0000',
          issuetype: { name: 'Story' },
          priority: { name: 'Medium' },
          created: '2026-03-08T09:00:00.000+0000',
        }
      }
    ];

    const mockChangelog = {
      values: [
        {
          author: { displayName: 'Jane Doe', accountId: 'jira-001' },
          created: '2026-03-09T10:00:00.000+0000',
          items: [
            { field: 'status', fromString: 'To Do', toString: 'In Progress' }
          ]
        }
      ]
    };

    const searchIssues = async () => mockIssues;
    const getIssueChangelog = async () => mockChangelog;

    const result = collectAndCapture(db, {
      searchIssuesFn: searchIssues,
      getIssueChangelogFn: getIssueChangelog,
      projects: ['ENG', 'ENGSUP'],
      accountIds: ['jira-001'],
      sinceDays: 1,
    });

    // collectAndCapture returns a promise
    result.then(({ captured, skipped }) => {
      assert.strictEqual(captured, 1, 'should capture 1 activity');

      // Verify raw_message was inserted
      const msgs = db.prepare("SELECT * FROM raw_messages WHERE source = 'jira'").all();
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].thread_id, 'ENG-10');
      assert.strictEqual(msgs[0].author_id, entity.id, 'should resolve author via identity_map');
      assert.ok(msgs[0].content.includes('status'), 'content should include change type');

      console.log('PASS: collectAndCapture processes issues into raw_messages');

      db.close();
      cleanup(p);
    }).catch(err => {
      db.close();
      cleanup(p);
      throw err;
    });
  } catch (err) {
    db.close();
    cleanup(p);
    throw err;
  }
}

// --- Test: collectAndCapture with DRY_RUN skips DB writes ---
{
  const { db, path: p } = tmpDb();
  try {
    const mockIssues = [
      {
        key: 'ENG-20',
        fields: {
          summary: 'Dry run test',
          status: { name: 'Open' },
          assignee: { displayName: 'Someone', accountId: 'jira-999' },
          updated: '2026-03-09T10:00:00.000+0000',
          issuetype: { name: 'Bug' },
          priority: { name: 'High' },
          created: '2026-03-08T09:00:00.000+0000',
        }
      }
    ];

    const mockChangelog = {
      values: [
        {
          author: { displayName: 'Someone', accountId: 'jira-999' },
          created: '2026-03-09T10:00:00.000+0000',
          items: [
            { field: 'status', fromString: 'Open', toString: 'In Progress' }
          ]
        }
      ]
    };

    collectAndCapture(db, {
      searchIssuesFn: async () => mockIssues,
      getIssueChangelogFn: async () => mockChangelog,
      projects: ['ENG'],
      accountIds: ['jira-999'],
      sinceDays: 1,
      dryRun: true,
    }).then(({ captured, skipped }) => {
      assert.strictEqual(captured, 0, 'dry run should capture 0');
      assert.strictEqual(skipped, 1, 'dry run should skip 1');

      const msgs = db.prepare("SELECT * FROM raw_messages WHERE source = 'jira'").all();
      assert.strictEqual(msgs.length, 0, 'dry run should not write to DB');

      console.log('PASS: collectAndCapture with dryRun skips DB writes');

      db.close();
      cleanup(p);
    }).catch(err => {
      db.close();
      cleanup(p);
      throw err;
    });
  } catch (err) {
    db.close();
    cleanup(p);
    throw err;
  }
}

// --- Test: collectAndCapture filters changes to known team members only ---
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Jane Doe' });
    kg.addIdentity(db, { entityId: entity.id, source: 'jira', externalId: 'jira-001', displayName: 'Jane Doe' });

    const mockIssues = [
      {
        key: 'ENG-30',
        fields: {
          summary: 'Mixed team test',
          status: { name: 'Done' },
          assignee: { displayName: 'Outsider', accountId: 'jira-ext-1' },
          updated: '2026-03-09T10:00:00.000+0000',
          issuetype: { name: 'Task' },
          priority: { name: 'Low' },
          created: '2026-03-08T09:00:00.000+0000',
        }
      }
    ];

    // Changelog has changes by both a team member and an outsider
    const mockChangelog = {
      values: [
        {
          author: { displayName: 'Jane Doe', accountId: 'jira-001' },
          created: '2026-03-09T09:00:00.000+0000',
          items: [
            { field: 'status', fromString: 'To Do', toString: 'In Progress' }
          ]
        },
        {
          author: { displayName: 'Outsider', accountId: 'jira-ext-1' },
          created: '2026-03-09T10:00:00.000+0000',
          items: [
            { field: 'status', fromString: 'In Progress', toString: 'Done' }
          ]
        }
      ]
    };

    collectAndCapture(db, {
      searchIssuesFn: async () => mockIssues,
      getIssueChangelogFn: async () => mockChangelog,
      projects: ['ENG'],
      accountIds: ['jira-001'],
      sinceDays: 1,
    }).then(({ captured }) => {
      assert.strictEqual(captured, 1, 'should only capture changes by team members');

      const msgs = db.prepare("SELECT * FROM raw_messages WHERE source = 'jira'").all();
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].author_id, entity.id);

      console.log('PASS: collectAndCapture filters changes to known team members only');

      db.close();
      cleanup(p);
    }).catch(err => {
      db.close();
      cleanup(p);
      throw err;
    });
  } catch (err) {
    db.close();
    cleanup(p);
    throw err;
  }
}

// Use a small delay to let async tests finish before final message
setTimeout(() => {
  console.log('\nAll jira-activity-collector tests passed.');
}, 500);
