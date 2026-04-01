'use strict';

const assert = require('assert');
const { classifyClosure } = require('./lib/closure-classifier');

// ── Short acks → closure ──

function testShortAcks() {
  const cases = [
    ['Thanks, got it', 'closure'],
    ['Sounds good', 'closure'],
    ['LGTM', 'closure'],
    ['Approved', 'closure'],
    ['Done', 'closure'],
    ['Will do', 'closure'],
    ['Noted', 'closure'],
    ['Looks good to me', 'closure'],
    ['Perfect, thank you', 'closure'],
    ['Ack', 'closure'],
    ['All set', 'closure'],
    ['Works for me', 'closure'],
    ['No worries, thanks for handling it', 'closure'],
    ['Thanks — got it', 'closure'],
  ];

  for (const [text, expected] of cases) {
    const result = classifyClosure(text);
    assert.strictEqual(result.classification, expected, `"${text}" should be ${expected}, got ${result.classification} (${result.reason})`);
  }
  console.log(`PASS: ${cases.length} short acks correctly classified as closure`);
}

// ── Continuations → continuation ──

function testContinuations() {
  const cases = [
    ['Thanks, can you also check the staging deploy?', 'continuation'],
    ['Got it. One more thing — what about the API rate limits?', 'continuation'],
    ["I'll check on that and get back to you by Friday", 'continuation'],
    ['Following up on the budget discussion from last week', 'continuation'],
    ['Checking in on the status of the migration', 'continuation'],
    ['Could you send me the updated spreadsheet?', 'continuation'],
    ['Thanks. Also, what do you think about the new pricing?', 'continuation'],
    ['Acknowledged, let me look into this and circle back tomorrow', 'continuation'],
    ['Please review and let me know if you have concerns', 'continuation'],
    ['How about we schedule a call to discuss?', 'continuation'],
  ];

  for (const [text, expected] of cases) {
    const result = classifyClosure(text);
    assert.strictEqual(result.classification, expected, `"${text}" should be ${expected}, got ${result.classification} (${result.reason})`);
  }
  console.log(`PASS: ${cases.length} continuations correctly classified`);
}

// ── Edge cases ──

function testEdgeCases() {
  // Empty
  assert.strictEqual(classifyClosure('').classification, 'continuation', 'Empty should be continuation');
  assert.strictEqual(classifyClosure(null).classification, 'continuation', 'Null should be continuation');

  // Question marks always continuation
  assert.strictEqual(classifyClosure('Sounds good?').classification, 'continuation', '"Sounds good?" with question mark should be continuation');
  assert.strictEqual(classifyClosure('Done?').classification, 'continuation', '"Done?" should be continuation');

  // Long message with no keywords defaults to continuation
  const long = 'I reviewed the entire proposal and went through all the sections carefully and discussed it with the team at length and we had a productive meeting about the various options and tradeoffs involved in this decision';
  assert.strictEqual(classifyClosure(long).classification, 'continuation', 'Long message with no keywords should be continuation');

  // Very short with no keywords — lean closure
  assert.strictEqual(classifyClosure('OK').classification, 'closure', '"OK" should be closure (very short)');
  assert.strictEqual(classifyClosure('Yes').classification, 'closure', '"Yes" should be closure (very short)');
  assert.strictEqual(classifyClosure('Sure').classification, 'closure', '"Sure" should be closure (very short)');

  console.log('PASS: edge cases handled correctly');
}

// ── Asymmetric risk: NO continuation misclassified as closure ──

function testAsymmetricRisk() {
  // These all contain continuation signals that MUST override any closure keywords
  const mustNotBeClosure = [
    'Thanks, also can you check the logs?',
    'Got it. By Friday, can we have the updated numbers?',
    'Sounds good — I\'ll follow up with the team next week',
    'Done with the first part. What about the second phase?',
    'Noted. Let me check with legal before we proceed',
    'Confirmed, but please also send the invoice',
  ];

  for (const text of mustNotBeClosure) {
    const result = classifyClosure(text);
    assert.strictEqual(result.classification, 'continuation',
      `ASYMMETRIC RISK: "${text}" MUST be continuation, got ${result.classification} (${result.reason})`);
  }
  console.log(`PASS: ${mustNotBeClosure.length} mixed signals correctly default to continuation (asymmetric risk preserved)`);
}

// ── Confidence levels ──

function testConfidence() {
  // Short ack with keyword = high confidence
  const shortAck = classifyClosure('Thanks, got it');
  assert.ok(shortAck.confidence >= 0.85, `Short ack confidence should be >= 0.85, got ${shortAck.confidence}`);

  // Continuation keyword = high confidence
  const contKw = classifyClosure('Can you check the deploy?');
  assert.ok(contKw.confidence >= 0.8, `Continuation keyword confidence should be >= 0.8, got ${contKw.confidence}`);

  // Default (no signals) = low confidence
  const noSignals = classifyClosure('I reviewed the proposal in detail and shared my thoughts with the team at the meeting yesterday afternoon');
  assert.ok(noSignals.confidence <= 0.6, `No-signal default confidence should be <= 0.6, got ${noSignals.confidence}`);

  console.log('PASS: confidence levels are appropriately calibrated');
}

testShortAcks();
testContinuations();
testEdgeCases();
testAsymmetricRisk();
testConfidence();
console.log('\n✅ All closure classifier tests passed');
