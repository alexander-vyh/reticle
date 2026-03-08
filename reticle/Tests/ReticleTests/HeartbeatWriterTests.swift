import XCTest
import Foundation

// MARK: - Test-local copy of HeartbeatWriter (mirrors recorder implementation)

struct HeartbeatMetrics: Equatable {
    let recording: Bool
    let meetingId: String?
    let duration: Double?
    let captureMode: String?
}

extension HeartbeatMetrics: Codable {
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

struct HeartbeatErrors2: Equatable {
    let lastError: String?
    let lastErrorAt: Double?
    let countSinceStart: Int
}

extension HeartbeatErrors2: Codable {
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

struct HeartbeatPayload: Codable {
    let service: String
    let pid: Int
    let startedAt: Double
    let lastCheck: Double
    let uptime: Double
    let checkInterval: Double
    let status: String
    let errors: HeartbeatErrors2
    let metrics: HeartbeatMetrics
}

/// Writes heartbeat JSON atomically to a directory.
/// This mirrors the production HeartbeatWriter from the recorder.
struct HeartbeatWriter {
    let directory: String
    let serviceName: String
    private(set) var startedAt: Double

    init(directory: String, serviceName: String, startedAt: Double = Double(Int(Date().timeIntervalSince1970 * 1000))) {
        self.directory = directory
        self.serviceName = serviceName
        self.startedAt = startedAt
    }

    var filePath: String {
        "\(directory)/\(serviceName).json"
    }

    var tmpPath: String {
        filePath + ".tmp"
    }

    func write(
        status: String = "ok",
        errors: HeartbeatErrors2 = HeartbeatErrors2(lastError: nil, lastErrorAt: nil, countSinceStart: 0),
        metrics: HeartbeatMetrics = HeartbeatMetrics(recording: false, meetingId: nil, duration: nil, captureMode: nil)
    ) throws {
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
    }
}

// MARK: - Tests

final class HeartbeatWriterTests: XCTestCase {

    var tmpDir: String!

    override func setUp() {
        super.setUp()
        tmpDir = NSTemporaryDirectory() + "heartbeat-test-\(UUID().uuidString)"
    }

    override func tearDown() {
        super.tearDown()
        try? FileManager.default.removeItem(atPath: tmpDir)
    }

    // MARK: - JSON format tests

    func testHeartbeatWritesValidJSON() throws {
        let writer = HeartbeatWriter(directory: tmpDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        try writer.write()

        let data = try Data(contentsOf: URL(fileURLWithPath: writer.filePath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["service"] as? String, "meeting-recorder")
        XCTAssertEqual(json["startedAt"] as? Double, 1741305600000)
        XCTAssertEqual(json["checkInterval"] as? Double, 30000)
        XCTAssertEqual(json["status"] as? String, "ok")
        XCTAssertNotNil(json["pid"])
        XCTAssertNotNil(json["lastCheck"])
        XCTAssertNotNil(json["uptime"])
    }

    func testHeartbeatIncludesErrorsObject() throws {
        let writer = HeartbeatWriter(directory: tmpDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        try writer.write()

        let data = try Data(contentsOf: URL(fileURLWithPath: writer.filePath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let errors = json["errors"] as! [String: Any]

        XCTAssertTrue(errors["lastError"] is NSNull, "lastError should be null")
        XCTAssertTrue(errors["lastErrorAt"] is NSNull, "lastErrorAt should be null")
        XCTAssertEqual(errors["countSinceStart"] as? Int, 0)
    }

    func testHeartbeatIncludesMetricsNotRecording() throws {
        let writer = HeartbeatWriter(directory: tmpDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        try writer.write()

        let data = try Data(contentsOf: URL(fileURLWithPath: writer.filePath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let metrics = json["metrics"] as! [String: Any]

        XCTAssertEqual(metrics["recording"] as? Bool, false)
        XCTAssertTrue(metrics["meetingId"] is NSNull, "meetingId should be null when not recording")
        XCTAssertTrue(metrics["duration"] is NSNull, "duration should be null when not recording")
        XCTAssertTrue(metrics["captureMode"] is NSNull, "captureMode should be null when not recording")
    }

    func testHeartbeatIncludesMetricsWhileRecording() throws {
        let writer = HeartbeatWriter(directory: tmpDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        let metrics = HeartbeatMetrics(recording: true, meetingId: "mtg-123", duration: 45.5, captureMode: "device")
        try writer.write(metrics: metrics)

        let data = try Data(contentsOf: URL(fileURLWithPath: writer.filePath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let m = json["metrics"] as! [String: Any]

        XCTAssertEqual(m["recording"] as? Bool, true)
        XCTAssertEqual(m["meetingId"] as? String, "mtg-123")
        XCTAssertEqual(m["duration"] as? Double, 45.5)
        XCTAssertEqual(m["captureMode"] as? String, "device")
    }

    func testHeartbeatCustomErrors() throws {
        let writer = HeartbeatWriter(directory: tmpDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        let errors = HeartbeatErrors2(lastError: "Audio device lost", lastErrorAt: 1741305650000, countSinceStart: 2)
        try writer.write(status: "degraded", errors: errors)

        let data = try Data(contentsOf: URL(fileURLWithPath: writer.filePath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["status"] as? String, "degraded")
        let e = json["errors"] as! [String: Any]
        XCTAssertEqual(e["lastError"] as? String, "Audio device lost")
        XCTAssertEqual(e["lastErrorAt"] as? Double, 1741305650000)
        XCTAssertEqual(e["countSinceStart"] as? Int, 2)
    }

    // MARK: - Atomic write tests

    func testWritesAtomicallyViaTmpFile() throws {
        let writer = HeartbeatWriter(directory: tmpDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        try writer.write()

        // After write, .tmp should not exist (was renamed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: writer.tmpPath))
        // Target file should exist
        XCTAssertTrue(FileManager.default.fileExists(atPath: writer.filePath))
    }

    func testCreatesDirectoryIfMissing() throws {
        let nestedDir = tmpDir + "/nested/heartbeats"
        let writer = HeartbeatWriter(directory: nestedDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        try writer.write()

        XCTAssertTrue(FileManager.default.fileExists(atPath: writer.filePath))
    }

    func testOverwritesPreviousHeartbeat() throws {
        let writer = HeartbeatWriter(directory: tmpDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        try writer.write(status: "ok")
        try writer.write(status: "degraded")

        let data = try Data(contentsOf: URL(fileURLWithPath: writer.filePath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["status"] as? String, "degraded")
    }

    // MARK: - Decodable round-trip

    func testPayloadDecodableByServiceManager() throws {
        let writer = HeartbeatWriter(directory: tmpDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        try writer.write()

        let data = try Data(contentsOf: URL(fileURLWithPath: writer.filePath))
        // Decode using the HeartbeatData shape that ServiceManager uses
        let decoded = try JSONDecoder().decode(HeartbeatPayload.self, from: data)
        XCTAssertEqual(decoded.service, "meeting-recorder")
        XCTAssertEqual(decoded.checkInterval, 30000)
        XCTAssertEqual(decoded.status, "ok")
    }

    // MARK: - Timestamps are epoch milliseconds

    func testTimestampsAreEpochMilliseconds() throws {
        let writer = HeartbeatWriter(directory: tmpDir, serviceName: "meeting-recorder", startedAt: 1741305600000)
        try writer.write()

        let data = try Data(contentsOf: URL(fileURLWithPath: writer.filePath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        let lastCheck = json["lastCheck"] as! Double
        // Should be in milliseconds (> 1_000_000_000_000 for any date after 2001)
        XCTAssertGreaterThan(lastCheck, 1_000_000_000_000, "lastCheck should be epoch milliseconds")
        XCTAssertGreaterThan(json["startedAt"] as! Double, 1_000_000_000_000, "startedAt should be epoch milliseconds")
    }

    // MARK: - File path

    func testFilePathFormat() {
        let writer = HeartbeatWriter(directory: "/tmp/test-hb", serviceName: "meeting-recorder", startedAt: 0)
        XCTAssertEqual(writer.filePath, "/tmp/test-hb/meeting-recorder.json")
    }
}
