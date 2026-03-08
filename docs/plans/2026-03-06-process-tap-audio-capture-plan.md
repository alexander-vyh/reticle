# Process Tap Audio Capture — Implementation Plan

**Date:** 2026-03-06
**Design:** `docs/plans/2026-03-06-process-tap-audio-capture-design.md`
**Goal:** Device-independent meeting audio capture, recorder reliability, hotkey voice capture.

## Outcomes

Each outcome is independently verifiable. Dependencies noted where they exist.

---

### Outcome 1: The recorder reports its own health

**What's true:** The tray app shows whether the recorder is healthy, recording, or
broken — not just whether the process is running.

**Verification:**

```bash
# Heartbeat file exists and is fresh (< 60s old)
cat ~/.reticle/heartbeats/meeting-recorder.json | jq '.timestamp'

# Tray shows recorder status (not null)
# Visual: open tray menu, recorder row shows "running" with last-seen time

# When recorder is killed, tray shows "unresponsive" within 60s
kill $(pgrep meeting-recorder)
# Visual: tray row changes to error state
```

**Changes:**
- `RecorderDaemon.swift`: add 30s heartbeat timer, write JSON to
  `~/.reticle/heartbeats/meeting-recorder.json`
- Heartbeat includes: service name, status, timestamp, recording state, meetingId,
  duration, captureMode, permissionStatus
- `tray/service-manager.js`: change HEARTBEAT_NAMES entry from `null` to
  `'meeting-recorder'`

**Depends on:** Nothing.

---

### Outcome 2: Recordings can't run forever

**What's true:** A recording that exceeds the configured max duration auto-stops
gracefully. The WAV and transcript are preserved.

**Verification:**

```bash
# Set a short max for testing
echo '{"maxRecordingDurationSeconds": 30}' > ~/.config/reticle/recorder.json

# Start a recording via HTTP
curl -X POST localhost:9847/start \
  -d '{"meetingId":"test","title":"test","attendees":[]}'

# Wait 35 seconds — recording auto-stops
curl localhost:9847/status
# → { "recording": false }

# WAV file exists and is playable
ls ~/.config/reticle/recordings/meeting-test-*.wav

# Heartbeat shows auto-stopped
cat ~/.reticle/heartbeats/meeting-recorder.json | jq '.status'
# → "auto-stopped"
```

**Changes:**
- `RecorderConfig.swift`: add `maxRecordingDurationSeconds` field (default 14400)
- `RecorderDaemon.swift`: add `DispatchSourceTimer` watchdog, started in
  `startRecording()`, cancelled in `stopRecording()`. On fire: call `stopRecording()`,
  log warning, write heartbeat with `"auto-stopped"` status.

**Depends on:** Outcome 1 (heartbeat writes the auto-stopped status).

---

### Outcome 3: Meeting audio is captured without virtual devices

**What's true:** When a Zoom/Teams/Slack meeting starts, the recorder captures all
participants' audio via Process Tap — regardless of which headset or speakers the
user is using. No BlackHole, no Multi-Output Device, no Audio MIDI Setup.

**Verification:**

```bash
# Start a Zoom call (or Teams/Slack huddle)
# Start recording
curl -X POST localhost:9847/start \
  -d '{"meetingId":"tap-test","title":"Tap Test","attendees":[]}'

# Check capture mode
curl localhost:9847/status | jq '.captureMode'
# → "tap"

# Switch from speakers to AirPods mid-call
# Recording continues without interruption

# Stop recording
curl -X POST localhost:9847/stop

# WAV contains both sides of the conversation (not just mic)
# Transcript JSON contains speech from all participants
cat ~/.config/reticle/transcripts/meeting-tap-test-*.json | jq '.segments[0].text'
```

**Changes:**
- New `ProcessTapCapture.swift` class:
  - Enumerates running processes by bundle ID
  - Translates PIDs to AudioObjectIDs
  - Creates `CATapDescription(stereoMixdownOfProcesses:)` with
    `muteBehavior = .unmuted`, `isPrivate = true`
  - Creates private aggregate device with tap attached
  - Sets up IOProc callback delivering Float32 audio
  - Teardown in correct order: stop → destroy IOProc → destroy aggregate → destroy tap
- `RecorderConfig.swift`: add `meetingApps` array (default: Zoom, Teams, Slack bundle IDs)
- `RecorderDaemon.swift`: new `resolveAudioSource()` method — tries ProcessTapCapture
  first, falls back to AUHAL. Sets `captureMode` in status dict.
- `status` dict gains `captureMode` field (`"tap"` or `"fallback"`)

**Dual-stream requirement:** Process Tap (meeting audio — all participants) runs
simultaneously with MicMonitor (user mic via AUHAL). Both streams feed independent
audio pipelines. The tap stream goes to WAV + Whisper for full-meeting transcription.
The mic stream provides the isolated user signal needed for future live analytics
(talk speed, listen/talk ratio, self/others attribution via VAD). Both must be
active during recording and both must survive output device switches.

**Reference implementations:**
- [AudioCap](https://github.com/insidegui/AudioCap) (per-process tap, Swift)
- [AudioTee](https://github.com/makeusabrew/audiotee) (global tap, CLI)

**Known gotcha:** Volume attenuation on >2 channel output devices. Monitor and
compensate if needed.

**Depends on:** TCC permission granted for the recorder binary.

---

### Outcome 4: When the tap can't be created, recording still works

**What's true:** If Process Tap permission is denied or no meeting apps are running,
the recorder falls back to AUHAL device capture silently. The tray shows the
degraded state.

**Verification:**

```bash
# Revoke audio capture permission in System Settings
# Start a recording
curl -X POST localhost:9847/start \
  -d '{"meetingId":"fallback-test","title":"Fallback","attendees":[]}'

# Response shows fallback
# → { "started": true, "captureMode": "fallback" }

# Status shows degraded mode
curl localhost:9847/status | jq '.captureMode'
# → "fallback"

# Tray menu shows: "Mic only (tap unavailable)"

# Re-grant permission, start a new recording
# → captureMode returns to "tap"
```

**Changes:**
- `RecorderDaemon.swift`: `resolveAudioSource()` catches tap creation failures,
  falls through to existing AUHAL path (`resolveDevice()`)
- `RecorderError`: add `.permissionDenied`, `.noMeetingAppsRunning`
- AUHAL fallback uses existing `preferredDevices` config
- `captureMode` in status/heartbeat distinguishes `"tap"` from `"fallback"`

**Depends on:** Outcome 3 (Process Tap code exists to fall back from).

---

### Outcome 5: The user and tray know when permission is missing

**What's true:** The tray continuously reflects permission status. The meeting popup
tells the user at join time if recording is degraded or unavailable.

**Verification:**

```bash
# With permission granted:
curl localhost:9847/status | jq '.permissionStatus'
# → "authorized"

# Revoke permission:
curl localhost:9847/status | jq '.permissionStatus'
# → "denied"

# Tray shows "⚠ Recording permission required"
# Click opens System Settings Privacy pane

# Start a meeting while permission denied:
# Meeting popup shows "Recording: mic only (tap unavailable)"
# Meeting alerts and popup function normally
```

**Changes:**
- `RecorderDaemon.swift` or `ProcessTapCapture.swift`: TCC pre-flight check on
  `/status` — probe `AudioHardwareCreateProcessTap` with minimal tap, immediately
  destroy on success
- `/status` response gains `permissionStatus` field (`"authorized"`, `"denied"`,
  `"unknown"`)
- `HTTPRouter.swift`: include `permissionStatus` in status response
- `meeting-alert-monitor.js`: distinguish `permissionDenied` from generic failure
  in `startRecording()`, pass to popup metadata
- Tray/Reticle.app: display permission warning when `permissionStatus != "authorized"`,
  click opens `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`

**Depends on:** Outcome 3 (the permission check is part of tap creation).

---

### Outcome 6: Browser-based meetings are captured when calendar says so

**What's true:** When `meeting-alert-monitor.js` detects a Google Meet or WebEx link
in a calendar event, it tells the recorder to temporarily include browser processes
in the tap. Browser audio is only captured during that meeting.

**Verification:**

```bash
# Create a test calendar event with a Google Meet link
# Wait for meeting-alert-monitor to detect it

# At meeting start:
curl localhost:9847/status | jq '.captureMode'
# → "tap"

# Join the Google Meet in Chrome/Safari
# Audio from all participants is captured

# After meeting stop:
# Browser processes are no longer in the tap
# Playing YouTube produces no recording
```

**Changes:**
- `meeting-alert-monitor.js`: `startRecording()` inspects meeting link via
  `meeting-link-parser.js`. If browser-based (Google Meet, WebEx), adds
  `browserMeeting: true` to the `/start` request body.
- `RecorderDaemon.swift`: `startRecording()` accepts `browserMeeting` parameter.
  When true, includes `browserApps` bundle IDs in the process tap alongside
  `meetingApps`.
- `RecorderConfig.swift`: add `browserApps` array (default: Safari, Chrome,
  Firefox, Arc bundle IDs)
- Tap teardown on `/stop` removes browser processes automatically (the entire
  tap is destroyed).

**Depends on:** Outcome 3 + changes to `meeting-alert-monitor.js`.

---

### Outcome 7: The user can capture voice notes with a hotkey

**What's true:** Pressing a global hotkey starts mic-only capture with live
transcription. In dictation mode, the transcribed text is available on the
clipboard. In notes mode, a transcript file is saved.

**Verification:**

```bash
# Via HTTP (hotkey sends this):
curl -X POST localhost:9847/capture/start \
  -d '{"mode":"dictation","source":"mic"}'
# → { "captureId": "cap-...", "streaming": true }

# SSE stream delivers transcript segments:
curl -N localhost:9847/capture/stream
# → event: transcript
# → data: {"text": "hello world", "final": true}

# Stop:
curl -X POST localhost:9847/capture/stop
# → { "transcript": "hello world", "wavPath": null }

# In notes mode: WAV + transcript JSON saved to disk
curl -X POST localhost:9847/capture/start \
  -d '{"mode":"notes","source":"mic"}'
# ... speak ...
curl -X POST localhost:9847/capture/stop
ls ~/.config/reticle/transcripts/capture-*.json
ls ~/.config/reticle/recordings/capture-*.wav

# Meeting takes priority:
curl -X POST localhost:9847/capture/start \
  -d '{"mode":"dictation","source":"mic"}'
curl -X POST localhost:9847/start \
  -d '{"meetingId":"m1","title":"Meeting","attendees":[]}'
# → capture auto-stopped, meeting starts
curl localhost:9847/status | jq '.recording'
# → true
```

**Changes:**
- `RecorderDaemon.swift`: new capture session model alongside meeting session.
  One active session at a time. `POST /start` auto-stops active capture.
- `HTTPRouter.swift`: new routes — `POST /capture/start`, `POST /capture/stop`,
  `GET /capture/stream`
- Capture uses AUHAL mic (same as MicMonitor path) + Python Whisper subprocess
- SSE stream returns transcript segments as they arrive from Python stdout
- Notes mode: saves WAV + transcript JSON on stop
- Dictation mode: no file saved, transcript streamed only
- Reticle.app (SwiftUI): register global hotkey, send HTTP, read SSE, write
  to `NSPasteboard` for dictation mode. Tray menu: "Start/Stop Voice Capture"

**Depends on:** Outcome 1 (session model), independent of Process Taps.

---

## Dependency Graph

```
1 (heartbeat) ──→ 2 (zombie protection)
      │
      └──────────→ 7 (hotkey capture)

3 (process taps) ──→ 4 (AUHAL fallback)
      │                    │
      ├──→ 5 (permission visibility)
      │
      └──→ 6 (browser meeting tap)
```

Two independent tracks:
- **Track A (reliability):** 1 → 2, then 7
- **Track B (capture migration):** 3 → 4, 5, 6

Tracks A and B can be built in parallel.
