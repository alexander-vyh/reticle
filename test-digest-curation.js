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

// --- Test: buildTeamsFromDB handles unknown team keys with raw DB name fallback ---
function testBuildTeamsUnknownTeamKey() {
  const { db, tmpPath } = setupTestDb();
  try {
    const peopleStore = require('./lib/people-store');
    peopleStore.addPerson(db, { email: 'dave@example.com', name: 'Dave', role: 'peer', team: 'infrastructure' });

    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { buildTeamsFromDB } = require('./lib/digest-curation');
    const teams = buildTeamsFromDB(db);

    assert.ok(teams.infrastructure, 'Should include unknown team keys');
    // Fallback display name uses raw DB value when no slug mapping exists
    assert.strictEqual(teams.infrastructure.name, 'infrastructure');
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

// --- Test: isSecondaryKTLO catches reconnect/restore patterns ---
function testIsSecondaryKTLOReconnect() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { isSecondaryKTLO } = require('./lib/digest-curation');

    // Should catch reconnection patterns
    assert.strictEqual(isSecondaryKTLO({ summary: 'Reconnect Trelica SSO integration after outage' }), true,
      'Should catch reconnect pattern');
    assert.strictEqual(isSecondaryKTLO({ summary: 'Restore backup process for production database' }), true,
      'Should catch restore pattern');
    assert.strictEqual(isSecondaryKTLO({ observation: 'Re-enable automated sync after credential rotation' }), true,
      'Should catch re-enable pattern');
    assert.strictEqual(isSecondaryKTLO({ summary: 'Re-establish VPN tunnel to vendor' }), true,
      'Should catch re-establish pattern');
    assert.strictEqual(isSecondaryKTLO({ summary: 'Fix broken SCIM provisioning flow' }), true,
      'Should catch fix broken pattern');
    assert.strictEqual(isSecondaryKTLO({ summary: 'Repair LDAP connection to AD' }), true,
      'Should catch repair pattern');

    console.log('  PASS: isSecondaryKTLO catches reconnect/restore patterns');
  } catch (err) {
    throw err;
  }
}

// --- Test: isSecondaryKTLO catches compliance patterns ---
function testIsSecondaryKTLOCompliance() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { isSecondaryKTLO } = require('./lib/digest-curation');

    assert.strictEqual(isSecondaryKTLO({ summary: 'Vanta compliance remediation for Q1' }), true,
      'Should catch Vanta compliance');
    assert.strictEqual(isSecondaryKTLO({ summary: 'Remediate audit finding from SOC2 review' }), true,
      'Should catch remediation');
    assert.strictEqual(isSecondaryKTLO({ observation: 'Address audit finding on access controls' }), true,
      'Should catch audit finding');

    console.log('  PASS: isSecondaryKTLO catches compliance patterns');
  } catch (err) {
    throw err;
  }
}

// --- Test: isSecondaryKTLO catches incident response patterns ---
function testIsSecondaryKTLOIncidentResponse() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { isSecondaryKTLO } = require('./lib/digest-curation');

    assert.strictEqual(isSecondaryKTLO({ summary: 'Incident response for production outage' }), true,
      'Should catch incident response');
    assert.strictEqual(isSecondaryKTLO({ summary: 'Incident resolve: DNS propagation failure' }), true,
      'Should catch incident resolve');

    console.log('  PASS: isSecondaryKTLO catches incident response patterns');
  } catch (err) {
    throw err;
  }
}

// --- Test: isSecondaryKTLO does NOT flag genuine capability work ---
function testIsSecondaryKTLOPassesCapability() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { isSecondaryKTLO } = require('./lib/digest-curation');

    assert.strictEqual(isSecondaryKTLO({ summary: 'Implement Terraform for new Okta attribute' }), false,
      'New Terraform work should not be KTLO');
    assert.strictEqual(isSecondaryKTLO({ summary: 'Configure SSO for new SaaS application' }), false,
      'New SSO config should not be KTLO');
    assert.strictEqual(isSecondaryKTLO({ summary: 'Deploy zero-touch imaging v3' }), false,
      'New deployment should not be KTLO');
    assert.strictEqual(isSecondaryKTLO({}), false,
      'Empty item should not be KTLO');

    console.log('  PASS: isSecondaryKTLO does not flag genuine capability work');
  } catch (err) {
    throw err;
  }
}

// --- Test: curateForWeeklySummary accepts object-format sources ---
function testCurateAcceptsObjectSources() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { curateForWeeklySummary } = require('./lib/digest-curation');

    const teams = {
      cse: { name: 'Infrastructure', members: ['Alice'], slackIds: ['U001'], emails: ['alice@example.com'] },
      desktop: { name: 'Support', members: ['Bob'], slackIds: ['U002'], emails: ['bob@example.com'] },
    };

    const sources = {
      jiraTickets: [
        { key: 'ENG-100', summary: 'Implement VPN automation', team: 'cse' },
      ],
      slackMessages: [
        { content: 'Working on Jamf MDM rollout', authorTeam: 'desktop', channel: 'eng-platform', date: '2026-03-15' },
      ],
      digestItems: [],
    };

    const result = curateForWeeklySummary(sources, teams);
    assert.ok(result.sections, 'Should have sections');
    // At least one section should contain items
    const totalItems = result.sections.reduce((sum, s) => sum + s.items.length, 0);
    assert.ok(totalItems >= 1, 'Should have assigned at least one item to a team');

    console.log('  PASS: curateForWeeklySummary accepts object-format sources');
  } catch (err) {
    throw err;
  }
}

// --- Test: curateForWeeklySummary filters secondary KTLO items ---
function testCurateFiltersSecondaryKTLO() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { curateForWeeklySummary } = require('./lib/digest-curation');

    const teams = {
      cse: { name: 'Infrastructure', members: ['Alice'], slackIds: ['U001'], emails: ['alice@example.com'] },
    };

    const sources = {
      jiraTickets: [
        { key: 'ENG-101', summary: 'Implement new Terraform module', team: 'cse' },
        { key: 'ENG-102', summary: 'Reconnect broken SCIM provisioning', team: 'cse' },
        { key: 'ENG-103', summary: 'Remediate Vanta compliance finding', team: 'cse' },
      ],
      slackMessages: [],
      digestItems: [],
    };

    const result = curateForWeeklySummary(sources, teams);
    const cseSection = result.sections.find(s => s.teamKey === 'cse');
    // Should have filtered out ENG-102 (reconnect) and ENG-103 (Vanta remediation)
    assert.ok(cseSection, 'Should have cse section');
    assert.strictEqual(cseSection.items.length, 1, 'Should have 1 item after KTLO filtering');
    assert.strictEqual(cseSection.items[0].key, 'ENG-101', 'Remaining item should be the capability ticket');
    // Secondary KTLO count should be reported
    assert.strictEqual(result.secondaryKtloCount, 2, 'Should report 2 secondary KTLO items filtered');

    console.log('  PASS: curateForWeeklySummary filters secondary KTLO items');
  } catch (err) {
    throw err;
  }
}

// --- Test: gap threshold fires at < 2 items ---
function testGapThresholdFiresAtLessThan2() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { curateForWeeklySummary } = require('./lib/digest-curation');

    const teams = {
      cse: { name: 'Infrastructure', members: ['Alice'], slackIds: ['U001'], emails: ['alice@example.com'] },
      desktop: { name: 'Support', members: ['Bob'], slackIds: ['U002'], emails: ['bob@example.com'] },
      security: { name: 'Security (Platform)', members: ['Carol'], slackIds: ['U003'], emails: ['carol@example.com'] },
    };

    const sources = {
      jiraTickets: [
        { key: 'ENG-200', summary: 'Implement VPN automation', team: 'cse' },
        { key: 'ENG-201', summary: 'Deploy new monitoring stack', team: 'cse' },
        { key: 'ENG-202', summary: 'Configure Jamf MDM policy', team: 'desktop' },
      ],
      slackMessages: [],
      digestItems: [],
    };

    const result = curateForWeeklySummary(sources, teams);
    assert.ok(result.gaps, 'Should have gaps array');
    // Desktop has 1 item (< 2 threshold) and security has 0 items — both should be gaps
    const desktopGap = result.gaps.find(g => g.includes('Support'));
    const securityGap = result.gaps.find(g => g.includes('Security'));
    assert.ok(desktopGap, 'Desktop should have a gap marker (only 1 item)');
    assert.ok(securityGap, 'Security should have a gap marker (0 items)');
    // CSE has 2 items — should NOT have a gap
    const cseGap = result.gaps.find(g => g.includes('Infrastructure'));
    assert.strictEqual(cseGap, undefined, 'CSE should not have a gap (has 2 items)');

    console.log('  PASS: gap threshold fires at < 2 items');
  } catch (err) {
    throw err;
  }
}

// --- Test: source fields preserved through curation ---
function testSourceFieldsPreserved() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { curateForWeeklySummary } = require('./lib/digest-curation');

    const teams = {
      cse: { name: 'Infrastructure', members: ['Alice'], slackIds: ['U001'], emails: ['alice@example.com'] },
    };

    const sources = {
      jiraTickets: [
        { key: 'ENG-300', summary: 'Implement VPN automation', team: 'cse' },
      ],
      slackMessages: [
        { content: 'Working on VPN automation', authorTeam: 'cse', channel: 'eng-infra', date: '2026-03-15' },
      ],
      digestItems: [],
    };

    const result = curateForWeeklySummary(sources, teams);
    const cseSection = result.sections.find(s => s.teamKey === 'cse');
    assert.ok(cseSection, 'Should have cse section');

    // Jira items should have source field
    const jiraItem = cseSection.items.find(i => i.source && i.source.includes('ENG-300'));
    assert.ok(jiraItem, 'Jira item should have source field with ticket key');

    // Slack items should have source field
    const slackItem = cseSection.items.find(i => i.source && i.source.includes('#eng-infra'));
    assert.ok(slackItem, 'Slack item should have source field with channel name');

    console.log('  PASS: source fields preserved through curation');
  } catch (err) {
    throw err;
  }
}

// --- Test: curateForWeeklySummary still works with array sources (backward compat) ---
function testCurateBackwardCompatArray() {
  try {
    try { delete require.cache[require.resolve('./lib/digest-curation')]; } catch {}
    const { curateForWeeklySummary } = require('./lib/digest-curation');

    const teams = {
      cse: { name: 'Infrastructure', members: ['Alice'], slackIds: ['U001'], emails: ['alice@example.com'] },
    };

    // Old-style array input should still work
    const result = curateForWeeklySummary([], teams);
    assert.ok(result, 'Should return a result for empty array');
    assert.ok(result.sections !== undefined, 'Should have sections');
    assert.ok(result.gaps !== undefined, 'Should have gaps');

    console.log('  PASS: curateForWeeklySummary backward compatible with array sources');
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

// New quality gate tests
testIsSecondaryKTLOReconnect();
testIsSecondaryKTLOCompliance();
testIsSecondaryKTLOIncidentResponse();
testIsSecondaryKTLOPassesCapability();
testCurateAcceptsObjectSources();
testCurateFiltersSecondaryKTLO();
testGapThresholdFiresAtLessThan2();
testSourceFieldsPreserved();
testCurateBackwardCompatArray();

console.log('All digest curation tests passed');
process.exit(0);
