'use strict';

const assert = require('node:assert');
const Module = require('module');

// --- Mock jira-reader.js so we never make real API calls ---

const originalResolve = Module._resolveFilename;
const mockSearchIssues = { fn: null };

Module._resolveFilename = function (request, parent, ...rest) {
  if (request === './jira-reader' || request.endsWith('/lib/jira-reader')) {
    return '__mock_jira_reader__';
  }
  // Block config.js from loading real secrets during tests
  if (request === './config' || request.endsWith('/lib/config')) {
    return '__mock_config__';
  }
  // Block logger from creating real log files
  if (request === './logger' || request.endsWith('/lib/logger')) {
    return '__mock_logger__';
  }
  return originalResolve.call(this, request, parent, ...rest);
};

// Register mock modules in require cache
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
require.cache['__mock_logger__'] = {
  id: '__mock_logger__',
  filename: '__mock_logger__',
  loaded: true,
  exports: () => noopLog,
};
require.cache['__mock_config__'] = {
  id: '__mock_config__',
  filename: '__mock_config__',
  loaded: true,
  exports: {},
};
require.cache['__mock_jira_reader__'] = {
  id: '__mock_jira_reader__',
  filename: '__mock_jira_reader__',
  loaded: true,
  exports: {
    searchIssues: async (...args) => mockSearchIssues.fn(...args),
  },
};

const { collectJiraResolved } = require('./lib/jira-collector');

// --- Fixture data ---

function makeIssue({ key, summary, assigneeId, assigneeName, status = 'Done', issuetype = 'Story', project = 'ENG', components = [] }) {
  return {
    key,
    fields: {
      summary,
      assignee: assigneeId ? { accountId: assigneeId, displayName: assigneeName } : null,
      status: { name: status },
      issuetype: { name: issuetype },
      components: components.map(c => ({ name: c })),
    },
  };
}

// Stub DB that returns team members from a static list
function makeMockDb(people) {
  return {
    prepare(sql) {
      return {
        all(...args) {
          // listTeamMembers query
          if (sql.includes('monitored_people')) {
            return people;
          }
          return [];
        },
      };
    },
  };
}

const teamMembers = [
  { id: '1', email: 'alice@example.com', name: 'Alice', jira_id: 'jira-alice', team: 'Platform', role: 'peer' },
  { id: '2', email: 'bob@example.com', name: 'Bob', jira_id: 'jira-bob', team: 'Data', role: 'peer' },
  { id: '3', email: 'carol@example.com', name: 'Carol', jira_id: 'jira-carol', team: 'Platform', role: 'peer' },
];

const weekStart = 1741651200; // 2025-03-11 00:00:00 UTC (epoch seconds)
const weekEnd   = 1742256000; // 2025-03-18 00:00:00 UTC (epoch seconds)

// --- Tests ---

// Test 1: Capability classification — Terraform ticket is capability
async function testCapabilityClassification() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENG-9407', summary: 'Terraform attribute mapping for SSO config', assigneeId: 'jira-alice', assigneeName: 'Alice' }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.strictEqual(result.tickets.length, 1, 'should have 1 capability ticket');
  assert.strictEqual(result.tickets[0].key, 'ENG-9407');
  assert.strictEqual(result.tickets[0].category, 'capability');
  assert.strictEqual(result.tickets[0].team, 'Platform');
  assert.strictEqual(result.ktloCount, 0);
  assert.strictEqual(result.totalResolved, 1);
  console.log('  PASS: capability classification');
}

// Test 2: KTLO classification — access request is KTLO
async function testKtloClassification() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENGSUP-16742', summary: 'Access Request: Bob needs Snowflake role', assigneeId: 'jira-bob', assigneeName: 'Bob', project: 'ENGSUP' }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.strictEqual(result.tickets.length, 0, 'KTLO should be stripped from tickets');
  assert.strictEqual(result.ktloCount, 1, 'should count 1 KTLO ticket');
  assert.strictEqual(result.totalResolved, 1);
  console.log('  PASS: KTLO classification');
}

// Test 3: KTLO via issue type — Service Request type is always KTLO
async function testKtloByIssueType() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENGSUP-16800', summary: 'Something unrelated', assigneeId: 'jira-carol', assigneeName: 'Carol', issuetype: 'Service Request', project: 'ENGSUP' }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.strictEqual(result.tickets.length, 0);
  assert.strictEqual(result.ktloCount, 1);
  console.log('  PASS: KTLO by issue type');
}

// Test 4: Mixed tickets — capability and KTLO together
async function testMixedTickets() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENG-9407', summary: 'Terraform attribute mapping', assigneeId: 'jira-alice', assigneeName: 'Alice' }),
    makeIssue({ key: 'ENGSUP-16742', summary: 'Access Request: Snowflake', assigneeId: 'jira-bob', assigneeName: 'Bob', project: 'ENGSUP' }),
    makeIssue({ key: 'ENGSUP-16750', summary: 'Onboarding: new hire setup', assigneeId: 'jira-carol', assigneeName: 'Carol', project: 'ENGSUP' }),
    makeIssue({ key: 'ENG-9410', summary: 'Implement SSO integration', assigneeId: 'jira-alice', assigneeName: 'Alice' }),
    makeIssue({ key: 'ENGSUP-16760', summary: 'Password reset for user X', assigneeId: 'jira-bob', assigneeName: 'Bob', project: 'ENGSUP' }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.strictEqual(result.tickets.length, 2, 'should have 2 capability tickets');
  assert.strictEqual(result.ktloCount, 3, 'should count 3 KTLO tickets');
  assert.strictEqual(result.totalResolved, 5);
  const keys = result.tickets.map(t => t.key);
  assert.ok(keys.includes('ENG-9407'), 'Terraform ticket should be capability');
  assert.ok(keys.includes('ENG-9410'), 'SSO ticket should be capability');
  console.log('  PASS: mixed tickets');
}

// Test 5: Unmatched assignee — not in team, still classified
async function testUnmatchedAssignee() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENG-9500', summary: 'Deploy new service', assigneeId: 'jira-unknown', assigneeName: 'Unknown Person' }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.strictEqual(result.tickets.length, 1, 'unmatched assignee should still appear');
  assert.strictEqual(result.tickets[0].team, null, 'unmatched assignee should have null team');
  assert.strictEqual(result.tickets[0].assignee, 'Unknown Person');
  assert.strictEqual(result.tickets[0].category, 'capability');
  console.log('  PASS: unmatched assignee');
}

// Test 6: Unassigned ticket — null assignee
async function testUnassignedTicket() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENG-9501', summary: 'Migrate database schema', assigneeId: null, assigneeName: null }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.strictEqual(result.tickets.length, 1);
  assert.strictEqual(result.tickets[0].assignee, null);
  assert.strictEqual(result.tickets[0].team, null);
  assert.strictEqual(result.tickets[0].category, 'capability');
  console.log('  PASS: unassigned ticket');
}

// Test 7: API failure — graceful degradation
async function testApiFailure() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => { throw new Error('ECONNREFUSED'); };

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.deepStrictEqual(result.tickets, []);
  assert.strictEqual(result.ktloCount, 0);
  assert.strictEqual(result.totalResolved, 0);
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('Jira API unavailable'), `warning should mention API unavailability, got: ${result.warnings[0]}`);
  console.log('  PASS: API failure graceful degradation');
}

// Test 8: Date conversion — epoch seconds to YYYY-MM-DD in JQL
async function testDateConversion() {
  const db = makeMockDb(teamMembers);
  let capturedJql = null;
  mockSearchIssues.fn = async (jql) => {
    capturedJql = jql;
    return [];
  };

  await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.ok(capturedJql, 'should have called searchIssues');
  // weekStart = 1741651200 = 2025-03-11 UTC
  // weekEnd   = 1742256000 = 2025-03-18 UTC
  assert.ok(capturedJql.includes('2025-03-11'), `JQL should contain start date 2025-03-11, got: ${capturedJql}`);
  assert.ok(capturedJql.includes('2025-03-18'), `JQL should contain end date 2025-03-18, got: ${capturedJql}`);
  assert.ok(capturedJql.includes('project in (ENG, ENGSUP)'), `JQL should filter by projects, got: ${capturedJql}`);
  assert.ok(capturedJql.includes('resolved'), `JQL should filter by resolved date, got: ${capturedJql}`);
  console.log('  PASS: date conversion');
}

// Test 9: KTLO by summary patterns — various patterns
async function testKtloSummaryPatterns() {
  const db = makeMockDb(teamMembers);
  const ktloSummaries = [
    'Provisioning new Okta groups',
    'Offboarding: remove access for departed employee',
    'Send hardware to remote employee',
    'Order hardware for new team member',
    'Desk issue in building 3',
    'Login issue with VPN',
    'Password reset for jsmith',
    'Okta MFA issue for user',
    'New hire onboarding checklist',
    'Badge request for contractor',
    'License renewal for Tableau',
    'Deprovision former employee accounts',
    'Phone issue with desk phone',
  ];

  for (const summary of ktloSummaries) {
    mockSearchIssues.fn = async () => [
      makeIssue({ key: 'ENGSUP-99', summary, assigneeId: 'jira-alice', assigneeName: 'Alice', project: 'ENGSUP' }),
    ];

    const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
    assert.strictEqual(result.ktloCount, 1, `"${summary}" should be classified as KTLO`);
    assert.strictEqual(result.tickets.length, 0, `"${summary}" should be stripped from capability`);
  }
  console.log('  PASS: KTLO summary patterns');
}

// Test 10: Capability by summary patterns
async function testCapabilitySummaryPatterns() {
  const db = makeMockDb(teamMembers);
  const capSummaries = [
    'Terraform module for VPC peering',
    'SSO integration with Okta SAML',
    'Automate deployment pipeline',
    'Import historical data from legacy system',
    'Deploy monitoring stack',
    'Configure Datadog alerts',
    'Implement RBAC for internal tool',
    'Migrate from EC2 to ECS',
    'Integrate Slack notifications',
    'Drift detection for infrastructure',
    'Update manifest for helm chart',
  ];

  for (const summary of capSummaries) {
    mockSearchIssues.fn = async () => [
      makeIssue({ key: 'ENGSUP-100', summary, assigneeId: 'jira-alice', assigneeName: 'Alice', project: 'ENGSUP' }),
    ];

    const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
    assert.strictEqual(result.tickets.length, 1, `"${summary}" should be classified as capability`);
    assert.strictEqual(result.tickets[0].category, 'capability');
  }
  console.log('  PASS: capability summary patterns');
}

// Test 11: ENG project defaults to capability even with ambiguous summary
async function testDwdevDefaultsCapability() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENG-9999', summary: 'Update documentation for API', assigneeId: 'jira-bob', assigneeName: 'Bob' }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.strictEqual(result.tickets.length, 1);
  assert.strictEqual(result.tickets[0].category, 'capability');
  console.log('  PASS: ENG defaults to capability');
}

// Test 12: Support issue type is KTLO
async function testSupportIssueType() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENGSUP-16900', summary: 'Help with data pipeline', assigneeId: 'jira-carol', assigneeName: 'Carol', issuetype: 'Support', project: 'ENGSUP' }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.strictEqual(result.tickets.length, 0);
  assert.strictEqual(result.ktloCount, 1);
  console.log('  PASS: Support issue type is KTLO');
}

// Test 13: Empty team — no team members in DB
async function testEmptyTeam() {
  const db = makeMockDb([]);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENG-100', summary: 'Deploy service', assigneeId: 'jira-alice', assigneeName: 'Alice' }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.strictEqual(result.tickets.length, 1);
  assert.strictEqual(result.tickets[0].team, null, 'no team match with empty roster');
  console.log('  PASS: empty team');
}

// Test 14: Return shape validation
async function testReturnShape() {
  const db = makeMockDb(teamMembers);
  mockSearchIssues.fn = async () => [
    makeIssue({ key: 'ENG-100', summary: 'Deploy service', assigneeId: 'jira-alice', assigneeName: 'Alice' }),
  ];

  const result = await collectJiraResolved(db, 'fake-token', weekStart, weekEnd);
  assert.ok(Array.isArray(result.tickets), 'tickets should be an array');
  assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
  assert.strictEqual(typeof result.ktloCount, 'number');
  assert.strictEqual(typeof result.totalResolved, 'number');

  const ticket = result.tickets[0];
  assert.ok(ticket.key, 'ticket should have key');
  assert.ok(ticket.summary, 'ticket should have summary');
  assert.ok(ticket.category, 'ticket should have category');
  // assignee and team can be null, but should be present
  assert.ok('assignee' in ticket, 'ticket should have assignee field');
  assert.ok('team' in ticket, 'ticket should have team field');
  console.log('  PASS: return shape validation');
}

// --- Run all tests ---

async function main() {
  await testCapabilityClassification();
  await testKtloClassification();
  await testKtloByIssueType();
  await testMixedTickets();
  await testUnmatchedAssignee();
  await testUnassignedTicket();
  await testApiFailure();
  await testDateConversion();
  await testKtloSummaryPatterns();
  await testCapabilitySummaryPatterns();
  await testDwdevDefaultsCapability();
  await testSupportIssueType();
  await testEmptyTeam();
  await testReturnShape();

  console.log('\nPASS: jira-collector tests');
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
