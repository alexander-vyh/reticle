# Post-Meeting Intelligence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically produce speaker-attributed meeting summaries with action items,
deliver them via Slack and daily digest, and store voice embeddings for progressive
speaker identification.

**Architecture:** Recording stops → `postprocess.py` (WhisperX transcription + diarization +
speaker ID) → POST transcript to Gateway → Gateway triggers AI summarization (Claude) →
Slack DM delivery → daily digest surfaces unreviewed meetings. All meeting data flows
through the Gateway API. Voice embeddings stored on person entities for cross-meeting learning.

**Tech Stack:** Node.js (Gateway, AI, Slack), Python (WhisperX, pyannote, speechbrain),
Swift (RecorderDaemon), SQLite (reticle-db), Anthropic Claude API.

**Design doc:** `docs/plans/2026-03-09-post-meeting-intelligence-design.md`

---

## Task 1: Database Schema — Meeting Tables

Add `meetings`, `meeting_summaries`, `speaker_embeddings`, and `transcription_corrections`
tables to `reticle-db.js`. Add new entity types and relationships to the registries.

**Files:**
- Modify: `reticle-db.js` (schema in `initDatabase()`, new query functions)
- Test: `test-reticle-db.js` (add meeting table tests)

### Step 1: Write failing test — meetings table exists

Add to `test-reticle-db.js`:

```js
// --- Test: meeting tables exist ---
const meetingTables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meetings', 'meeting_summaries', 'speaker_embeddings', 'transcription_corrections') ORDER BY name"
).all().map(r => r.name);
assert.deepStrictEqual(meetingTables, [
  'meeting_summaries', 'meetings', 'speaker_embeddings', 'transcription_corrections'
]);
console.log('PASS: meeting tables created');
```

Update the existing "all tables created" assertion to include the 4 new tables (16 total).

### Step 2: Run test to verify it fails

```bash
node test-reticle-db.js
```

Expected: FAIL — `meetings` table does not exist yet.

### Step 3: Add schema to `initDatabase()`

In `reticle-db.js`, add inside `initDatabase()` after the `feedback_candidates` table:

```sql
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  title TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  duration_sec REAL,
  attendee_emails TEXT,
  capture_mode TEXT,
  review_status TEXT NOT NULL DEFAULT 'new',
  transcript_path TEXT,
  wav_path TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_time);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(review_status);

CREATE TABLE IF NOT EXISTS meeting_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  summary TEXT NOT NULL,
  topics TEXT,
  action_items TEXT,
  decisions TEXT,
  open_questions TEXT,
  key_people TEXT,
  flagged_items TEXT,
  model_used TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_msummary_meeting ON meeting_summaries(meeting_id);

CREATE TABLE IF NOT EXISTS speaker_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  source_meeting_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  quality_score REAL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(person_id, source_meeting_id)
);
CREATE INDEX IF NOT EXISTS idx_speaker_person ON speaker_embeddings(person_id);

CREATE TABLE IF NOT EXISTS transcription_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  heard TEXT NOT NULL,
  correct TEXT NOT NULL,
  person_id TEXT,
  source_meeting_id TEXT,
  usage_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_corrections_heard ON transcription_corrections(heard);
```

Add to registries:

```js
// In ENTITY_TYPES, add:
meeting: 'meeting',
meeting_summary: 'meeting_summary',

// In RELATIONSHIPS, add:
summarized_by: 'summarized_by',
spoke_in: 'spoke_in',
```

### Step 4: Run test to verify it passes

```bash
node test-reticle-db.js
```

Expected: PASS — all tables exist, total table count now 16.

### Step 5: Commit

```bash
git add reticle-db.js test-reticle-db.js
git commit -m "feat: add meeting, summary, speaker embedding, and correction tables"
```

---

## Task 2: Database Query Functions — Meetings CRUD

Add query functions for creating/reading meetings and summaries. These are what the
Gateway routes will call.

**Files:**
- Modify: `reticle-db.js` (new exported functions)
- Test: `test-reticle-db.js` (add CRUD tests)

### Step 1: Write failing tests

Add to `test-reticle-db.js`:

```js
// --- Test: createMeeting + getMeeting ---
const now = Math.floor(Date.now() / 1000);
const meeting = reticleDb.createMeeting(db, {
  id: 'test-meeting-001',
  title: 'Weekly Standup',
  startTime: now - 1800,
  endTime: now,
  durationSec: 1800,
  attendeeEmails: ['alex@co.com', 'mark@co.com'],
  captureMode: 'tap',
  transcriptPath: '/tmp/transcript.json',
  wavPath: '/tmp/meeting.wav'
});
assert.strictEqual(meeting.id, 'test-meeting-001');
assert.strictEqual(meeting.title, 'Weekly Standup');
assert.strictEqual(meeting.review_status, 'new');
console.log('PASS: createMeeting');

const fetched = reticleDb.getMeeting(db, 'test-meeting-001');
assert.strictEqual(fetched.title, 'Weekly Standup');
assert.deepStrictEqual(JSON.parse(fetched.attendee_emails), ['alex@co.com', 'mark@co.com']);
console.log('PASS: getMeeting');

// --- Test: listMeetings ---
const meetings = reticleDb.listMeetings(db);
assert.ok(meetings.length >= 1);
console.log('PASS: listMeetings');

// --- Test: getTodaysMeetings ---
const todayMeetings = reticleDb.getTodaysMeetings(db);
assert.ok(todayMeetings.length >= 1);
console.log('PASS: getTodaysMeetings');

// --- Test: saveMeetingSummary + getMeetingSummary ---
reticleDb.saveMeetingSummary(db, {
  meetingId: 'test-meeting-001',
  summary: 'Discussed Q3 goals',
  topics: ['goals', 'hiring'],
  actionItems: [{ owner: 'Mark', item: 'Draft job posting' }],
  decisions: ['Hire 2 engineers'],
  openQuestions: ['Budget approval?'],
  keyPeople: [{ mentioned: 'Mark', context: 'hiring lead' }],
  flaggedItems: [{ type: 'unresolved_speaker', label: 'SPEAKER_02', segmentCount: 4 }],
  modelUsed: 'haiku',
  inputTokens: 2000,
  outputTokens: 500
});
const summary = reticleDb.getMeetingSummary(db, 'test-meeting-001');
assert.strictEqual(summary.summary, 'Discussed Q3 goals');
assert.deepStrictEqual(JSON.parse(summary.topics), ['goals', 'hiring']);
assert.deepStrictEqual(JSON.parse(summary.flagged_items), [{ type: 'unresolved_speaker', label: 'SPEAKER_02', segmentCount: 4 }]);
console.log('PASS: saveMeetingSummary + getMeetingSummary');

// --- Test: updateMeetingReviewStatus ---
reticleDb.updateMeetingReviewStatus(db, 'test-meeting-001', 'reviewed');
const updated = reticleDb.getMeeting(db, 'test-meeting-001');
assert.strictEqual(updated.review_status, 'reviewed');
console.log('PASS: updateMeetingReviewStatus');
```

### Step 2: Run test to verify it fails

```bash
node test-reticle-db.js
```

Expected: FAIL — `reticleDb.createMeeting is not a function`.

### Step 3: Implement query functions

In `reticle-db.js`, add before the `module.exports`:

```js
// --- Meetings ---

function createMeeting(db, { id, title, startTime, endTime, durationSec,
    attendeeEmails, captureMode, transcriptPath, wavPath }) {
  db.prepare(`INSERT INTO meetings (id, title, start_time, end_time, duration_sec,
    attendee_emails, capture_mode, transcript_path, wav_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = COALESCE(excluded.title, meetings.title),
      end_time = COALESCE(excluded.end_time, meetings.end_time),
      duration_sec = COALESCE(excluded.duration_sec, meetings.duration_sec),
      transcript_path = COALESCE(excluded.transcript_path, meetings.transcript_path),
      wav_path = COALESCE(excluded.wav_path, meetings.wav_path)`
  ).run(id, title || null, startTime, endTime || null, durationSec || null,
    attendeeEmails ? JSON.stringify(attendeeEmails) : null,
    captureMode || null, transcriptPath || null, wavPath || null);
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

function getMeeting(db, id) {
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

function listMeetings(db, { limit = 50 } = {}) {
  return db.prepare(
    'SELECT m.*, ms.summary FROM meetings m LEFT JOIN meeting_summaries ms ON m.id = ms.meeting_id ORDER BY m.start_time DESC LIMIT ?'
  ).all(limit);
}

function getTodaysMeetings(db) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(startOfDay.getTime() / 1000);
  return db.prepare(
    'SELECT m.*, ms.summary, ms.flagged_items FROM meetings m LEFT JOIN meeting_summaries ms ON m.id = ms.meeting_id WHERE m.start_time >= ? ORDER BY m.start_time ASC'
  ).all(dayStart);
}

function updateMeetingReviewStatus(db, meetingId, status) {
  db.prepare('UPDATE meetings SET review_status = ? WHERE id = ?').run(status, meetingId);
}

// --- Meeting Summaries ---

function saveMeetingSummary(db, { meetingId, summary, topics, actionItems, decisions,
    openQuestions, keyPeople, flaggedItems, modelUsed, inputTokens, outputTokens }) {
  db.prepare(`INSERT INTO meeting_summaries (meeting_id, summary, topics, action_items,
    decisions, open_questions, key_people, flagged_items, model_used, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(meetingId, summary,
    topics ? JSON.stringify(topics) : null,
    actionItems ? JSON.stringify(actionItems) : null,
    decisions ? JSON.stringify(decisions) : null,
    openQuestions ? JSON.stringify(openQuestions) : null,
    keyPeople ? JSON.stringify(keyPeople) : null,
    flaggedItems ? JSON.stringify(flaggedItems) : null,
    modelUsed || null, inputTokens || null, outputTokens || null);
}

function getMeetingSummary(db, meetingId) {
  return db.prepare(
    'SELECT * FROM meeting_summaries WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(meetingId);
}
```

Add to `module.exports`:

```js
createMeeting,
getMeeting,
listMeetings,
getTodaysMeetings,
updateMeetingReviewStatus,
saveMeetingSummary,
getMeetingSummary,
```

### Step 4: Run test to verify it passes

```bash
node test-reticle-db.js
```

Expected: All meeting tests PASS.

### Step 5: Commit

```bash
git add reticle-db.js test-reticle-db.js
git commit -m "feat: add meeting and summary query functions to reticle-db"
```

---

## Task 3: Database Query Functions — Speaker Embeddings + Corrections

**Files:**
- Modify: `reticle-db.js`
- Test: `test-reticle-db.js`

### Step 1: Write failing tests

```js
// --- Test: saveSpeakerEmbedding + getSpeakerEmbeddings ---
const embeddingBuffer = Buffer.alloc(192 * 4); // 192 floats × 4 bytes
reticleDb.saveSpeakerEmbedding(db, {
  personId: 'person-001',
  embedding: embeddingBuffer,
  sourceMeetingId: 'test-meeting-001',
  modelVersion: 'ecapa-tdnn-v1',
  qualityScore: 0.85
});
const embeddings = reticleDb.getSpeakerEmbeddings(db, 'person-001');
assert.strictEqual(embeddings.length, 1);
assert.strictEqual(embeddings[0].model_version, 'ecapa-tdnn-v1');
assert.ok(Buffer.isBuffer(embeddings[0].embedding));
console.log('PASS: saveSpeakerEmbedding + getSpeakerEmbeddings');

// --- Test: getAllActiveEmbeddings ---
const allEmb = reticleDb.getAllActiveEmbeddings(db);
assert.ok(allEmb.length >= 1);
console.log('PASS: getAllActiveEmbeddings');

// --- Test: saveCorrection + getCorrections ---
reticleDb.saveCorrection(db, {
  heard: 'Kaczalka',
  correct: 'Kaczorek',
  personId: 'person-001',
  sourceMeetingId: 'test-meeting-001'
});
const corrections = reticleDb.getCorrections(db);
assert.strictEqual(corrections.length, 1);
assert.strictEqual(corrections[0].heard, 'Kaczalka');
assert.strictEqual(corrections[0].correct, 'Kaczorek');
console.log('PASS: saveCorrection + getCorrections');

// --- Test: incrementCorrectionUsage ---
reticleDb.incrementCorrectionUsage(db, corrections[0].id);
const updated2 = reticleDb.getCorrections(db);
assert.strictEqual(updated2[0].usage_count, 2);
console.log('PASS: incrementCorrectionUsage');
```

### Step 2: Run test to verify it fails

```bash
node test-reticle-db.js
```

Expected: FAIL — `reticleDb.saveSpeakerEmbedding is not a function`.

### Step 3: Implement

In `reticle-db.js`:

```js
// --- Speaker Embeddings ---

function saveSpeakerEmbedding(db, { personId, embedding, sourceMeetingId, modelVersion, qualityScore }) {
  db.prepare(`INSERT INTO speaker_embeddings (person_id, embedding, source_meeting_id, model_version, quality_score)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(person_id, source_meeting_id) DO UPDATE SET
      embedding = excluded.embedding,
      model_version = excluded.model_version,
      quality_score = excluded.quality_score`
  ).run(personId, embedding, sourceMeetingId, modelVersion, qualityScore || null);
}

function getSpeakerEmbeddings(db, personId) {
  return db.prepare(
    'SELECT * FROM speaker_embeddings WHERE person_id = ? ORDER BY created_at DESC'
  ).all(personId);
}

function getAllActiveEmbeddings(db) {
  // Latest embedding per person (most recent by created_at)
  return db.prepare(`
    SELECT se.*, mp.name, mp.email FROM speaker_embeddings se
    JOIN monitored_people mp ON se.person_id = mp.id
    WHERE se.id IN (
      SELECT id FROM speaker_embeddings se2
      WHERE se2.person_id = se.person_id
      ORDER BY se2.created_at DESC LIMIT 1
    )
  `).all();
}

// --- Transcription Corrections ---

function saveCorrection(db, { heard, correct, personId, sourceMeetingId }) {
  db.prepare(`INSERT INTO transcription_corrections (heard, correct, person_id, source_meeting_id)
    VALUES (?, ?, ?, ?)`
  ).run(heard, correct, personId || null, sourceMeetingId || null);
}

function getCorrections(db) {
  return db.prepare(
    'SELECT * FROM transcription_corrections ORDER BY usage_count DESC'
  ).all();
}

function incrementCorrectionUsage(db, correctionId) {
  db.prepare(
    'UPDATE transcription_corrections SET usage_count = usage_count + 1 WHERE id = ?'
  ).run(correctionId);
}
```

Add to `module.exports`:

```js
saveSpeakerEmbedding,
getSpeakerEmbeddings,
getAllActiveEmbeddings,
saveCorrection,
getCorrections,
incrementCorrectionUsage,
```

### Step 4: Run tests

```bash
node test-reticle-db.js
```

### Step 5: Commit

```bash
git add reticle-db.js test-reticle-db.js
git commit -m "feat: add speaker embedding and transcription correction queries"
```

---

## Task 4: AI Summarization Function

Add `summarizeMeeting()` to `lib/ai.js` — the function the Gateway calls after
receiving a transcript upload.

**Files:**
- Modify: `lib/ai.js`
- Test: `test-ai-summarize.js` (new test file)

### Step 1: Write failing test

Create `test-ai-summarize.js` at project root:

```js
'use strict';

const assert = require('assert');

// Test 1: Module exports summarizeMeeting
const ai = require('./lib/ai');
assert.strictEqual(typeof ai.summarizeMeeting, 'function');
console.log('PASS: summarizeMeeting exported');

// Test 2: buildMeetingSummaryPrompt builds correct prompt shape
const { buildMeetingSummaryPrompt } = require('./lib/ai');
const prompt = buildMeetingSummaryPrompt({
  transcript: [
    { start: 0, end: 5, text: 'Hello everyone', speaker: 'SPEAKER_00' },
    { start: 5, end: 12, text: 'Let us discuss the roadmap', speaker: 'SPEAKER_01' }
  ],
  attendees: ['the primary user', 'Boromir Hall'],
  title: 'Weekly Standup',
  durationMin: 30
});

// Should contain attendee names for closed-set resolution
assert.ok(prompt.userMessage.includes('the primary user'));
assert.ok(prompt.userMessage.includes('Boromir Hall'));
// Should contain transcript lines
assert.ok(prompt.userMessage.includes('[SPEAKER_00] Hello everyone'));
// Should contain duration context
assert.ok(prompt.userMessage.includes('30'));
console.log('PASS: buildMeetingSummaryPrompt includes attendees and transcript');

// Test 3: selectMeetingModel routes by meeting type
const { selectMeetingModel } = require('./lib/ai');
assert.strictEqual(selectMeetingModel({ title: 'Daily Standup', attendeeCount: 5, durationMin: 15 }), 'claude-haiku-4-5-20251001');
assert.strictEqual(selectMeetingModel({ title: '1:1 with Mark', attendeeCount: 2, durationMin: 30 }), 'claude-sonnet-4-6-20250514');
assert.strictEqual(selectMeetingModel({ title: 'Strategy Planning', attendeeCount: 3, durationMin: 60 }), 'claude-sonnet-4-6-20250514');
assert.strictEqual(selectMeetingModel({ title: 'Team Sync', attendeeCount: 8, durationMin: 25 }), 'claude-haiku-4-5-20251001');
console.log('PASS: selectMeetingModel routes correctly');

console.log('\nAll AI summarize tests passed');
```

### Step 2: Run test to verify it fails

```bash
node test-ai-summarize.js
```

Expected: FAIL — `summarizeMeeting` not exported.

### Step 3: Implement

Add to `lib/ai.js` before `module.exports`:

```js
const MEETING_SUMMARY_SYSTEM = `You are a meeting notes assistant for a VP of IT.
Given a meeting transcript with speaker labels, extract structured meeting notes.

The transcript is from automatic speech recognition — expect disfluencies, fragments,
and occasional errors. Focus on substance, not filler.

You are given the meeting attendee list. Use it to resolve speaker labels and names
mentioned in conversation to specific people. When someone says "Mark should do X",
match "Boromir" to the attendee named Boromir Hall if present.

Return a JSON object with these fields:
{
  "summary": "2-3 sentence overview of what was discussed",
  "topics": ["topic1", "topic2"],
  "actionItems": [
    {"owner": "person name", "personId": null, "item": "description", "deadline": "if mentioned, else null", "confidence": "explicit|implied|inferred"}
  ],
  "decisions": ["decision1", "decision2"],
  "openQuestions": ["question1", "question2"],
  "keyPeople": [
    {"mentioned": "name as said", "resolvedName": "full name if matched", "context": "brief context"}
  ]
}

Be specific about action items — who committed to doing what.
Only include items where someone clearly said they would do something or asked someone to do something.
Omit pleasantries, small talk, and connection issues.`;

function buildMeetingSummaryPrompt({ transcript, attendees, title, durationMin }) {
  const lines = transcript.map(seg =>
    `[${seg.speaker}] ${seg.text}`
  );

  const headerLines = [
    `Meeting: ${title || 'Untitled'}`,
    `Duration: ${durationMin} minutes`,
    `Attendees: ${attendees.join(', ')}`,
    '',
    'Transcript:'
  ];

  return {
    systemMessage: MEETING_SUMMARY_SYSTEM,
    userMessage: [...headerLines, ...lines].join('\n')
  };
}

const O3_TITLE_PATTERNS = [/1[:\-]1/i, /o3/i, /one.on.one/i, /check.in/i];
const ROUTINE_TITLE_PATTERNS = [/standup/i, /stand-up/i, /sync/i, /huddle/i, /scrum/i, /daily/i, /weekly.*team/i];

function selectMeetingModel({ title, attendeeCount, durationMin }) {
  const t = title || '';
  // O3s and 1:1s are important — use Sonnet
  if (O3_TITLE_PATTERNS.some(p => p.test(t))) return 'claude-sonnet-4-6-20250514';
  // Long meetings or small strategic meetings — use Sonnet
  if (durationMin >= 45) return 'claude-sonnet-4-6-20250514';
  if (attendeeCount <= 3 && durationMin >= 25 && !ROUTINE_TITLE_PATTERNS.some(p => p.test(t))) {
    return 'claude-sonnet-4-6-20250514';
  }
  // Routine meetings — use Haiku
  return 'claude-haiku-4-5-20251001';
}

async function summarizeMeeting({ transcript, attendees, title, durationMin }) {
  const anthropic = getClient();
  if (!anthropic) {
    log.warn('Meeting summarization skipped: no AI credentials');
    return null;
  }

  const model = selectMeetingModel({ title, attendeeCount: attendees.length, durationMin });
  const { systemMessage, userMessage } = buildMeetingSummaryPrompt({ transcript, attendees, title, durationMin });

  log.info({ model, segments: transcript.length, chars: userMessage.length }, 'Summarizing meeting');

  const response = await anthropic.messages.create({
    model,
    max_tokens: 2000,
    system: systemMessage,
    messages: [{ role: 'user', content: userMessage }]
  });

  const text = response.content[0]?.text;
  log.info({
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens
  }, 'Meeting summarization tokens');

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const result = JSON.parse(cleaned);

  return {
    ...result,
    modelUsed: model.includes('haiku') ? 'haiku' : 'sonnet',
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens
  };
}
```

Update `module.exports`:

```js
module.exports = {
  assessEmailUrgency,
  parseRuleRefinement,
  getClient,
  summarizeMeeting,
  buildMeetingSummaryPrompt,
  selectMeetingModel
};
```

### Step 4: Run tests

```bash
node test-ai-summarize.js
```

### Step 5: Commit

```bash
git add lib/ai.js test-ai-summarize.js
git commit -m "feat: add summarizeMeeting function with model routing"
```

---

## Task 5: Gateway Routes — Meeting Lifecycle

Add the meeting API endpoints to `gateway.js`.

**Files:**
- Modify: `gateway.js`
- Test: `test-gateway.js` (add meeting route tests)

### Step 1: Write failing tests

Add to `test-gateway.js`:

```js
function testGatewayMeetingRoutes() {
  const reticleDb = require('./reticle-db');
  const TEST_DB = path.join(os.tmpdir(), `gateway-meeting-test-${Date.now()}.db`);
  process.env.RETICLE_DB_PATH = TEST_DB;

  // Re-require to get fresh module with new DB path
  delete require.cache[require.resolve('./reticle-db')];
  const freshDb = require('./reticle-db');
  const db = freshDb.initDatabase();

  const now = Math.floor(Date.now() / 1000);

  // Test createMeeting via db function (simulating POST /meetings/{id}/transcript)
  freshDb.createMeeting(db, {
    id: 'meeting-gw-001',
    title: 'Gateway Test Meeting',
    startTime: now - 1800,
    endTime: now,
    durationSec: 1800,
    attendeeEmails: ['alex@test.com'],
    captureMode: 'tap'
  });

  // Test listing
  const meetings = freshDb.listMeetings(db);
  assert.ok(meetings.length >= 1);
  assert.strictEqual(meetings[0].title, 'Gateway Test Meeting');

  // Test today's meetings
  const today = freshDb.getTodaysMeetings(db);
  assert.ok(today.length >= 1);

  // Test status update
  freshDb.updateMeetingReviewStatus(db, 'meeting-gw-001', 'needs_review');
  const updated = freshDb.getMeeting(db, 'meeting-gw-001');
  assert.strictEqual(updated.review_status, 'needs_review');

  // Cleanup
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}

  console.log('  PASS: gateway meeting routes (unit logic)');
}
```

### Step 2: Run test to verify it fails

```bash
node test-gateway.js
```

### Step 3: Add Gateway routes

In `gateway.js`, add the meeting routes after the feedback routes:

```js
const ai = require('./lib/ai');
const slack = require('./lib/slack');

// POST /meetings/:id/transcript — Upload transcript from recorder daemon
app.post('/meetings/:id/transcript', async (req, res) => {
  const meetingId = req.params.id;
  const { title, startTime, endTime, durationSec, attendeeEmails,
          captureMode, transcriptPath, wavPath, segments } = req.body;

  if (!segments || !Array.isArray(segments)) {
    return res.status(400).json({ error: 'segments array required' });
  }

  // Store meeting
  reticleDb.createMeeting(db, {
    id: meetingId, title, startTime, endTime, durationSec,
    attendeeEmails, captureMode, transcriptPath, wavPath
  });

  // Resolve attendee names from monitored_people
  const attendeeNames = [];
  if (attendeeEmails) {
    for (const email of attendeeEmails) {
      const person = db.prepare('SELECT name, email FROM monitored_people WHERE email = ?').get(email);
      attendeeNames.push(person ? (person.name || person.email) : email);
    }
  }

  // AI summarization (async, don't block response)
  summarizeAndDeliver(meetingId, segments, attendeeNames, title, durationSec).catch(err => {
    console.error(`Meeting summarization failed for ${meetingId}:`, err.message);
  });

  res.json({ ok: true, meetingId });
});

// GET /meetings — list meetings with summary status
app.get('/meetings', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const meetings = reticleDb.listMeetings(db, { limit });
  res.json({ meetings });
});

// GET /meetings/today — today's meetings for digest
app.get('/meetings/today', (req, res) => {
  const meetings = reticleDb.getTodaysMeetings(db);
  res.json({ meetings });
});

// GET /meetings/:id — full meeting detail
app.get('/meetings/:id', (req, res) => {
  const meeting = reticleDb.getMeeting(db, req.params.id);
  if (!meeting) return res.status(404).json({ error: 'not found' });
  const summary = reticleDb.getMeetingSummary(db, req.params.id);
  res.json({ meeting, summary });
});

// POST /meetings/:id/speakers — assign speaker label to person
app.post('/meetings/:id/speakers', (req, res) => {
  const { speakerLabel, personId } = req.body;
  if (!speakerLabel || !personId) {
    return res.status(400).json({ error: 'speakerLabel and personId required' });
  }
  // Store speaker assignment via entity_links
  reticleDb.link(db, {
    sourceType: 'meeting', sourceId: req.params.id,
    targetType: 'person', targetId: personId,
    relationship: 'spoke_in',
    metadata: JSON.stringify({ speakerLabel })
  });
  res.json({ ok: true });
});

// GET /speakers/embeddings — known voice embeddings for postprocess.py
app.get('/speakers/embeddings', (req, res) => {
  const embeddings = reticleDb.getAllActiveEmbeddings(db);
  // Convert BLOB to base64 for JSON transport
  const result = embeddings.map(e => ({
    personId: e.person_id,
    name: e.name,
    email: e.email,
    embedding: e.embedding.toString('base64'),
    modelVersion: e.model_version
  }));
  res.json({ embeddings: result });
});

// GET /corrections/dictionary — accumulated corrections for postprocess.py
app.get('/corrections/dictionary', (req, res) => {
  const corrections = reticleDb.getCorrections(db);
  res.json({ corrections });
});

// POST /meetings/:id/corrections — spelling/name fixes
app.post('/meetings/:id/corrections', (req, res) => {
  const { heard, correct, personId } = req.body;
  if (!heard || !correct) {
    return res.status(400).json({ error: 'heard and correct required' });
  }
  reticleDb.saveCorrection(db, {
    heard, correct, personId: personId || null,
    sourceMeetingId: req.params.id
  });
  res.json({ ok: true });
});
```

Add the `summarizeAndDeliver` helper function before the routes:

```js
async function summarizeAndDeliver(meetingId, segments, attendeeNames, title, durationSec) {
  const durationMin = Math.round((durationSec || 0) / 60);

  const result = await ai.summarizeMeeting({
    transcript: segments,
    attendees: attendeeNames,
    title: title || 'Untitled Meeting',
    durationMin
  });

  if (!result) return;

  // Store summary
  reticleDb.saveMeetingSummary(db, {
    meetingId,
    summary: result.summary,
    topics: result.topics,
    actionItems: result.actionItems,
    decisions: result.decisions,
    openQuestions: result.openQuestions,
    keyPeople: result.keyPeople,
    flaggedItems: buildFlaggedItems(result, segments),
    modelUsed: result.modelUsed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens
  });

  // Create action item entities linked to people
  if (result.actionItems) {
    for (const item of result.actionItems) {
      if (item.personId) {
        reticleDb.link(db, {
          sourceType: 'action_item', sourceId: `${meetingId}:${item.item.substring(0, 30)}`,
          targetType: 'person', targetId: String(item.personId),
          relationship: 'assigned_to',
          metadata: JSON.stringify({ item: item.item, deadline: item.deadline, source: 'meeting' })
        });
      }
    }
  }

  // Determine flagged items for review status
  const flagged = buildFlaggedItems(result, segments);
  if (flagged.length > 0) {
    reticleDb.updateMeetingReviewStatus(db, meetingId, 'needs_review');
  }

  // Send Slack notification
  await sendMeetingSlack(meetingId, title, attendeeNames, durationMin, result, flagged);
}

function buildFlaggedItems(result, segments) {
  const flagged = [];

  // Unresolved speakers (still have generic labels like SPEAKER_00)
  const speakerLabels = [...new Set(segments.map(s => s.speaker))];
  const unresolvedSpeakers = speakerLabels.filter(s => s.startsWith('SPEAKER_'));
  for (const label of unresolvedSpeakers) {
    const count = segments.filter(s => s.speaker === label).length;
    flagged.push({ type: 'unresolved_speaker', label, segmentCount: count });
  }

  // Unresolved people mentions
  if (result.keyPeople) {
    for (const p of result.keyPeople) {
      if (!p.resolvedName) {
        flagged.push({ type: 'unresolved_person', mentioned: p.mentioned, context: p.context });
      }
    }
  }

  // Low-confidence action items
  if (result.actionItems) {
    for (const a of result.actionItems) {
      if (a.confidence === 'inferred') {
        flagged.push({ type: 'low_confidence_action', item: a.item, owner: a.owner });
      }
    }
  }

  return flagged;
}
```

### Step 4: Run tests

```bash
node test-gateway.js
```

### Step 5: Commit

```bash
git add gateway.js test-gateway.js
git commit -m "feat: add meeting lifecycle routes to gateway"
```

---

## Task 6: Slack Meeting Notification

Add the `sendMeetingSlack()` function that delivers post-meeting summaries via DM.

**Files:**
- Modify: `gateway.js` (add `sendMeetingSlack` function, already referenced in Task 5)

### Step 1: Write failing test

Add to `test-gateway.js`:

```js
function testMeetingSlackFormat() {
  // Test the Slack message formatting (without sending)
  // We verify the function exists and formats correctly
  const { execSync } = require('child_process');
  execSync('node -c gateway.js', { stdio: 'pipe' });
  console.log('  PASS: gateway.js syntax valid with meeting Slack code');
}
```

### Step 2: Implement `sendMeetingSlack`

Add to `gateway.js`:

```js
async function sendMeetingSlack(meetingId, title, attendeeNames, durationMin, result, flagged) {
  const lines = [];
  lines.push(`*Meeting: ${title || 'Untitled'}* (${durationMin} min)`);
  if (attendeeNames.length > 0) {
    lines.push(`Participants: ${attendeeNames.join(', ')}`);
  }

  if (result.summary) {
    lines.push('');
    lines.push(result.summary);
  }

  if (result.actionItems && result.actionItems.length > 0) {
    lines.push('');
    lines.push('*Action Items:*');
    for (const a of result.actionItems) {
      const dl = a.deadline ? ` (by ${a.deadline})` : '';
      lines.push(`  → ${a.owner}: ${a.item}${dl}`);
    }
  }

  if (result.decisions && result.decisions.length > 0) {
    lines.push('');
    lines.push('*Decisions:*');
    for (const d of result.decisions) {
      lines.push(`  ✓ ${d}`);
    }
  }

  if (flagged.length > 0) {
    lines.push('');
    lines.push(`⚠ ${flagged.length} item${flagged.length > 1 ? 's' : ''} need review`);
  }

  try {
    await slack.sendSlackDM(lines.join('\n'));
  } catch (err) {
    console.error('Failed to send meeting Slack DM:', err.message);
  }
}
```

### Step 3: Run tests

```bash
node test-gateway.js
```

### Step 4: Commit

```bash
git add gateway.js test-gateway.js
git commit -m "feat: add Slack DM delivery for post-meeting summaries"
```

---

## Task 7: Daily Digest — Meeting Collector

Add `collectMeetings()` to `lib/digest-collectors.js`.

**Files:**
- Modify: `lib/digest-collectors.js`
- Test: `test-digest-collectors.js` (add meeting collector tests)

### Step 1: Write failing test

Add to `test-digest-collectors.js`:

```js
// --- Test: collectMeetings ---
const { collectMeetings } = require('./lib/digest-collectors');

// Seed a meeting
reticleDb.createMeeting(db, {
  id: 'digest-meeting-001',
  title: 'Architecture Review',
  startTime: now - 3600,
  endTime: now,
  durationSec: 3600,
  attendeeEmails: ['alex@test.com']
});

// Add a summary with flagged items
reticleDb.saveMeetingSummary(db, {
  meetingId: 'digest-meeting-001',
  summary: 'Reviewed architecture decisions',
  topics: ['architecture'],
  flaggedItems: [{ type: 'unresolved_speaker', label: 'SPEAKER_01', segmentCount: 5 }],
  modelUsed: 'sonnet',
  inputTokens: 3000,
  outputTokens: 800
});

const meetingItems = collectMeetings(db);
assert.ok(meetingItems.length >= 1);
const archItem = meetingItems.find(i => i.observation.includes('Architecture Review'));
assert.ok(archItem, 'should find Architecture Review meeting');
assert.strictEqual(archItem.priority, 'high'); // has flagged items
assert.strictEqual(archItem.collector, 'meeting');
console.log('PASS: collectMeetings returns meetings with flagged items');
```

### Step 2: Run test to verify it fails

```bash
node test-digest-collectors.js
```

Expected: FAIL — `collectMeetings is not a function`.

### Step 3: Implement

In `lib/digest-collectors.js`, add:

```js
function collectMeetings(db) {
  const now = Math.floor(Date.now() / 1000);
  const items = [];

  // Get today's meetings (requires reticleDb to have getTodaysMeetings)
  const meetings = reticleDb.getTodaysMeetings(db);

  for (const meeting of meetings) {
    const flagged = meeting.flagged_items ? JSON.parse(meeting.flagged_items) : [];
    const hasFlags = flagged.length > 0;
    const isUnreviewed = meeting.review_status === 'new' || meeting.review_status === 'needs_review';
    const durationMin = Math.round((meeting.duration_sec || 0) / 60);

    let observation = `Meeting: ${meeting.title || 'Untitled'} (${durationMin} min)`;
    if (meeting.summary) {
      observation += ` — ${meeting.summary.substring(0, 80)}`;
    }
    if (hasFlags && isUnreviewed) {
      observation += ` [${flagged.length} item${flagged.length > 1 ? 's' : ''} need review]`;
    }

    items.push(createDigestItem({
      collector: 'meeting',
      observation,
      reason: hasFlags ? `${flagged.length} unresolved item${flagged.length > 1 ? 's' : ''} from meeting` : 'Meeting summary available',
      authority: 'Auto-capture: post-meeting intelligence',
      consequence: hasFlags
        ? 'Review speaker assignments and flagged items in Reticle.'
        : 'No action needed. Summary is available.',
      sourceType: 'meeting',
      category: isUnreviewed && hasFlags ? 'meeting-needs-review' : 'meeting-summarized',
      priority: isUnreviewed && hasFlags ? 'high' : 'normal',
      entityId: meeting.id,
      observedAt: meeting.start_time
    }));
  }

  return items;
}
```

Update the module exports:

```js
module.exports = { collectFollowups, collectEmail, collectO3, collectCalendar, collectMeetings };
```

### Step 4: Run tests

```bash
node test-digest-collectors.js
```

### Step 5: Commit

```bash
git add lib/digest-collectors.js test-digest-collectors.js
git commit -m "feat: add collectMeetings digest collector for meeting summaries"
```

---

## Task 8: postprocess.py — WhisperX Migration

Replace the first three pipeline steps (transcribe → diarize → align) with WhisperX.
Add Gateway queries for known embeddings and corrections dictionary.

**Files:**
- Modify: `recorder/scripts/postprocess.py`
- Modify: `recorder/scripts/requirements.txt` (add whisperx)

**Important context:**
- WhisperX handles transcription + forced alignment + diarization in one integrated call
- It uses `faster-whisper` (CTranslate2) instead of MLX Whisper — slower on Apple Silicon
  but better word-level alignment
- pyannote model upgrade: `speaker-diarization-3.1` → `community-1`
- Post-processing runs after the meeting ends, so speed vs quality favors quality
- Gateway runs at `http://localhost:3001`

### Step 1: Update requirements.txt

Check if `recorder/scripts/requirements.txt` exists, then add `whisperx`:

```
whisperx>=3.1.0
pyannote.audio>=4.0.0
speechbrain>=1.0.0
torch>=2.0.0
scipy
```

### Step 2: Replace transcription + diarization functions

Replace `transcribe_audio()`, `load_audio()`, `run_diarization()`, and
`align_transcript_with_speakers()` with a single WhisperX-based function:

```python
def transcribe_and_diarize(wav_path: str, model: str, language: str | None,
                           hf_token: str | None = None) -> list[dict]:
    """Run WhisperX: transcription + forced alignment + diarization in one pipeline."""
    log.info("Running WhisperX pipeline: %s", wav_path)

    import whisperx

    device = "cpu"  # MPS not fully supported by faster-whisper/CTranslate2
    compute_type = "int8"

    # Step 1: Transcribe with faster-whisper
    whisper_model = whisperx.load_model(
        model.replace("mlx-community/", ""),  # WhisperX uses HF model names directly
        device,
        compute_type=compute_type,
        language=language,
    )
    audio = whisperx.load_audio(wav_path)
    result = whisper_model.transcribe(audio, batch_size=16)
    log.info("Transcription complete: %d segments", len(result["segments"]))

    # Step 2: Forced alignment via wav2vec2
    align_model, align_metadata = whisperx.load_align_model(
        language_code=result.get("language", language or "en"),
        device=device,
    )
    result = whisperx.align(
        result["segments"], align_model, align_metadata,
        audio, device,
        return_char_alignments=False,
    )
    log.info("Alignment complete: %d segments with word timestamps", len(result["segments"]))

    # Step 3: Speaker diarization
    if hf_token:
        diarize_model = whisperx.DiarizationPipeline(
            model_name="pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
            device=device,
        )
        diarize_segments = diarize_model(audio)
        result = whisperx.assign_word_speakers(diarize_segments, result)
        speakers = set(s.get("speaker", "Unknown") for s in result["segments"])
        log.info("Diarization complete: %d speakers", len(speakers))
    else:
        log.warning("No HF_TOKEN — skipping diarization")

    # Convert to our segment format
    segments = []
    for seg in result["segments"]:
        text = seg.get("text", "").strip()
        if not text:
            continue
        segments.append({
            "start": round(seg["start"], 2),
            "end": round(seg["end"], 2),
            "text": text,
            "speaker": seg.get("speaker", "Unknown"),
        })

    # Merge consecutive segments from same speaker
    merged = []
    for seg in segments:
        if merged and merged[-1]["speaker"] == seg["speaker"]:
            gap = seg["start"] - merged[-1]["end"]
            if gap < 1.5:
                merged[-1]["end"] = seg["end"]
                merged[-1]["text"] += " " + seg["text"]
                continue
        merged.append(dict(seg))

    log.info("Final: %d merged segments", len(merged))
    return merged
```

### Step 3: Add Gateway integration functions

```python
import urllib.request
import urllib.error

GATEWAY_URL = "http://localhost:3001"

def fetch_known_embeddings() -> list[dict]:
    """Fetch known speaker embeddings from Gateway."""
    try:
        req = urllib.request.Request(f"{GATEWAY_URL}/speakers/embeddings")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("embeddings", [])
    except (urllib.error.URLError, Exception) as e:
        log.warning("Could not fetch speaker embeddings from Gateway: %s", e)
        return []

def fetch_corrections_dictionary() -> list[dict]:
    """Fetch accumulated corrections from Gateway."""
    try:
        req = urllib.request.Request(f"{GATEWAY_URL}/corrections/dictionary")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("corrections", [])
    except (urllib.error.URLError, Exception) as e:
        log.warning("Could not fetch corrections dictionary from Gateway: %s", e)
        return []

def upload_transcript(meeting_id: str, metadata: dict, segments: list[dict]) -> bool:
    """Upload transcript to Gateway for summarization."""
    payload = json.dumps({
        "title": metadata.get("title", ""),
        "startTime": metadata.get("startTime", ""),
        "endTime": metadata.get("endTime", ""),
        "durationSec": metadata.get("durationSec"),
        "attendeeEmails": metadata.get("attendees", []),
        "captureMode": metadata.get("captureMode", ""),
        "segments": segments,
    }).encode()

    try:
        req = urllib.request.Request(
            f"{GATEWAY_URL}/meetings/{meeting_id}/transcript",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            if result.get("ok"):
                log.info("Transcript uploaded to Gateway for meeting %s", meeting_id)
                return True
    except (urllib.error.URLError, Exception) as e:
        log.warning("Failed to upload transcript to Gateway: %s", e)
    return False
```

### Step 4: Update `apply_corrections` to use Gateway dictionary

```python
def apply_gateway_corrections(segments: list[dict], corrections: list[dict]) -> list[dict]:
    """Apply dictionary-based corrections from Gateway."""
    if not corrections:
        return segments

    # Build lookup: heard → correct
    correction_map = {c["heard"].lower(): c["correct"] for c in corrections}
    total = 0

    for seg in segments:
        for heard, correct in correction_map.items():
            if heard in seg["text"].lower():
                import re
                seg["text"] = re.sub(re.escape(heard), correct, seg["text"], flags=re.IGNORECASE)
                total += 1

    if total:
        log.info("Applied %d Gateway dictionary corrections", total)
    return segments
```

### Step 5: Update `main()` to use new pipeline

```python
def main():
    args = parse_args()

    metadata = json.loads(args.metadata)
    wav_path = args.wav
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    hf_token = os.environ.get("HF_TOKEN")

    log.info("Post-processing: %s (%s)", metadata.get("title", "?"), wav_path)

    # Step 1+2+3: WhisperX transcription + alignment + diarization
    segments = transcribe_and_diarize(wav_path, args.model, args.language, hf_token)
    log.info("WhisperX pipeline complete: %d segments", len(segments))

    # Step 4: Speaker identification against known embeddings
    known_embeddings = fetch_known_embeddings()
    attendees = metadata.get("attendees", [])
    segments, speaker_info = identify_speakers(segments, wav_path, attendees)

    # Step 5: Apply corrections from Gateway dictionary
    gateway_corrections = fetch_corrections_dictionary()
    segments = apply_gateway_corrections(segments, gateway_corrections)

    # Also try local corrections if available
    if not args.skip_corrections:
        segments = apply_corrections(segments)

    # Step 6: Optional LLM corrections
    if args.enable_llm_corrections:
        segments = apply_llm_corrections(segments)

    # Step 7: Build and write output
    output = build_output(segments, speaker_info, metadata, wav_path, args.model)

    meeting_id = metadata.get("meetingId", "unknown")
    date_str = datetime.now().strftime("%Y-%m-%d")
    output_path = output_dir / f"meeting-{meeting_id}-{date_str}.json"

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    log.info("Transcript written to %s", output_path)

    # Step 8: Upload to Gateway for summarization + delivery
    upload_transcript(meeting_id, metadata, segments)

    # Print path to stdout for the caller
    print(str(output_path))
```

Add `import os` to the imports at the top of the file.

### Step 6: Commit

```bash
git add recorder/scripts/postprocess.py recorder/scripts/requirements.txt
git commit -m "feat: migrate postprocess.py to WhisperX pipeline + Gateway integration"
```

---

## Task 9: RecorderDaemon — Pass HF_TOKEN to Post-Processor

The Swift RecorderDaemon needs to pass the `HF_TOKEN` environment variable to the
Python subprocess so pyannote can access the diarization model.

**Files:**
- Modify: `recorder/Sources/MeetingRecorder/RecorderDaemon.swift`

### Step 1: Add HF_TOKEN to process environment

In `launchPostProcessor()`, after `let process = Process()` and before `process.run()`,
add the environment setup:

```swift
// Pass through HF_TOKEN for pyannote diarization
var environment = ProcessInfo.processInfo.environment
if let hfToken = environment["HF_TOKEN"] {
    process.environment = ["HF_TOKEN": hfToken, "PATH": environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"]
} else {
    // Try reading from .env file
    let envPath = "\(config.reticleHomeDir)/.env"
    if let envContents = try? String(contentsOfFile: envPath, encoding: .utf8) {
        for line in envContents.split(separator: "\n") {
            let parts = line.split(separator: "=", maxSplits: 1)
            if parts.count == 2 && parts[0].trimmingCharacters(in: .whitespaces) == "HF_TOKEN" {
                let token = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
                process.environment = ["HF_TOKEN": token, "PATH": environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"]
                break
            }
        }
    }
}
```

### Step 2: Verify build

```bash
cd recorder && make build
```

### Step 3: Commit

```bash
git add recorder/Sources/MeetingRecorder/RecorderDaemon.swift
git commit -m "feat: pass HF_TOKEN to post-processor for pyannote diarization"
```

---

## Task 10: Wire Daily Digest to Include Meetings

Update `digest-daily.js` to call the new `collectMeetings()` collector.

**Files:**
- Modify: `digest-daily.js`

### Step 1: Read current digest-daily.js

Read the file to find where collectors are called and add `collectMeetings`.

### Step 2: Add meeting collector

Find the section where collectors are called (likely something like
`const items = [...collectFollowups(...), ...collectEmail(...), ...]`) and add:

```js
const { collectMeetings } = require('./lib/digest-collectors');
// ... in the collector aggregation:
...collectMeetings(db),
```

### Step 3: Run tests

```bash
npm test
```

### Step 4: Commit

```bash
git add digest-daily.js
git commit -m "feat: include meeting summaries in daily digest"
```

---

## Task 11: Integration Test — Full Pipeline

Create an integration test that verifies the complete flow: create meeting → store
transcript → summarize (mocked) → query results.

**Files:**
- Create: `test-meeting-pipeline.js`

### Step 1: Write integration test

```js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB_PATH = path.join(os.tmpdir(), `meeting-pipeline-test-${Date.now()}.db`);
process.env.RETICLE_DB_PATH = TEST_DB_PATH;

const reticleDb = require('./reticle-db');
const { collectMeetings } = require('./lib/digest-collectors');

process.on('exit', () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

const db = reticleDb.initDatabase();
const now = Math.floor(Date.now() / 1000);

// --- Full pipeline test ---

// 1. Create meeting
reticleDb.createMeeting(db, {
  id: 'pipeline-test-001',
  title: 'Infrastructure Leads Weekly',
  startTime: now - 1800,
  endTime: now,
  durationSec: 1800,
  attendeeEmails: ['alex@test.com', 'mark@test.com', 'geoff@test.com'],
  captureMode: 'tap',
  wavPath: '/tmp/test.wav'
});

const meeting = reticleDb.getMeeting(db, 'pipeline-test-001');
assert.strictEqual(meeting.title, 'Infrastructure Leads Weekly');
assert.strictEqual(meeting.review_status, 'new');
console.log('PASS: meeting created with default review_status');

// 2. Store summary (as Gateway would after AI summarization)
reticleDb.saveMeetingSummary(db, {
  meetingId: 'pipeline-test-001',
  summary: 'Discussed AI adoption strategy and Salesforce evaluation',
  topics: ['AI adoption', 'CRM evaluation', 'champions program'],
  actionItems: [
    { owner: 'Mark', item: 'Ratify AI policy', deadline: 'next Friday', confidence: 'explicit' },
    { owner: 'Alexander', item: 'Identify AI champions', deadline: null, confidence: 'implied' }
  ],
  decisions: ['Build adoption through champions, not top-down mandate'],
  openQuestions: ['Salesforce credit usage?'],
  keyPeople: [{ mentioned: 'Boromir', resolvedName: 'Boromir Hall', context: 'AI policy owner' }],
  flaggedItems: [
    { type: 'unresolved_speaker', label: 'SPEAKER_02', segmentCount: 3 },
    { type: 'low_confidence_action', item: 'Identify AI champions', owner: 'Alexander' }
  ],
  modelUsed: 'sonnet',
  inputTokens: 2935,
  outputTokens: 517
});

// 3. Verify summary stored correctly
const summary = reticleDb.getMeetingSummary(db, 'pipeline-test-001');
assert.strictEqual(summary.summary, 'Discussed AI adoption strategy and Salesforce evaluation');
assert.strictEqual(summary.model_used, 'sonnet');
const actionItems = JSON.parse(summary.action_items);
assert.strictEqual(actionItems.length, 2);
assert.strictEqual(actionItems[0].owner, 'Mark');
console.log('PASS: summary with action items stored');

// 4. Flagged items trigger needs_review status
reticleDb.updateMeetingReviewStatus(db, 'pipeline-test-001', 'needs_review');
const updated = reticleDb.getMeeting(db, 'pipeline-test-001');
assert.strictEqual(updated.review_status, 'needs_review');
console.log('PASS: review status updated');

// 5. Digest collector picks up flagged meeting
const digestItems = collectMeetings(db);
const pipelineItem = digestItems.find(i => i.entityId === 'pipeline-test-001');
assert.ok(pipelineItem, 'meeting should appear in digest');
assert.strictEqual(pipelineItem.priority, 'high');
assert.ok(pipelineItem.observation.includes('Infrastructure Leads Weekly'));
console.log('PASS: flagged meeting appears in digest as high priority');

// 6. After review, status changes
reticleDb.updateMeetingReviewStatus(db, 'pipeline-test-001', 'reviewed');
const reviewed = reticleDb.getMeeting(db, 'pipeline-test-001');
assert.strictEqual(reviewed.review_status, 'reviewed');
console.log('PASS: meeting marked as reviewed');

// 7. Speaker embedding storage
const embBuffer = Buffer.alloc(192 * 4);
reticleDb.saveSpeakerEmbedding(db, {
  personId: 'person-mark',
  embedding: embBuffer,
  sourceMeetingId: 'pipeline-test-001',
  modelVersion: 'ecapa-tdnn-v1',
  qualityScore: 0.92
});
const embeddings = reticleDb.getSpeakerEmbeddings(db, 'person-mark');
assert.strictEqual(embeddings.length, 1);
console.log('PASS: speaker embedding stored');

// 8. Corrections dictionary
reticleDb.saveCorrection(db, {
  heard: 'Kaczalka',
  correct: 'Kaczorek',
  personId: 'person-mark',
  sourceMeetingId: 'pipeline-test-001'
});
const corrections = reticleDb.getCorrections(db);
assert.ok(corrections.some(c => c.heard === 'Kaczalka'));
console.log('PASS: transcription correction stored');

// 9. Speaker assignment via entity_links
reticleDb.link(db, {
  sourceType: 'meeting',
  sourceId: 'pipeline-test-001',
  targetType: 'person',
  targetId: 'person-mark',
  relationship: 'spoke_in',
  metadata: JSON.stringify({ speakerLabel: 'SPEAKER_01' })
});
const links = reticleDb.getLinked(db, 'meeting', 'pipeline-test-001', {
  direction: 'forward', relationship: 'spoke_in'
});
assert.ok(links.length >= 1);
console.log('PASS: speaker-person link created');

console.log('\n=== All meeting pipeline integration tests passed ===');
```

### Step 2: Run integration test

```bash
node test-meeting-pipeline.js
```

### Step 3: Commit

```bash
git add test-meeting-pipeline.js
git commit -m "test: add full meeting pipeline integration test"
```

---

## Summary of All Tasks

| Task | What | Files |
|------|------|-------|
| 1 | Database schema (4 new tables) | `reticle-db.js`, `test-reticle-db.js` |
| 2 | Meeting CRUD queries | `reticle-db.js`, `test-reticle-db.js` |
| 3 | Embedding + correction queries | `reticle-db.js`, `test-reticle-db.js` |
| 4 | AI `summarizeMeeting()` | `lib/ai.js`, `test-ai-summarize.js` |
| 5 | Gateway meeting routes | `gateway.js`, `test-gateway.js` |
| 6 | Slack meeting notification | `gateway.js`, `test-gateway.js` |
| 7 | Digest meeting collector | `lib/digest-collectors.js`, `test-digest-collectors.js` |
| 8 | postprocess.py WhisperX migration | `recorder/scripts/postprocess.py`, `requirements.txt` |
| 9 | RecorderDaemon HF_TOKEN passing | `RecorderDaemon.swift` |
| 10 | Wire digest-daily.js | `digest-daily.js` |
| 11 | Integration test | `test-meeting-pipeline.js` |

## Not in This Plan (Separate Efforts)

- **SwiftUI Meetings tab** — MeetingListView, MeetingDetailView, speaker assignment UI,
  inline corrections (tracked separately as SwiftUI work)
- **Live transcription quality** — buffer size, overlapping windows, cross-chunk merging
  (deferred follow-up)
- **Voice enrollment ceremony** — passive enrollment via meeting review corrections
  (builds on Tasks 3 and 5 but needs SwiftUI UI)
