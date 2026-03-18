'use strict';

const assert = require('assert');

const {
  buildDailyPrompt, buildWeeklyPrompt, formatFallback,
  buildWeeklySummaryPrompt, formatWeeklySummaryFallback, narrateWeeklySummary
} = require('./lib/digest-narration');

// --- Test: buildDailyPrompt ---
const items = [
  {
    id: 'test-1', collector: 'followup', priority: 'high',
    observation: 'Sarah emailed you 52h ago', reason: 'Unreplied >48h',
    authority: 'Auto-capture: hygiene', consequence: 'Will escalate.',
    sourceType: 'email', category: 'unreplied'
  },
  {
    id: 'test-2', collector: 'calendar', priority: 'low',
    observation: '5 meetings (4.5h)', reason: 'Calendar density',
    authority: 'Auto-capture', consequence: 'Informational.',
    sourceType: 'calendar', category: 'meeting-density'
  }
];

const dailyPrompt = buildDailyPrompt(items);
assert.ok(dailyPrompt.system, 'Should have system prompt');
assert.ok(dailyPrompt.user, 'Should have user message');
assert.ok(dailyPrompt.system.includes('calm'), 'System prompt should mention tone');
assert.ok(dailyPrompt.system.includes('Do not add information'), 'Should include grounding rule');
assert.ok(dailyPrompt.user.includes('Sarah emailed'), 'User message should contain item data');
console.log('PASS: buildDailyPrompt');

// --- Test: buildWeeklyPrompt ---
const patterns = [
  {
    id: 'pattern-1', type: 'trend', significance: 'moderate',
    observation: 'Reply time increased 8h to 14h',
    evidence: {}, reason: 'trend', authority: 'computed', consequence: 'info'
  }
];

const weeklyPrompt = buildWeeklyPrompt(items, patterns);
assert.ok(weeklyPrompt.system.includes('reflection'), 'Weekly should mention reflection');
assert.ok(weeklyPrompt.user.includes('Reply time increased'), 'Should include patterns');
console.log('PASS: buildWeeklyPrompt');

// --- Test: formatFallback ---
const fallback = formatFallback(items);
assert.ok(fallback.includes('Sarah emailed'), 'Fallback should list observations');
assert.ok(fallback.includes('high'), 'Fallback should show priority');
console.log('PASS: formatFallback');

// --- Test: empty items ---
const emptyDaily = buildDailyPrompt([]);
assert.ok(emptyDaily.user.includes('no items') || emptyDaily.user.includes('[]'),
  'Empty items should be handled');
console.log('PASS: empty items handled');

// === Weekly Summary Narration Tests ===

const sampleCuratedData = {
  teams: {
    cse: {
      accomplishments: [
        { signal: 'Implemented Terraform management for the termed-user attribute with prevent-destroy safeguards.', sources: [{ type: 'jira', key: 'ENG-9407' }], confidence: 0.7 },
        { signal: 'Configured SSO for new vendor portal via Okta integration.', sources: [{ type: 'jira', key: 'ENGSUP-123' }], confidence: 0.5 }
      ],
      inProgress: [
        { signal: 'Continued expansion of JamfPro IaC imports into production.', sources: [{ type: 'slack' }], confidence: 0.5 }
      ],
      hiring: { status: 'One open Senior Systems Engineer.', details: 'Two candidates in final round interviews.', sources: [] }
    },
    desktop: {
      accomplishments: [],
      inProgress: [],
      hiring: null
    },
    security: {
      accomplishments: [
        { signal: 'Validated endpoint detection rule set against MITRE ATT&CK T1059 sub-techniques.', sources: [{ type: 'jira' }], confidence: 0.5 },
        { signal: 'Implemented automated certificate rotation for internal PKI.', sources: [{ type: 'jira' }], confidence: 0.5 }
      ],
      inProgress: [
        { signal: 'Expanded Sentinel SIEM coverage to include Azure AD sign-in logs.', sources: [{ type: 'slack' }], confidence: 0.5 }
      ],
      hiring: { status: 'One open Security Engineer.', details: 'Sourcing pipeline has been reset after two declined offers.', sources: [] }
    }
  },
  executiveSummary: {
    stability: true,
    highlights: ['Terraform adoption expanded with new prevent-destroy safeguards'],
    riskPosture: 'unchanged'
  },
  gaps: [],
  continuity: ['JamfPro IaC imports — week 3 of ongoing work']
};

const samplePreviousNotes = `## Digital Workplace

### Executive Summary
All systems remained stable with no employee-impacting disruptions this week. Risk posture remains unchanged.

### Team Notes

#### Corporate Systems Engineering
The team focused on infrastructure-as-code expansion this week.
- Began importing initial JamfPro resources into Terraform for centralized management.
- Configured Okta SSO for the new contractor onboarding portal.

One open Senior Systems Engineer. Three candidates in pipeline; phone screens scheduled.

#### Desktop Support
Normal operational activity; no notable trends or employee-impacting issues requiring attention this week.

#### Security (Platform & Endpoint)
Continued focus on detection coverage and operational maturity.
- Expanded Sentinel SIEM integration to cover Exchange Online audit logs.
- Validated email gateway DLP rules against current data classification policy.

One open Security Engineer. Two candidates in final round interviews.`;

// --- Test: buildWeeklySummaryPrompt ---
{
  const prompt = buildWeeklySummaryPrompt(sampleCuratedData, samplePreviousNotes);

  // Has both system and user fields
  assert.ok(prompt.system, 'Weekly summary prompt should have system');
  assert.ok(prompt.user, 'Weekly summary prompt should have user message');

  // System prompt encodes key content rules
  assert.ok(prompt.system.includes('Ticket counts'), 'System prompt should forbid ticket counts');
  assert.ok(prompt.system.includes('Individual employee names'), 'System prompt should forbid individual names');
  assert.ok(prompt.system.includes('remained stable'), 'System prompt should include vocabulary');
  assert.ok(prompt.system.includes('Digital Workplace'), 'System prompt should reference the section name');
  assert.ok(prompt.system.includes('Corporate Systems Engineering'), 'System prompt should name sub-teams');
  assert.ok(prompt.system.includes('Executive Summary'), 'System prompt should describe output structure');

  // User message includes curated data
  assert.ok(prompt.user.includes('prevent-destroy'), 'User message should include curated data');
  assert.ok(prompt.user.includes('JamfPro'), 'User message should include in-progress items');

  // User message includes previous notes for continuity
  assert.ok(prompt.user.includes('Began importing initial JamfPro'), 'User message should include previous notes');

  console.log('PASS: buildWeeklySummaryPrompt');
}

// --- Test: buildWeeklySummaryPrompt without previous notes ---
{
  const prompt = buildWeeklySummaryPrompt(sampleCuratedData, null);
  assert.ok(prompt.user, 'Should handle null previous notes');
  assert.ok(!prompt.user.includes('undefined'), 'Should not contain "undefined" literal');
  console.log('PASS: buildWeeklySummaryPrompt without previous notes');
}

// --- Test: formatWeeklySummaryFallback ---
{
  const fallback = formatWeeklySummaryFallback(sampleCuratedData);

  // Should contain the basic structure
  assert.ok(fallback.includes('Digital Workplace'), 'Fallback should have DW header');
  assert.ok(fallback.includes('Executive Summary'), 'Fallback should have exec summary');
  assert.ok(fallback.includes('Corporate Systems Engineering'), 'Fallback should have CSE section');
  assert.ok(fallback.includes('Desktop Support'), 'Fallback should have Desktop section');
  assert.ok(fallback.includes('Security'), 'Fallback should have Security section');

  // Should include actual data
  assert.ok(fallback.includes('prevent-destroy'), 'Fallback should include accomplishments');
  assert.ok(fallback.includes('JamfPro'), 'Fallback should include in-progress items');
  assert.ok(fallback.includes('Security Engineer'), 'Fallback should include hiring');
  assert.ok(fallback.includes('remains unchanged'), 'Fallback should include risk posture');

  console.log('PASS: formatWeeklySummaryFallback');
}

// --- Test: formatWeeklySummaryFallback with empty desktop ---
{
  const fallback = formatWeeklySummaryFallback(sampleCuratedData);
  // Desktop should get default text when no accomplishments
  assert.ok(
    fallback.includes('Normal operational activity') || fallback.includes('no notable trends'),
    'Fallback should use default text for empty Desktop section'
  );
  console.log('PASS: formatWeeklySummaryFallback empty desktop default');
}

// --- Test: narrateWeeklySummary calls AI and returns text ---
{
  // Mock the AI module
  const origModule = require.cache[require.resolve('./lib/ai')];
  const origExports = origModule.exports;

  const mockResponse = '## Digital Workplace\n\n### Executive Summary\nAll systems remained stable.';
  origModule.exports = {
    ...origExports,
    getClient: () => ({
      messages: {
        create: async (params) => {
          // Verify it uses the right model
          assert.strictEqual(params.model, 'claude-sonnet-4-6', 'Should use claude-sonnet-4-6');
          assert.strictEqual(params.max_tokens, 2000, 'Should use 2000 max tokens');
          return {
            content: [{ text: mockResponse }],
            usage: { input_tokens: 500, output_tokens: 200 }
          };
        }
      }
    })
  };

  // Clear the digest-narration cache to pick up the mock
  delete require.cache[require.resolve('./lib/digest-narration')];
  const { narrateWeeklySummary: mockedNarrate } = require('./lib/digest-narration');

  mockedNarrate(sampleCuratedData, samplePreviousNotes).then(result => {
    assert.strictEqual(result, mockResponse, 'Should return AI response text');
    console.log('PASS: narrateWeeklySummary with AI mock');

    // Restore
    origModule.exports = origExports;
    delete require.cache[require.resolve('./lib/digest-narration')];
  }).catch(err => {
    origModule.exports = origExports;
    delete require.cache[require.resolve('./lib/digest-narration')];
    throw err;
  });
}

// --- Test: narrateWeeklySummary falls back when AI unavailable ---
{
  const origModule = require.cache[require.resolve('./lib/ai')];
  const origExports = origModule.exports;

  origModule.exports = {
    ...origExports,
    getClient: () => null
  };

  delete require.cache[require.resolve('./lib/digest-narration')];
  const { narrateWeeklySummary: fallbackNarrate } = require('./lib/digest-narration');

  fallbackNarrate(sampleCuratedData, samplePreviousNotes).then(result => {
    // When AI is unavailable, should return the fallback
    assert.ok(result, 'Should return a fallback string');
    assert.ok(result.includes('Digital Workplace'), 'Fallback should have DW header');
    assert.ok(result.includes('Executive Summary'), 'Fallback should have exec summary');
    console.log('PASS: narrateWeeklySummary fallback when AI unavailable');

    // Restore
    origModule.exports = origExports;
    delete require.cache[require.resolve('./lib/digest-narration')];
  }).catch(err => {
    origModule.exports = origExports;
    delete require.cache[require.resolve('./lib/digest-narration')];
    throw err;
  });
}

// --- Test: narrateWeeklySummary falls back when AI throws ---
{
  const origModule = require.cache[require.resolve('./lib/ai')];
  const origExports = origModule.exports;

  origModule.exports = {
    ...origExports,
    getClient: () => ({
      messages: {
        create: async () => { throw new Error('API error'); }
      }
    })
  };

  delete require.cache[require.resolve('./lib/digest-narration')];
  const { narrateWeeklySummary: errorNarrate } = require('./lib/digest-narration');

  errorNarrate(sampleCuratedData, samplePreviousNotes).then(result => {
    assert.ok(result, 'Should return fallback on error');
    assert.ok(result.includes('Digital Workplace'), 'Fallback should have DW header');
    console.log('PASS: narrateWeeklySummary fallback on AI error');

    // Restore
    origModule.exports = origExports;
    delete require.cache[require.resolve('./lib/digest-narration')];
  }).catch(err => {
    origModule.exports = origExports;
    delete require.cache[require.resolve('./lib/digest-narration')];
    throw err;
  });
}

console.log('\n=== NARRATION TESTS PASSED ===');
