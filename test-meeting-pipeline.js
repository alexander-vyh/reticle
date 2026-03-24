'use strict';

// Integration test: end-to-end post-meeting intelligence pipeline
// Tests the seam between recorder → DB → gateway logic → digest collector
// Does NOT hit the Anthropic API — uses a pre-built summary result

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB_PATH = path.join(os.tmpdir(), `reticle-pipeline-test-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

const reticleDb = require('./reticle-db');
const { buildFlaggedItems } = require('./gateway');
const { collectMeetings } = require('./lib/digest-collectors');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = reticleDb.initDatabase();

// ────────────────────────────────────────────────────────────────
// Stage 1: Recorder daemon delivers a transcript to the DB
// ────────────────────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);
const meetingId = 'pipeline-test-001';

const segments = [
  { speaker: 'SPEAKER_00', text: 'Lets talk about the Q3 roadmap.' },
  { speaker: 'SPEAKER_00', text: 'We should prioritize the search feature.' },
  { speaker: 'Alexander', text: 'Agreed. Who owns the spec?' },
  { speaker: 'SPEAKER_01', text: 'I can take that.' },
  { speaker: 'Alexander', text: 'Sarah mentioned the design is blocked on legal review.' }
];

const attendeeEmails = ['alex@test.com', 'teammate@test.com'];

reticleDb.createMeeting(db, {
  id: meetingId,
  title: 'Q3 Roadmap Planning',
  startTime: now - 3600,
  endTime: now,
  durationSec: 3600,
  attendeeEmails,
  captureMode: 'process_tap'
});

const stored = reticleDb.getMeeting(db, meetingId);
assert.ok(stored, 'Meeting should be retrievable after createMeeting');
assert.strictEqual(stored.title, 'Q3 Roadmap Planning');
assert.deepStrictEqual(JSON.parse(stored.attendee_emails), attendeeEmails);
console.log('PASS: Stage 1 — recorder delivers meeting to DB');

// ────────────────────────────────────────────────────────────────
// Stage 2: Gateway logic flags items from AI result (no API call)
// ────────────────────────────────────────────────────────────────

const mockAiResult = {
  summary: 'Team aligned on Q3 roadmap priorities. Search feature to be specced.',
  topics: ['roadmap', 'search'],
  actionItems: [
    { owner: 'SPEAKER_01', item: 'Write search spec', confidence: 'explicit' },
    { owner: 'Alexander', item: 'Maybe chase legal on design sign-off', confidence: 'inferred' }
  ],
  decisions: ['Search feature is Q3 priority'],
  keyPeople: [
    { mentioned: 'Sarah', context: 'design blocked on legal review' } // no resolvedName — should flag
  ]
};

const flagged = buildFlaggedItems(mockAiResult, segments);

// SPEAKER_00 and SPEAKER_01 are unresolved
const speakerFlags = flagged.filter(f => f.type === 'unresolved_speaker');
assert.strictEqual(speakerFlags.length, 2, 'Both SPEAKER_* labels should be flagged');

const spk0 = speakerFlags.find(f => f.label === 'SPEAKER_00');
assert.strictEqual(spk0.segmentCount, 2);

// Sarah mentioned but not resolved
const personFlags = flagged.filter(f => f.type === 'unresolved_person');
assert.strictEqual(personFlags.length, 1);
assert.strictEqual(personFlags[0].mentioned, 'Sarah');

// Inferred action item flagged
const actionFlags = flagged.filter(f => f.type === 'low_confidence_action');
assert.strictEqual(actionFlags.length, 1);
assert.ok(actionFlags[0].item.includes('legal'));

console.log('PASS: Stage 2 — gateway buildFlaggedItems flags unresolved speakers, people, inferred actions');

// ────────────────────────────────────────────────────────────────
// Stage 3: Gateway persists the summary + updates review status
// ────────────────────────────────────────────────────────────────

reticleDb.saveMeetingSummary(db, {
  meetingId,
  summary: mockAiResult.summary,
  topics: mockAiResult.topics,
  actionItems: mockAiResult.actionItems,
  decisions: mockAiResult.decisions,
  keyPeople: mockAiResult.keyPeople,
  flaggedItems: flagged,
  modelUsed: 'claude-sonnet-4-6',
  inputTokens: 5200,
  outputTokens: 380
});

reticleDb.updateMeetingReviewStatus(db, meetingId, 'needs_review');

const summary = reticleDb.getMeetingSummary(db, meetingId);
assert.ok(summary, 'Summary should be retrievable');
assert.strictEqual(summary.summary, mockAiResult.summary);
assert.strictEqual(JSON.parse(summary.flagged_items).length, flagged.length);

const meetingAfter = reticleDb.getMeeting(db, meetingId);
assert.strictEqual(meetingAfter.review_status, 'needs_review');
console.log('PASS: Stage 3 — summary persisted, review_status updated to needs_review');

// ────────────────────────────────────────────────────────────────
// Stage 4: Digest collector surfaces it with correct priority
// ────────────────────────────────────────────────────────────────

const digestItems = collectMeetings(db);
assert.ok(digestItems.length >= 1, 'Digest should include at least one meeting item');

const pipelineItem = digestItems.find(i => i.entityId === meetingId);
assert.ok(pipelineItem, 'Digest should include the pipeline test meeting');
assert.strictEqual(pipelineItem.priority, 'high', 'Meeting with flagged items + needs_review should be high priority');
assert.strictEqual(pipelineItem.category, 'meeting-needs-review');
assert.ok(pipelineItem.observation.includes('Q3 Roadmap Planning'), 'Observation should name the meeting');
assert.ok(pipelineItem.observation.includes('need review'), 'Observation should mention review needed');
assert.ok(pipelineItem.collector, 'meeting');
assert.ok(pipelineItem.authority, 'Must have authority');
assert.ok(pipelineItem.consequence, 'Must have consequence');
console.log('PASS: Stage 4 — digest collector surfaces flagged meeting at high priority');

// ────────────────────────────────────────────────────────────────
// Stage 5: Speaker embeddings stored for future diarization
// ────────────────────────────────────────────────────────────────

const embedding = Buffer.alloc(192 * 4); // 192-dim float32 vector
reticleDb.saveSpeakerEmbedding(db, {
  personId: 'person-alex',
  embedding,
  sourceMeetingId: meetingId,
  modelVersion: 'ecapa-tdnn-v1',
  qualityScore: 0.92
});

const allEmbeddings = reticleDb.getAllActiveEmbeddings(db);
assert.ok(allEmbeddings.length >= 1);
const alexEmb = allEmbeddings.find(e => e.person_id === 'person-alex');
assert.ok(alexEmb, 'Alex embedding should be in getAllActiveEmbeddings');
assert.strictEqual(alexEmb.model_version, 'ecapa-tdnn-v1');
console.log('PASS: Stage 5 — speaker embedding stored for future diarization');

// ────────────────────────────────────────────────────────────────
// Stage 6: User corrects a transcription error; usage tracked
// ────────────────────────────────────────────────────────────────

reticleDb.saveCorrection(db, {
  heard: 'Roadmapp',
  correct: 'Roadmap',
  personId: null,
  sourceMeetingId: meetingId
});

const corrections = reticleDb.getCorrections(db);
assert.strictEqual(corrections.length, 1);
assert.strictEqual(corrections[0].heard, 'Roadmapp');

reticleDb.incrementCorrectionUsage(db, corrections[0].id);
const updated = reticleDb.getCorrections(db);
assert.strictEqual(updated[0].usage_count, 2, 'Usage count should increment on correction use');
console.log('PASS: Stage 6 — correction stored and usage tracked');

// ────────────────────────────────────────────────────────────────
// Stage 7: Entity links can connect meeting to a person (speaker resolution)
// ────────────────────────────────────────────────────────────────

reticleDb.link(db, {
  sourceType: 'meeting',
  sourceId: meetingId,
  targetType: 'person',
  targetId: 'person-alex',
  relationship: 'spoke_in',
  metadata: JSON.stringify({ speakerLabel: 'Alexander' })
});

const links = reticleDb.getLinked(db, 'meeting', meetingId, { relationship: 'spoke_in', direction: 'forward' });
assert.ok(links.length >= 1, 'Should have at least one spoke_in link');
assert.ok(links.some(l => l.target_id === 'person-alex'), 'Alex should be linked as speaker');
console.log('PASS: Stage 7 — entity link connects meeting to identified speaker');

console.log('\n=== MEETING PIPELINE INTEGRATION TEST PASSED ===');
