import Foundation
import CoreAudio
import os

/// Orchestrates audio recording sessions: manages CoreAudioRecorder, Python live transcription
/// subprocess, and post-processing pipeline.
final class RecorderDaemon {
    private let logger = Logger(subsystem: "ai.openclaw.meeting-recorder", category: "Daemon")
    private let config: RecorderConfig
    private let deviceManager: AudioDeviceManager
    private let recorder = CoreAudioRecorder()

    // Active recording state
    private var activeSession: RecordingSession?
    private var httpServer: HTTPServer?

    struct RecordingSession {
        let meetingId: String
        let title: String
        let attendees: [String]
        let startTime: Date
        let deviceID: AudioDeviceID
        let wavPath: String
        let pythonProcess: Process?
        let pythonStdinPipe: Pipe?
        var liveSegments: [[String: Any]] = []
    }

    init(config: RecorderConfig, deviceManager: AudioDeviceManager) {
        self.config = config
        self.deviceManager = deviceManager
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
            ]
        }
        return ["recording": false]
    }

    func startRecording(meetingId: String, title: String, attendees: [String],
                        startTime: String?, endTime: String?, deviceHint: String?) throws {
        guard activeSession == nil else {
            throw RecorderError.alreadyRecording
        }

        // Resolve device
        let deviceID = resolveDevice(hint: deviceHint)
        guard deviceID != 0 else {
            throw RecorderError.noDeviceFound
        }

        let deviceName = deviceManager.getDeviceName(deviceID: deviceID) ?? "Unknown"
        logger.notice("Starting recording: meeting=\(meetingId), device=\(deviceName)")

        // Prepare WAV output path
        let dateStr = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let wavFilename = "meeting-\(meetingId)-\(dateStr).wav"
        let wavPath = "\(config.resolvedRecordingsDir)/\(wavFilename)"
        let wavURL = URL(fileURLWithPath: wavPath)

        // Start Python live transcription subprocess
        let (pythonProcess, stdinPipe) = launchLiveTranscriber()

        // Set up audio chunk handler: pipe PCM to Python stdin
        recorder.onAudioChunk = { [weak self] data in
            guard let pipe = self?.activeSession?.pythonStdinPipe else { return }
            pipe.fileHandleForWriting.write(data)
        }

        // Start audio capture (also writes WAV internally)
        try recorder.startRecording(toOutputFile: wavURL, deviceID: deviceID)

        activeSession = RecordingSession(
            meetingId: meetingId,
            title: title,
            attendees: attendees,
            startTime: Date(),
            deviceID: deviceID,
            wavPath: wavPath,
            pythonProcess: pythonProcess,
            pythonStdinPipe: stdinPipe
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

        logger.notice("Stopping recording: meeting=\(session.meetingId)")

        // Stop audio capture
        recorder.onAudioChunk = nil
        recorder.stopRecording()

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

        let wavPath = session.wavPath

        // Launch batch post-processing in background
        launchPostProcessor(session: session)

        activeSession = nil

        logger.notice("Recording stopped. WAV at \(wavPath)")
        return wavPath
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
            logger.info("Live: \(text)")
            activeSession?.liveSegments.append(json)
        }
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

    var errorDescription: String? {
        switch self {
        case .alreadyRecording: return "A recording is already in progress"
        case .noDeviceFound: return "No suitable audio input device found"
        case .notRecording: return "No recording is in progress"
        }
    }
}
