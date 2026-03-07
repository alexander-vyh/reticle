# Process Tap Audio Capture Design

**Date:** 2026-03-06
**Status:** Approved
**Goal:** Replace device-based audio capture (BlackHole/ZoomAudioDevice) with Core Audio
Process Taps for device-independent system audio capture, add recorder reliability
features, and add a hotkey-triggered voice capture mode.

## Problem

The meeting recorder captures audio via CoreAudio AUHAL, requiring a virtual audio
device (BlackHole 2ch or ZoomAudioDevice) and manual OS-level routing (Multi-Output
Device in Audio MIDI Setup). This breaks every time the user switches headsets or
connects AirPods — the Multi-Output Device is bypassed and recordings capture silence.
ZoomAudioDevice only works for Zoom, not Teams/Meet/browser-based meetings.

Additionally, the recorder has no heartbeat (the tray can't distinguish "running" from
"running but stuck"), no zombie session protection, no visible failure signaling, and
no way to capture audio outside of scheduled meetings.

## Solution

### Core Audio Process Taps (macOS 14.2+)

`AudioHardwareCreateProcessTap` captures audio from specific processes regardless of
the system's output device. No virtual drivers, no routing configuration. The tap
creates a private aggregate device that reads the tapped audio — it does not change
the system output.

**Requires:** `kTCCServiceAudioCapture` permission grant. On macOS 15+, may require
monthly re-authorization.

**Reference implementations:** [AudioCap](https://github.com/insidegui/AudioCap),
[AudioTee](https://github.com/makeusabrew/audiotee)

## Architecture

### Dual-Source Hybrid

```
┌─ MEETING AUDIO ──────────────────────────────────────────────┐
│  CATapDescription (meeting apps: Zoom, Teams, Slack)         │
│       + temporary browser tap for calendar-detected Meet URLs │
│  → AudioHardwareCreateProcessTap → private aggregate device  │
│  → IOProc callback → Float32 → Int16 16kHz mono              │
│  → WAV file + Python stdin (Whisper)                         │
│                                                               │
│  FALLBACK (if tap unavailable):                              │
│  → AUHAL device capture (ZoomAudioDevice > BlackHole > default)│
│  → same conversion pipeline                                   │
└──────────────────────────────────────────────────────────────┘

┌─ MIC (unchanged) ───────────────────────────────────────────┐
│  AUHAL device capture (config.micDevice > system default)    │
│  → VAD (RMS threshold) for self/others attribution           │
│  → MicMonitor feeds LiveTranscriptStore                      │
└──────────────────────────────────────────────────────────────┘

┌─ HOTKEY CAPTURE (new) ──────────────────────────────────────┐
│  POST /capture/start → AUHAL mic capture                     │
│  → Python stdin (Whisper) → transcript text                  │
│  → SSE stream back to caller (for clipboard/file output)     │
│  One session at a time (409 if meeting recording active)     │
└──────────────────────────────────────────────────────────────┘
```

Meeting audio uses Process Taps (system audio from specific apps). Mic capture stays
AUHAL (physical input device for VAD). These are naturally separate streams serving
separate purposes.

### Tap Scope

Meeting apps only, identified by bundle ID:
- `us.zoom.xos` (Zoom)
- `com.microsoft.teams2` (Teams)
- `com.tinyspeck.slackmacgap` (Slack)

Browsers are **not** in the default tap — no way to filter by tab, so YouTube/music
would be captured alongside meetings.

**Exception:** When `meeting-alert-monitor.js` detects a browser-based meeting link
(Google Meet, WebEx), it passes `browserMeeting: true` in the `/start` request. The
recorder creates a **temporary** browser tap for that session's duration only, adding:
- `com.apple.Safari`
- `com.google.Chrome`
- `org.mozilla.firefox`
- `company.thebrowser.Browser`

The browser tap is destroyed when the meeting recording stops.

### AUHAL Fallback

When Process Tap creation fails (permission denied, no matching processes, API error):
1. Fall back to AUHAL device capture: ZoomAudioDevice → BlackHole → system default
2. Set `captureMode = "fallback"` in status
3. Recording proceeds — tray shows "Mic only (tap unavailable)"

This preserves backward compatibility. BlackHole/ZoomAudioDevice continue to work if
present but are no longer required.

## Process Tap Lifecycle

### Creation (on `POST /start`)

1. Enumerate running processes, filter to configured meeting app bundle IDs
2. Translate PIDs to `AudioObjectID` via `kAudioHardwarePropertyTranslatePIDToProcessObject`
3. If `browserMeeting: true`, include browser process IDs
4. Create `CATapDescription(stereoMixdownOfProcesses: processObjects)`
   - `muteBehavior = .unmuted` (audio plays normally through speakers)
   - `isPrivate = true` (aggregate device hidden from system lists)
5. `AudioHardwareCreateProcessTap(description, &tapID)`
6. Create private aggregate device with tap attached
7. `AudioDeviceCreateIOProcIDWithBlock` on aggregate device
8. `AudioDeviceStart` — audio flows through existing conversion pipeline

### Teardown (on `POST /stop`)

Order matters:
1. `AudioDeviceStop`
2. `AudioDeviceDestroyIOProcID`
3. `AudioHardwareDestroyAggregateDevice`
4. `AudioHardwareDestroyProcessTap`

### Tapped app exits mid-recording

Tap delivers silence but remains valid. Recording continues — the scheduled stop timer
handles meeting end. No auto-stop on app exit.

### Audio format

Tap delivers Float32 at the system output's sample rate (typically 48kHz). Existing
resampling to 16kHz mono Int16 stays the same. Sample rate cannot be controlled — must
resample after capture.

**Known gotcha:** Volume attenuation on devices with >2 output channels (-6dB per
additional stereo pair). Monitor and compensate if needed.

## TCC Permissions & Failure Visibility

### Permission model

Process Taps require `kTCCServiceAudioCapture`. On macOS 15, appears under
"Screen & System Audio Recording" in System Settings. May require monthly
re-authorization.

### Pre-flight check

`/status` endpoint gains a `permissionStatus` field:

```json
{
  "recording": false,
  "permissionStatus": "authorized",
  "captureMode": "tap"
}
```

Values: `"authorized"`, `"denied"`, `"unknown"`

Check probes `AudioHardwareCreateProcessTap` with a minimal tap description.
If it returns an error, permission is denied. Tap immediately destroyed if successful.

### Tray integration (continuous health polling)

Tray polls `/status`. `permissionStatus` feeds into the service menu:
- `authorized`: normal display
- `denied`/`unknown`: warning — "⚠ Recording permission required" with click action
  opening `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`

### Meeting popup (at join time)

When `POST /start` gets a permission error:
- If AUHAL fallback succeeded: `{ "error": "permissionDenied", "fallback": true, "captureMode": "fallback" }`
- If no fallback: `{ "error": "permissionDenied", "fallback": false }`
- Popup shows: "Recording: mic only (tap unavailable)" or "Recording unavailable"

### Error types

```swift
enum RecorderError: LocalizedError {
    case alreadyRecording
    case noDeviceFound
    case notRecording
    case permissionDenied
    case noMeetingAppsRunning
}
```

## Recorder Heartbeat & Zombie Protection

### Heartbeat

Written to `~/.reticle/heartbeats/meeting-recorder.json` every 30 seconds:

```json
{
  "service": "meeting-recorder",
  "status": "ok",
  "timestamp": 1741276800,
  "recording": true,
  "meetingId": "abc123",
  "duration": 1823.4,
  "captureMode": "tap",
  "permissionStatus": "authorized"
}
```

Fills the existing `null` slot in `tray/service-manager.js` HEARTBEAT_NAMES.

### Zombie session protection

`DispatchSourceTimer` in `RecorderDaemon` fires at `maxRecordingDurationSeconds`
(default 14400 = 4 hours, configurable in `recorder.json`).

- Timer starts on `startRecording()`, cancelled on `stopRecording()`
- If timer fires: graceful auto-stop, log warning, heartbeat shows `"auto-stopped"`
- WAV and transcript preserved

Also: `meeting-alert-monitor.js` already checks `/status` on startup and stops
recordings past their scheduled end time. Zombie timer is the backstop.

## Hotkey Voice Capture

### HTTP API

```
POST /capture/start  { "mode": "dictation"|"notes", "source": "mic" }
→ 200 { "captureId": "cap-1741276800", "streaming": true }
→ 409 { "error": "alreadyRecording" }

POST /capture/stop
→ 200 { "captureId": "...", "transcript": "...", "wavPath": "..." }

GET /capture/stream
→ SSE event: transcript  data: {"text": "...", "final": false}
→ SSE event: transcript  data: {"text": "...", "final": true}
→ SSE event: status      data: {"status": "stopped"}
```

### Modes

| Mode | Audio source | Output |
|------|-------------|--------|
| `dictation` | Mic (AUHAL) | SSE transcript → caller writes to clipboard |
| `notes` | Mic (AUHAL) | WAV + transcript JSON saved to disk |

### Session model

One active session at a time, shared with meeting recording:
- `POST /capture/start` returns 409 if meeting recording active
- `POST /start` (meeting) auto-stops any active capture (meeting takes priority)
- SSE receives `{ "status": "stopped", "reason": "meeting-priority" }`

### Trigger

Global hotkey + tray menu item, both in SwiftUI Reticle.app:
- Hotkey: configurable, toggle on/off with same key
- Tray: "Start Voice Capture" / "Stop Voice Capture"
- Both send HTTP to recorder daemon

Reticle.app handles clipboard (reads SSE, accumulates `final: true` segments,
writes to `NSPasteboard`).

## Configuration

New fields in `~/.config/reticle/recorder.json`:

```json
{
  "meetingApps": [
    "us.zoom.xos",
    "com.microsoft.teams2",
    "com.tinyspeck.slackmacgap"
  ],
  "browserApps": [
    "com.apple.Safari",
    "com.google.Chrome",
    "org.mozilla.firefox",
    "company.thebrowser.Browser"
  ],
  "maxRecordingDurationSeconds": 14400
}
```

Existing fields (`preferredDevices`, `micDevice`, etc.) remain for AUHAL fallback
and mic capture.

## Component Changes

### RecorderDaemon.swift

- New `ProcessTapCapture` class for tap lifecycle
- `resolveAudioSource()` replaces `resolveDevice()`: tap first → AUHAL fallback
- `startRecording()` gains `browserMeeting` parameter
- `status` dict gains `captureMode`, `permissionStatus`
- New error cases: `.permissionDenied`, `.noMeetingAppsRunning`
- Heartbeat timer (30s writes to heartbeat JSON)
- Zombie watchdog timer

### HTTPRouter.swift

- New routes: `POST /capture/start`, `POST /capture/stop`, `GET /capture/stream`
- `/status` extended with `permissionStatus`, `captureMode`

### RecorderConfig.swift

- New fields: `meetingApps`, `browserApps`, `maxRecordingDurationSeconds`
- `preferredDevices` order updated: `["BlackHole 2ch", "ZoomAudioDevice"]` (fallback only)

### meeting-alert-monitor.js

- `startRecording()` sends `browserMeeting: true` when meeting link is browser-based
- Handles `permissionDenied` response distinctly from generic failure
- Passes capture status to popup metadata

### Reticle.app (SwiftUI)

- Global hotkey registration (configurable)
- Tray menu: "Start/Stop Voice Capture"
- Clipboard handling: reads `/capture/stream` SSE, writes to `NSPasteboard`
- Permission warning: polls `/status`, shows warning when `permissionStatus != "authorized"`

### tray/service-manager.js (until SwiftUI replaces it)

- HEARTBEAT_NAMES: `'ai.reticle.meeting-recorder': 'meeting-recorder'`
- Display `captureMode` and `permissionStatus` from heartbeat data

### Files preserved

`CoreAudioRecorder.swift` stays as AUHAL fallback. `preferredDevices` config remains.
BlackHole/ZoomAudioDevice work if present but are no longer required.

## Meeting Recording Flow

```
Calendar poll → meeting-alert-monitor detects meeting
  → Check meeting link: browser-based?
  → POST /start { meetingId, title, attendees, browserMeeting }
  → RecorderDaemon.startRecording():
      1. Check TCC permission
      2. Enumerate meeting app processes by bundle ID
         + if browserMeeting: add browser processes
      3. SUCCESS: Create tap → aggregate → IOProc → start
         FAIL: AUHAL fallback
      4. Start conversion: Float32 → Int16 16kHz mono
      5. Start WAV writer + Python Whisper
      6. Start MicMonitor for VAD
      7. Start heartbeat (30s) + zombie watchdog
      8. Return { started, captureMode }
  → meeting-alert-monitor schedules stop at end + 2min
  → POST /stop → teardown tap, close WAV, finalize transcript
```

## Hotkey Capture Flow

```
User presses hotkey (or tray menu)
  → Reticle.app sends POST /capture/start { mode: "dictation" }
  → RecorderDaemon starts AUHAL mic + Python Whisper
  → Reticle.app reads GET /capture/stream SSE
  → Accumulates final segments to clipboard
  → User presses hotkey again
  → Reticle.app sends POST /capture/stop
  → Capture stops

Meeting starts while dictating:
  → POST /start arrives
  → Daemon auto-stops capture, starts meeting
  → SSE sends { status: "stopped", reason: "meeting-priority" }
```

## Permission Failure Flow

```
Tray polls GET /status every 5s
  → permissionStatus: "denied"
  → Tray shows "⚠ Recording permission required"
  → User clicks → System Settings Privacy pane

Meeting starts while permission denied:
  → POST /start → tap fails → AUHAL fallback
  → If fallback OK: popup shows "Recording: mic only"
  → If fallback fails: popup shows "Recording unavailable"
  → Meeting alerts function normally regardless
```
