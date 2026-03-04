'use strict';

const kg = require('./knowledge-graph');
const claudiaDb = require('../claudia-db');

// Reference data — no emails or Slack IDs (gitleaks).
// Identity mapping comes from monitored_people and config at runtime.
const TEAMS = [
  'Corporate Systems Engineering',
  'Desktop Support',
  'Security',
];

const PEOPLE = [
  { name: 'Gandalf Grey', team: 'Corporate Systems Engineering' },
  { name: 'Faramir Guard', team: 'Corporate Systems Engineering' },
  { name: 'Marissa Chen', team: 'Corporate Systems Engineering' },
  { name: 'Travis Odom', team: 'Desktop Support' },
  { name: 'Deshawn Park', team: 'Desktop Support' },
  { name: 'Aaliyah Foster', team: 'Security' },
  { name: 'Jordan Reeves', team: 'Security' },
];

const VENDORS = [
  'Okta',
  'Salesforce',
  'ServiceNow',
  'Zscaler',
  'CrowdStrike',
];

function findOrCreateEntity(db, entityType, canonicalName) {
  const existing = db.prepare(
    'SELECT * FROM entities WHERE entity_type = ? AND canonical_name = ?'
  ).get(entityType, canonicalName);
  if (existing) return existing;
  return kg.createEntity(db, { entityType, canonicalName });
}

function seedAll(db, mainDb) {
  // 1. Create teams
  const teamEntities = {};
  for (const teamName of TEAMS) {
    teamEntities[teamName] = findOrCreateEntity(db, 'team', teamName);
  }

  // 2. Create people and link to teams
  for (const person of PEOPLE) {
    const personEntity = findOrCreateEntity(db, 'person', person.name);
    const teamEntity = teamEntities[person.team];
    if (teamEntity) {
      claudiaDb.link(mainDb, {
        sourceType: 'person',
        sourceId: personEntity.id,
        targetType: 'team',
        targetId: teamEntity.id,
        relationship: 'member_of',
      });
    }
  }

  // 3. Create vendors
  for (const vendorName of VENDORS) {
    findOrCreateEntity(db, 'vendor', vendorName);
  }

  // 4. Layered identity seeding from monitored_people
  seedFromMonitoredPeople(db, mainDb);
}

function seedFromMonitoredPeople(db, mainDb) {
  const rows = mainDb.prepare('SELECT * FROM monitored_people').all();

  for (const row of rows) {
    if (!row.name) continue;

    // Find or create the person entity
    const personEntity = findOrCreateEntity(db, 'person', row.name);

    // Map slack_id into identity_map
    if (row.slack_id) {
      kg.addIdentity(db, {
        entityId: personEntity.id,
        source: 'slack',
        externalId: row.slack_id,
        displayName: row.name,
        jiraId: row.jira_id || null,
      });
    }

    // Map email into identity_map
    if (row.email) {
      kg.addIdentity(db, {
        entityId: personEntity.id,
        source: 'email',
        externalId: row.email,
        displayName: row.name,
      });
    }
  }
}

module.exports = { seedAll, seedFromMonitoredPeople, TEAMS, PEOPLE, VENDORS };
