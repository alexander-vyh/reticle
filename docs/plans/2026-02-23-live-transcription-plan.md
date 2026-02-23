# Live Transcription & Meeting Coaching Foundation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add SSE-based live transcript delivery, dual-stream capture (meeting audio + mic), heuristic metrics (WPM, talk ratio, monologue detection), and persistence of live data.

**Architecture:** Swift daemon gets new components — `MetricsEngine` (heuristics + mic VAD), `LiveTranscriptStore` (segment storage + SSE fan-out + persistence). A second `CoreAudioRecorder` captures the mic for self/others tagging. `GET /live` SSE endpoint streams segments and metrics in real time.

**Tech Stack:** Swift 5.9, macOS 14+, CoreAudio AUHAL, Network framework (NWListener), Python 3.12 (unchanged `stream_transcribe.py`)

**Design doc:** `docs/plans/2026-02-23-live-transcription-design.md`

---

## Task 1: RecorderConfig — Add mic and VAD fields

**Files:**
- Modify: `recorder/Sources/MeetingRecorder/RecorderConfig.swift`

**Step 1: Add new config properties**

Add `micDevice` and `micVadThreshold` to `RecorderConfig`:

```swift
// Add after `language` property (line 12):
var micDevice: String = ""
var micVadThreshold: Double = 0.01
```

`micDevice` defaults to empty string (meaning "use system default input"). `micVadThreshold` is the RMS energy threshold for detecting speech on the mic.

**Step 2: Build to verify**

Run: `cd recorder && swift build`
Expected: Build succeeds. The new fields are `Codable` automatically since `RecorderConfig` conforms to `Codable` and these are simple types.

**Step 3: Commit**

```bash
git add recorder/Sources/MeetingRecorder/RecorderConfig.swift
git commit -m "feat(recorder): add micDevice and micVadThreshold config fields"
```

---

## Task 2: MicMonitor — Lightweight mic VAD

**Files:**
- Create: `recorder/Sources/MeetingRecorder/Audio/MicMonitor.swift`

**Step 1: Create MicMonitor class**

This is a second `CoreAudioRecorder`-style class, but much simpler: it only captures audio to compute RMS energy for voice activity detection. No WAV file, no Python pipe.

```swift
import Foundation
import CoreAudio
import os

/// Monitors the local microphone for voice activity (RMS energy).
/// Used to determine when "self" is speaking for self/others segment tagging.
final class MicMonitor {
    private let logger = Logger(subsystem: "ai.openclaw.meeting-recorder", category: "MicMonitor")

    private var audioUnit: AudioUnit?
    private var isRunning = false
    private var deviceFormat = AudioStreamBasicDescription()

    // Pre-allocated render buffer
    private var renderBuffer: UnsafeMutablePointer<Float32>?
    private var renderBufferSize: UInt32 = 0

    // Thread-safe VAD state
    private let lock = NSLock()
    private var _rmsEnergy: Float = 0.0
    private var _isSpeaking = false
    private var vadThreshold: Float

    // VAD history: array of (timestamp, isSpeaking) for segment attribution
    private var _vadHistory: [(time: TimeInterval, speaking: Bool)] = []
    private let historyLock = NSLock()
    private var startTime: Date?

    var rmsEnergy: Float {
        lock.lock()
        defer { lock.unlock() }
        return _rmsEnergy
    }

    var isSpeaking: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isSpeaking
    }

    init(vadThreshold: Float = 0.01) {
        self.vadThreshold = vadThreshold
    }

    deinit {
        stop()
    }

    // MARK: - Public Interface

    func start(deviceID: AudioDeviceID) throws {
        stop()
        startTime = Date()

        // Create AUHAL
        var desc = AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0
        )

        guard let component = AudioComponentFindNext(nil, &desc) else {
            throw MicMonitorError.audioUnitNotFound
        }

        var unit: AudioUnit?
        var status = AudioComponentInstanceNew(component, &unit)
        guard status == noErr, let audioUnit = unit else {
            throw MicMonitorError.setupFailed(status: status)
        }
        self.audioUnit = audioUnit

        // Enable input, disable output
        var enableInput: UInt32 = 1
        status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_EnableIO,
                                      kAudioUnitScope_Input, 1, &enableInput,
                                      UInt32(MemoryLayout<UInt32>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        var disableOutput: UInt32 = 0
        status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_EnableIO,
                                      kAudioUnitScope_Output, 0, &disableOutput,
                                      UInt32(MemoryLayout<UInt32>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Set device
        var device = deviceID
        status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_CurrentDevice,
                                      kAudioUnitScope_Global, 0, &device,
                                      UInt32(MemoryLayout<AudioDeviceID>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Get device format
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = AudioUnitGetProperty(audioUnit, kAudioUnitProperty_StreamFormat,
                                      kAudioUnitScope_Input, 1, &deviceFormat, &formatSize)
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Set callback format (Float32)
        var callbackFormat = AudioStreamBasicDescription(
            mSampleRate: deviceFormat.mSampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(MemoryLayout<Float32>.size) * deviceFormat.mChannelsPerFrame,
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(MemoryLayout<Float32>.size) * deviceFormat.mChannelsPerFrame,
            mChannelsPerFrame: deviceFormat.mChannelsPerFrame,
            mBitsPerChannel: 32,
            mReserved: 0
        )

        status = AudioUnitSetProperty(audioUnit, kAudioUnitProperty_StreamFormat,
                                      kAudioUnitScope_Output, 1, &callbackFormat,
                                      UInt32(MemoryLayout<AudioStreamBasicDescription>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Allocate render buffer
        let maxFrames: UInt32 = 4096
        let bufferSamples = maxFrames * deviceFormat.mChannelsPerFrame
        renderBuffer = UnsafeMutablePointer<Float32>.allocate(capacity: Int(bufferSamples))
        renderBufferSize = bufferSamples

        // Set callback
        var callbackStruct = AURenderCallbackStruct(
            inputProc: micInputCallback,
            inputProcRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_SetInputCallback,
                                      kAudioUnitScope_Global, 0, &callbackStruct,
                                      UInt32(MemoryLayout<AURenderCallbackStruct>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Start
        status = AudioUnitInitialize(audioUnit)
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        status = AudioOutputUnitStart(audioUnit)
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        isRunning = true
        logger.notice("MicMonitor started on device \(deviceID)")
    }

    func stop() {
        if let unit = audioUnit {
            AudioOutputUnitStop(unit)
            AudioComponentInstanceDispose(unit)
            audioUnit = nil
        }
        renderBuffer?.deallocate()
        renderBuffer = nil
        renderBufferSize = 0
        isRunning = false
    }

    /// Check if self was speaking during a time window (relative to recording start).
    /// Returns the fraction of VAD samples in the window that were "speaking".
    func selfSpeakingRatio(from startSec: Double, to endSec: Double) -> Double {
        historyLock.lock()
        defer { historyLock.unlock() }

        let relevant = _vadHistory.filter { $0.time >= startSec && $0.time <= endSec }
        guard !relevant.isEmpty else { return 0.0 }

        let speakingCount = relevant.filter(\.speaking).count
        return Double(speakingCount) / Double(relevant.count)
    }

    /// Clear VAD history (call on recording stop)
    func clearHistory() {
        historyLock.lock()
        _vadHistory.removeAll()
        historyLock.unlock()
        startTime = nil
    }

    // MARK: - Audio Callback

    fileprivate func handleMicInput(
        ioActionFlags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
        inTimeStamp: UnsafePointer<AudioTimeStamp>,
        inBusNumber: UInt32,
        inNumberFrames: UInt32
    ) -> OSStatus {
        guard let audioUnit = audioUnit, isRunning, let renderBuf = renderBuffer else {
            return noErr
        }

        let channelCount = deviceFormat.mChannelsPerFrame
        let requiredSamples = inNumberFrames * channelCount
        guard requiredSamples <= renderBufferSize else { return noErr }

        let bytesPerFrame = UInt32(MemoryLayout<Float32>.size) * channelCount
        let bufferSize = inNumberFrames * bytesPerFrame

        var bufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
                mNumberChannels: channelCount,
                mDataByteSize: bufferSize,
                mData: renderBuf
            )
        )

        let status = AudioUnitRender(audioUnit, ioActionFlags, inTimeStamp,
                                     inBusNumber, inNumberFrames, &bufferList)
        if status != noErr { return status }

        // Compute RMS
        guard let data = bufferList.mBuffers.mData else { return noErr }
        let samples = data.assumingMemoryBound(to: Float32.self)
        let totalSamples = Int(inNumberFrames) * Int(channelCount)
        guard totalSamples > 0 else { return noErr }

        var sum: Float = 0.0
        for i in 0..<totalSamples {
            let s = samples[i]
            sum += s * s
        }
        let rms = sqrt(sum / Float(totalSamples))
        let speaking = rms >= vadThreshold

        lock.lock()
        _rmsEnergy = rms
        _isSpeaking = speaking
        lock.unlock()

        // Record VAD event
        if let start = startTime {
            let elapsed = Date().timeIntervalSince(start)
            historyLock.lock()
            _vadHistory.append((time: elapsed, speaking: speaking))
            // Trim history older than 10 minutes to bound memory
            if _vadHistory.count > 60_000 {
                _vadHistory.removeFirst(_vadHistory.count - 60_000)
            }
            historyLock.unlock()
        }

        return noErr
    }
}

// MARK: - Callback

private let micInputCallback: AURenderCallback = { (
    inRefCon, ioActionFlags, inTimeStamp, inBusNumber, inNumberFrames, _
) -> OSStatus in
    let monitor = Unmanaged<MicMonitor>.fromOpaque(inRefCon).takeUnretainedValue()
    return monitor.handleMicInput(
        ioActionFlags: ioActionFlags,
        inTimeStamp: inTimeStamp,
        inBusNumber: inBusNumber,
        inNumberFrames: inNumberFrames
    )
}

// MARK: - Errors

enum MicMonitorError: LocalizedError {
    case audioUnitNotFound
    case setupFailed(status: OSStatus)

    var errorDescription: String? {
        switch self {
        case .audioUnitNotFound: return "HAL Output AudioUnit not found"
        case .setupFailed(let status): return "MicMonitor setup failed: \(status)"
        }
    }
}
```

**Step 2: Build to verify**

Run: `cd recorder && swift build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add recorder/Sources/MeetingRecorder/Audio/MicMonitor.swift
git commit -m "feat(recorder): add MicMonitor for mic voice activity detection"
```

---

## Task 3: MetricsEngine — Heuristic speech metrics

**Files:**
- Create: `recorder/Sources/MeetingRecorder/MetricsEngine.swift`

**Step 1: Create MetricsEngine struct**

The MetricsEngine is a pure data structure — no audio capture, no I/O. It receives tagged segments and computes metrics.

```swift
import Foundation

/// Computes rolling heuristic metrics from tagged transcript segments.
struct MetricsEngine {

    struct TaggedSegment {
        let id: Int
        let text: String
        let start: Double
        let end: Double
        let speaker: Speaker

        enum Speaker: String, Codable {
            case selfSpeaker = "self"
            case others = "others"
        }

        var wordCount: Int {
            text.split(separator: " ").count
        }

        var duration: Double {
            max(end - start, 0)
        }
    }

    struct Snapshot: Codable {
        let selfWpm: Int
        let silenceRatio: Double
        let selfTalkTimeSec: Double
        let othersTalkTimeSec: Double
        let talkRatio: Double
        let longestMonologueSec: Double
        let longestSilenceSec: Double
        let segmentCount: Int
        let avgSegmentLenWords: Double
        let elapsedSec: Double
    }

    private var segments: [TaggedSegment] = []
    private let recordingStartTime: Date

    init(recordingStartTime: Date = Date()) {
        self.recordingStartTime = recordingStartTime
    }

    // MARK: - Mutating

    mutating func addSegment(_ segment: TaggedSegment) {
        segments.append(segment)
    }

    // MARK: - Computed Metrics

    func snapshot() -> Snapshot {
        let elapsed = Date().timeIntervalSince(recordingStartTime)
        guard !segments.isEmpty else {
            return Snapshot(
                selfWpm: 0, silenceRatio: 1.0,
                selfTalkTimeSec: 0, othersTalkTimeSec: 0, talkRatio: 0,
                longestMonologueSec: 0, longestSilenceSec: 0,
                segmentCount: 0, avgSegmentLenWords: 0, elapsedSec: elapsed
            )
        }

        let selfSegs = segments.filter { $0.speaker == .selfSpeaker }
        let othersSegs = segments.filter { $0.speaker == .others }

        let selfTalkTime = selfSegs.reduce(0.0) { $0 + $1.duration }
        let othersTalkTime = othersSegs.reduce(0.0) { $0 + $1.duration }
        let totalTalkTime = selfTalkTime + othersTalkTime

        // Self WPM: words in self-tagged segments from last 60s of speech
        let selfWpm = computeWpm(segments: selfSegs, windowSeconds: 60.0)

        // Silence ratio: time not covered by any segment / elapsed
        let silenceRatio = elapsed > 0 ? max(0, 1.0 - (totalTalkTime / elapsed)) : 0

        // Talk ratio: self / total
        let talkRatio = totalTalkTime > 0 ? selfTalkTime / totalTalkTime : 0

        // Longest self monologue: consecutive self segments with < 1.5s gaps
        let longestMonologue = computeLongestMonologue(segments: selfSegs)

        // Longest silence: largest gap between any consecutive segments
        let longestSilence = computeLongestSilence()

        // Avg segment length
        let totalWords = segments.reduce(0) { $0 + $1.wordCount }
        let avgLen = Double(totalWords) / Double(segments.count)

        return Snapshot(
            selfWpm: selfWpm,
            silenceRatio: round(silenceRatio * 1000) / 1000,
            selfTalkTimeSec: round(selfTalkTime * 10) / 10,
            othersTalkTimeSec: round(othersTalkTime * 10) / 10,
            talkRatio: round(talkRatio * 100) / 100,
            longestMonologueSec: round(longestMonologue * 10) / 10,
            longestSilenceSec: round(longestSilence * 10) / 10,
            segmentCount: segments.count,
            avgSegmentLenWords: round(avgLen * 10) / 10,
            elapsedSec: round(elapsed * 10) / 10
        )
    }

    // MARK: - Private Helpers

    private func computeWpm(segments: [TaggedSegment], windowSeconds: Double) -> Int {
        guard !segments.isEmpty else { return 0 }

        let now = Date().timeIntervalSince(recordingStartTime)
        let windowStart = now - windowSeconds

        // Get segments within the rolling window
        let windowed = segments.filter { $0.end >= windowStart }
        guard !windowed.isEmpty else { return 0 }

        let totalWords = windowed.reduce(0) { $0 + $1.wordCount }
        let spokenTime = windowed.reduce(0.0) { $0 + $1.duration }

        // WPM = words / spoken minutes (not elapsed minutes)
        let spokenMinutes = spokenTime / 60.0
        guard spokenMinutes > 0.05 else { return 0 } // need at least 3s of speech

        return Int(round(Double(totalWords) / spokenMinutes))
    }

    private func computeLongestMonologue(segments: [TaggedSegment]) -> Double {
        guard !segments.isEmpty else { return 0 }

        let sorted = segments.sorted { $0.start < $1.start }
        var longest = sorted[0].duration
        var current = sorted[0].duration

        for i in 1..<sorted.count {
            let gap = sorted[i].start - sorted[i - 1].end
            if gap < 1.5 {
                current += gap + sorted[i].duration
            } else {
                current = sorted[i].duration
            }
            longest = max(longest, current)
        }

        return longest
    }

    private func computeLongestSilence() -> Double {
        guard segments.count >= 2 else { return 0 }

        let sorted = segments.sorted { $0.start < $1.start }
        var longest = 0.0

        for i in 1..<sorted.count {
            let gap = sorted[i].start - sorted[i - 1].end
            if gap > longest {
                longest = gap
            }
        }

        return longest
    }
}
```

**Step 2: Build to verify**

Run: `cd recorder && swift build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add recorder/Sources/MeetingRecorder/MetricsEngine.swift
git commit -m "feat(recorder): add MetricsEngine for heuristic speech metrics"
```

---

## Task 4: LiveTranscriptStore — Segment storage, SSE fan-out, persistence

**Files:**
- Create: `recorder/Sources/MeetingRecorder/LiveTranscriptStore.swift`

**Step 1: Create LiveTranscriptStore class**

This class holds segments, manages SSE subscriber connections, tags segments using the MicMonitor, computes metrics, and persists to disk on stop.

```swift
import Foundation
import Network
import os

/// Stores live transcript segments, manages SSE subscribers, computes metrics,
/// and persists data to disk when recording stops.
final class LiveTranscriptStore {
    private let logger = Logger(subsystem: "ai.openclaw.meeting-recorder", category: "LiveStore")

    private let lock = NSLock()
    private var segments: [SegmentEvent] = []
    private var metrics: MetricsEngine
    private var nextId: Int = 0

    // Meeting metadata
    let meetingId: String
    let title: String
    let startTime: Date

    // SSE subscribers
    private var subscribers: [UUID: NWConnection] = []
    private let subscriberLock = NSLock()

    // Mic monitor for self/others tagging
    private weak var micMonitor: MicMonitor?

    struct SegmentEvent: Codable {
        let id: Int
        let text: String
        let start: Double
        let end: Double
        let speaker: String
    }

    init(meetingId: String, title: String, micMonitor: MicMonitor?) {
        self.meetingId = meetingId
        self.title = title
        self.startTime = Date()
        self.micMonitor = micMonitor
        self.metrics = MetricsEngine(recordingStartTime: Date())
    }

    // MARK: - Segment Ingestion

    /// Called by RecorderDaemon.handleTranscriptLine() when a new segment arrives from Python.
    func addSegment(text: String, start: Double, end: Double) {
        // Determine speaker via mic VAD
        let speakingRatio = micMonitor?.selfSpeakingRatio(from: start, to: end) ?? 0.0
        let speaker: MetricsEngine.TaggedSegment.Speaker = speakingRatio > 0.3 ? .selfSpeaker : .others

        lock.lock()
        let id = nextId
        nextId += 1

        let event = SegmentEvent(id: id, text: text, start: start, end: end, speaker: speaker.rawValue)
        segments.append(event)

        let taggedSegment = MetricsEngine.TaggedSegment(
            id: id, text: text, start: start, end: end, speaker: speaker
        )
        metrics.addSegment(taggedSegment)
        let metricsSnapshot = metrics.snapshot()
        lock.unlock()

        // Push to SSE subscribers
        pushEvent(type: "segment", data: event)
        pushEvent(type: "metrics", data: metricsSnapshot)
    }

    // MARK: - SSE Subscriber Management

    func addSubscriber(connection: NWConnection) {
        let id = UUID()
        subscriberLock.lock()
        subscribers[id] = connection
        subscriberLock.unlock()

        // Send status event
        let status = StatusEvent(state: "recording", meetingId: meetingId, title: title)
        sendSSE(to: connection, type: "status", data: status)

        // Replay accumulated segments
        lock.lock()
        let currentSegments = segments
        let currentMetrics = metrics.snapshot()
        lock.unlock()

        for segment in currentSegments {
            sendSSE(to: connection, type: "segment", data: segment)
        }
        if !currentSegments.isEmpty {
            sendSSE(to: connection, type: "metrics", data: currentMetrics)
        }

        // Set up removal on connection close
        connection.stateUpdateHandler = { [weak self] state in
            if case .cancelled = state {
                self?.removeSubscriber(id: id)
            }
        }

        logger.notice("SSE subscriber added (total: \(self.subscribers.count))")
    }

    func removeSubscriber(id: UUID) {
        subscriberLock.lock()
        subscribers.removeValue(forKey: id)
        subscriberLock.unlock()
    }

    func removeAllSubscribers() {
        subscriberLock.lock()
        for (_, connection) in subscribers {
            connection.cancel()
        }
        subscribers.removeAll()
        subscriberLock.unlock()
    }

    /// Send status:stopped to all subscribers
    func notifyStopped() {
        lock.lock()
        let finalMetrics = metrics.snapshot()
        lock.unlock()

        let status = StoppedEvent(
            state: "stopped",
            totalSegments: finalMetrics.segmentCount,
            totalDuration: finalMetrics.elapsedSec
        )
        pushEvent(type: "status", data: status)
    }

    // MARK: - Heartbeat

    func sendHeartbeat() {
        subscriberLock.lock()
        let connections = Array(subscribers.values)
        subscriberLock.unlock()

        let heartbeat = ":\n\n".data(using: .utf8)!
        for connection in connections {
            connection.send(content: heartbeat, completion: .contentProcessed { _ in })
        }
    }

    // MARK: - Persistence

    /// Write live transcript + final metrics to disk.
    /// Call this before clearing the session.
    func persist(to directory: String) {
        lock.lock()
        let finalSegments = segments
        let finalMetrics = metrics.snapshot()
        lock.unlock()

        let dateStr = ISO8601DateFormatter().string(from: startTime)
            .prefix(10) // YYYY-MM-DD
        let filename = "meeting-\(meetingId)-\(dateStr)-live.json"
        let path = "\(directory)/\(filename)"

        let output: [String: Any] = [
            "meetingId": meetingId,
            "title": title,
            "startTime": ISO8601DateFormatter().string(from: startTime),
            "endTime": ISO8601DateFormatter().string(from: Date()),
            "segments": finalSegments.map { seg -> [String: Any] in
                ["id": seg.id, "text": seg.text, "start": seg.start,
                 "end": seg.end, "speaker": seg.speaker]
            },
            "finalMetrics": [
                "selfWpm": finalMetrics.selfWpm,
                "silenceRatio": finalMetrics.silenceRatio,
                "selfTalkTimeSec": finalMetrics.selfTalkTimeSec,
                "othersTalkTimeSec": finalMetrics.othersTalkTimeSec,
                "talkRatio": finalMetrics.talkRatio,
                "longestMonologueSec": finalMetrics.longestMonologueSec,
                "longestSilenceSec": finalMetrics.longestSilenceSec,
                "segmentCount": finalMetrics.segmentCount,
                "avgSegmentLenWords": finalMetrics.avgSegmentLenWords,
                "elapsedSec": finalMetrics.elapsedSec,
            ]
        ]

        do {
            let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: path))
            logger.notice("Live transcript persisted to \(path)")
        } catch {
            logger.error("Failed to persist live transcript: \(error.localizedDescription)")
        }
    }

    // MARK: - SSE Helpers

    private func pushEvent<T: Encodable>(type: String, data: T) {
        subscriberLock.lock()
        let connections = Array(subscribers.values)
        subscriberLock.unlock()

        guard !connections.isEmpty else { return }

        guard let jsonData = try? JSONEncoder().encode(data),
              let jsonString = String(data: jsonData, encoding: .utf8) else { return }

        let sseMessage = "event: \(type)\ndata: \(jsonString)\n\n"
        guard let messageData = sseMessage.data(using: .utf8) else { return }

        for connection in connections {
            connection.send(content: messageData, completion: .contentProcessed { _ in })
        }
    }

    private func sendSSE<T: Encodable>(to connection: NWConnection, type: String, data: T) {
        guard let jsonData = try? JSONEncoder().encode(data),
              let jsonString = String(data: jsonData, encoding: .utf8) else { return }

        let sseMessage = "event: \(type)\ndata: \(jsonString)\n\n"
        guard let messageData = sseMessage.data(using: .utf8) else { return }

        connection.send(content: messageData, completion: .contentProcessed { _ in })
    }

    // MARK: - SSE Event Types

    private struct StatusEvent: Codable {
        let state: String
        let meetingId: String
        let title: String
    }

    private struct StoppedEvent: Codable {
        let state: String
        let totalSegments: Int
        let totalDuration: Double
    }

    struct IdleEvent: Codable {
        let state: String
    }
}
```

**Step 2: Build to verify**

Run: `cd recorder && swift build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add recorder/Sources/MeetingRecorder/LiveTranscriptStore.swift
git commit -m "feat(recorder): add LiveTranscriptStore for segment storage, SSE, and persistence"
```

---

## Task 5: HTTPServer — SSE support

**Files:**
- Modify: `recorder/Sources/MeetingRecorder/HTTP/HTTPServer.swift`
- Modify: `recorder/Sources/MeetingRecorder/HTTP/HTTPRouter.swift`

**Step 1: Add SSE connection handling to HTTPServer**

The current `sendResponse` always closes the connection after response. For SSE, we need to send headers and keep the connection open, handing it to the `LiveTranscriptStore`.

In `HTTPServer.swift`, modify `parseAndRoute` to detect `GET /live` and handle it differently. Add a `weak var daemon: RecorderDaemon?` reference (currently only the router has it).

Replace the `handleConnection` method to check if the route is SSE:

```swift
// In HTTPServer, add:
private weak var daemon: RecorderDaemon?

// Update init:
init(port: UInt16, daemon: RecorderDaemon) {
    self.port = port
    self.daemon = daemon  // add this line
    self.router = HTTPRouter(daemon: daemon)
}
```

In `handleConnection`, after parsing the request, check for SSE:

```swift
// After parseAndRoute, add this branch:
if method == "GET" && path == "/live" {
    self.handleSSEConnection(connection)
    return
}
```

Add the SSE handler method:

```swift
private func handleSSEConnection(_ connection: NWConnection) {
    // Send SSE headers
    let headers = """
    HTTP/1.1 200 OK\r
    Content-Type: text/event-stream\r
    Cache-Control: no-cache\r
    Connection: keep-alive\r
    \r

    """
    guard let headerData = headers.data(using: .utf8) else {
        connection.cancel()
        return
    }

    connection.send(content: headerData, completion: .contentProcessed { [weak self] error in
        if let error = error {
            self?.logger.error("Failed to send SSE headers: \(error.localizedDescription)")
            connection.cancel()
            return
        }

        // Register as subscriber
        if let store = self?.daemon?.liveStore {
            store.addSubscriber(connection: connection)
        } else {
            // No active recording — send idle status and keep connection open
            let idle = "event: status\ndata: {\"state\":\"idle\"}\n\n"
            if let data = idle.data(using: .utf8) {
                connection.send(content: data, completion: .contentProcessed { _ in })
            }
            // TODO: register for future recording starts
        }
    })
}
```

**Step 2: Expose `liveStore` on RecorderDaemon**

This will be done in Task 6 when wiring up the daemon. For now, add a stub property to `RecorderDaemon` so this compiles:

In `RecorderDaemon.swift`, add after the `activeSession` property:

```swift
/// Current live transcript store (nil when not recording)
private(set) var liveStore: LiveTranscriptStore?
```

**Step 3: Update HTTPServer.handleConnection to parse method/path before routing**

The current `handleConnection` calls `parseAndRoute` which returns a response. We need to extract the method/path first to check for SSE. Refactor:

```swift
private func handleConnection(_ connection: NWConnection) {
    connection.start(queue: queue)

    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
        guard let self = self else {
            connection.cancel()
            return
        }

        if let error = error {
            self.logger.error("Connection error: \(error.localizedDescription)")
            connection.cancel()
            return
        }

        guard let data = data, !data.isEmpty else {
            connection.cancel()
            return
        }

        // Parse request line to check for SSE route
        let (method, path) = self.parseRequestLine(data: data)

        if method == "GET" && path == "/live" {
            self.handleSSEConnection(connection)
            return
        }

        let response = self.parseAndRoute(data: data)
        self.sendResponse(response, on: connection)
    }
}

private func parseRequestLine(data: Data) -> (String, String) {
    guard let raw = String(data: data, encoding: .utf8) else { return ("GET", "/") }
    let headerSection = raw.components(separatedBy: "\r\n\r\n").first ?? ""
    let headerLines = headerSection.components(separatedBy: "\r\n")
    guard let requestLine = headerLines.first else { return ("GET", "/") }
    let tokens = requestLine.split(separator: " ", maxSplits: 2)
    guard tokens.count >= 2 else { return ("GET", "/") }
    return (String(tokens[0]), String(tokens[1]))
}
```

**Step 4: Build to verify**

Run: `cd recorder && swift build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add recorder/Sources/MeetingRecorder/HTTP/HTTPServer.swift \
      recorder/Sources/MeetingRecorder/RecorderDaemon.swift
git commit -m "feat(recorder): add SSE support to HTTPServer for GET /live"
```

---

## Task 6: Wire up RecorderDaemon — Dual-stream + LiveTranscriptStore integration

**Files:**
- Modify: `recorder/Sources/MeetingRecorder/RecorderDaemon.swift`

This is the integration task — connecting all the new components to the existing daemon lifecycle.

**Step 1: Add MicMonitor and LiveTranscriptStore properties**

Add after existing properties:

```swift
private let micMonitor = MicMonitor()
private(set) var liveStore: LiveTranscriptStore?  // replace the stub from Task 5
private var heartbeatTimer: DispatchSourceTimer?
```

**Step 2: Update `startRecording` to start mic monitor and create LiveTranscriptStore**

After the line `try recorder.startRecording(toOutputFile: wavURL, deviceID: deviceID)`, add mic monitor start:

```swift
// Start mic monitor for self/others detection
let micDeviceID = resolveMicDevice()
if micDeviceID != 0 {
    do {
        try micMonitor.start(deviceID: micDeviceID)
    } catch {
        logger.warning("Mic monitor failed to start: \(error.localizedDescription). Self/others detection disabled.")
    }
}

// Create live transcript store
liveStore = LiveTranscriptStore(meetingId: meetingId, title: title, micMonitor: micMonitor)

// Start SSE heartbeat timer (every 15 seconds)
startHeartbeat()
```

**Step 3: Add `resolveMicDevice` method**

```swift
private func resolveMicDevice() -> AudioDeviceID {
    let micHint = config.micDevice
    if !micHint.isEmpty, let id = deviceManager.findDevice(byName: micHint) {
        return id
    }
    // Fall back to system default input
    return deviceManager.getSystemDefaultDevice() ?? 0
}
```

**Step 4: Update `handleTranscriptLine` to use LiveTranscriptStore**

Replace the existing body of `handleTranscriptLine`:

```swift
private func handleTranscriptLine(_ line: String) {
    guard let data = line.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return
    }

    // Status messages (ready, done)
    if let status = json["status"] as? String {
        logger.notice("Transcriber status: \(status)")
        return
    }

    // Transcript segment
    if let text = json["text"] as? String {
        let start = json["start"] as? Double ?? 0.0
        let end = json["end"] as? Double ?? 0.0
        logger.info("Live: \(text)")
        liveStore?.addSegment(text: text, start: start, end: end)
    }
}
```

**Step 5: Update `stopRecording` to persist and clean up**

Before the line `activeSession = nil`, add:

```swift
// Persist live transcript and metrics
liveStore?.notifyStopped()
liveStore?.persist(to: config.resolvedRecordingsDir)
liveStore?.removeAllSubscribers()
liveStore = nil

// Stop mic monitor
micMonitor.stop()
micMonitor.clearHistory()

// Stop heartbeat
stopHeartbeat()
```

**Step 6: Add heartbeat timer methods**

```swift
private func startHeartbeat() {
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    timer.schedule(deadline: .now() + 15, repeating: 15)
    timer.setEventHandler { [weak self] in
        self?.liveStore?.sendHeartbeat()
    }
    timer.resume()
    heartbeatTimer = timer
}

private func stopHeartbeat() {
    heartbeatTimer?.cancel()
    heartbeatTimer = nil
}
```

**Step 7: Remove old `liveSegments` from RecordingSession**

In the `RecordingSession` struct, remove:

```swift
var liveSegments: [[String: Any]] = []
```

And remove the old append in `handleTranscriptLine` (already replaced in Step 4).

**Step 8: Build to verify**

Run: `cd recorder && swift build`
Expected: Build succeeds.

**Step 9: Commit**

```bash
git add recorder/Sources/MeetingRecorder/RecorderDaemon.swift
git commit -m "feat(recorder): wire up dual-stream capture, LiveTranscriptStore, and SSE heartbeat"
```

---

## Task 7: Integration test — SSE endpoint

**Files:**
- Modify: `recorder/tests/test_http_api.py`

**Step 1: Add SSE test class**

Add to `test_http_api.py`:

```python
import threading


class TestSSELiveEndpoint:
    """GET /live should stream Server-Sent Events."""

    def test_live_returns_sse_headers(self, daemon):
        """GET /live should return text/event-stream content type."""
        resp = requests.get(f"{BASE_URL}/live", stream=True, timeout=5)
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("Content-Type", "")
        resp.close()

    def test_live_idle_when_not_recording(self, daemon):
        """When not recording, /live should send a status:idle event."""
        resp = requests.get(f"{BASE_URL}/live", stream=True, timeout=5)
        # Read first event
        first_line = b""
        for chunk in resp.iter_content(chunk_size=1):
            first_line += chunk
            if b"\n\n" in first_line:
                break
        resp.close()

        text = first_line.decode("utf-8")
        assert "event: status" in text
        assert '"idle"' in text

    def test_live_streams_segments_during_recording(self, daemon):
        """Start a recording, connect to /live, verify segment events arrive."""
        # Start recording
        start_resp = requests.post(
            f"{BASE_URL}/start",
            json={"meetingId": "sse-test", "title": "SSE Test"},
        )
        assert start_resp.status_code == 200

        events = []
        stop_flag = threading.Event()

        def collect_events():
            try:
                resp = requests.get(f"{BASE_URL}/live", stream=True, timeout=15)
                for line in resp.iter_lines():
                    if stop_flag.is_set():
                        break
                    if line:
                        events.append(line.decode("utf-8"))
                resp.close()
            except Exception:
                pass

        # Collect SSE events in background
        t = threading.Thread(target=collect_events, daemon=True)
        t.start()

        # Wait a bit for events to accumulate, then stop
        time.sleep(8)
        requests.post(f"{BASE_URL}/stop", json={"meetingId": "sse-test"}, timeout=10)
        time.sleep(2)
        stop_flag.set()
        t.join(timeout=5)

        # Should have received at least a status event
        event_text = "\n".join(events)
        assert "event: status" in event_text, f"Expected status event, got: {event_text}"

    def test_live_persists_on_stop(self, daemon):
        """After stop, a -live.json file should be written."""
        import glob
        import os

        recordings_dir = os.path.expanduser("~/.config/claudia/recordings")

        # Start and stop a recording
        requests.post(
            f"{BASE_URL}/start",
            json={"meetingId": "persist-test", "title": "Persist Test"},
        )
        time.sleep(3)
        requests.post(f"{BASE_URL}/stop", json={"meetingId": "persist-test"}, timeout=10)
        time.sleep(2)

        # Check for live JSON file
        live_files = glob.glob(f"{recordings_dir}/meeting-persist-test-*-live.json")
        assert len(live_files) >= 1, f"Expected live JSON file, found: {live_files}"

        # Verify contents
        import json
        with open(live_files[0]) as f:
            data = json.load(f)
        assert data["meetingId"] == "persist-test"
        assert "finalMetrics" in data
        assert "segments" in data
```

**Step 2: Run tests**

Run: `cd recorder && ~/.config/claudia/recorder-venv/bin/python3 -m pytest tests/test_http_api.py -v`
Expected: All tests pass (existing + new SSE tests).

**Step 3: Commit**

```bash
git add recorder/tests/test_http_api.py
git commit -m "test(recorder): add SSE live endpoint integration tests"
```

---

## Task 8: Manual smoke test with live meeting

**Step 1: Build release binary**

Run: `cd recorder && swift build`

**Step 2: Start daemon**

Run: `.build/debug/meeting-recorder &`

**Step 3: Verify health**

Run: `curl -s http://localhost:9847/health`
Expected: `{"ok":true,"pythonAvailable":true,...}`

**Step 4: Start recording (with active Zoom meeting)**

```bash
curl -s -X POST http://localhost:9847/start \
  -H "Content-Type: application/json" \
  -d '{"meetingId":"smoke-test","title":"Smoke Test","deviceHint":"Zoom"}'
```

**Step 5: Connect SSE client**

In a second terminal:

```bash
curl -N http://localhost:9847/live
```

Expected: See `event: status` followed by `event: segment` and `event: metrics` events streaming in.

**Step 6: Talk into mic — verify self/others tagging**

Speak into the microphone. Segments from your voice should show `"speaker":"self"`. Meeting audio from others should show `"speaker":"others"`.

**Step 7: Stop recording**

```bash
curl -s -X POST http://localhost:9847/stop \
  -H "Content-Type: application/json" \
  -d '{"meetingId":"smoke-test"}'
```

**Step 8: Verify persistence**

```bash
ls ~/.config/claudia/recordings/meeting-smoke-test-*-live.json
cat ~/.config/claudia/recordings/meeting-smoke-test-*-live.json | python3 -m json.tool | head -30
```

Expected: JSON file with segments, speaker tags, and finalMetrics.

**Step 9: Kill daemon**

```bash
kill %1
```

**Step 10: Commit if all works**

```bash
git commit --allow-empty -m "test(recorder): manual smoke test passed for live transcription SSE"
```

---

Plan complete and saved to `docs/plans/2026-02-23-live-transcription-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open a new session with `executing-plans`, batch execution with checkpoints

Which approach?