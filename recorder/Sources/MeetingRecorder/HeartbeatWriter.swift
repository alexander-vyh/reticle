import Foundation
import os

/// Writes file-based heartbeat JSON for the meeting-recorder daemon.
/// Matches the format used by lib/heartbeat.js (Node.js services).
///
/// Timestamps are epoch MILLISECONDS (JavaScript convention).
/// Writes atomically via .tmp + rename.
struct HeartbeatWriter {

    private let logger = Logger(subsystem: "ai.reticle.meeting-recorder", category: "Heartbeat")

    let directory: String
    let serviceName: String
    let startedAt: Double  // epoch ms

    init(directory: String, serviceName: String = "meeting-recorder") {
        self.directory = directory
        self.serviceName = serviceName
        self.startedAt = Double(Int(Date().timeIntervalSince1970 * 1000))
    }

    var filePath: String {
        "\(directory)/\(serviceName).json"
    }

    private var tmpPath: String {
        filePath + ".tmp"
    }

    /// Write a heartbeat JSON file atomically.
    func write(
        status: String = "ok",
        errors: HeartbeatErrorsPayload = HeartbeatErrorsPayload(),
        metrics: HeartbeatMetricsPayload = HeartbeatMetricsPayload()
    ) {
        let now = Double(Int(Date().timeIntervalSince1970 * 1000))
        let uptime = (now - startedAt) / 1000.0

        let payload = HeartbeatPayload(
            service: serviceName,
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            startedAt: startedAt,
            lastCheck: now,
            uptime: uptime,
            checkInterval: 30000,
            status: status,
            errors: errors,
            metrics: metrics
        )

        do {
            let fm = FileManager.default
            if !fm.fileExists(atPath: directory) {
                try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
            }

            let encoder = JSONEncoder()
            let data = try encoder.encode(payload)
            let tmpURL = URL(fileURLWithPath: tmpPath)
            let targetURL = URL(fileURLWithPath: filePath)

            try data.write(to: tmpURL)
            _ = try? fm.removeItem(at: targetURL)
            try fm.moveItem(at: tmpURL, to: targetURL)
        } catch {
            logger.error("Failed to write heartbeat: \(error.localizedDescription)")
        }
    }
}

// MARK: - Payload types

struct HeartbeatPayload: Codable {
    let service: String
    let pid: Int
    let startedAt: Double
    let lastCheck: Double
    let uptime: Double
    let checkInterval: Double
    let status: String
    let errors: HeartbeatErrorsPayload
    let metrics: HeartbeatMetricsPayload
}

struct HeartbeatErrorsPayload: Codable {
    let lastError: String?
    let lastErrorAt: Double?
    let countSinceStart: Int

    init(lastError: String? = nil, lastErrorAt: Double? = nil, countSinceStart: Int = 0) {
        self.lastError = lastError
        self.lastErrorAt = lastErrorAt
        self.countSinceStart = countSinceStart
    }

    // Encode nil as null (not absent) to match JS heartbeat format
    enum CodingKeys: String, CodingKey {
        case lastError, lastErrorAt, countSinceStart
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(lastError, forKey: .lastError)
        try container.encode(lastErrorAt, forKey: .lastErrorAt)
        try container.encode(countSinceStart, forKey: .countSinceStart)
    }
}

struct HeartbeatMetricsPayload: Codable {
    let recording: Bool
    let meetingId: String?
    let duration: Double?
    let captureMode: String?

    init(recording: Bool = false, meetingId: String? = nil, duration: Double? = nil, captureMode: String? = nil) {
        self.recording = recording
        self.meetingId = meetingId
        self.duration = duration
        self.captureMode = captureMode
    }

    // Encode nil as null (not absent) to match JS heartbeat format
    enum CodingKeys: String, CodingKey {
        case recording, meetingId, duration, captureMode
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(recording, forKey: .recording)
        try container.encode(meetingId, forKey: .meetingId)
        try container.encode(duration, forKey: .duration)
        try container.encode(captureMode, forKey: .captureMode)
    }
}
