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

console.log('feedback-collector tests:');
testFilterToReportMessages();
testFilterToReportMessagesNoDuplicates();
console.log('All feedback-collector tests passed');
