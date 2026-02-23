# Live Transcription & Meeting Coaching Foundation — Design

**Date:** 2026-02-23
**Status:** Approved
**Scope:** Foundation + basic heuristic metrics with dual-stream capture

## Problem

The meeting recorder's live transcription subprocess (`stream_transcribe.py`) produces real-time transcript segments during recording, but these segments are accumulated in `activeSession.liveSegments` and discarded when the recording stops. No external consumer can access them, and the data is lost.

## Vision

Real-time meeting coaching: measure talking speed, detect monologues, track self vs. others talk ratio, and surface prompts about the ongoing conversation. This design covers the **foundation layer** — live transport, heuristic metrics, and dual-stream capture — not the overlay UI or LLM-powered analysis (future work).

## Prior Art

- **Poised:** Forks BGM (Background Music) to create two virtual audio devices (`Poised Speaker` + `Poised Mic`). Routes meeting audio through the speaker device and captures mic separately. Gets self/others separation without per-speaker diarization. Streams audio to servers for real-time coaching analysis, returns feedback to an overlay.
- **Screenpipe:** REST API with polling. No real-time streaming. Batch FTS indexing on 30-second cycles. Not a model for low-latency transcription delivery.

## Architecture

```
┌─ CoreAudioRecorder (enhanced) ───────────────────────────┐
│                                                           │
│  Stream A: Meeting Audio                                  │
│  Device: ZoomAudioDevice / MSTeamsAudio (from deviceHint) │
│  → WAV file (unchanged)                                   │
│  → PCM pipe to Python (unchanged)                         │
│                                                           │
│  Stream B: Self (Mic)                                     │
│  Device: config.micDevice (e.g. "MacBook Pro Microphone") │
│  → PCM pipe to MetricsEngine only (no WAV, no Python)     │
│                                                           │
└──────────────┬────────────────────┬───────────────────────┘
               │ Stream A           │ Stream B
               ▼                    ▼
┌─ stream_transcribe.py ┐   ┌─ MetricsEngine (Swift) ──────┐
│ (unchanged)            │   │                               │
│ JSON segments on stdout│   │ Voice Activity Detection:     │
└──────────┬─────────────┘   │  • RMS energy on mic stream   │
           │                 │  • "self is speaking" flag     │
           ▼                 │                               │
┌─ LiveTranscriptStore ──────┤ Heuristic Metrics:            │
│ • Segments array           │  • selfTalkTimeSec            │
│ • Tags segments as         │  • othersTalkTimeSec          │
│   self/others based on     │  • selfWpm (rolling 60s)      │
│   mic VAD timing           │  • silenceRatio               │
│ • SSE push to subscribers  │  • longestMonologueSec (self) │
│ • Persist on stop          │  • talkRatio (self/total)     │
└────────────────────────────┴───────────────────────────────┘
               │
               ▼
         GET /live (SSE)
```

### What changes in existing code

- `CoreAudioRecorder` — add second capture session for mic stream
- `RecorderConfig` — add `micDevice`, `micVadThreshold` fields
- `RecorderDaemon` — wire up LiveTranscriptStore, manage dual-stream start/stop lifecycle
- `HTTPServer` — support SSE keep-alive connections (don't close after response)
- `HTTPRouter` — add `GET /live` route

### What doesn't change

- `stream_transcribe.py` — untouched, still emits the same JSON
- `postprocess.py` — untouched
- `POST /start`, `POST /stop`, `GET /status`, `GET /health` — unchanged

## SSE Protocol

Endpoint: `GET /live`

### Event types

**`status`** — sent on connect and when recording starts/stops:
```
event: status
data: {"state":"recording","meetingId":"abc123","title":"Weekly Standup"}
```

**`segment`** — sent each time Python emits a transcript segment:
```
event: segment
data: {"id":0,"text":"Good morning everyone","start":10.32,"end":11.76,"speaker":"others"}
```

Includes monotonic `id` for gap detection. `speaker` is `"self"` or `"others"` based on mic VAD.

**`metrics`** — sent after every segment with updated rolling stats:
```
event: metrics
data: {"selfWpm":142,"silenceRatio":0.31,"selfTalkTimeSec":8.2,"othersTalkTimeSec":22.1,"talkRatio":0.27,"segmentCount":12,"longestMonologueSec":45.0,"elapsedSec":120.5}
```

### Connection behavior

- Client connects mid-recording → receives `status` event, then replay of all accumulated segments, then live updates.
- No recording active → receives `status: {"state":"idle"}`, stays connected waiting.
- Heartbeat: `:\n\n` comment every 15 seconds to keep connection alive.

## Dual-Stream Capture

### Self/others tagging

We don't run two Whisper instances. Instead:

1. Stream A (meeting audio) goes to Python for transcription (unchanged).
2. Stream B (mic) feeds a lightweight voice activity detector in Swift — RMS energy thresholding to determine when you're speaking.
3. When a transcript segment arrives from Python, check: "was the mic active during this segment's time window?" If yes → `"self"`. If no → `"others"`.

This is a heuristic. Simultaneous speech won't be perfectly attributed. But for coaching metrics (your WPM, your talk ratio, your monologue length) it's good enough.

### Device resolution

Meeting audio device: resolved from `deviceHint` in the `/start` request (existing logic).
Mic device: resolved from `config.micDevice` (new config field). Falls back to system default input.

### New config fields

```json
{
  "micDevice": "MacBook Pro Microphone",
  "micVadThreshold": 0.01
}
```

## MetricsEngine

Updated with each incoming segment. Produces a snapshot on demand.

| Metric | How | Purpose |
|--------|-----|---------|
| `selfWpm` | Words in self-tagged segments in last 60s ÷ spoken minutes | Your speaking pace |
| `silenceRatio` | Total silence ÷ total elapsed | Dead air detection |
| `selfTalkTimeSec` | Sum of self-tagged segment durations | Your cumulative talk time |
| `othersTalkTimeSec` | Sum of others-tagged segment durations | Others' cumulative talk time |
| `talkRatio` | selfTalkTime ÷ (selfTalkTime + othersTalkTime) | Are you dominating or silent? |
| `longestMonologueSec` | Longest run of consecutive self-tagged segments with < 1.5s gaps | Monologue detection |
| `longestSilenceSec` | Largest gap between consecutive segments | Awkward pause detection |
| `segmentCount` | Total segments received | Activity indicator |
| `avgSegmentLenWords` | Total words ÷ segment count | Fragment vs. monologue indicator |
| `elapsedSec` | Time since recording started | Clock reference |

Not computed yet (future): tone/sentiment, filler words, per-remote-speaker metrics.

## Persistence

On `stopRecording()`, the `LiveTranscriptStore` writes to disk before the session is cleared.

**Output file:** `~/.config/claudia/recordings/meeting-{meetingId}-{date}-live.json`

```json
{
  "meetingId": "abc123",
  "title": "Weekly Standup",
  "startTime": "2026-02-23T09:20:54Z",
  "endTime": "2026-02-23T09:55:12Z",
  "segments": [
    {"id": 0, "text": "Good morning everyone", "start": 10.32, "end": 11.76, "speaker": "self"}
  ],
  "finalMetrics": {
    "selfWpm": 138,
    "silenceRatio": 0.28,
    "selfTalkTimeSec": 842.0,
    "othersTalkTimeSec": 1000.0,
    "talkRatio": 0.46,
    "longestMonologueSec": 185.0,
    "longestSilenceSec": 14.2,
    "segmentCount": 247,
    "avgSegmentLenWords": 12.3,
    "elapsedSec": 2058.0
  }
}
```

Separate from the post-processed transcript (which re-transcribes the full WAV with higher accuracy + speaker diarization).

## Testing

**Python unit tests (`recorder/tests/`):**
- `test_metrics_engine.py` — MetricsEngine computations with synthetic segment data

**Swift integration (extend `test_http_api.py`):**
- `GET /live` returns SSE headers and status event on connect
- Start recording → segment and metrics events arrive via SSE
- Stop recording → status:stopped event, live JSON file persisted
- Mid-recording connect → replay of accumulated segments

**Manual smoke test:**
- Start daemon, record during real meeting, verify SSE with curl, stop, check output

## Components Summary

| Component | Change | Description |
|-----------|--------|-------------|
| `CoreAudioRecorder` | Modify | Add second capture session for mic |
| `RecorderConfig` | Modify | Add `micDevice`, `micVadThreshold` |
| `LiveTranscriptStore` | New | Segment storage, SSE subscribers, persistence |
| `MetricsEngine` | New | Rolling heuristics, mic VAD, self/others tagging |
| `RecorderDaemon` | Modify | Wire up store, dual-stream lifecycle |
| `HTTPServer` | Modify | SSE keep-alive support |
| `HTTPRouter` | Modify | Add `GET /live` route |
| `RequestTypes` | Modify | SSE event types, metrics response |
| `stream_transcribe.py` | Unchanged | |
| `postprocess.py` | Unchanged | |

## Future Work (not in this round)

- On-screen overlay for live metrics and coaching prompts
- LLM-powered analysis (topic relevance, tone detection)
- Filler word detection via word-level Whisper timestamps
- Custom virtual audio driver (BGM fork) for platform-agnostic capture
- Per-remote-speaker metrics via online pyannote diarization
- Overlapping transcription windows for smoother text output
