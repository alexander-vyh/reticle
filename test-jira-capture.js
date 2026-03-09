'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase } = require('./lib/org-memory-db');
const kg = require('./lib/knowledge-graph');
const { captureJiraActivity } = require('./lib/jira-capture');

function tmpDb() {
  const p = path.join(os.tmpdir(), `test-jira-capture-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = initDatabase(p);
  return { db, path: p };
}

function cleanup(dbPath) {
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
}

// --- Test: basic capture inserts a raw_message ---
{
  const { db, path: p } = tmpDb();
  try {
    const result = captureJiraActivity(db, {
      issueKey: 'DWDEV-42',
      summary: 'Fix the widget',
      status: 'In Progress',
      assigneeAccountId: '5f1234abc',
      assigneeName: 'Jane Doe',
      projectKey: 'DWDEV',
      updatedAt: 1709900000,
      changeType: 'status',
      changeDetail: 'To Do -> In Progress',
    });

    assert.ok(result, 'should return inserted raw_message');
    assert.strictEqual(result.source, 'jira');
    assert.strictEqual(result.source_id, 'DWDEV-42:status:1709900000');
    assert.strictEqual(result.thread_id, 'DWDEV-42');
    assert.strictEqual(result.occurred_at, 1709900000);
    assert.ok(result.content.includes('DWDEV-42'), 'content should include issue key');
    assert.ok(result.content.includes('Fix the widget'), 'content should include summary');
    assert.ok(result.content.includes('status'), 'content should include change type');
    assert.ok(result.content.includes('To Do -> In Progress'), 'content should include change detail');
    console.log('PASS: basic capture inserts a raw_message');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: identity resolution maps assignee to entity ---
{
  const { db, path: p } = tmpDb();
  try {
    const entity = kg.createEntity(db, { entityType: 'person', canonicalName: 'Jane Doe' });
    kg.addIdentity(db, { entityId: entity.id, source: 'jira', externalId: '5f1234abc', displayName: 'Jane Doe' });

    const result = captureJiraActivity(db, {
      issueKey: 'DWDEV-99',
      summary: 'Another task',
      status: 'Done',
      assigneeAccountId: '5f1234abc',
      assigneeName: 'Jane Doe',
      projectKey: 'DWDEV',
      updatedAt: 1709900100,
      changeType: 'resolution',
      changeDetail: 'Fixed',
    });

    assert.strictEqual(result.author_id, entity.id, 'author_id should resolve to entity');
    assert.strictEqual(result.author_name, 'Jane Doe');
    console.log('PASS: identity resolution maps assignee to entity');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: unknown assignee yields null author_id ---
{
  const { db, path: p } = tmpDb();
  try {
    const result = captureJiraActivity(db, {
      issueKey: 'DWS-10',
      summary: 'Unassigned task',
      status: 'Open',
      assigneeAccountId: 'unknown-id',
      assigneeName: 'Unknown Person',
      projectKey: 'DWS',
      updatedAt: 1709900200,
      changeType: 'created',
      changeDetail: null,
    });

    assert.strictEqual(result.author_id, null, 'unknown assignee should yield null author_id');
    assert.strictEqual(result.author_name, 'Unknown Person');
    console.log('PASS: unknown assignee yields null author_id');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: deduplication — same sourceId is idempotent ---
{
  const { db, path: p } = tmpDb();
  try {
    const activity = {
      issueKey: 'DWDEV-42',
      summary: 'Fix the widget',
      status: 'In Progress',
      assigneeAccountId: '5f1234abc',
      assigneeName: 'Jane Doe',
      projectKey: 'DWDEV',
      updatedAt: 1709900000,
      changeType: 'status',
      changeDetail: 'To Do -> In Progress',
    };

    const first = captureJiraActivity(db, activity);
    const second = captureJiraActivity(db, activity);

    assert.strictEqual(first.id, second.id, 'duplicate should return same record');

    const count = db.prepare("SELECT COUNT(*) as cnt FROM raw_messages WHERE source = 'jira'").get().cnt;
    assert.strictEqual(count, 1, 'should only have one row');
    console.log('PASS: deduplication — same sourceId is idempotent');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: channelId uses projectKey ---
{
  const { db, path: p } = tmpDb();
  try {
    const result = captureJiraActivity(db, {
      issueKey: 'DWS-5',
      summary: 'Project channel test',
      status: 'Open',
      assigneeAccountId: null,
      assigneeName: null,
      projectKey: 'DWS',
      updatedAt: 1709900300,
      changeType: 'created',
      changeDetail: null,
    });

    assert.strictEqual(result.channel_id, 'DWS', 'channel_id should be projectKey');
    assert.strictEqual(result.channel_name, 'DWS', 'channel_name should be projectKey');
    assert.strictEqual(result.author_name, null, 'null assignee should yield null author_name');
    console.log('PASS: channelId uses projectKey');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: content formatting with null changeDetail ---
{
  const { db, path: p } = tmpDb();
  try {
    const result = captureJiraActivity(db, {
      issueKey: 'DWDEV-1',
      summary: 'New ticket',
      status: 'Open',
      assigneeAccountId: null,
      assigneeName: null,
      projectKey: 'DWDEV',
      updatedAt: 1709900400,
      changeType: 'created',
      changeDetail: null,
    });

    assert.ok(result.content.includes('created'), 'content should include change type');
    assert.ok(!result.content.includes('null'), 'content should not include literal "null"');
    console.log('PASS: content formatting with null changeDetail');
  } finally {
    db.close();
    cleanup(p);
  }
}

console.log('\nAll jira-capture tests passed.');
