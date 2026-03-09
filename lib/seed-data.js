'use strict';

const kg = require('./knowledge-graph');
const reticleDb = require('../reticle-db');

// Reference data — no emails or Slack IDs (gitleaks).
// Identity mapping comes from monitored_people and config at runtime.
const TEAMS = [
  'Corporate Systems Engineering',
  'Desktop Support',
  'Security',
  'Platform & Endpoint Security',
];

const PEOPLE = [
  { name: 'Gandalf Grey', team: 'Corporate Systems Engineering' },
  { name: 'Aragorn King', team: 'Corporate Systems Engineering' },
  { name: 'Samwise Brown', team: 'Corporate Systems Engineering' },
  { name: 'Legolas Wood', team: 'Platform & Endpoint Security' },
  { name: "Gimli 'G' Stone", team: 'Platform & Endpoint Security' },
  { name: 'Eowyn Rider', team: 'Desktop Support' },
  { name: 'Faramir Guard', team: 'Desktop Support' },
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
      reticleDb.link(mainDb, {
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

/**
 * Seed the DW team into org-memory. Pure function — no API calls.
 * @param {import('better-sqlite3').Database} db - org-memory database
 * @param {Array<{name: string, team: string, slackId?: string, jiraAccountId?: string}>} teamMembers
 */
function seedDwTeam(db, teamMembers) {
  for (const member of teamMembers) {
    const entity = findOrCreateEntity(db, 'person', member.name);

    // Store team assignment as a state fact
    if (member.team) {
      kg.upsertFact(db, {
        entityId: entity.id,
        attribute: 'team',
        value: member.team,
        factType: 'state',
      });
    }

    // Add Slack identity
    if (member.slackId) {
      kg.addIdentity(db, {
        entityId: entity.id,
        source: 'slack',
        externalId: member.slackId,
        displayName: member.name,
      });
    }

    // Add Jira identity
    if (member.jiraAccountId) {
      kg.addIdentity(db, {
        entityId: entity.id,
        source: 'jira',
        externalId: member.jiraAccountId,
        displayName: member.name,
      });
    }
  }
}

module.exports = { seedAll, seedFromMonitoredPeople, seedDwTeam, TEAMS, PEOPLE, VENDORS };

// --- CLI entry point ---
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--seed-dw')) {
    (async () => {
      const config = require('./config');
      const slackReader = require('./slack-reader');
      const jiraReader = require('./jira-reader');
      const orgMemoryDb = require('./org-memory-db');

      const db = orgMemoryDb.getDatabase();
      const teamEmails = config.dwTeamEmails || [];
      if (teamEmails.length === 0) {
        console.error('No dwTeamEmails found in config. Add to team.json: { "dwTeamEmails": [{"name": "...", "team": "...", "email": "..."}] }');
        process.exit(1);
      }

      console.log(`Resolving identities for ${teamEmails.length} DW team members...`);
      const resolved = [];
      for (const member of teamEmails) {
        const entry = { name: member.name, team: member.team };
        try {
          let slackId = await slackReader.lookupUserByEmail(member.email);
          if (!slackId) slackId = await slackReader.lookupUserByName(member.name);
          if (slackId) entry.slackId = slackId;
          else console.warn(`  WARN: No Slack ID found for ${member.name} (${member.email})`);
        } catch (err) {
          console.warn(`  WARN: Slack lookup failed for ${member.name}: ${err.message}`);
        }
        try {
          const jiraUser = await jiraReader.lookupUserByEmail(member.email);
          if (jiraUser?.accountId) entry.jiraAccountId = jiraUser.accountId;
          else console.warn(`  WARN: No Jira account found for ${member.name} (${member.email})`);
        } catch (err) {
          console.warn(`  WARN: Jira lookup failed for ${member.name}: ${err.message}`);
        }
        resolved.push(entry);
        console.log(`  ${member.name}: slack=${entry.slackId || 'MISSING'}, jira=${entry.jiraAccountId || 'MISSING'}`);
      }

      seedDwTeam(db, resolved);
      console.log(`Seeded ${resolved.length} DW team members into org-memory.`);
    })().catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  } else {
    console.log('Usage: node lib/seed-data.js --seed-dw');
    console.log('  Resolves Slack/Jira IDs and seeds DW team into org-memory.');
  }
}
