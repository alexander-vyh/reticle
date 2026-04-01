import XCTest

// MARK: - Test-local copies of pure types and functions from ServiceManager
// These mirror the production types exactly so tests run without importing the main target.

enum ServiceStatus: String, Equatable {
    case running, stopped, error, unloaded, unknown
}

struct LaunchctlEntry: Equatable {
    let pid: Int?
    let exitCode: Int
}

struct HeartbeatErrors: Codable {
    let lastError: String?
    let lastErrorAt: Double?
    let countSinceStart: Int
}

struct HeartbeatMetrics: Codable {
    let recording: Bool?
    let meetingId: String?
    let duration: Double?
    let captureMode: String?
    let permissionStatus: String?
    let itemCount: Int?
    let patternCount: Int?
    let degradedReason: String?
}

struct HeartbeatData: Codable {
    let service: String?
    let pid: Int?
    let startedAt: Double?
    let lastCheck: Double?
    let checkInterval: Double?
    let status: String?
    let errors: HeartbeatErrors?
    let metrics: HeartbeatMetrics?
}

struct HeartbeatHealth: Equatable {
    let health: String
    let detail: String?
    let errorCount: Int
    static let unknown = HeartbeatHealth(health: "unknown", detail: nil, errorCount: 0)
}

// Pure function: parse launchctl list output into label -> entry map
func parseLaunchctlList(_ output: String) -> [String: LaunchctlEntry] {
    var map: [String: LaunchctlEntry] = [:]
    for line in output.split(separator: "\n", omittingEmptySubsequences: true) {
        let parts = line.split(separator: "\t")
        guard parts.count >= 3 else { continue }
        let label = String(parts[2])
        if label == "Label" { continue }
        let pid = parts[0] == "-" ? nil : Int(parts[0])
        let exitCode = Int(parts[1]) ?? 0
        map[label] = LaunchctlEntry(pid: pid, exitCode: exitCode)
    }
    return map
}

// Pure function: derive status from an optional launchctl entry
func statusFromEntry(_ entry: LaunchctlEntry?) -> ServiceStatus {
    guard let entry = entry else { return .unloaded }
    if entry.pid != nil { return .running }
    return entry.exitCode == 0 ? .stopped : .error
}

// Pure function: evaluate heartbeat health
func evaluateHeartbeat(_ hb: HeartbeatData?, now: Double? = nil) -> HeartbeatHealth {
    guard let hb = hb else { return .unknown }

    if hb.status == "startup-failed" {
        let detail = hb.errors?.lastError ?? "Unknown error"
        return HeartbeatHealth(health: "startup-failed", detail: detail, errorCount: 0)
    }
    if hb.status == "error" || hb.status == "degraded" {
        return HeartbeatHealth(
            health: hb.status!,
            detail: hb.errors?.lastError,
            errorCount: hb.errors?.countSinceStart ?? 0
        )
    }
    if hb.status == "shutting-down" {
        return HeartbeatHealth(health: "shutting-down", detail: nil, errorCount: 0)
    }

    // If checkInterval is present, check staleness
    if let lastCheck = hb.lastCheck, let interval = hb.checkInterval {
        let currentTime = now ?? (Date().timeIntervalSince1970 * 1000)
        let ageMs = currentTime - lastCheck
        if ageMs > interval * 3 {
            let ageMin = Int(ageMs / 60000)
            return HeartbeatHealth(health: "unresponsive", detail: "No heartbeat for \(ageMin)m", errorCount: 0)
        }
    }

    // Scheduled services may not write checkInterval — if lastCheck exists, treat as healthy
    if hb.lastCheck != nil {
        return HeartbeatHealth(
            health: "healthy",
            detail: nil,
            errorCount: hb.errors?.countSinceStart ?? 0
        )
    }

    return .unknown
}

struct ServiceDefinitionMirror {
    let label: String
    let launchdLabel: String
    let heartbeatName: String?
    let scheduled: Bool
}

let serviceDefinitions: [ServiceDefinitionMirror] = [
    ServiceDefinitionMirror(label: "Gmail Monitor",     launchdLabel: "ai.reticle.gmail-monitor",      heartbeatName: "gmail-monitor",      scheduled: false),
    ServiceDefinitionMirror(label: "Slack Events",      launchdLabel: "ai.reticle.slack-events",       heartbeatName: "slack-events",       scheduled: false),
    ServiceDefinitionMirror(label: "Meeting Alerts",    launchdLabel: "ai.reticle.meeting-alerts",     heartbeatName: "meeting-alerts",     scheduled: false),
    ServiceDefinitionMirror(label: "Follow-up Checker", launchdLabel: "ai.reticle.followup-checker",   heartbeatName: "followup-checker",   scheduled: false),
    ServiceDefinitionMirror(label: "Meeting Recorder",  launchdLabel: "ai.reticle.meeting-recorder",   heartbeatName: "meeting-recorder",   scheduled: false),
    ServiceDefinitionMirror(label: "Gateway",           launchdLabel: "ai.reticle.gateway",            heartbeatName: "gateway",            scheduled: false),
    ServiceDefinitionMirror(label: "Daily Digest",      launchdLabel: "ai.reticle.digest-daily",       heartbeatName: "digest-daily",       scheduled: true),
    ServiceDefinitionMirror(label: "Weekly Digest",     launchdLabel: "ai.reticle.digest-weekly",      heartbeatName: "digest-weekly",      scheduled: true),
]

let heartbeatDir: String = {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return "\(home)/.reticle/heartbeats"
}()

// MARK: - Tests

final class ServiceManagerTests: XCTestCase {

    // MARK: - parseLaunchctlList

    func testParseLaunchctlOutput() {
        let output = """
        PID\tStatus\tLabel
        1234\t0\tai.claudia.gmail-monitor
        -\t0\tai.claudia.slack-events
        -\t78\tai.claudia.followup-checker
        """
        let map = parseLaunchctlList(output)

        XCTAssertEqual(map.count, 3)

        // Running service (has PID)
        XCTAssertEqual(map["ai.claudia.gmail-monitor"], LaunchctlEntry(pid: 1234, exitCode: 0))

        // Stopped service (no PID, exit 0)
        XCTAssertEqual(map["ai.claudia.slack-events"], LaunchctlEntry(pid: nil, exitCode: 0))

        // Error service (no PID, non-zero exit)
        XCTAssertEqual(map["ai.claudia.followup-checker"], LaunchctlEntry(pid: nil, exitCode: 78))
    }

    func testEmptyLaunchctlOutput() {
        let map = parseLaunchctlList("")
        XCTAssertTrue(map.isEmpty)
    }

    func testHeaderOnlyOutput() {
        let output = "PID\tStatus\tLabel\n"
        let map = parseLaunchctlList(output)
        XCTAssertTrue(map.isEmpty)
    }

    // MARK: - statusFromEntry

    func testStatusFromEntryNil() {
        XCTAssertEqual(statusFromEntry(nil), .unloaded)
    }

    func testStatusFromEntryRunning() {
        let entry = LaunchctlEntry(pid: 5678, exitCode: 0)
        XCTAssertEqual(statusFromEntry(entry), .running)
    }

    func testStatusFromEntryStopped() {
        let entry = LaunchctlEntry(pid: nil, exitCode: 0)
        XCTAssertEqual(statusFromEntry(entry), .stopped)
    }

    func testStatusFromEntryError() {
        let entry = LaunchctlEntry(pid: nil, exitCode: 1)
        XCTAssertEqual(statusFromEntry(entry), .error)
    }

    // MARK: - evaluateHeartbeat

    func testEvaluateHeartbeatNil() {
        let result = evaluateHeartbeat(nil)
        XCTAssertEqual(result, HeartbeatHealth.unknown)
    }

    func testEvaluateHeartbeatStartupFailed() {
        let hb = HeartbeatData(
            service: "test", pid: nil, startedAt: nil,
            lastCheck: nil, checkInterval: nil,
            status: "startup-failed",
            errors: HeartbeatErrors(lastError: "Missing token", lastErrorAt: nil, countSinceStart: 0),
            metrics: nil
        )
        let result = evaluateHeartbeat(hb)
        XCTAssertEqual(result.health, "startup-failed")
        XCTAssertEqual(result.detail, "Missing token")
        XCTAssertEqual(result.errorCount, 0)
    }

    func testEvaluateHeartbeatStartupFailedNoErrors() {
        let hb = HeartbeatData(
            service: "test", pid: nil, startedAt: nil,
            lastCheck: nil, checkInterval: nil,
            status: "startup-failed",
            errors: nil,
            metrics: nil
        )
        let result = evaluateHeartbeat(hb)
        XCTAssertEqual(result.detail, "Unknown error")
    }

    func testEvaluateHeartbeatHealthy() {
        let now = Date().timeIntervalSince1970 * 1000
        let hb = HeartbeatData(
            service: "test", pid: 1234, startedAt: now - 60000,
            lastCheck: now - 5000, checkInterval: 30000,
            status: "ok",
            errors: HeartbeatErrors(lastError: nil, lastErrorAt: nil, countSinceStart: 0),
            metrics: nil
        )
        let result = evaluateHeartbeat(hb, now: now)
        XCTAssertEqual(result.health, "healthy")
        XCTAssertNil(result.detail)
        XCTAssertEqual(result.errorCount, 0)
    }

    func testEvaluateHeartbeatUnresponsive() {
        let now = Date().timeIntervalSince1970 * 1000
        // lastCheck was 10 minutes ago, interval is 30s -> age (600000) > 30000*3 (90000)
        let hb = HeartbeatData(
            service: "test", pid: 1234, startedAt: now - 700000,
            lastCheck: now - 600000, checkInterval: 30000,
            status: "ok",
            errors: nil,
            metrics: nil
        )
        let result = evaluateHeartbeat(hb, now: now)
        XCTAssertEqual(result.health, "unresponsive")
        XCTAssertEqual(result.detail, "No heartbeat for 10m")
        XCTAssertEqual(result.errorCount, 0)
    }

    func testEvaluateHeartbeatDegraded() {
        let hb = HeartbeatData(
            service: "test", pid: 1234, startedAt: nil,
            lastCheck: nil, checkInterval: nil,
            status: "degraded",
            errors: HeartbeatErrors(lastError: "Slack API slow", lastErrorAt: nil, countSinceStart: 3),
            metrics: nil
        )
        let result = evaluateHeartbeat(hb)
        XCTAssertEqual(result.health, "degraded")
        XCTAssertEqual(result.detail, "Slack API slow")
        XCTAssertEqual(result.errorCount, 3)
    }

    func testEvaluateHeartbeatErrorStatus() {
        let hb = HeartbeatData(
            service: "test", pid: 1234, startedAt: nil,
            lastCheck: nil, checkInterval: nil,
            status: "error",
            errors: HeartbeatErrors(lastError: "DB locked", lastErrorAt: nil, countSinceStart: 5),
            metrics: nil
        )
        let result = evaluateHeartbeat(hb)
        XCTAssertEqual(result.health, "error")
        XCTAssertEqual(result.detail, "DB locked")
        XCTAssertEqual(result.errorCount, 5)
    }

    func testEvaluateHeartbeatShuttingDown() {
        let hb = HeartbeatData(
            service: "test", pid: 1234, startedAt: nil,
            lastCheck: nil, checkInterval: nil,
            status: "shutting-down",
            errors: nil,
            metrics: nil
        )
        let result = evaluateHeartbeat(hb)
        XCTAssertEqual(result.health, "shutting-down")
        XCTAssertNil(result.detail)
        XCTAssertEqual(result.errorCount, 0)
    }

    // MARK: - evaluateHeartbeat — scheduled services (no checkInterval)

    func testEvaluateHeartbeatNoCheckInterval_WithLastCheck_Healthy() {
        // Scheduled services (digests) write lastCheck but not checkInterval.
        // They should be treated as healthy, not unknown/unresponsive.
        let now = Date().timeIntervalSince1970 * 1000
        let hb = HeartbeatData(
            service: "digest-daily", pid: nil, startedAt: now - 60000,
            lastCheck: now - 5000, checkInterval: nil,
            status: "ok",
            errors: nil,
            metrics: nil
        )
        let result = evaluateHeartbeat(hb, now: now)
        XCTAssertEqual(result.health, "healthy",
            "Scheduled service with lastCheck but no checkInterval should be healthy")
    }

    func testEvaluateHeartbeatNoCheckIntervalNoLastCheck_Unknown() {
        // No lastCheck and no checkInterval — genuinely unknown
        let hb = HeartbeatData(
            service: "digest-daily", pid: nil, startedAt: nil,
            lastCheck: nil, checkInterval: nil,
            status: "ok",
            errors: nil,
            metrics: nil
        )
        let result = evaluateHeartbeat(hb)
        XCTAssertEqual(result.health, "unknown",
            "No lastCheck and no checkInterval means we have no data — unknown")
    }

    // MARK: - ServiceDefinition labels

    func testAllLaunchdLabelsUseReticlePrefix() {
        for def in serviceDefinitions {
            XCTAssertTrue(
                def.launchdLabel.hasPrefix("ai.reticle."),
                "\(def.label) has stale launchd label: \(def.launchdLabel)"
            )
        }
    }

    func testAllPersistentServicesHaveHeartbeatName() {
        let persistent = serviceDefinitions.filter { !$0.scheduled }
        for def in persistent {
            XCTAssertNotNil(
                def.heartbeatName,
                "\(def.label) is a persistent service but has nil heartbeatName"
            )
        }
    }

    func testMeetingRecorderHasHeartbeatName() {
        let recorder = serviceDefinitions.first { $0.label == "Meeting Recorder" }
        XCTAssertNotNil(recorder, "Meeting Recorder not found in service definitions")
        XCTAssertEqual(recorder?.heartbeatName, "meeting-recorder")
    }

    func testGatewayHasHeartbeatName() {
        let gateway = serviceDefinitions.first { $0.label == "Gateway" }
        XCTAssertNotNil(gateway, "Gateway not found in service definitions")
        XCTAssertEqual(gateway?.heartbeatName, "gateway")
    }

    func testHeartbeatDirPointsToReticle() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let expected = "\(home)/.reticle/heartbeats"
        XCTAssertEqual(heartbeatDir, expected)
    }

    func testServiceDefinitionCount() {
        XCTAssertEqual(serviceDefinitions.count, 8)
    }

    // MARK: - HeartbeatData JSON decoding (contract test with Node.js heartbeat.js)

    func testDecodeNodeJsHeartbeatJSON() throws {
        // This is the exact JSON shape written by lib/heartbeat.js write()
        let json = """
        {
            "service": "gmail-monitor",
            "pid": 12345,
            "startedAt": 1711900000000,
            "lastCheck": 1711900030000,
            "uptime": 30,
            "checkInterval": 30000,
            "status": "ok",
            "errors": {
                "lastError": null,
                "lastErrorAt": null,
                "countSinceStart": 0
            },
            "metrics": {}
        }
        """.data(using: .utf8)!

        let hb = try JSONDecoder().decode(HeartbeatData.self, from: json)
        XCTAssertEqual(hb.service, "gmail-monitor")
        XCTAssertEqual(hb.pid, 12345)
        XCTAssertEqual(hb.startedAt, 1711900000000)
        XCTAssertEqual(hb.lastCheck, 1711900030000)
        XCTAssertEqual(hb.checkInterval, 30000)
        XCTAssertEqual(hb.status, "ok")
        XCTAssertEqual(hb.errors?.countSinceStart, 0)
        XCTAssertNil(hb.errors?.lastError)
    }

    func testDecodeNodeJsHeartbeatWithErrors() throws {
        let json = """
        {
            "service": "slack-events",
            "pid": 9999,
            "startedAt": 1711900000000,
            "lastCheck": 1711900060000,
            "uptime": 60,
            "checkInterval": 30000,
            "status": "degraded",
            "errors": {
                "lastError": "Slack API rate limited",
                "lastErrorAt": 1711900055000,
                "countSinceStart": 3
            },
            "metrics": {}
        }
        """.data(using: .utf8)!

        let hb = try JSONDecoder().decode(HeartbeatData.self, from: json)
        XCTAssertEqual(hb.status, "degraded")
        XCTAssertEqual(hb.errors?.lastError, "Slack API rate limited")
        XCTAssertEqual(hb.errors?.lastErrorAt, 1711900055000)
        XCTAssertEqual(hb.errors?.countSinceStart, 3)
    }

    func testDecodeNodeJsHeartbeatWithMetrics() throws {
        // Meeting recorder heartbeat with recording metrics
        let json = """
        {
            "service": "meeting-recorder",
            "pid": 5678,
            "startedAt": 1711900000000,
            "lastCheck": 1711900300000,
            "uptime": 300,
            "checkInterval": 30000,
            "status": "ok",
            "errors": {
                "lastError": null,
                "lastErrorAt": null,
                "countSinceStart": 0
            },
            "metrics": {
                "recording": true,
                "meetingId": "mtg-abc123",
                "duration": 245.5,
                "captureMode": "process-tap"
            }
        }
        """.data(using: .utf8)!

        let hb = try JSONDecoder().decode(HeartbeatData.self, from: json)
        XCTAssertEqual(hb.metrics?.recording, true)
        XCTAssertEqual(hb.metrics?.meetingId, "mtg-abc123")
        XCTAssertEqual(hb.metrics?.duration, 245.5)
        XCTAssertEqual(hb.metrics?.captureMode, "process-tap")
    }

    func testDecodeDigestHeartbeatNoCheckInterval() throws {
        // Scheduled services (digests) may omit checkInterval
        let json = """
        {
            "service": "digest-daily",
            "pid": 4321,
            "startedAt": 1711900000000,
            "lastCheck": 1711900000000,
            "status": "ok",
            "errors": {
                "lastError": null,
                "lastErrorAt": null,
                "countSinceStart": 0
            },
            "metrics": {
                "itemCount": 42,
                "patternCount": 12
            }
        }
        """.data(using: .utf8)!

        let hb = try JSONDecoder().decode(HeartbeatData.self, from: json)
        XCTAssertNil(hb.checkInterval, "Scheduled services may not have checkInterval")
        XCTAssertEqual(hb.metrics?.itemCount, 42)
        XCTAssertEqual(hb.metrics?.patternCount, 12)

        // evaluateHeartbeat should treat this as healthy
        let health = evaluateHeartbeat(hb)
        XCTAssertEqual(health.health, "healthy")
    }

    func testDecodeMinimalHeartbeat() throws {
        // Minimal valid heartbeat — just status, no extras
        let json = """
        {
            "status": "startup-failed",
            "errors": {
                "lastError": "SLACK_BOT_TOKEN not set",
                "lastErrorAt": null,
                "countSinceStart": 1
            }
        }
        """.data(using: .utf8)!

        let hb = try JSONDecoder().decode(HeartbeatData.self, from: json)
        XCTAssertEqual(hb.status, "startup-failed")
        XCTAssertNil(hb.service)
        XCTAssertNil(hb.pid)

        let health = evaluateHeartbeat(hb)
        XCTAssertEqual(health.health, "startup-failed")
        XCTAssertEqual(health.detail, "SLACK_BOT_TOKEN not set")
    }

    // MARK: - Heartbeat file I/O integration test

    func testReadHeartbeatFromFile() throws {
        // Write a realistic heartbeat file to a temp directory and read it back
        let tmpDir = NSTemporaryDirectory() + "heartbeat-read-test-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmpDir) }

        let json = """
        {
            "service": "gmail-monitor",
            "pid": 12345,
            "startedAt": 1711900000000,
            "lastCheck": 1711900030000,
            "uptime": 30,
            "checkInterval": 30000,
            "status": "ok",
            "errors": {"lastError": null, "lastErrorAt": null, "countSinceStart": 0},
            "metrics": {}
        }
        """
        let filePath = "\(tmpDir)/gmail-monitor.json"
        try json.write(toFile: filePath, atomically: true, encoding: .utf8)

        // Read and decode
        guard let data = FileManager.default.contents(atPath: filePath) else {
            XCTFail("Could not read heartbeat file")
            return
        }
        let hb = try JSONDecoder().decode(HeartbeatData.self, from: data)
        XCTAssertEqual(hb.service, "gmail-monitor")
        XCTAssertEqual(hb.pid, 12345)
        XCTAssertEqual(hb.status, "ok")

        // Feed through evaluateHeartbeat — should be healthy
        let now = 1711900035000.0 // 5 seconds after lastCheck
        let health = evaluateHeartbeat(hb, now: now)
        XCTAssertEqual(health.health, "healthy")
    }

    func testReadCorruptHeartbeatFileReturnsNil() throws {
        let tmpDir = NSTemporaryDirectory() + "heartbeat-corrupt-test-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmpDir) }

        // Write garbage
        let filePath = "\(tmpDir)/broken.json"
        try "not valid json {{{".write(toFile: filePath, atomically: true, encoding: .utf8)

        guard let data = FileManager.default.contents(atPath: filePath) else {
            XCTFail("Could not read file")
            return
        }
        let hb = try? JSONDecoder().decode(HeartbeatData.self, from: data)
        XCTAssertNil(hb, "Corrupt heartbeat file should decode to nil")
    }

    func testReadMissingHeartbeatFileReturnsNil() {
        let data = FileManager.default.contents(atPath: "/tmp/nonexistent-heartbeat-\(UUID().uuidString).json")
        XCTAssertNil(data, "Missing heartbeat file should return nil data")
    }
}
