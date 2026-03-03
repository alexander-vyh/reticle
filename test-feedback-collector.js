'use strict';

const assert = require('assert');

function testFilterToReportMessages() {
  const { filterToReportMessages } = require('./lib/feedback-collector');

  const messages = [
    { user: 'U_MARCUS', text: 'Pushed the migration with rollback support and tested staging', ts: '1700000001.000', channelId: 'C01', channelName: 'platform-eng' },
    { user: 'U_OUTSIDER', text: 'Has anyone tried the new deployment pipeline yet?', ts: '1700000002.000', channelId: 'C01', channelName: 'platform-eng' },
    { user: 'U_PRIYA', text: 'I fixed the flaky test in CI by adding a retry', ts: '1700000003.000', channelId: 'C02', channelName: 'incidents' },
    { user: 'U_OUTSIDER', text: 'Great work <@U_MARCUS> on the migration script', ts: '1700000004.000', channelId: 'C01', channelName: 'platform-eng' },
  ];

  const reportSlackIds = new Map([
    ['U_MARCUS', 'Marcus Chen'],
    ['U_PRIYA', 'Priya Patel']
  ]);

  const candidates = filterToReportMessages(messages, reportSlackIds);
  assert.strictEqual(candidates.length, 3);
  assert.strictEqual(candidates[0].reportName, 'Marcus Chen');
  assert.strictEqual(candidates[0].messageType, 'authored');
  assert.strictEqual(candidates[2].reportName, 'Marcus Chen');
  assert.strictEqual(candidates[2].messageType, 'mentioned');

  console.log('  PASS: filterToReportMessages — authored and mentioned');
}

function testFilterToReportMessagesNoDuplicates() {
  const { filterToReportMessages } = require('./lib/feedback-collector');

  const messages = [
    { user: 'U_MARCUS', text: 'I (<@U_MARCUS>) just pushed the fix', ts: '1700000001.000', channelId: 'C01', channelName: 'general' }
  ];

  const candidates = filterToReportMessages(messages, new Map([['U_MARCUS', 'Marcus Chen']]));
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].messageType, 'authored');

  console.log('  PASS: filterToReportMessages — no duplicates');
}

function testParseAssessmentResponse() {
  const { parseAssessmentResponse } = require('./lib/feedback-collector');

  const raw = `\`\`\`json
[
  {"index": 0, "category": "affirming", "behavior": "Added rollback support", "context": "Reduced deployment risk", "confidence": "high"},
  {"index": 1, "category": "skip", "behavior": "", "context": "", "confidence": "high"},
  {"index": 2, "category": "adjusting", "behavior": "Posted error without context", "context": "Made debugging harder", "confidence": "low"}
]
\`\`\``;

  const results = parseAssessmentResponse(raw);
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].category, 'affirming');
  assert.strictEqual(results[2].confidence, 'low');

  console.log('  PASS: parseAssessmentResponse');
}

function testFilterByConfidence() {
  const { filterByConfidence } = require('./lib/feedback-collector');

  const assessed = [
    { index: 0, category: 'affirming', confidence: 'high' },
    { index: 1, category: 'skip', confidence: 'high' },
    { index: 2, category: 'adjusting', confidence: 'low' },
    { index: 3, category: 'affirming', confidence: 'medium' }
  ];

  const kept = filterByConfidence(assessed);
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(kept[0].index, 0);
  assert.strictEqual(kept[1].index, 3);

  console.log('  PASS: filterByConfidence — keeps high/medium non-skip');
}

function testBuildFeedbackDraftPrompt() {
  const { buildFeedbackDraftPrompt } = require('./lib/feedback-collector');

  const candidate = {
    reportName: 'Marcus Chen',
    channelName: 'platform-eng',
    messageText: 'Pushed the migration with rollback support and tested staging',
    messageType: 'authored'
  };
  const assessment = {
    category: 'affirming',
    behavior: 'Added rollback support to migration script and tested against staging',
    context: 'Reduced deployment risk for the team'
  };

  const prompt = buildFeedbackDraftPrompt(candidate, assessment);

  assert.ok(prompt.system.includes('When you'), 'System prompt should reference the format');
  assert.ok(prompt.user.includes('Marcus Chen'), 'User prompt should include report name');
  assert.ok(prompt.user.includes('affirming'), 'User prompt should include category');

  console.log('  PASS: buildFeedbackDraftPrompt — constructs prompt with context');
}

function testCreateFeedbackDigestItem() {
  const { createFeedbackDigestItem } = require('./lib/feedback-collector');

  const candidate = {
    reportName: 'Marcus Chen',
    reportSlackId: 'U_MARCUS',
    channelName: 'platform-eng',
    channelId: 'C01',
    messageText: 'Pushed the migration with rollback support',
    timestamp: '1700000001.000',
    messageType: 'authored'
  };
  const assessment = {
    category: 'affirming',
    behavior: 'Added rollback support to migration',
    context: 'Reduced deployment risk'
  };
  const draft = 'When you added rollback support to the migration script, it reduced deployment risk for the whole team.';

  const item = createFeedbackDigestItem(candidate, assessment, draft);

  assert.strictEqual(item.collector, 'feedback');
  assert.strictEqual(item.sourceType, 'slack-public');
  assert.strictEqual(item.category, 'affirming');
  assert.strictEqual(item.counterparty, 'Marcus Chen');
  assert.strictEqual(item.entityId, 'C01:1700000001.000');
  assert.strictEqual(item.priority, 'normal');
  assert.strictEqual(item.feedbackDraft, draft);
  assert.ok(item.rawArtifact.includes('Pushed the migration'));
  assert.ok(item.authority.includes('#platform-eng'));

  console.log('  PASS: createFeedbackDigestItem — all fields populated');
}

function testCreateFeedbackDigestItemAdjusting() {
  const { createFeedbackDigestItem } = require('./lib/feedback-collector');

  const candidate = {
    reportName: 'Priya Patel',
    reportSlackId: 'U_PRIYA',
    channelName: 'incidents',
    channelId: 'C02',
    messageText: 'The alert fired but I could not find the runbook',
    timestamp: '1700000002.000',
    messageType: 'authored'
  };
  const assessment = { category: 'adjusting', behavior: 'Runbook not found', context: 'Incident response delayed' };
  const draft = 'When the runbook was not discoverable during the incident...';

  const item = createFeedbackDigestItem(candidate, assessment, draft);

  assert.strictEqual(item.priority, 'high');
  assert.strictEqual(item.category, 'adjusting');

  console.log('  PASS: createFeedbackDigestItem — adjusting gets high priority');
}

console.log('feedback-collector tests:');
testFilterToReportMessages();
testFilterToReportMessagesNoDuplicates();
testParseAssessmentResponse();
testFilterByConfidence();
testBuildFeedbackDraftPrompt();
testCreateFeedbackDigestItem();
testCreateFeedbackDigestItemAdjusting();
console.log('All feedback-collector tests passed');
