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
  assert.strictEqual(teams.length, 3);
  assert.ok(teams.find(t => t.canonical_name === 'Corporate Systems Engineering'));
  assert.ok(teams.find(t => t.canonical_name === 'Desktop Support'));
  assert.ok(teams.find(t => t.canonical_name === 'Security'));
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed creates teams');
}

function testSeedCreatesPeople() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedAll(db, mainDb);

  const people = db.prepare("SELECT * FROM entities WHERE entity_type = 'person'").all();
  assert.ok(people.length >= 7, `Expected at least 7 people, got ${people.length}`);
  assert.ok(people.find(p => p.canonical_name === 'Kinski Wu'));
  assert.ok(people.find(p => p.canonical_name === 'Keshon Bowman'));
  db.close(); mainDb.close(); cleanup();
  console.log('  PASS: seed creates people');
}

function testSeedLinksPeopleToTeams() {
  const { db, mainDb } = freshDbs();
  const seedData = require('./lib/seed-data');
  seedData.seedAll(db, mainDb);

  const kinski = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Kinski Wu'").get();
  const cse = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Corporate Systems Engineering'").get();

  const link = mainDb.prepare(
    "SELECT * FROM entity_links WHERE source_type = 'person' AND source_id = ? AND target_type = 'team' AND target_id = ? AND relationship = 'member_of'"
  ).get(kinski.id, cse.id);
  assert.ok(link, 'Kinski should be member_of CSE');
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
  const kinski = people.filter(p => p.canonical_name === 'Kinski Wu');
  assert.strictEqual(kinski.length, 1, 'Should not duplicate Kinski Wu');

  const teams = db.prepare("SELECT * FROM entities WHERE entity_type = 'team'").all();
  assert.strictEqual(teams.length, 3, 'Should not duplicate teams');

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
console.log('All seed-data tests passed.');
