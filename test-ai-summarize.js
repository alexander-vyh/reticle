'use strict';

const assert = require('assert');

// Test 1: Module exports summarizeMeeting
const ai = require('./lib/ai');
assert.strictEqual(typeof ai.summarizeMeeting, 'function', 'summarizeMeeting must be exported');
console.log('PASS: summarizeMeeting exported');

// Test 2: buildMeetingSummaryPrompt builds correct prompt shape
const { buildMeetingSummaryPrompt } = require('./lib/ai');
const prompt = buildMeetingSummaryPrompt({
  transcript: [
    { start: 0, end: 5, text: 'Hello everyone', speaker: 'SPEAKER_00' },
    { start: 5, end: 12, text: 'Let us discuss the roadmap', speaker: 'SPEAKER_01' }
  ],
  attendees: ['Alexander Vyhmeister', 'Jane Doe'],
  title: 'Weekly Standup',
  durationMin: 30
});

assert.ok(typeof prompt.systemMessage === 'string', 'systemMessage must be a string');
assert.ok(typeof prompt.userMessage === 'string', 'userMessage must be a string');
// Attendees appear in the user message for closed-set speaker resolution
assert.ok(prompt.userMessage.includes('Alexander Vyhmeister'), 'must include attendee names');
// Speaker-attributed transcript lines are present
assert.ok(prompt.userMessage.includes('[SPEAKER_00]'), 'must include speaker labels');
assert.ok(prompt.userMessage.includes('Hello everyone'), 'must include transcript text');
// Duration context is present
assert.ok(prompt.userMessage.includes('30'), 'must include duration');
// System message must be non-trivial (production prompt is 1000+ chars)
assert.ok(prompt.systemMessage.length > 500, `system message too short: ${prompt.systemMessage.length} chars`);
console.log('PASS: buildMeetingSummaryPrompt includes attendees, transcript, and production system prompt');

// Test 3: selectMeetingModel always returns Sonnet (Haiku excluded after A/B test analysis)
const { selectMeetingModel } = require('./lib/ai');
const SONNET = 'claude-sonnet-4-6';
assert.strictEqual(selectMeetingModel({ title: 'Daily Standup', attendeeCount: 5, durationMin: 15 }), SONNET,
  'standups must use Sonnet (precision issues with Haiku confirmed across 4 meetings)');
assert.strictEqual(selectMeetingModel({ title: '1:1 with someone', attendeeCount: 2, durationMin: 30 }), SONNET);
assert.strictEqual(selectMeetingModel({ title: 'Strategy Planning', attendeeCount: 3, durationMin: 60 }), SONNET);
assert.strictEqual(selectMeetingModel({ title: 'Team Sync', attendeeCount: 8, durationMin: 25 }), SONNET);
console.log('PASS: selectMeetingModel always returns Sonnet');

// Test 4: getClient is exported (null-credential graceful degradation path exists)
assert.strictEqual(typeof ai.getClient, 'function', 'getClient must be exported');
console.log('PASS: getClient exported');

console.log('\n=== ALL AI SUMMARIZE TESTS PASSED ===');
