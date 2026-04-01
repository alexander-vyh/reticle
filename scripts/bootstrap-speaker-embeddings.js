#!/usr/bin/env node
/**
 * Bootstrap speaker embeddings from past recordings.
 *
 * Scans the meetings table for entries with WAV files and known attendees,
 * extracts ECAPA-TDNN embeddings per speaker cluster, and saves them to the
 * speaker_embeddings table linked to person entities.
 *
 * Prerequisites:
 *   - Python venv with speechbrain, torch, scipy, pyannote.audio
 *   - Past meetings recorded with WAV files on disk
 *   - Attendee emails in meeting records matching monitored_people
 *
 * Usage:
 *   node scripts/bootstrap-speaker-embeddings.js [--dry-run] [--meeting-id <id>]
 *
 * Idempotent — uses UPSERT on (person_id, source_meeting_id).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const reticleDb = require('../reticle-db');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3001';
const PYTHON = process.env.PYTHON_PATH || path.join(
  process.env.HOME, '.config', 'reticle', 'venv', 'bin', 'python3'
);
const MODEL_VERSION = 'ecapa-tdnn-v1';

// Inline Python script that extracts per-speaker-cluster embeddings from a WAV
// using pyannote diarization + speechbrain ECAPA-TDNN.
const EXTRACT_EMBEDDINGS_PY = `
import sys, json, struct, base64, logging
logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("extract-embeddings")

def main():
    import numpy as np
    import torch
    from scipy.io import wavfile
    from pyannote.audio import Pipeline as DiarizePipeline
    from speechbrain.inference.speaker import EncoderClassifier

    wav_path = sys.argv[1]
    hf_token = sys.argv[2] if len(sys.argv) > 2 else None

    log.info("Loading diarization pipeline...")
    diarize = DiarizePipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token,
    )
    log.info("Loading ECAPA-TDNN classifier...")
    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": "cpu"},
    )

    log.info("Running diarization on %s...", wav_path)
    diarization = diarize(wav_path)

    sample_rate, full_audio = wavfile.read(wav_path)
    if full_audio.dtype == np.int16:
        full_audio = full_audio.astype(np.float32) / 32768.0
    if full_audio.ndim == 2:
        full_audio = full_audio.mean(axis=1)

    # Group segments by speaker
    speaker_segments = {}
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speaker_segments.setdefault(speaker, []).append((turn.start, turn.end))

    results = []
    for speaker_label, segs in speaker_segments.items():
        clips = []
        total_samples = 0
        max_samples = sample_rate * 30  # up to 30s per speaker
        for start, end in segs:
            if total_samples >= max_samples:
                break
            s = int(start * sample_rate)
            e = int(end * sample_rate)
            clip = full_audio[s:e]
            clips.append(clip)
            total_samples += len(clip)

        if not clips or total_samples < sample_rate:
            log.warning("Speaker %s has insufficient audio (<1s), skipping", speaker_label)
            continue

        combined = np.concatenate(clips)
        waveform = torch.from_numpy(combined).unsqueeze(0)
        embedding = classifier.encode_batch(waveform).squeeze().detach().numpy()

        # Encode as base64 float32 array
        raw_bytes = struct.pack(f"{len(embedding)}f", *embedding.tolist())
        b64 = base64.b64encode(raw_bytes).decode("ascii")

        total_speech_sec = sum(e - s for s, e in segs)
        results.append({
            "speakerLabel": speaker_label,
            "embedding": b64,
            "speechSeconds": round(total_speech_sec, 1),
            "segmentCount": len(segs),
        })

    json.dump(results, sys.stdout)

if __name__ == "__main__":
    main()
`;

function parseArgs() {
  const args = { dryRun: false, meetingId: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    if (argv[i] === '--meeting-id' && argv[i + 1]) args.meetingId = argv[++i];
  }
  return args;
}

function resolveAttendeesToPeople(db, attendeeEmails) {
  const people = [];
  for (const email of attendeeEmails) {
    const person = db.prepare(
      'SELECT id, email, name FROM monitored_people WHERE email = ?'
    ).get(email);
    if (person) people.push(person);
  }
  return people;
}

function extractEmbeddings(wavPath) {
  // Write the Python script to a temp file and execute it
  const tmpScript = path.join(require('os').tmpdir(), 'extract-speaker-embeddings.py');
  fs.writeFileSync(tmpScript, EXTRACT_EMBEDDINGS_PY);

  const hfToken = process.env.HF_TOKEN || '';
  try {
    const result = execSync(
      `"${PYTHON}" "${tmpScript}" "${wavPath}" "${hfToken}"`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 600000, encoding: 'utf-8' }
    );
    return JSON.parse(result);
  } catch (err) {
    console.error(`  ERROR extracting embeddings from ${wavPath}: ${err.message}`);
    return null;
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }
}

function assignSpeakersToAttendees(speakerClusters, attendees) {
  // Simple round-robin assignment by speech time (most speech = first attendee).
  // In practice, this should use an interactive prompt or meeting review UI.
  // For bootstrap, we assign by sorted order and let the user correct via review.
  //
  // If there's only 1 attendee (self-recording) or 1 speaker, assign directly.
  // Otherwise, sort speakers by speechSeconds descending and assign to attendees
  // in the order they appear. Unmatched speakers are skipped.
  const sorted = [...speakerClusters].sort((a, b) => b.speechSeconds - a.speechSeconds);
  const assignments = [];

  for (let i = 0; i < Math.min(sorted.length, attendees.length); i++) {
    assignments.push({
      speakerLabel: sorted[i].speakerLabel,
      embedding: sorted[i].embedding,
      person: attendees[i],
      speechSeconds: sorted[i].speechSeconds,
      segmentCount: sorted[i].segmentCount,
    });
  }

  return assignments;
}

function main() {
  const args = parseArgs();
  const db = reticleDb.initDatabase();

  console.log('Bootstrap Speaker Embeddings');
  console.log('============================');
  if (args.dryRun) console.log('DRY RUN — no embeddings will be saved\n');

  // Find meetings with WAV files and attendees
  let meetings;
  if (args.meetingId) {
    const m = reticleDb.getMeeting(db, args.meetingId);
    meetings = m ? [m] : [];
  } else {
    meetings = reticleDb.listMeetings(db, { limit: 500 });
  }

  let processed = 0;
  let saved = 0;
  let skipped = 0;

  for (const meeting of meetings) {
    const wavPath = meeting.wav_path;
    if (!wavPath || !fs.existsSync(wavPath)) {
      console.log(`  SKIP ${meeting.id}: no WAV file${wavPath ? ` (${wavPath} not found)` : ''}`);
      skipped++;
      continue;
    }

    const attendeeEmails = meeting.attendee_emails ? JSON.parse(meeting.attendee_emails) : [];
    if (attendeeEmails.length === 0) {
      console.log(`  SKIP ${meeting.id}: no attendee emails`);
      skipped++;
      continue;
    }

    const people = resolveAttendeesToPeople(db, attendeeEmails);
    if (people.length === 0) {
      console.log(`  SKIP ${meeting.id}: no attendees matched to monitored_people`);
      skipped++;
      continue;
    }

    console.log(`\nProcessing: ${meeting.title || meeting.id}`);
    console.log(`  WAV: ${wavPath}`);
    console.log(`  Attendees: ${people.map(p => p.name || p.email).join(', ')}`);

    const clusters = extractEmbeddings(wavPath);
    if (!clusters || clusters.length === 0) {
      console.log(`  SKIP: no speaker clusters extracted`);
      skipped++;
      continue;
    }

    console.log(`  Found ${clusters.length} speaker cluster(s)`);
    const assignments = assignSpeakersToAttendees(clusters, people);

    for (const a of assignments) {
      console.log(`  ${a.speakerLabel} → ${a.person.name || a.person.email} (${a.speechSeconds}s, ${a.segmentCount} segments)`);
      if (!args.dryRun) {
        const embeddingBuffer = Buffer.from(a.embedding, 'base64');
        reticleDb.saveSpeakerEmbedding(db, {
          personId: a.person.id,
          embedding: embeddingBuffer,
          sourceMeetingId: meeting.id,
          modelVersion: MODEL_VERSION,
          qualityScore: null,
        });
        saved++;
      }
    }
    processed++;
  }

  console.log(`\nDone: ${processed} meetings processed, ${saved} embeddings saved, ${skipped} skipped`);
  if (args.dryRun) console.log('(dry run — re-run without --dry-run to save)');
}

main();
