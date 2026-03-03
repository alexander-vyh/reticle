// test-feedback-blocks.js
'use strict';

const assert = require('assert');

function testBuildFeedbackBlocks() {
  const { buildFeedbackBlocks } = require('./lib/feedback-blocks');

  const items = [{
    counterparty: 'Marcus Chen',
    category: 'affirming',
    rawArtifact: '#platform-eng — Marcus: "Pushed migration with rollback"',
    feedbackDraft: 'When you added rollback support, it reduced risk.',
    entityId: 'C01:1.000',
    feedbackType: 'affirming'
  }];

  const blocks = buildFeedbackBlocks(items);

  assert.ok(blocks.length >= 4);
  assert.strictEqual(blocks[0].type, 'header');

  const actionsBlock = blocks.find(b => b.type === 'actions');
  assert.ok(actionsBlock);
  assert.strictEqual(actionsBlock.elements.length, 2);

  const ids = actionsBlock.elements.map(e => e.action_id);
  assert.ok(ids.includes('feedback_delivered'));
  assert.ok(ids.includes('feedback_skipped'));

  const btn = actionsBlock.elements.find(e => e.action_id === 'feedback_delivered');
  const val = JSON.parse(btn.value);
  assert.strictEqual(val.report, 'Marcus Chen');

  console.log('  PASS: buildFeedbackBlocks — header, quote, draft, buttons');
}

function testBuildFeedbackBlocksEmpty() {
  const { buildFeedbackBlocks } = require('./lib/feedback-blocks');
  assert.strictEqual(buildFeedbackBlocks([]).length, 0);
  console.log('  PASS: buildFeedbackBlocks — empty input');
}

console.log('feedback-blocks tests:');
testBuildFeedbackBlocks();
testBuildFeedbackBlocksEmpty();
console.log('All feedback-blocks tests passed');
