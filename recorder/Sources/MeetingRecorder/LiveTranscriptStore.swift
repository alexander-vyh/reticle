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
    private var subscribers: [UUID: NWConnection] = [:]
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
        let now = Date()
        self.meetingId = meetingId
        self.title = title
        self.startTime = now
        self.micMonitor = micMonitor
        self.metrics = MetricsEngine(recordingStartTime: now)
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

        // Send status event
        let status = StatusEvent(state: "recording", meetingId: meetingId, title: title)
        sendSSE(to: connection, type: "status", data: status)

        // Replay accumulated segments before registering, so pushEvent
        // doesn't race with replay and deliver out-of-order events
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

        // Register AFTER replay completes
        subscriberLock.lock()
        subscribers[id] = connection
        let count = subscribers.count
        subscriberLock.unlock()

        // Set up removal on connection close or failure
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled, .failed:
                self?.removeSubscriber(id: id)
            default:
                break
            }
        }

        logger.notice("SSE subscriber added (total: \(count))")
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
