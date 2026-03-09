'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase } = require('./lib/org-memory-db');
const kg = require('./lib/knowledge-graph');
const { buildReport, formatReport } = require('./dw-weekly-report');

function tmpDb() {
  const p = path.join(os.tmpdir(), `test-dw-report-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = initDatabase(p);
  return { db, path: p };
}

function cleanup(dbPath) {
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
}

/**
 * Helper: seed a person with team fact, identities, and raw_messages.
 */
function seedPerson(db, { name, team, slackId, jiraId, messages }) {
  const entity = db.prepare(
    'SELECT * FROM entities WHERE entity_type = ? AND canonical_name = ?'
  ).get('person', name) || kg.createEntity(db, { entityType: 'person', canonicalName: name });

  if (team) {
    kg.upsertFact(db, {
      entityId: entity.id,
      attribute: 'team',
      value: team,
      factType: 'state',
    });
  }

  if (slackId) {
    kg.addIdentity(db, { entityId: entity.id, source: 'slack', externalId: slackId, displayName: name });
  }
  if (jiraId) {
    kg.addIdentity(db, { entityId: entity.id, source: 'jira', externalId: jiraId, displayName: name });
  }

  for (const msg of (messages || [])) {
    kg.insertRawMessage(db, {
      source: msg.source,
      sourceId: msg.sourceId,
      channelId: msg.channelId || null,
      channelName: msg.channelName || null,
      authorId: entity.id,
      authorName: name,
      content: msg.content,
      threadId: msg.threadId || null,
      occurredAt: msg.occurredAt,
    });
  }

  return entity;
}

// --- Test: buildReport groups messages by team and person ---
{
  const { db, path: p } = tmpDb();
  try {
    const now = Math.floor(Date.now() / 1000);

    seedPerson(db, {
      name: 'Kinski Wu',
      team: 'Corporate Systems Engineering',
      slackId: 'U001',
      jiraId: 'jira-001',
      messages: [
        { source: 'slack', sourceId: 'ch1:1001', channelName: 'iops-dw-cse', content: 'Finished UKG lifecycle automation validation', occurredAt: now - 3600 },
        { source: 'jira', sourceId: 'DWDEV-1234:status:' + (now - 7200), channelName: 'DWDEV', content: '[DWDEV-1234] Implement Jamf IAM (In Progress) — status: To Do -> In Progress', threadId: 'DWDEV-1234', occurredAt: now - 7200 },
      ]
    });

    seedPerson(db, {
      name: 'Ken Dominiec',
      team: 'Desktop Support',
      slackId: 'U002',
      messages: [
        { source: 'slack', sourceId: 'ch2:2001', channelName: 'iops-dw-desktop', content: 'Imaging new laptops for Q2 hire class', occurredAt: now - 1800 },
      ]
    });

    const report = buildReport(db, { sinceDays: 7, now });

    // Verify structure
    assert.ok(report, 'report should not be null');
    assert.ok(Array.isArray(report.teams), 'report.teams should be an array');
    assert.strictEqual(report.teams.length, 2, 'should have 2 teams');

    const cse = report.teams.find(t => t.name === 'Corporate Systems Engineering');
    assert.ok(cse, 'should have CSE team');
    assert.strictEqual(cse.members.length, 1);
    assert.strictEqual(cse.members[0].name, 'Kinski Wu');
    assert.strictEqual(cse.members[0].slackMessages.length, 1);
    assert.strictEqual(cse.members[0].jiraMessages.length, 1);

    const desktop = report.teams.find(t => t.name === 'Desktop Support');
    assert.ok(desktop, 'should have Desktop Support team');
    assert.strictEqual(desktop.members.length, 1);
    assert.strictEqual(desktop.members[0].name, 'Ken Dominiec');

    console.log('PASS: buildReport groups messages by team and person');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: formatReport produces expected markdown structure ---
{
  const { db, path: p } = tmpDb();
  try {
    const now = Math.floor(Date.now() / 1000);

    seedPerson(db, {
      name: 'Jane Test',
      team: 'Security',
      slackId: 'U003',
      messages: [
        { source: 'slack', sourceId: 'ch3:3001', channelName: 'security-ops', content: 'Reviewed firewall rules', occurredAt: now - 600 },
      ]
    });

    const report = buildReport(db, { sinceDays: 7, now });
    const md = formatReport(report);

    assert.ok(md.includes('## Security'), 'markdown should include team header');
    assert.ok(md.includes('### Jane Test'), 'markdown should include person header');
    assert.ok(md.includes('Slack activity'), 'markdown should include Slack section');
    assert.ok(md.includes('[security-ops]'), 'markdown should include channel name');
    assert.ok(md.includes('Reviewed firewall rules'), 'markdown should include message content');
    assert.ok(!md.includes('Jira activity'), 'should not include Jira section when no Jira messages');

    console.log('PASS: formatReport produces expected markdown structure');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: buildReport excludes messages older than sinceDays ---
{
  const { db, path: p } = tmpDb();
  try {
    const now = Math.floor(Date.now() / 1000);
    const eightDaysAgo = now - (8 * 24 * 3600);

    seedPerson(db, {
      name: 'Old Data Person',
      team: 'Security',
      messages: [
        { source: 'slack', sourceId: 'old:1', channelName: 'general', content: 'Old message', occurredAt: eightDaysAgo },
        { source: 'slack', sourceId: 'new:1', channelName: 'general', content: 'Recent message', occurredAt: now - 3600 },
      ]
    });

    const report = buildReport(db, { sinceDays: 7, now });
    const member = report.teams[0].members[0];
    assert.strictEqual(member.slackMessages.length, 1, 'should only include recent messages');
    assert.ok(member.slackMessages[0].content.includes('Recent message'));

    console.log('PASS: buildReport excludes messages older than sinceDays');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: buildReport handles person with no team assignment ---
{
  const { db, path: p } = tmpDb();
  try {
    const now = Math.floor(Date.now() / 1000);

    seedPerson(db, {
      name: 'No Team Person',
      team: null, // no team
      messages: [
        { source: 'slack', sourceId: 'nt:1', channelName: 'general', content: 'Floating message', occurredAt: now - 300 },
      ]
    });

    const report = buildReport(db, { sinceDays: 7, now });
    const unassigned = report.teams.find(t => t.name === 'Unassigned');
    assert.ok(unassigned, 'should have an Unassigned team for people without team facts');
    assert.strictEqual(unassigned.members[0].name, 'No Team Person');

    console.log('PASS: buildReport handles person with no team assignment');
  } finally {
    db.close();
    cleanup(p);
  }
}

// --- Test: formatReport with both Slack and Jira activity ---
{
  const { db, path: p } = tmpDb();
  try {
    const now = Math.floor(Date.now() / 1000);

    seedPerson(db, {
      name: 'Both Sources',
      team: 'Corporate Systems Engineering',
      messages: [
        { source: 'slack', sourceId: 'bs:1', channelName: 'iops-dw', content: 'Working on IaC prep', occurredAt: now - 600 },
        { source: 'jira', sourceId: 'DWS-567:status:' + (now - 1200), channelName: 'DWS', content: '[DWS-567] Routine config issue (Done) — status: In Progress -> Done', threadId: 'DWS-567', occurredAt: now - 1200 },
      ]
    });

    const report = buildReport(db, { sinceDays: 7, now });
    const md = formatReport(report);

    assert.ok(md.includes('**Slack activity:**'), 'should have Slack header');
    assert.ok(md.includes('**Jira activity:**'), 'should have Jira header');
    assert.ok(md.includes('[iops-dw]'), 'should include Slack channel');
    assert.ok(md.includes('[DWS-567]'), 'should include Jira issue key');

    console.log('PASS: formatReport with both Slack and Jira activity');
  } finally {
    db.close();
    cleanup(p);
  }
}

console.log('\nAll dw-weekly-report tests passed.');
