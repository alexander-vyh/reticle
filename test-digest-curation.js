'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================================
// UNIT TESTS — digest-curation: buildTeamsFromDB + curateForWeeklySummary
// ============================================================================

function setupTestDb() {
  const tmpPath = path.join(os.tmpdir(), `reticle-curation-test-${Date.now()}.db`);
  process.env.RETICLE_DB_PATH = tmpPath;

  // Clear module cache to pick up new DB path
  for (const mod of ['./reticle-db', './lib/people-store', './lib/digest-curation']) {
    try {
      const resolved = require.resolve(mod);
      delete require.cache[resolved];
    } catch {}
  }

  const reticleDb = require('./reticle-db');
  const db = reticleDb.initDatabase();

  return { db, reticleDb, tmpPath };
}

function cleanupDb(tmpPath) {
  try { fs.unlinkSync(tmpPath); } catch {}
  try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
  try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
}

// --- Test: buildTeamsFromDB returns empty object when no team members exist ---
function testBuildTeamsEmpty() {
  const { db, tmpPath } = setupTestDb();
  try {
    // Clear module cache so digest-curation loads fresh
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { buildTeamsFromDB } = require('./lib/digest-curation');

    const teams = buildTeamsFromDB(db);
    assert.deepStrictEqual(teams, {}, 'Should return empty object when no team members');
    console.log('  PASS: buildTeamsFromDB returns empty when no team members');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: buildTeamsFromDB groups members by team ---
function testBuildTeamsGroupsByTeam() {
  const { db, tmpPath } = setupTestDb();
  try {
    const peopleStore = require('./lib/people-store');
    // Add team members
    peopleStore.addPerson(db, { email: 'alice@example.com', name: 'Alice Smith', role: 'peer', team: 'cse' });
    peopleStore.addPerson(db, { email: 'bob@example.com', name: 'Bob Jones', role: 'peer', team: 'cse' });
    peopleStore.addPerson(db, { email: 'carol@example.com', name: 'Carol White', role: 'peer', team: 'desktop' });
    // Update slack IDs
    peopleStore.updateSlackId(db, 'alice@example.com', 'U001');
    peopleStore.updateSlackId(db, 'bob@example.com', 'U002');
    peopleStore.updateSlackId(db, 'carol@example.com', 'U003');

    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { buildTeamsFromDB } = require('./lib/digest-curation');
    const teams = buildTeamsFromDB(db);

    // Should have two teams
    assert.ok(teams.cse, 'Should have cse team');
    assert.ok(teams.desktop, 'Should have desktop team');
    assert.strictEqual(Object.keys(teams).length, 2, 'Should have exactly 2 teams');

    // CSE team should have 2 members
    assert.strictEqual(teams.cse.members.length, 2);
    assert.ok(teams.cse.members.includes('Alice Smith'));
    assert.ok(teams.cse.members.includes('Bob Jones'));
    assert.strictEqual(teams.cse.slackIds.length, 2);
    assert.ok(teams.cse.slackIds.includes('U001'));
    assert.ok(teams.cse.slackIds.includes('U002'));
    assert.strictEqual(teams.cse.emails.length, 2);
    assert.ok(teams.cse.emails.includes('alice@example.com'));
    assert.ok(teams.cse.emails.includes('bob@example.com'));

    // Desktop team should have 1 member
    assert.strictEqual(teams.desktop.members.length, 1);
    assert.strictEqual(teams.desktop.members[0], 'Carol White');
    assert.strictEqual(teams.desktop.slackIds[0], 'U003');
    assert.strictEqual(teams.desktop.emails[0], 'carol@example.com');

    console.log('  PASS: buildTeamsFromDB groups members by team');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: buildTeamsFromDB uses display names from TEAM_DISPLAY_NAMES ---
function testBuildTeamsDisplayNames() {
  const { db, tmpPath } = setupTestDb();
  try {
    const peopleStore = require('./lib/people-store');
    peopleStore.addPerson(db, { email: 'alice@example.com', name: 'Alice', role: 'peer', team: 'cse' });
    peopleStore.addPerson(db, { email: 'bob@example.com', name: 'Bob', role: 'peer', team: 'security' });

    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { buildTeamsFromDB, TEAM_DISPLAY_NAMES } = require('./lib/digest-curation');
    const teams = buildTeamsFromDB(db);

    // Known teams should have display names from the constant map
    assert.strictEqual(teams.cse.name, TEAM_DISPLAY_NAMES.cse);
    assert.strictEqual(teams.security.name, TEAM_DISPLAY_NAMES.security);

    console.log('  PASS: buildTeamsFromDB uses display names from constant map');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: buildTeamsFromDB handles unknown team keys with title-case fallback ---
function testBuildTeamsUnknownTeamKey() {
  const { db, tmpPath } = setupTestDb();
  try {
    const peopleStore = require('./lib/people-store');
    peopleStore.addPerson(db, { email: 'dave@example.com', name: 'Dave', role: 'peer', team: 'infrastructure' });

    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { buildTeamsFromDB } = require('./lib/digest-curation');
    const teams = buildTeamsFromDB(db);

    assert.ok(teams.infrastructure, 'Should include unknown team keys');
    // Fallback display name should be title-cased from the key
    assert.strictEqual(teams.infrastructure.name, 'Infrastructure');
    assert.strictEqual(teams.infrastructure.members[0], 'Dave');

    console.log('  PASS: buildTeamsFromDB handles unknown team key with fallback name');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: buildTeamsFromDB skips members without names (uses email as fallback) ---
function testBuildTeamsMemberWithoutName() {
  const { db, tmpPath } = setupTestDb();
  try {
    const peopleStore = require('./lib/people-store');
    peopleStore.addPerson(db, { email: 'noname@example.com', role: 'peer', team: 'cse' });

    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { buildTeamsFromDB } = require('./lib/digest-curation');
    const teams = buildTeamsFromDB(db);

    assert.ok(teams.cse);
    // Should use email as fallback for name
    assert.strictEqual(teams.cse.members[0], 'noname@example.com');
    assert.strictEqual(teams.cse.emails[0], 'noname@example.com');

    console.log('  PASS: buildTeamsFromDB uses email as fallback when name is null');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: buildTeamsFromDB excludes members without slack_id from slackIds ---
function testBuildTeamsNullSlackId() {
  const { db, tmpPath } = setupTestDb();
  try {
    const peopleStore = require('./lib/people-store');
    peopleStore.addPerson(db, { email: 'noslack@example.com', name: 'No Slack', role: 'peer', team: 'desktop' });

    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { buildTeamsFromDB } = require('./lib/digest-curation');
    const teams = buildTeamsFromDB(db);

    assert.ok(teams.desktop);
    assert.strictEqual(teams.desktop.members.length, 1);
    assert.strictEqual(teams.desktop.slackIds.length, 0, 'Null slack IDs should be excluded');
    assert.strictEqual(teams.desktop.emails.length, 1);

    console.log('  PASS: buildTeamsFromDB excludes null slack IDs');
  } finally {
    db.close();
    cleanupDb(tmpPath);
  }
}

// --- Test: curateForWeeklySummary accepts teams parameter ---
function testCurateForWeeklySummaryAcceptsTeams() {
  try {
    // Clear cache
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { curateForWeeklySummary } = require('./lib/digest-curation');

    const teams = {
      cse: {
        name: 'Corporate Systems Engineering',
        members: ['Alice Smith'],
        slackIds: ['U001'],
        emails: ['alice@example.com']
      }
    };

    // Should not throw when teams parameter is provided
    const result = curateForWeeklySummary([], teams);
    assert.ok(result, 'Should return a result');
    assert.ok(result.sections !== undefined || result.curated !== undefined || Array.isArray(result),
      'Should return curated data structure');

    console.log('  PASS: curateForWeeklySummary accepts teams parameter');
  } catch (err) {
    // If the module doesn't exist yet, test should fail (RED phase)
    throw err;
  }
}

// --- Test: TOPIC_PATTERNS and TOPIC_TEAM_OVERRIDES are still exported ---
function testConstantsExported() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const curation = require('./lib/digest-curation');

    assert.ok(curation.TOPIC_PATTERNS !== undefined, 'TOPIC_PATTERNS should be exported');
    assert.ok(curation.TOPIC_TEAM_OVERRIDES !== undefined, 'TOPIC_TEAM_OVERRIDES should be exported');
    assert.ok(curation.TEAM_DISPLAY_NAMES !== undefined, 'TEAM_DISPLAY_NAMES should be exported');

    console.log('  PASS: TOPIC_PATTERNS, TOPIC_TEAM_OVERRIDES, TEAM_DISPLAY_NAMES are exported');
  } catch (err) {
    throw err;
  }
}

// --- Run all tests ---

console.log('digest curation tests:');

testBuildTeamsEmpty();
testBuildTeamsGroupsByTeam();
testBuildTeamsDisplayNames();
testBuildTeamsUnknownTeamKey();
testBuildTeamsMemberWithoutName();
testBuildTeamsNullSlackId();
testCurateForWeeklySummaryAcceptsTeams();
testConstantsExported();

console.log('All digest curation tests passed');
process.exit(0);
