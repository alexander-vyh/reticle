# Post-Meeting Intelligence Design

**Date:** 2026-03-09
**Status:** Approved
**Goal:** Automatically produce speaker-attributed meeting summaries with action items,
deliver them via Slack and daily digest, and build a voice learning loop that improves
speaker identification over time through user corrections.

## Problem

The meeting recorder captures audio and produces live transcripts, but:

1. Live transcripts are fragmented (287 segments for a 27-min meeting) with broken
   speaker attribution (mic VAD heuristic tags ~95% as "self")
2. `postprocess.py` exists with a full diarization pipeline but fails silently due to
   pyannote 4.x API changes and missing HF_TOKEN
3. No summarization, action item extraction, or delivery happens after a meeting ends
4. No way to review transcripts, correct speaker labels, or teach the system voices
5. Speaker identification via ECAPA-TDNN is scaffolded but not wired

The recorder captures hours of audio daily. None of it becomes actionable information.

## Solution

Three connected systems:

1. **Post-meeting processing pipeline** — automatic transcription, diarization,
   speaker identification, summarization, and delivery
2. **Meeting review UI** — SwiftUI view to review summaries, correct speakers, and
   fix transcription errors
3. **Speaker learning loop** — voice embeddings stored on person entities, refined
   through corrections, used for automatic identification in future meetings

## Architecture

### Data Flow

```
Recording stops (RecorderDaemon.stopRecording)
  │
  ├─ launchPostProcessor() [already exists]
  │   └─ postprocess.py (WhisperX + speaker ID + corrections)
  │       → transcript JSON to disk
  │
  ├─ POST /meetings/{id}/transcript → Gateway
  │   ├─ Store transcript + segments in reticle-db
  │   ├─ Run AI summarization (Claude)
  │   │   ├─ Extract: summary, action items, decisions, open questions
  │   │   ├─ Resolve names against calendar attendees + monitored_people
  │   │   └─ Store summary in reticle-db
  │   ├─ Create action item entities + entity_links to people
  │   ├─ Flag items needing review (unresolved speakers, uncertain names)
  │   └─ Send Slack DM (immediate)
  │       ├─ Action items + key decisions
  │       ├─ Review checklist (flagged items count)
  │       └─ "Review in Reticle" deep link
  │
  └─ Daily digest collector
      └─ GET /meetings/today → include in morning digest
          └─ Unreviewed flagged items surface as nudge
```

### API Surface (Gateway)

All meeting data flows through the Gateway. No direct file reads between systems.

```
# Meeting lifecycle
POST   /meetings/{id}/transcript     Upload transcript from recorder daemon
GET    /meetings                     List meetings (with summary status)
GET    /meetings/{id}                Full detail: transcript + summary + speakers
GET    /meetings/today               Today's meetings for digest collector

# Speaker corrections
POST   /meetings/{id}/speakers       Assign speaker label → person entity
GET    /speakers/embeddings          Known voice embeddings (for postprocess.py)

# Corrections
POST   /meetings/{id}/corrections    Spelling/name fixes
GET    /corrections/dictionary       Accumulated corrections (for postprocess.py)

# People mentions
POST   /meetings/{id}/people-mentions  Link mentioned name → person entity
```

## Post-Meeting Processing Pipeline

### WhisperX Replaces Custom Pipeline

Replace the first three steps of `postprocess.py` (transcribe → diarize → align)
with WhisperX, which does all three in one integrated call with superior forced
phoneme alignment via wav2vec2.

**Current pipeline (postprocess.py):**
1. MLX Whisper transcription
2. pyannote diarization (separate call)
3. Custom word-to-speaker alignment (midpoint majority vote)
4. Speaker identification (ECAPA-TDNN)
5. Dictionary corrections
6. Optional LLM corrections

**New pipeline:**
1. WhisperX (transcription + forced alignment + diarization in one call)
2. Speaker identification against known embeddings (from Gateway)
3. Dictionary corrections (from Gateway)
4. Output JSON

WhisperX uses `faster-whisper` (CTranslate2) instead of MLX Whisper. This is slower
on Apple Silicon but produces better word-level alignment. Since postprocessing runs
after the meeting ends, speed is less important than quality.

### pyannote Model Upgrade

Upgrade from `pyannote/speaker-diarization-3.1` to `pyannote/speaker-diarization-community-1`
(pyannote.audio 4.x). Community-1 significantly improves speaker assignment and counting.

### Speaker Identification

After WhisperX produces speaker clusters (SPEAKER_00, SPEAKER_01, etc.):

1. Query Gateway: `GET /speakers/embeddings` for known voice profiles
2. Query Gateway or use meeting metadata: get calendar attendees for this meeting
3. For each speaker cluster, extract embedding from audio segments
4. **Closed-set identification**: compare cluster embeddings against known embeddings
   of expected attendees (calendar participants). Pick best cosine similarity match
   above threshold (0.5 initial, calibrate over time)
5. Unmatched clusters flagged for user review
6. Output: segments with person entity IDs where matched, speaker labels where not

Using calendar attendees as a closed set dramatically simplifies identification —
instead of "who is this voice?" (open set), the question becomes "which of these
5 expected people does this voice match?" (closed set, much higher accuracy).

### AI Summarization

After transcript is uploaded to Gateway:

1. Load transcript segments from reticle-db
2. Load calendar attendees for the meeting
3. Build prompt with attendee list as closed-set context for name resolution
4. Call Claude API via `lib/ai.js`:
   - **Haiku** for routine meetings (standups, syncs)
   - **Sonnet** for important meetings (O3s, strategy sessions)
   - Route by meeting metadata (title patterns, attendee count, duration)
5. Extract structured output:
   ```json
   {
     "summary": "2-3 sentence overview",
     "topics": ["topic1", "topic2"],
     "actionItems": [
       {
         "owner": "person name",
         "personId": 42,
         "item": "description",
         "deadline": "if mentioned, else null",
         "confidence": "explicit|implied|inferred"
       }
     ],
     "decisions": ["decision1"],
     "openQuestions": ["question1"],
     "keyPeople": [
       { "mentioned": "Mark", "personId": 42, "context": "new hire, AI champion" }
     ]
   }
   ```
6. Store summary in reticle-db
7. Create action item entities linked to person entities via `entity_links`
   - This feeds the existing followup-checker naturally
8. Flag items needing review:
   - Unresolved speaker labels (no embedding match)
   - Names mentioned but not matched to any person entity
   - Low-confidence action items

### Slack Delivery (Immediate)

Post-meeting Slack DM via `lib/slack.js`:

```
Meeting: Weekly Infrastructure Leads (30 min)
Participants: Alexander, Geoffrey, Mark

Action Items:
  → Mark: Ratify AI policy and present at SPAI meeting
  → Alexander + Mark: Identify 20-40 internal AI champions
  → Both: Join future CRM decision discussions

Decisions:
  ✓ Build AI adoption through champions, not top-down mandate
  ✓ Included in future Salesforce evaluation discussions

⚠ 2 items need review — Open in Reticle
```

### Daily Digest Integration

New `collectMeetings()` function in `lib/digest-collectors.js`:
- Queries `GET /meetings/today`
- Creates `DigestItem` for each meeting with unreviewed flagged items
- Priority: `normal` for reviewed meetings, `high` for meetings with unresolved items
  older than 24 hours

## Meeting Review UI

### SwiftUI Management Window — "Meetings" Tab

New tab in ContentView sidebar alongside People and Feedback.

#### Left Panel: Meeting List

Each row displays: date, title, duration, participant count, review status badge.

Status badges:
- **New** — unreviewed, has flagged items
- **Needs Review** — partially reviewed, some flags remain
- **Reviewed** — all flags resolved

Sorted most recent first. API: `GET /meetings`

#### Right Panel: Meeting Detail

**Section 1: Review Checklist (top, collapsible)**

Short list of items needing attention — not the full transcript. Only surfaces:
- Unresolved speaker labels ("SPEAKER_02 not identified — 4 segments")
- Mentioned names not matched to people ("Mark mentioned 6 times — link to person?")
- Low-confidence action items ("Implied: someone should look into Salesforce credits")

Each item has an inline action: dropdown to pick a person, confirm/dismiss button.
When all items are resolved, the meeting status changes to "Reviewed."

**Section 2: Summary (read-only)**

AI-generated summary, action items with owners, decisions, open questions.
Action items show person linkage when resolved.

**Section 3: Transcript (scrollable, interactive)**

Speaker-labeled segments. Each speaker label is a clickable chip — tap to reassign
to a person entity via dropdown search. When assigned, all segments with that label
update immediately.

Uncertain name spellings highlighted — tap to correct inline. Corrections stored
via `POST /meetings/{id}/corrections`.

The full transcript is available but not the primary review surface. The checklist
(Section 1) is the default working view.

## Speaker Learning Loop

### Voice Embeddings on Person Entities

Speaker embeddings stored in reticle-db on person entities:

```sql
-- New table (or metadata JSON on monitored_people)
CREATE TABLE speaker_embeddings (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES monitored_people(id),
  embedding BLOB NOT NULL,           -- float32 vector (192-256 dims, ~1KB)
  source_meeting_id TEXT NOT NULL,   -- which meeting this came from
  model_version TEXT NOT NULL,       -- embedding model identifier
  quality_score REAL,                -- audio quality metric
  created_at INTEGER NOT NULL,       -- epoch seconds
  UNIQUE(person_id, source_meeting_id)
);
```

Active profile is a single embedding per person, stored as an EMA
(exponential moving average) updated on each new confirmed sample:

```
active_embedding = 0.2 * new_embedding + 0.8 * active_embedding
```

Last 20 raw embeddings retained per person for re-clustering on model upgrades.

### Enrollment Flow

No separate enrollment ceremony. Enrollment happens passively through meeting review:

1. First meeting: pyannote clusters speakers. User reviews transcript, assigns
   "SPEAKER_00 is me", "SPEAKER_01 is Mark"
2. Gateway triggers embedding extraction for confirmed segments
3. Embedding stored on person entity with `model_version` and `source_meeting_id`
4. Confidence status on person: "Learning (1/3 meetings)" → "Ready (confidence: 92%)"

After 3+ confirmed meetings, identification becomes automatic (>90% accuracy for
meetings with known participants).

### Correction Feedback

When the system misidentifies a speaker:
- User corrects in review UI
- Old embedding for that cluster is discarded (negative signal)
- Correct person's embedding updated with new sample
- Threshold may need recalibration if false positive rate is high

### Model Version Management

Every embedding stored with `model_version`. When the embedding model is upgraded:
1. Mark all existing embeddings as `needs_re_extraction`
2. Re-extract from stored meeting WAVs (retroactive, async)
3. Rebuild active profiles from re-extracted embeddings

This is feasible because meeting WAVs are retained on disk.

### Calendar-Seeded Closed-Set Identification

For each meeting, the identification problem is scoped to expected attendees:

1. Calendar event has attendee list (emails)
2. Resolve emails → person entities via `monitored_people`
3. Load embeddings for resolved people
4. Compare diarization clusters against only these embeddings
5. Unknown voices (no calendar match) flagged for review — may be a new person
   to add to `monitored_people`

### Spelling Corrections Dictionary

When the user corrects a transcription error:
- Store: `{ "heard": "Kaczalka", "correct": "Kaczorek", "person_id": 42 }`
- Gateway serves accumulated corrections via `GET /corrections/dictionary`
- `postprocess.py` applies corrections after transcription
- Microsoft-style "sounds like" mapping: corrections include what Whisper heard,
  so future transcriptions can be auto-corrected

### Progressive Learning Metric

Track correction frequency over time. Surface in the Meetings tab:
- "3 speaker corrections this week (down from 8 last week)"
- "Custom vocabulary resolved 12 terms automatically"
- Per-person voice confidence: "No voiceprint" → "Learning (2/5)" → "Ready (92%)"

Aligns with Reticle's axiom: longitudinal patterns over events.

## Database Changes

### New Tables

```sql
-- Meeting metadata
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,               -- meetingId from calendar
  title TEXT,
  start_time INTEGER NOT NULL,       -- epoch seconds
  end_time INTEGER,
  duration_sec REAL,
  attendee_emails TEXT,              -- JSON array
  capture_mode TEXT,                 -- tap|fallback|auhal
  review_status TEXT DEFAULT 'new',  -- new|needs_review|reviewed
  transcript_path TEXT,              -- path to full transcript JSON
  wav_path TEXT,                     -- path to WAV file
  created_at INTEGER NOT NULL
);

-- Meeting summary (AI-generated)
CREATE TABLE meeting_summaries (
  id INTEGER PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  summary TEXT NOT NULL,             -- 2-3 sentence overview
  topics TEXT,                       -- JSON array
  decisions TEXT,                    -- JSON array
  open_questions TEXT,               -- JSON array
  model_used TEXT,                   -- haiku|sonnet
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL
);

-- Speaker embeddings (see above)
CREATE TABLE speaker_embeddings ( ... );

-- Spelling corrections
CREATE TABLE transcription_corrections (
  id INTEGER PRIMARY KEY,
  heard TEXT NOT NULL,               -- what Whisper produced
  correct TEXT NOT NULL,             -- user's correction
  person_id INTEGER,                 -- optional link to person
  source_meeting_id TEXT,            -- where first corrected
  usage_count INTEGER DEFAULT 1,     -- how many times auto-applied
  created_at INTEGER NOT NULL
);
```

Action items from meetings stored as entities in existing `action_log` /
`entity_links` tables — linked to person entities via `assigned_to` relationship.

## Component Changes

### postprocess.py

- Replace steps 1-3 (transcribe + diarize + align) with WhisperX
- Upgrade diarization model: `speaker-diarization-3.1` → `community-1`
- Query Gateway for known embeddings before identification step
- Query Gateway for corrections dictionary
- Fix: config paths `claudia` → `reticle` (already applied)
- Fix: pyannote 4.x DiarizeOutput API (already applied)
- Output: speaker-attributed transcript JSON with person entity IDs where matched

### RecorderDaemon.swift

- After `launchPostProcessor()` completes, POST transcript to Gateway
- Pass `HF_TOKEN` environment variable to Python subprocess
- Pass meeting metadata (attendees, title) from the `/start` request

### gateway.js

- New routes: `/meetings/*`, `/speakers/embeddings`, `/corrections/dictionary`
- Summarization trigger on transcript upload
- Slack delivery after summarization
- Embedding extraction trigger on speaker assignment

### reticle-db.js

- New tables: `meetings`, `meeting_summaries`, `speaker_embeddings`,
  `transcription_corrections`
- Action items stored via existing entity/link system

### lib/ai.js

- New function: `summarizeMeeting({ transcript, attendees, meetingType })`
- Model routing: Haiku for routine, Sonnet for important

### lib/digest-collectors.js

- New `collectMeetings()` function
- Queries Gateway for today's meetings with unreviewed flagged items

### Reticle.app (SwiftUI)

- New "Meetings" tab in ContentView sidebar
- MeetingListView: list with status badges
- MeetingDetailView: review checklist + summary + transcript
- Speaker assignment dropdown (search People entities)
- Inline correction editing

### recorder/scripts/requirements.txt

- Add `whisperx` dependency
- Keep `pyannote.audio>=4.0.0` (used by WhisperX)
- Keep `speechbrain` (used for ECAPA-TDNN embeddings)

## Fixes Included

From the 2026-03-09 ad-hoc experiment:
- pyannote 4.x `DiarizeOutput` → access `.speaker_diarization` attribute (applied)
- Config path `~/.config/claudia` → `~/.config/reticle` in postprocess.py (applied)
- HF_TOKEN cached in `~/.cache/huggingface/token` and `.env`

## Separate Follow-Up

**Live transcription quality parity** — not part of this design:
- Increase buffer from 3s to 10s with overlapping windows
- Cross-chunk context and segment merging
- Goal: live transcript quality approaching batch quality

## Cost Estimate

At 10 meetings/day:
- Haiku summarization: ~$0.60/month
- Sonnet for O3s (~2/week): ~$0.40/month
- Total AI cost: ~$1/month
- Storage: ~50MB WAV + ~100KB JSON per meeting, ~1.5GB/month
