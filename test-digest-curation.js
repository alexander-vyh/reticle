'use strict';

const assert = require('assert');

const {
  curateForWeeklySummary,
  TEAMS,
  TOPIC_PATTERNS,
  identifyTeam,
  identifyTopics,
  groupSignals,
  frameCababilitySignal,
  detectContinuityItems,
  detectGaps
} = require('./lib/digest-curation');

// ============================================================================
// Fixtures — based on real DW weekly data
// ============================================================================

const FIXTURES = {
  jiraTickets: [
    {
      key: 'ENG-9058',
      summary: 'Default apps for first deployment',
      assignee: 'Legolas Wood',
      team: 'security',
      resolvedDate: '2026-03-14',
      status: 'Done',
      components: ['ZTD']
    },
    {
      key: 'ENG-9012',
      summary: 'Terraform import existing Okta groups',
      assignee: 'Aragorn King',
      team: 'cse',
      resolvedDate: '2026-03-12',
      status: 'Done',
      components: ['okta-terraform']
    },
    {
      key: 'ENG-9045',
      summary: 'Termed-user attribute cleanup script',
      assignee: 'Samwise Brown',
      team: 'cse',
      resolvedDate: '2026-03-13',
      status: 'Done',
      components: ['identity-management']
    },
    {
      key: 'ENG-9067',
      summary: 'JamfPro Terraform device naming convention',
      assignee: 'Gimli Stone',
      team: 'security',
      resolvedDate: null,
      status: 'In Progress',
      components: ['jamfpro-terraform']
    },
    {
      key: 'ENG-9030',
      summary: 'Druva backup agent silent install fix',
      assignee: 'Faramir Guard',
      team: 'desktop',
      resolvedDate: '2026-03-11',
      status: 'Done',
      components: ['endpoint-security']
    },
    {
      key: 'ENG-9071',
      summary: 'Terraform drift detection for Okta app assignments',
      assignee: 'Aragorn King',
      team: 'cse',
      resolvedDate: null,
      status: 'In Progress',
      components: ['okta-terraform']
    }
  ],

  slackMessages: [
    {
      author: 'Legolas Wood',
      authorTeam: 'security',
      channel: '#dw-security',
      date: '2026-03-14',
      content: 'Zero-touch deployments confirmed successful on all test machines. ZTD v3 validated.'
    },
    {
      author: 'Aragorn King',
      authorTeam: 'cse',
      channel: '#dw-cse',
      date: '2026-03-13',
      content: 'Finished importing all existing Okta groups into Terraform state. No drift detected after import.'
    },
    {
      author: 'Gimli Stone',
      authorTeam: 'security',
      channel: '#dw-security',
      date: '2026-03-12',
      content: 'JamfPro Terraform app manifest PR is up for review. Covers deployment profiles and naming.'
    },
    {
      author: 'Faramir Guard',
      authorTeam: 'desktop',
      channel: '#dw-desktop',
      date: '2026-03-11',
      content: 'Druva backup agent issue resolved. Silent install package updated and tested on 3 machines.'
    },
    {
      author: 'Eowyn Rider',
      authorTeam: 'desktop',
      channel: '#dw-desktop',
      date: '2026-03-14',
      content: 'Confirmed zero-touch deployment working for new hire onboarding this week.'
    }
  ],

  confluencePages: [
    {
      title: 'Okta Group Terraform Import Runbook',
      author: 'Aragorn King',
      space: 'DW',
      lastModified: '2026-03-13'
    },
    {
      title: 'ZTD v3 Deployment Checklist',
      author: 'Legolas Wood',
      space: 'DW',
      lastModified: '2026-03-14'
    }
  ],

  digestItems: [],

  meetingMetadata: [
    {
      title: 'DW Weekly Sync',
      date: '2026-03-10',
      attendees: ['the primary user', 'Aragorn King', 'Legolas Wood', 'Gimli Stone']
    }
  ],

  previousNotes: `## Digital Workplace
- **CSE:** Began Terraform import of Okta groups (Bill). Drift detection spike planned.
- **Security:** Validated ZTD v3 on initial test cohort. JamfPro Terraform manifest in progress.
- **Desktop:** Investigating Druva backup agent silent install failure.
- **Hiring:** Open req for Security Engineer — sourcing phase.`
};


// ============================================================================
// Test: Module exports expected functions
// ============================================================================

assert.strictEqual(typeof curateForWeeklySummary, 'function', 'curateForWeeklySummary should be a function');
assert.strictEqual(typeof TEAMS, 'object', 'TEAMS should be exported');
assert.strictEqual(typeof TOPIC_PATTERNS, 'object', 'TOPIC_PATTERNS should be exported');
assert.strictEqual(typeof identifyTeam, 'function', 'identifyTeam should be a function');
assert.strictEqual(typeof identifyTopics, 'function', 'identifyTopics should be a function');
assert.strictEqual(typeof groupSignals, 'function', 'groupSignals should be a function');
assert.strictEqual(typeof frameCababilitySignal, 'function', 'frameCababilitySignal should be a function');
assert.strictEqual(typeof detectContinuityItems, 'function', 'detectContinuityItems should be a function');
assert.strictEqual(typeof detectGaps, 'function', 'detectGaps should be a function');
console.log('PASS: module exports all expected functions');


// ============================================================================
// Test: TEAMS contains all 3 sub-teams
// ============================================================================

assert.ok(TEAMS.cse, 'TEAMS should have cse');
assert.ok(TEAMS.desktop, 'TEAMS should have desktop');
assert.ok(TEAMS.security, 'TEAMS should have security');
assert.strictEqual(TEAMS.cse.members.length, 3, 'CSE should have 3 members');
assert.strictEqual(TEAMS.desktop.members.length, 2, 'Desktop should have 2 members');
assert.strictEqual(TEAMS.security.members.length, 2, 'Security should have 2 members');
console.log('PASS: TEAMS structure is correct');


// ============================================================================
// Test: identifyTeam — maps person to correct team
// ============================================================================

assert.strictEqual(identifyTeam('Aragorn King'), 'cse');
assert.strictEqual(identifyTeam('Samwise Brown'), 'cse');
assert.strictEqual(identifyTeam('Gandalf Grey'), 'cse');
assert.strictEqual(identifyTeam('Faramir Guard'), 'desktop');
assert.strictEqual(identifyTeam('Eowyn Rider'), 'desktop');
assert.strictEqual(identifyTeam('Gimli Stone'), 'security');
assert.strictEqual(identifyTeam('Legolas Wood'), 'security');
assert.strictEqual(identifyTeam('Unknown Person'), null);
console.log('PASS: identifyTeam maps all members correctly');


// ============================================================================
// Test: identifyTeam — works with Slack IDs
// ============================================================================

assert.strictEqual(identifyTeam(null, 'U0412G376E9'), 'cse', 'Should find Aragorn King by Slack ID');
assert.strictEqual(identifyTeam(null, 'U070SD8QX39'), 'desktop', 'Should find Keshon by Slack ID');
assert.strictEqual(identifyTeam(null, 'ULPLLCRQF'), 'security', 'Should find Geoffrey by Slack ID');
assert.strictEqual(identifyTeam(null, 'UNKNOWN'), null, 'Unknown Slack ID returns null');
console.log('PASS: identifyTeam works with Slack IDs');


// ============================================================================
// Test: identifyTeam — works with emails
// ============================================================================

assert.strictEqual(identifyTeam(null, null, 'billp@example.com'), 'cse');
assert.strictEqual(identifyTeam(null, null, 'keshon.bowman@example.com'), 'desktop');
assert.strictEqual(identifyTeam(null, null, 'geoffrey@example.com'), 'security');
console.log('PASS: identifyTeam works with emails');


// ============================================================================
// Test: identifyTopics — extracts topics from text
// ============================================================================

{
  const topics1 = identifyTopics('Terraform import of existing Okta groups completed');
  assert.ok(topics1.includes('terraform'), 'Should detect terraform topic');

  const topics2 = identifyTopics('Zero-touch deployments confirmed successful. ZTD v3 validated.');
  assert.ok(topics2.includes('ztd'), 'Should detect ZTD topic');

  const topics3 = identifyTopics('JamfPro Terraform app manifest is ready');
  assert.ok(topics3.includes('jamfpro'), 'Should detect JamfPro topic');
  assert.ok(topics3.includes('terraform'), 'Should detect terraform from JamfPro Terraform text');

  const topics4 = identifyTopics('New hire onboarding hardware setup complete');
  assert.ok(topics4.includes('hardware-lifecycle'), 'Should detect hardware lifecycle topic');

  const topics5 = identifyTopics('SSO integration with Okta SAML configured');
  assert.ok(topics5.includes('identity-sso'), 'Should detect identity/SSO topic');

  const topics6 = identifyTopics('Nothing relevant here about cooking or gardening');
  assert.strictEqual(topics6.length, 0, 'Unrelated text should have no topics');
}
console.log('PASS: identifyTopics extracts correct topics');


// ============================================================================
// Test: groupSignals — groups related signals by topic
// ============================================================================

{
  const signals = [
    { type: 'jira', text: 'Default apps for first deployment', team: 'security', key: 'ENG-9058', topics: ['ztd'] },
    { type: 'slack', text: 'Zero-touch deployments confirmed successful', team: 'security', topics: ['ztd'] },
    { type: 'confluence', text: 'ZTD v3 Deployment Checklist', team: 'security', topics: ['ztd'] },
    { type: 'jira', text: 'Terraform import existing Okta groups', team: 'cse', key: 'ENG-9012', topics: ['terraform'] },
    { type: 'slack', text: 'Finished importing all existing Okta groups into Terraform state', team: 'cse', topics: ['terraform'] }
  ];

  const groups = groupSignals(signals);

  // Should have at least 2 groups: ZTD and terraform
  assert.ok(groups.length >= 2, `Expected at least 2 groups, got ${groups.length}`);

  const ztdGroup = groups.find(g => g.topic === 'ztd');
  assert.ok(ztdGroup, 'Should have a ZTD group');
  assert.strictEqual(ztdGroup.signals.length, 3, 'ZTD group should have 3 signals');
  assert.strictEqual(ztdGroup.team, 'security', 'ZTD group should be attributed to security');

  const tfGroup = groups.find(g => g.topic === 'terraform');
  assert.ok(tfGroup, 'Should have a terraform group');
  assert.strictEqual(tfGroup.signals.length, 2, 'Terraform group should have 2 signals');
  assert.strictEqual(tfGroup.team, 'cse', 'Terraform group should be attributed to CSE');
}
console.log('PASS: groupSignals groups related signals correctly');


// ============================================================================
// Test: frameCababilitySignal — converts raw signal groups to capability statements
// ============================================================================

{
  const ztdGroup = {
    topic: 'ztd',
    team: 'security',
    signals: [
      { type: 'jira', text: 'Default apps for first deployment', status: 'Done', key: 'ENG-9058' },
      { type: 'slack', text: 'Zero-touch deployments confirmed successful. ZTD v3 validated.' },
      { type: 'confluence', text: 'ZTD v3 Deployment Checklist' }
    ]
  };

  const result = frameCababilitySignal(ztdGroup);
  assert.ok(result.signal, 'Should produce a signal string');
  assert.ok(result.signal.length > 0, 'Signal should not be empty');
  assert.ok(result.sources.length === 3, 'Should reference all 3 sources');
  assert.ok(result.confidence >= 0 && result.confidence <= 1, 'Confidence should be 0-1');
  // 3 sources = high confidence
  assert.ok(result.confidence >= 0.7, 'With 3 sources confidence should be >= 0.7');
}
console.log('PASS: frameCababilitySignal produces capability statements');


// ============================================================================
// Test: frameCababilitySignal — single source has lower confidence
// ============================================================================

{
  const singleGroup = {
    topic: 'terraform',
    team: 'cse',
    signals: [
      { type: 'slack', text: 'Started looking at drift detection' }
    ]
  };

  const result = frameCababilitySignal(singleGroup);
  assert.ok(result.confidence < 0.7, 'Single source should have lower confidence');
}
console.log('PASS: frameCababilitySignal single source has lower confidence');


// ============================================================================
// Test: detectContinuityItems — finds items from previous notes needing follow-up
// ============================================================================

{
  const previousNotes = `## Digital Workplace
- **CSE:** Began Terraform import of Okta groups (Bill). Drift detection spike planned.
- **Security:** Validated ZTD v3 on initial test cohort. JamfPro Terraform manifest in progress.
- **Desktop:** Investigating Druva backup agent silent install failure.
- **Hiring:** Open req for Security Engineer — sourcing phase.`;

  const currentSignals = [
    { topic: 'terraform', team: 'cse', signals: [{ type: 'jira', text: 'import done' }] },
    { topic: 'ztd', team: 'security', signals: [{ type: 'slack', text: 'ZTD validated' }] }
  ];

  const continuity = detectContinuityItems(previousNotes, currentSignals);

  // Hiring should appear since no current signals mention it
  const hiringItem = continuity.find(c => c.item.toLowerCase().includes('hiring') || c.item.toLowerCase().includes('security engineer'));
  assert.ok(hiringItem, 'Should flag hiring as needing follow-up');

  // JamfPro should appear as still in progress
  const jamfItem = continuity.find(c => c.item.toLowerCase().includes('jamf'));
  assert.ok(jamfItem, 'Should flag JamfPro as ongoing');
}
console.log('PASS: detectContinuityItems finds items needing follow-up');


// ============================================================================
// Test: detectGaps — flags teams with thin signal
// ============================================================================

{
  const teams = {
    cse: {
      accomplishments: [
        { signal: 'thing 1', sources: ['s1'], confidence: 0.8 },
        { signal: 'thing 2', sources: ['s2'], confidence: 0.9 }
      ],
      inProgress: [],
      hiring: null
    },
    desktop: {
      accomplishments: [
        { signal: 'thing 1', sources: ['s1'], confidence: 0.5 }
      ],
      inProgress: [],
      hiring: null
    },
    security: {
      accomplishments: [],
      inProgress: [{ signal: 'something', sources: ['s1'] }],
      hiring: null
    }
  };

  const gaps = detectGaps(teams);
  // Desktop has only 1 accomplishment — should be flagged
  assert.ok(gaps.some(g => g.toLowerCase().includes('desktop')), 'Desktop should be flagged for thin signal');
  // Security has 0 accomplishments — should be flagged
  assert.ok(gaps.some(g => g.toLowerCase().includes('security')), 'Security should be flagged for thin signal');
  // CSE has 2 accomplishments — should NOT be flagged
  assert.ok(!gaps.some(g => g.toLowerCase().includes('cse')), 'CSE should not be flagged');
}
console.log('PASS: detectGaps flags teams with thin signal');


// ============================================================================
// Test: curateForWeeklySummary — full integration with fixture data
// ============================================================================

{
  const result = curateForWeeklySummary(FIXTURES);

  // Output shape validation
  assert.ok(result.teams, 'Result should have teams');
  assert.ok(result.teams.cse, 'Should have cse team');
  assert.ok(result.teams.desktop, 'Should have desktop team');
  assert.ok(result.teams.security, 'Should have security team');
  assert.ok(result.executiveSummary, 'Should have executiveSummary');
  assert.ok(Array.isArray(result.gaps), 'gaps should be an array');
  assert.ok(Array.isArray(result.continuity), 'continuity should be an array');

  // Each team should have the required shape
  for (const teamKey of ['cse', 'desktop', 'security']) {
    const team = result.teams[teamKey];
    assert.ok(Array.isArray(team.accomplishments), `${teamKey}.accomplishments should be array`);
    assert.ok(Array.isArray(team.inProgress), `${teamKey}.inProgress should be array`);
    // hiring can be null or object
    assert.ok(team.hiring === null || typeof team.hiring === 'object', `${teamKey}.hiring should be null or object`);
  }

  // CSE should have accomplishments (Terraform import, termed-user cleanup)
  assert.ok(result.teams.cse.accomplishments.length >= 1,
    `CSE should have at least 1 accomplishment, got ${result.teams.cse.accomplishments.length}`);

  // CSE should have in-progress items (drift detection)
  assert.ok(result.teams.cse.inProgress.length >= 1,
    `CSE should have at least 1 in-progress item, got ${result.teams.cse.inProgress.length}`);

  // Security should have accomplishments (ZTD validation)
  assert.ok(result.teams.security.accomplishments.length >= 1,
    `Security should have at least 1 accomplishment, got ${result.teams.security.accomplishments.length}`);

  // Security should have in-progress items (JamfPro Terraform)
  assert.ok(result.teams.security.inProgress.length >= 1,
    `Security should have at least 1 in-progress item, got ${result.teams.security.inProgress.length}`);

  // Desktop should have accomplishments (Druva fix)
  assert.ok(result.teams.desktop.accomplishments.length >= 1,
    `Desktop should have at least 1 accomplishment, got ${result.teams.desktop.accomplishments.length}`);

  // Executive summary shape
  assert.strictEqual(typeof result.executiveSummary.stability, 'boolean', 'stability should be boolean');
  assert.ok(Array.isArray(result.executiveSummary.highlights), 'highlights should be array');
  assert.ok(['unchanged', 'elevated', 'reduced'].includes(result.executiveSummary.riskPosture),
    `riskPosture should be unchanged/elevated/reduced, got ${result.executiveSummary.riskPosture}`);
}
console.log('PASS: curateForWeeklySummary full integration');


// ============================================================================
// Test: curateForWeeklySummary — accomplishment signals include sources
// ============================================================================

{
  const result = curateForWeeklySummary(FIXTURES);

  // Each accomplishment should have sources array
  for (const teamKey of ['cse', 'desktop', 'security']) {
    for (const acc of result.teams[teamKey].accomplishments) {
      assert.ok(acc.signal, `${teamKey} accomplishment should have signal`);
      assert.ok(Array.isArray(acc.sources), `${teamKey} accomplishment should have sources array`);
      assert.ok(acc.sources.length > 0, `${teamKey} accomplishment sources should not be empty`);
      assert.ok(typeof acc.confidence === 'number', `${teamKey} accomplishment should have confidence number`);
    }
  }
}
console.log('PASS: accomplishment signals include sources and confidence');


// ============================================================================
// Test: curateForWeeklySummary — cross-team attribution rules
// ============================================================================

{
  // ZTD is a security project even if Desktop confirms it works
  const result = curateForWeeklySummary(FIXTURES);

  // Eowyn Rider (desktop) confirmed zero-touch working — but ZTD is a security project
  // The ZTD signal should be under security, not desktop
  const secAccSignals = result.teams.security.accomplishments.map(a => a.signal.toLowerCase());
  const hasZTD = secAccSignals.some(s => s.includes('zero-touch') || s.includes('ztd') || s.includes('deployment'));
  assert.ok(hasZTD, 'ZTD accomplishment should be attributed to security team');
}
console.log('PASS: cross-team attribution rules applied correctly');


// ============================================================================
// Test: curateForWeeklySummary — continuity detection from previous notes
// ============================================================================

{
  const result = curateForWeeklySummary(FIXTURES);

  // Should have at least 1 continuity item (hiring status was in previous notes)
  assert.ok(result.continuity.length >= 1,
    `Should have continuity items, got ${result.continuity.length}`);

  // Each continuity item should have required shape
  for (const item of result.continuity) {
    assert.ok(item.item, 'Continuity item should have item text');
    assert.ok(item.status, 'Continuity item should have status');
    assert.ok(item.team || item.team === null, 'Continuity item should have team (or null)');
  }
}
console.log('PASS: continuity detection from previous notes');


// ============================================================================
// Test: curateForWeeklySummary — handles empty input gracefully
// ============================================================================

{
  const result = curateForWeeklySummary({
    jiraTickets: [],
    slackMessages: [],
    confluencePages: [],
    digestItems: [],
    meetingMetadata: [],
    previousNotes: ''
  });

  assert.ok(result.teams, 'Should still produce teams structure with empty input');
  assert.ok(result.teams.cse, 'Should have cse even with empty input');
  assert.strictEqual(result.teams.cse.accomplishments.length, 0, 'No accomplishments with empty input');
  assert.ok(result.gaps.length >= 3, 'All 3 teams should be flagged as gaps with empty input');
}
console.log('PASS: handles empty input gracefully');


// ============================================================================
// Test: curateForWeeklySummary — Druva attributed to Desktop (resolver drove it)
// ============================================================================

{
  // Druva fix was done by Faramir Guard (desktop) — should be attributed to desktop
  const result = curateForWeeklySummary(FIXTURES);
  const desktopSignals = result.teams.desktop.accomplishments.map(a => a.signal.toLowerCase());
  const hasDruva = desktopSignals.some(s => s.includes('druva') || s.includes('backup'));
  assert.ok(hasDruva, 'Druva fix should be attributed to desktop (Keshon drove the resolution)');
}
console.log('PASS: Druva attributed to desktop (resolver)');


// ============================================================================
// Test: identifyTopics — handles Jira component-based topics
// ============================================================================

{
  const topics = identifyTopics('Default apps for first deployment', ['ZTD']);
  assert.ok(topics.includes('ztd'), 'Should detect ZTD from components array');

  const topics2 = identifyTopics('Some task', ['okta-terraform']);
  assert.ok(topics2.includes('terraform'), 'Should detect terraform from okta-terraform component');
}
console.log('PASS: identifyTopics handles Jira components');


// ============================================================================
// Test: groupSignals — handles signals with multiple topics
// ============================================================================

{
  const signals = [
    { type: 'slack', text: 'JamfPro Terraform manifest ready', team: 'security', topics: ['jamfpro', 'terraform'] },
    { type: 'jira', text: 'JamfPro Terraform device naming', team: 'security', key: 'ENG-9067', topics: ['jamfpro', 'terraform'] }
  ];

  const groups = groupSignals(signals);
  // These should be grouped together under jamfpro (more specific) rather than split
  const jamfGroup = groups.find(g => g.topic === 'jamfpro');
  assert.ok(jamfGroup, 'Should have a JamfPro group');
  assert.strictEqual(jamfGroup.signals.length, 2, 'Both signals should be in the JamfPro group');
}
console.log('PASS: groupSignals handles multi-topic signals');


// ============================================================================
// Test: executive summary stability detection
// ============================================================================

{
  // With all resolved tickets and no in-progress issues, stability should be true
  const stableSources = {
    jiraTickets: FIXTURES.jiraTickets.filter(t => t.status === 'Done'),
    slackMessages: FIXTURES.slackMessages,
    confluencePages: FIXTURES.confluencePages,
    digestItems: [],
    meetingMetadata: [],
    previousNotes: ''
  };

  const result = curateForWeeklySummary(stableSources);
  assert.strictEqual(result.executiveSummary.stability, true, 'All done tickets should indicate stability');
}
console.log('PASS: executive summary stability detection');


console.log('\n=== ALL DIGEST-CURATION TESTS PASSED ===');
