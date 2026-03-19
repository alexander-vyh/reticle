'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const TEST_OM_PATH = path.join(__dirname, 'test-seed-om.db');
const TEST_MAIN_PATH = path.join(__dirname, 'test-seed-reticle.db');
process.env.ORG_MEMORY_DB_PATH = TEST_OM_PATH;
process.env.RETICLE_DB_PATH = TEST_MAIN_PATH;

function cleanup() {
  for (const p of [TEST_OM_PATH, TEST_MAIN_PATH]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(p + suffix); } catch {}
    }
  }
}

function freshDbs() {
  cleanup();
  // Clear require cache for both modules
  delete require.cache[require.resolve('./lib/org-memory-db')];
  delete require.cache[require.resolve('./reticle-db')];
  delete require.cache[require.resolve('./lib/seed-data')];
  delete require.cache[require.resolve('./lib/knowledge-graph')];
  const orgDb = require('./lib/org-memory-db');
  const reticleDb = require('./reticle-db');
  return {
    db: orgDb.initDatabase(TEST_OM_PATH),
    mainDb: reticleDb.initDatabase()
  };
}

function testSeedCreatesTeams() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedAll(db, mainDb);

  const teams = db.prepare("SELECT * FROM entities WHERE entity_type = 'team'").all();
  assert.strictEqual(teams.length, 4);
  assert.ok(teams.find(t => t.canonical_name === 'Corporate Systems Engineering'));
  assert.ok(teams.find(t => t.canonical_name === 'Desktop Support'));
  assert.ok(teams.find(t => t.canonical_name === 'Security'));
  assert.ok(teams.find(t => t.canonical_name === 'Platform & Endpoint Security'));
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed creates teams');
}

function testSeedCreatesPeople() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedAll(db, mainDb);

  const people = db.prepare("SELECT * FROM entities WHERE entity_type = 'person'").all();
  assert.ok(people.length >= 7, `Expected at least 7 people, got ${people.length}`);
  assert.ok(people.find(p => p.canonical_name === 'Gandalf Grey'));
  assert.ok(people.find(p => p.canonical_name === 'Aragorn King'));
  assert.ok(people.find(p => p.canonical_name === 'Legolas Wood'));
  assert.ok(people.find(p => p.canonical_name === 'Eowyn Rider'));
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed creates people');
}

function testSeedLinksPeopleToTeams() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedAll(db, mainDb);

  const kinski = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Gandalf Grey'").get();
  const cse = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Corporate Systems Engineering'").get();

  const link = mainDb.prepare(
    "SELECT * FROM entity_links WHERE source_type = 'person' AND source_id = ? AND target_type = 'team' AND target_id = ? AND relationship = 'member_of'"
  ).get(kinski.id, cse.id);
  assert.ok(link, 'Gandalf Grey should be member_of Corporate Systems Engineering');
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed links people to teams');
}

function testSeedCreatesVendors() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedAll(db, mainDb);

  const vendors = db.prepare("SELECT * FROM entities WHERE entity_type = 'vendor'").all();
  assert.ok(vendors.length >= 5, `Expected at least 5 vendors, got ${vendors.length}`);
  assert.ok(vendors.find(v => v.canonical_name === 'Okta'));
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed creates vendors');
}

function testSeedIsIdempotent() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedAll(db, mainDb);
  seedData.seedAll(db, mainDb); // Run twice

  const people = db.prepare("SELECT * FROM entities WHERE entity_type = 'person'").all();
  const kinski = people.filter(p => p.canonical_name === 'Gandalf Grey');
  assert.strictEqual(kinski.length, 1, 'Should not duplicate Gandalf Grey');

  const teams = db.prepare("SELECT * FROM entities WHERE entity_type = 'team'").all();
  assert.strictEqual(teams.length, 4, 'Should not duplicate teams');

  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed is idempotent');
}

function testSeedFromMonitoredPeople() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');

  // Simulate existing monitored_people data (actual schema: email NOT NULL, slack_id column)
  mainDb.prepare(`INSERT INTO monitored_people (id, email, name, slack_id, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('mp-1', 'testperson@example.com', 'Test Person', 'U_TEST_123',
    Math.floor(Date.now() / 1000));

  seedData.seedFromMonitoredPeople(db, mainDb);

  // Should have created entity and identity_map entry
  const identity = db.prepare(
    "SELECT * FROM identity_map WHERE source = 'slack' AND external_id = 'U_TEST_123'"
  ).get();
  assert.ok(identity, 'Should create identity_map entry from monitored_people');

  // Should have created a person entity
  const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(identity.entity_id);
  assert.ok(entity, 'Should create person entity');
  assert.strictEqual(entity.entity_type, 'person');
  assert.strictEqual(entity.canonical_name, 'Test Person');

  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed from monitored_people');
}

function testSeedFromMonitoredPeopleWithJiraId() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');

  mainDb.prepare(`INSERT INTO monitored_people (id, email, name, slack_id, jira_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('mp-2', 'jira@example.com', 'Jira Person', 'U_JIRA_456', 'jira-account-789',
    Math.floor(Date.now() / 1000));

  seedData.seedFromMonitoredPeople(db, mainDb);

  const identity = db.prepare(
    "SELECT * FROM identity_map WHERE source = 'slack' AND external_id = 'U_JIRA_456'"
  ).get();
  assert.ok(identity);
  assert.strictEqual(identity.jira_id, 'jira-account-789', 'Should copy jira_id from monitored_people');

  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed from monitored_people with jira_id');
}

function testSeedFromMonitoredPeopleIsIdempotent() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');

  mainDb.prepare(`INSERT INTO monitored_people (id, email, name, slack_id, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('mp-3', 'repeat@example.com', 'Repeat Person', 'U_REPEAT',
    Math.floor(Date.now() / 1000));

  seedData.seedFromMonitoredPeople(db, mainDb);
  seedData.seedFromMonitoredPeople(db, mainDb); // Run twice

  const identities = db.prepare(
    "SELECT * FROM identity_map WHERE source = 'slack' AND external_id = 'U_REPEAT'"
  ).all();
  assert.strictEqual(identities.length, 1, 'Should not duplicate identity_map entries');

  const people = db.prepare("SELECT * FROM entities WHERE canonical_name = 'Repeat Person'").all();
  assert.strictEqual(people.length, 1, 'Should not duplicate person entities');

  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed from monitored_people is idempotent');
}

// --- seedDwTeam tests ---

const DW_TEAM_INPUT = [
  { name: 'Gandalf Grey', team: 'CSE', slackId: 'U_KW_001', jiraAccountId: 'jira-kw-001' },
  { name: 'Aragorn King', team: 'CSE', slackId: 'U_BP_002', jiraAccountId: 'jira-bp-002' },
  { name: 'Samwise Brown', team: 'CSE', slackId: 'U_DR_003', jiraAccountId: 'jira-dr-003' },
  { name: 'Legolas Wood', team: 'PIE', slackId: 'U_GS_004', jiraAccountId: 'jira-gs-004' },
  { name: "Gimli 'G' Stone", team: 'PIE', slackId: 'U_DS_005', jiraAccountId: 'jira-ds-005' },
  { name: 'Eowyn Rider', team: 'Desktop Support', slackId: 'U_KD_006', jiraAccountId: 'jira-kd-006' },
  { name: 'Faramir Guard', team: 'Desktop Support', slackId: 'U_KB_007', jiraAccountId: 'jira-kb-007' },
];

function testSeedDwTeamCreatesEntities() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedDwTeam(db, DW_TEAM_INPUT);

  const people = db.prepare("SELECT * FROM entities WHERE entity_type = 'person'").all();
  assert.strictEqual(people.length, 7, `Expected 7 people, got ${people.length}`);
  assert.ok(people.find(p => p.canonical_name === 'Gandalf Grey'));
  assert.ok(people.find(p => p.canonical_name === 'Aragorn King'));
  assert.ok(people.find(p => p.canonical_name === "Gimli 'G' Stone"));
  assert.ok(people.find(p => p.canonical_name === 'Faramir Guard'));
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seedDwTeam creates person entities');
}

function testSeedDwTeamCreatesSlackIdentities() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedDwTeam(db, DW_TEAM_INPUT);

  const kg = require('./lib/knowledge-graph');
  // Verify Slack identity resolution works
  const entityId = kg.resolveIdentity(db, 'slack', 'U_KW_001');
  assert.ok(entityId, 'Should resolve Gandalf Grey by Slack ID');

  const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
  assert.strictEqual(entity.canonical_name, 'Gandalf Grey');
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seedDwTeam creates Slack identities');
}

function testSeedDwTeamCreatesJiraIdentities() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedDwTeam(db, DW_TEAM_INPUT);

  const kg = require('./lib/knowledge-graph');
  const entityId = kg.resolveIdentity(db, 'jira', 'jira-gs-004');
  assert.ok(entityId, 'Should resolve Legolas Wood by Jira account ID');

  const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
  assert.strictEqual(entity.canonical_name, 'Legolas Wood');
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seedDwTeam creates Jira identities');
}

function testSeedDwTeamStoresTeamAsFact() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedDwTeam(db, DW_TEAM_INPUT);

  const kg = require('./lib/knowledge-graph');
  const entityId = kg.resolveIdentity(db, 'slack', 'U_GS_004');
  const state = kg.getCurrentState(db, entityId);
  assert.strictEqual(state.team, 'PIE', 'Geoffrey should have team=PIE');
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seedDwTeam stores team as state fact');
}

function testSeedDwTeamIsIdempotent() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedDwTeam(db, DW_TEAM_INPUT);
  seedData.seedDwTeam(db, DW_TEAM_INPUT); // Run twice

  const people = db.prepare("SELECT * FROM entities WHERE entity_type = 'person'").all();
  assert.strictEqual(people.length, 7, 'Should not duplicate people');

  const identities = db.prepare("SELECT * FROM identity_map WHERE source = 'slack'").all();
  assert.strictEqual(identities.length, 7, 'Should not duplicate Slack identities');

  const jiraIdentities = db.prepare("SELECT * FROM identity_map WHERE source = 'jira'").all();
  assert.strictEqual(jiraIdentities.length, 7, 'Should not duplicate Jira identities');

  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seedDwTeam is idempotent');
}

function testSeedDwTeamHandlesMissingOptionalIds() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  // Seed with a member that has no Jira ID
  seedData.seedDwTeam(db, [
    { name: 'Partial Person', team: 'CSE', slackId: 'U_PP_001' },
  ]);

  const kg = require('./lib/knowledge-graph');
  const entityId = kg.resolveIdentity(db, 'slack', 'U_PP_001');
  assert.ok(entityId, 'Should still create entity with Slack ID');

  const jiraId = kg.resolveIdentity(db, 'jira', undefined);
  assert.strictEqual(jiraId, null, 'Should not create Jira identity when missing');

  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seedDwTeam handles missing optional IDs');
}

// Run all tests
console.log('seed-data tests:');
testSeedCreatesTeams();
testSeedCreatesPeople();
testSeedLinksPeopleToTeams();
testSeedCreatesVendors();
testSeedIsIdempotent();
testSeedFromMonitoredPeople();
testSeedFromMonitoredPeopleWithJiraId();
testSeedFromMonitoredPeopleIsIdempotent();
testSeedDwTeamCreatesEntities();
testSeedDwTeamCreatesSlackIdentities();
testSeedDwTeamCreatesJiraIdentities();
testSeedDwTeamStoresTeamAsFact();
testSeedDwTeamIsIdempotent();
testSeedDwTeamHandlesMissingOptionalIds();
console.log('All seed-data tests passed.');
