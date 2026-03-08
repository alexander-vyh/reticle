import Foundation
import CoreAudio
import os

/// Orchestrates audio recording sessions: manages CoreAudioRecorder, Python live transcription
/// subprocess, and post-processing pipeline.
final class RecorderDaemon {
    private let logger = Logger(subsystem: "ai.reticle.meeting-recorder", category: "Daemon")
    private let config: RecorderConfig
    private let deviceManager: AudioDeviceManager
    private let recorder = CoreAudioRecorder()

    // Active recording state
    private var activeSession: RecordingSession?
    private var httpServer: HTTPServer?

    /// Current live transcript store (nil when not recording)
    private(set) var liveStore: LiveTranscriptStore?

    private let micMonitor: MicMonitor
    private var heartbeatTimer: DispatchSourceTimer?

    struct RecordingSession {
        let meetingId: String
        let title: String
        let attendees: [String]
        let startTime: Date
        let deviceID: AudioDeviceID
        let wavPath: String
        let pythonProcess: Process?
        let pythonStdinPipe: Pipe?
        let captureMode: String  // "tap" or "fallback"
        let processTap: ProcessTapCapture?  // nil when using fallback
    }

    init(config: RecorderConfig, deviceManager: AudioDeviceManager) {
        self.config = config
        self.deviceManager = deviceManager
        self.micMonitor = MicMonitor(vadThreshold: Float(config.micVadThreshold))
    }

    // MARK: - Daemon Lifecycle

    func start(port: UInt16) {
        httpServer = HTTPServer(port: port, daemon: self)
        httpServer?.start()
    }

    func stop() {
        if activeSession != nil {
            stopRecording()
        }
        httpServer?.stop()
    }

    // MARK: - Recording Control

    var isRecording: Bool { activeSession != nil }

    var status: [String: Any] {
        if let session = activeSession {
            let duration = Date().timeIntervalSince(session.startTime)
            let deviceName = deviceManager.getDeviceName(deviceID: session.deviceID) ?? "Unknown"
            return [
                "recording": true,
                "meetingId": session.meetingId,
                "title": session.title,
                "duration": round(duration * 10) / 10,
                "deviceName": deviceName,
                "captureMode": session.captureMode,
            ]
        }
        return ["recording": false]
    }

    func startRecording(meetingId: String, title: String, attendees: [String],
                        startTime: String?, endTime: String?, deviceHint: String?,
                        browserMeeting: Bool = false) throws {
        guard activeSession == nil else {
            throw RecorderError.alreadyRecording
        }

        // Prepare WAV output path
        let dateStr = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let wavFilename = "meeting-\(meetingId)-\(dateStr).wav"
        let wavPath = "\(config.resolvedRecordingsDir)/\(wavFilename)"
        let wavURL = URL(fileURLWithPath: wavPath)

        // Start Python live transcription subprocess
        let (pythonProcess, stdinPipe) = launchLiveTranscriber()

        // Resolve audio source: try Process Tap first, fall back to AUHAL
        let audioSource = resolveAudioSource(browserMeeting: browserMeeting)

        var captureMode: String
        var tapCapture: ProcessTapCapture?
        var deviceID: AudioDeviceID = 0

        switch audioSource {
        case .processTap(let tap):
            captureMode = "tap"
            tapCapture = tap

            // Set up audio chunk handler: pipe PCM to Python stdin
            tap.onAudioChunk = { [weak self] data in
                guard let pipe = self?.activeSession?.pythonStdinPipe else { return }
                pipe.fileHandleForWriting.write(data)
            }

            // Start the tap (writes WAV + delivers chunks)
            do {
                try tap.start(outputFile: wavURL)
                logger.notice("Starting recording via Process Tap: meeting=\(meetingId)")
            } catch {
                // Tap failed at start — fall through to AUHAL
                logger.warning("Process Tap start failed: \(error.localizedDescription). Falling back to AUHAL.")
                tapCapture = nil
                captureMode = "fallback"

                // Fall back to AUHAL device capture
                deviceID = resolveDevice(hint: deviceHint)
                guard deviceID != 0 else { throw RecorderError.noDeviceFound }
                let deviceName = deviceManager.getDeviceName(deviceID: deviceID) ?? "Unknown"
                logger.notice("Starting recording via AUHAL fallback: meeting=\(meetingId), device=\(deviceName)")

                recorder.onAudioChunk = { [weak self] data in
                    guard let pipe = self?.activeSession?.pythonStdinPipe else { return }
                    pipe.fileHandleForWriting.write(data)
                }
                try recorder.startRecording(toOutputFile: wavURL, deviceID: deviceID)
            }

        case .device(let id):
            captureMode = "fallback"
            deviceID = id
            let deviceName = deviceManager.getDeviceName(deviceID: deviceID) ?? "Unknown"
            logger.notice("Starting recording via AUHAL: meeting=\(meetingId), device=\(deviceName)")

            recorder.onAudioChunk = { [weak self] data in
                guard let pipe = self?.activeSession?.pythonStdinPipe else { return }
                pipe.fileHandleForWriting.write(data)
            }
            try recorder.startRecording(toOutputFile: wavURL, deviceID: deviceID)

        case .none:
            throw RecorderError.noDeviceFound
        }

        // Start mic monitor for self/others detection
        let micDeviceID = resolveMicDevice()
        if micDeviceID != 0 && micDeviceID != deviceID {
            do {
                try micMonitor.start(deviceID: micDeviceID)
            } catch {
                logger.warning("Mic monitor failed to start: \(error.localizedDescription). Self/others detection disabled.")
            }
        } else if micDeviceID == deviceID && captureMode == "fallback" {
            logger.warning("Mic device is same as capture device (\(deviceID)). Self/others detection may be inaccurate.")
            do {
                try micMonitor.start(deviceID: micDeviceID)
            } catch {
                logger.warning("Mic monitor failed to start: \(error.localizedDescription). Self/others detection disabled.")
            }
        } else if micDeviceID != 0 {
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

        activeSession = RecordingSession(
            meetingId: meetingId,
            title: title,
            attendees: attendees,
            startTime: Date(),
            deviceID: deviceID,
            wavPath: wavPath,
            pythonProcess: pythonProcess,
            pythonStdinPipe: stdinPipe,
            captureMode: captureMode,
            processTap: tapCapture
        )

        // Start reading live transcript from Python stdout
        if let process = pythonProcess {
            readLiveTranscript(from: process)
        }
    }

    @discardableResult
    func stopRecording() -> String? {
        guard let session = activeSession else {
            logger.warning("stopRecording called but no active session")
            return nil
        }

        logger.notice("Stopping recording: meeting=\(session.meetingId), mode=\(session.captureMode)")

        // Stop audio capture — tap or AUHAL depending on mode
        if let tap = session.processTap {
            tap.stop()
        } else {
            recorder.onAudioChunk = nil
            recorder.stopRecording()
        }

        // Close Python stdin to signal EOF -> triggers graceful shutdown
        session.pythonStdinPipe?.fileHandleForWriting.closeFile()

        // Wait for Python to finish (it exits on stdin EOF)
        if let process = session.pythonProcess, process.isRunning {
            DispatchQueue.global().async {
                process.waitUntilExit()
            }
            // Give it up to 5 seconds to finish
            Thread.sleep(forTimeInterval: 5.0)
            if process.isRunning {
                logger.warning("Python live transcriber didn't exit cleanly, terminating")
                process.terminate()
            }
        }

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

        // Launch batch post-processing in background
        launchPostProcessor(session: session)

        // Clear session immediately so new recordings can start without waiting
        activeSession = nil

        // Python cleanup and post-processing happen in background — don't block HTTP response
        DispatchQueue.global(qos: .utility).async { [weak self] in
            // Wait for Python live transcriber to finish
            if let process = session.pythonProcess, process.isRunning {
                // Give it up to 5 seconds to exit cleanly on EOF
                Thread.sleep(forTimeInterval: 5.0)
                if process.isRunning {
                    self?.logger.warning("Python live transcriber didn't exit cleanly, terminating")
                    process.terminate()
                }
            }

            // Launch batch post-processing
            self?.launchPostProcessor(session: session)
        }

        logger.notice("Recording stopped. WAV at \(session.wavPath)")
        return session.wavPath
    }

    // MARK: - Audio Source Resolution

    /// Represents the resolved audio capture source.
    enum AudioSource {
        case processTap(ProcessTapCapture)  // Process Tap targeting meeting apps
        case device(AudioDeviceID)           // AUHAL device capture (fallback)
        case none                            // No source available
    }

    /// Try Process Tap first (macOS 14.2+), fall back to AUHAL device capture.
    /// - Parameter browserMeeting: If true, include browser apps in tap targets
    ///   (for Google Meet, WebEx in browser).
    /// - Returns: The resolved audio source.
    private func resolveAudioSource(browserMeeting: Bool = false) -> AudioSource {
        // Check if Process Tap is available on this macOS version
        guard ProcessTapCapture.isAvailable else {
            logger.notice("Process Taps unavailable (requires macOS 14.2+), using AUHAL fallback")
            return resolveDeviceSource()
        }

        // Build target bundle ID list
        var targetBundleIDs = config.meetingApps
        if browserMeeting {
            targetBundleIDs.append(contentsOf: config.browserApps)
        }

        let tap = ProcessTapCapture(bundleIDs: targetBundleIDs)
        let pids = tap.findTargetProcessPIDs()

        guard !pids.isEmpty else {
            logger.notice("No meeting apps running, falling back to AUHAL device capture")
            return resolveDeviceSource()
        }

        logger.notice("Found \(pids.count) meeting process(es), will attempt Process Tap")
        return .processTap(tap)
    }

    /// Wrap resolveDevice() into an AudioSource enum value.
    private func resolveDeviceSource() -> AudioSource {
        let deviceID = resolveDevice(hint: nil)
        return deviceID != 0 ? .device(deviceID) : .none
    }

    // MARK: - Device Resolution

    private func resolveDevice(hint: String?) -> AudioDeviceID {
        // Try device hint first (e.g. "zoom" -> "ZoomAudioDevice")
        if let hint = hint, let id = deviceManager.findDevice(byName: hint) {
            return id
        }

        // Try preferred devices from config
        for preferred in config.preferredDevices {
            if let id = deviceManager.findDevice(byName: preferred) {
                return id
            }
        }

        // Fall back to system default
        if let id = deviceManager.getSystemDefaultDevice() {
            return id
        }

        return deviceManager.findBestAvailableDevice() ?? 0
    }

    // MARK: - Python Subprocess Management

    private func launchLiveTranscriber() -> (Process?, Pipe?) {
        let pythonPath = config.pythonPath
        let scriptPath = "\(config.scriptsDir)/stream_transcribe.py"

        guard FileManager.default.fileExists(atPath: pythonPath) else {
            logger.warning("Python venv not found at \(pythonPath), live transcription disabled")
            return (nil, nil)
        }

        guard FileManager.default.fileExists(atPath: scriptPath) else {
            logger.warning("stream_transcribe.py not found at \(scriptPath), live transcription disabled")
            return (nil, nil)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: pythonPath)
        process.arguments = [
            "-u",  // Unbuffered stdout
            scriptPath,
            "--model", config.whisperModel,
        ]
        if config.language != "auto" {
            process.arguments?.append(contentsOf: ["--language", config.language])
        }

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        // Log stderr from Python
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            self?.logger.info("Python: \(line.trimmingCharacters(in: .whitespacesAndNewlines))")
        }

        do {
            try process.run()
            logger.notice("Live transcriber started (PID \(process.processIdentifier))")
        } catch {
            logger.error("Failed to launch live transcriber: \(error.localizedDescription)")
            return (nil, nil)
        }

        return (process, stdinPipe)
    }

    private func readLiveTranscript(from process: Process) {
        guard let stdoutPipe = process.standardOutput as? Pipe else { return }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let handle = stdoutPipe.fileHandleForReading
            var buffer = Data()

            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }  // EOF

                buffer.append(chunk)

                // Process complete lines
                while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                    let lineData = buffer[buffer.startIndex..<newlineIndex]
                    buffer = Data(buffer[buffer.index(after: newlineIndex)...])

                    guard let line = String(data: lineData, encoding: .utf8),
                          !line.isEmpty else { continue }

                    self?.handleTranscriptLine(line)
                }
            }
        }
    }

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

    // MARK: - Mic & Heartbeat Helpers

    private func resolveMicDevice() -> AudioDeviceID {
        let micHint = config.micDevice
        if !micHint.isEmpty, let id = deviceManager.findDevice(byName: micHint) {
            return id
        }
        // Fall back to system default input
        return deviceManager.getSystemDefaultDevice() ?? 0
    }

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

    // MARK: - Post-Processing

    private func launchPostProcessor(session: RecordingSession) {
        let pythonPath = config.pythonPath
        let scriptPath = "\(config.scriptsDir)/postprocess.py"

        guard FileManager.default.fileExists(atPath: pythonPath),
              FileManager.default.fileExists(atPath: scriptPath) else {
            logger.warning("Post-processor not available, skipping")
            return
        }

        // Build metadata JSON for the post-processor
        let metadata: [String: Any] = [
            "meetingId": session.meetingId,
            "title": session.title,
            "attendees": session.attendees,
            "startTime": ISO8601DateFormatter().string(from: session.startTime),
            "endTime": ISO8601DateFormatter().string(from: Date()),
        ]

        guard let metadataJSON = try? JSONSerialization.data(withJSONObject: metadata),
              let metadataStr = String(data: metadataJSON, encoding: .utf8) else {
            logger.error("Failed to serialize meeting metadata")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: pythonPath)
        process.arguments = [
            scriptPath,
            "--wav", session.wavPath,
            "--metadata", metadataStr,
            "--output-dir", config.resolvedTranscriptsDir,
            "--model", config.whisperModel,
        ]
        if config.language != "auto" {
            process.arguments?.append(contentsOf: ["--language", config.language])
        }

        // Capture stdout for transcript path output
        let stdoutPipe = Pipe()
        process.standardOutput = stdoutPipe
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                self?.logger.notice("PostProcess output: \(trimmed)")
            }
        }

        // Capture stderr for logging
        let stderrPipe = Pipe()
        process.standardError = stderrPipe
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            self?.logger.info("PostProcess: \(line.trimmingCharacters(in: .whitespacesAndNewlines))")
        }

        process.terminationHandler = { [weak self] proc in
            if proc.terminationStatus == 0 {
                self?.logger.notice("Post-processing complete for meeting \(session.meetingId)")
            } else {
                self?.logger.error("Post-processing failed with exit code \(proc.terminationStatus)")
                fputs("[postproc] FAILED: meeting=\(session.meetingId) exit=\(proc.terminationStatus)\n", stderr)
            }
        }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            do {
                try process.run()
                self?.logger.notice("Post-processor started for meeting \(session.meetingId)")
            } catch {
                self?.logger.error("Failed to launch post-processor: \(error.localizedDescription)")
            }
        }
    }
}

// MARK: - Errors

enum RecorderError: LocalizedError {
    case alreadyRecording
    case noDeviceFound
    case notRecording
    case permissionDenied
    case noMeetingAppsRunning
    case tapCreationFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .alreadyRecording: return "A recording is already in progress"
        case .noDeviceFound: return "No suitable audio input device found"
        case .notRecording: return "No recording is in progress"
        case .permissionDenied: return "Audio capture permission denied"
        case .noMeetingAppsRunning: return "No meeting apps are currently running"
        case .tapCreationFailed(let status): return "Process Tap creation failed: \(status)"
        }
    }
}
