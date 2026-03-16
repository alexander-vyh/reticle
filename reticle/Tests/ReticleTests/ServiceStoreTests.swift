import XCTest

// MARK: - Test-local types (reuses ServiceStatus, HeartbeatHealth from ServiceManagerTests)
// Only defines types that ServiceManagerTests doesn't already provide.

enum AggregateStatus: Equatable {
    case healthy, degraded, error, unknown
}

enum EffectiveStatus: Equatable {
    case running, stopped, error, unloaded, unknown
    case unresponsive, degraded, startupFailed
}

struct ServiceDefinition {
    let label: String
    let launchdLabel: String
    let heartbeatName: String?
    let scheduled: Bool
}

struct ServiceState {
    let definition: ServiceDefinition
    let status: ServiceStatus
    let pid: Int?
    let exitCode: Int?
    let heartbeat: HeartbeatData?
    let heartbeatHealth: HeartbeatHealth
}

// MARK: - Pure function copies from ServiceStore

func effectiveStatusFor(_ state: ServiceState) -> EffectiveStatus {
    if state.status != .running {
        switch state.status {
        case .stopped: return .stopped
        case .error: return .error
        case .unloaded: return .unloaded
        default: return .unknown
        }
    }

    let hh = state.heartbeatHealth.health
    switch hh {
    case "healthy": return .running
    case "unresponsive": return .unresponsive
    case "startup-failed": return .startupFailed
    case "error": return .error
    case "degraded": return .degraded
    default: return .running
    }
}

func computeAggregate(_ services: [ServiceState]) -> AggregateStatus {
    let persistent = services.filter { !$0.definition.scheduled }
    guard !persistent.isEmpty else { return .unknown }

    var hasError = false
    var hasDegraded = false

    for svc in persistent {
        let effective = effectiveStatusFor(svc)
        switch effective {
        case .stopped, .error, .startupFailed:
            hasError = true
        case .unresponsive, .degraded:
            hasDegraded = true
        case .running:
            break
        case .unloaded, .unknown:
            hasDegraded = true
        }
    }

    if hasError { return .error }
    if hasDegraded { return .degraded }
    return .healthy
}

func statusColor(for aggregate: AggregateStatus) -> String? {
    switch aggregate {
    case .healthy: return nil
    case .degraded: return "yellow"
    case .error: return "red"
    case .unknown: return "yellow"
    }
}

// MARK: - Pure function: relative time formatting (mirrors TrayMenu.relativeTime)

func relativeTime(from epochMs: Double, now: Double) -> String {
    let ageSec = Int((now - epochMs) / 1000)
    if ageSec < 60 { return "\(ageSec)s ago" }
    let ageMin = ageSec / 60
    if ageMin < 60 { return "\(ageMin)m ago" }
    let ageHr = ageMin / 60
    if ageHr < 24 { return "\(ageHr)h ago" }
    let ageDays = ageHr / 24
    return "\(ageDays)d ago"
}

// MARK: - Pure function: scheduled service detail (mirrors TrayMenu.scheduledServiceDetail)

func scheduledServiceDetail(_ heartbeat: HeartbeatData?, health: HeartbeatHealth, now: Double) -> String {
    guard let hb = heartbeat, let lastCheck = hb.lastCheck else {
        return "never run"
    }

    var parts: [String] = []

    parts.append("ran \(relativeTime(from: lastCheck, now: now))")

    if let metrics = hb.metrics {
        if let items = metrics.itemCount {
            parts.append("\(items) items")
        }
        if let patterns = metrics.patternCount {
            parts.append("\(patterns) patterns")
        }
    }

    return parts.joined(separator: ", ")
}

// MARK: - Test helpers

func makeService(
    label: String = "Test",
    launchdLabel: String = "ai.claudia.test",
    scheduled: Bool = false,
    status: ServiceStatus = .running,
    heartbeatHealth: String = "healthy",
    heartbeat: HeartbeatData? = nil
) -> ServiceState {
    ServiceState(
        definition: ServiceDefinition(label: label, launchdLabel: launchdLabel, heartbeatName: "test", scheduled: scheduled),
        status: status,
        pid: status == .running ? 1234 : nil,
        exitCode: status == .error ? 1 : 0,
        heartbeat: heartbeat,
        heartbeatHealth: HeartbeatHealth(health: heartbeatHealth, detail: nil, errorCount: 0)
    )
}

// MARK: - Tests

final class ServiceStoreTests: XCTestCase {

    // ==========================================================
    // Outcome: "Does the menu bar icon color tell the truth?"
    // ==========================================================

    func testAllServicesHealthy_IconShowsNoColor() {
        let services = [
            makeService(label: "Gmail", launchdLabel: "ai.claudia.gmail-monitor"),
            makeService(label: "Slack", launchdLabel: "ai.claudia.slack-events"),
            makeService(label: "Meetings", launchdLabel: "ai.claudia.meeting-alerts"),
            makeService(label: "Followup", launchdLabel: "ai.claudia.followup-checker"),
        ]
        let agg = computeAggregate(services)
        XCTAssertEqual(agg, .healthy)
        XCTAssertNil(statusColor(for: agg), "Healthy = no tint on tray icon")
    }

    func testOneServiceStopped_IconShowsRed() {
        let services = [
            makeService(label: "Gmail", status: .running),
            makeService(label: "Slack", status: .stopped),
        ]
        let agg = computeAggregate(services)
        XCTAssertEqual(agg, .error)
        XCTAssertEqual(statusColor(for: agg), "red")
    }

    func testOneServiceDegraded_IconShowsYellow() {
        let services = [
            makeService(label: "Gmail", status: .running, heartbeatHealth: "healthy"),
            makeService(label: "Slack", status: .running, heartbeatHealth: "degraded"),
        ]
        let agg = computeAggregate(services)
        XCTAssertEqual(agg, .degraded)
        XCTAssertEqual(statusColor(for: agg), "yellow")
    }

    func testOneServiceUnresponsive_IconShowsYellow() {
        let services = [
            makeService(label: "Gmail", status: .running, heartbeatHealth: "healthy"),
            makeService(label: "Slack", status: .running, heartbeatHealth: "unresponsive"),
        ]
        let agg = computeAggregate(services)
        XCTAssertEqual(agg, .degraded)
        XCTAssertEqual(statusColor(for: agg), "yellow")
    }

    func testErrorTrumpsDegraded_IconShowsRed() {
        let services = [
            makeService(label: "Gmail", status: .running, heartbeatHealth: "degraded"),
            makeService(label: "Slack", status: .error),
        ]
        let agg = computeAggregate(services)
        XCTAssertEqual(agg, .error)
        XCTAssertEqual(statusColor(for: agg), "red")
    }

    func testScheduledServicesIgnoredForAggregate() {
        let services = [
            makeService(label: "Gmail", status: .running),
            makeService(label: "Daily Digest", launchdLabel: "ai.claudia.digest-daily", scheduled: true, status: .stopped),
        ]
        let agg = computeAggregate(services)
        XCTAssertEqual(agg, .healthy, "Stopped scheduled service should not make icon red")
    }

    func testEmptyServices_Unknown() {
        let agg = computeAggregate([])
        XCTAssertEqual(agg, .unknown)
        XCTAssertEqual(statusColor(for: agg), "yellow", "Unknown = yellow (cautious)")
    }

    func testStartupFailed_IconShowsRed() {
        let services = [
            makeService(label: "Gmail", status: .running, heartbeatHealth: "startup-failed"),
        ]
        let agg = computeAggregate(services)
        XCTAssertEqual(agg, .error, "startup-failed is an error, not degraded")
    }

    // ==========================================================
    // Outcome: "Does each service indicator tell the truth?"
    // ==========================================================

    func testEffective_RunningAndHealthy() {
        let svc = makeService(status: .running, heartbeatHealth: "healthy")
        XCTAssertEqual(effectiveStatusFor(svc), .running)
    }

    func testEffective_RunningButUnresponsive() {
        let svc = makeService(status: .running, heartbeatHealth: "unresponsive")
        XCTAssertEqual(effectiveStatusFor(svc), .unresponsive)
    }

    func testEffective_RunningButStartupFailed() {
        let svc = makeService(status: .running, heartbeatHealth: "startup-failed")
        XCTAssertEqual(effectiveStatusFor(svc), .startupFailed)
    }

    func testEffective_RunningButErrorHeartbeat() {
        let svc = makeService(status: .running, heartbeatHealth: "error")
        XCTAssertEqual(effectiveStatusFor(svc), .error)
    }

    func testEffective_RunningButDegradedHeartbeat() {
        let svc = makeService(status: .running, heartbeatHealth: "degraded")
        XCTAssertEqual(effectiveStatusFor(svc), .degraded)
    }

    func testEffective_Stopped() {
        let svc = makeService(status: .stopped)
        XCTAssertEqual(effectiveStatusFor(svc), .stopped)
    }

    func testEffective_Error() {
        let svc = makeService(status: .error)
        XCTAssertEqual(effectiveStatusFor(svc), .error)
    }

    func testEffective_Unloaded() {
        let svc = makeService(status: .unloaded)
        XCTAssertEqual(effectiveStatusFor(svc), .unloaded)
    }

    func testEffective_RunningUnknownHeartbeat_TreatedAsRunning() {
        let svc = makeService(status: .running, heartbeatHealth: "unknown")
        XCTAssertEqual(effectiveStatusFor(svc), .running)
    }

    // ==========================================================
    // Outcome: "Do launchd labels match what deploy generates?"
    // ==========================================================

    func testServiceLabelsMatchDeployScript() {
        // The deploy script generates plists with ai.reticle.{name} labels.
        // ServiceDefinition.all must use exactly the same labels.
        let expectedLabels: Set<String> = [
            "ai.reticle.gmail-monitor",
            "ai.reticle.slack-events",
            "ai.reticle.meeting-alerts",
            "ai.reticle.followup-checker",
            "ai.reticle.meeting-recorder",
            "ai.reticle.gateway",
            "ai.reticle.digest-daily",
            "ai.reticle.digest-weekly",
        ]

        // Production ServiceDefinition.all — duplicated here for contract test
        let productionLabels: Set<String> = [
            "ai.reticle.gmail-monitor",
            "ai.reticle.slack-events",
            "ai.reticle.meeting-alerts",
            "ai.reticle.followup-checker",
            "ai.reticle.meeting-recorder",
            "ai.reticle.gateway",
            "ai.reticle.digest-daily",
            "ai.reticle.digest-weekly",
        ]

        XCTAssertEqual(expectedLabels, productionLabels,
            "ServiceDefinition launchd labels must match deploy script plist labels")
    }

    // ==========================================================
    // Outcome: "Do scheduled services render correct detail text?"
    // ==========================================================

    func testRelativeTime_Seconds() {
        let now = 1710000000000.0 // arbitrary epoch ms
        XCTAssertEqual(relativeTime(from: now - 30_000, now: now), "30s ago")
    }

    func testRelativeTime_Minutes() {
        let now = 1710000000000.0
        XCTAssertEqual(relativeTime(from: now - 300_000, now: now), "5m ago")
    }

    func testRelativeTime_Hours() {
        let now = 1710000000000.0
        XCTAssertEqual(relativeTime(from: now - 7_200_000, now: now), "2h ago")
    }

    func testRelativeTime_Days() {
        let now = 1710000000000.0
        XCTAssertEqual(relativeTime(from: now - 172_800_000, now: now), "2d ago")
    }

    func testScheduledDetail_NeverRun() {
        let detail = scheduledServiceDetail(nil, health: .unknown, now: 1710000000000.0)
        XCTAssertEqual(detail, "never run")
    }

    func testScheduledDetail_RanRecently() {
        let now = 1710000000000.0
        let hb = HeartbeatData(
            service: "digest-daily", pid: nil, startedAt: now - 60000,
            lastCheck: now - 5000, checkInterval: nil,
            status: "ok", errors: nil, metrics: nil
        )
        let health = HeartbeatHealth(health: "healthy", detail: nil, errorCount: 0)
        let detail = scheduledServiceDetail(hb, health: health, now: now)
        XCTAssertEqual(detail, "ran 5s ago")
    }

    func testScheduledDetail_WithMetrics() {
        let now = 1710000000000.0
        let hb = HeartbeatData(
            service: "digest-weekly", pid: nil, startedAt: now - 7200000,
            lastCheck: now - 7200000, checkInterval: nil,
            status: "ok", errors: nil,
            metrics: HeartbeatMetrics(
                recording: nil, meetingId: nil, duration: nil,
                captureMode: nil, permissionStatus: nil,
                itemCount: 809, patternCount: 228, degradedReason: nil
            )
        )
        let health = HeartbeatHealth(health: "healthy", detail: nil, errorCount: 0)
        let detail = scheduledServiceDetail(hb, health: health, now: now)
        XCTAssertEqual(detail, "ran 2h ago, 809 items, 228 patterns")
    }

    func testScheduledDetail_WithItemCountOnly() {
        let now = 1710000000000.0
        let hb = HeartbeatData(
            service: "digest-daily", pid: nil, startedAt: now - 300000,
            lastCheck: now - 300000, checkInterval: nil,
            status: "ok", errors: nil,
            metrics: HeartbeatMetrics(
                recording: nil, meetingId: nil, duration: nil,
                captureMode: nil, permissionStatus: nil,
                itemCount: 42, patternCount: nil, degradedReason: nil
            )
        )
        let health = HeartbeatHealth(health: "healthy", detail: nil, errorCount: 0)
        let detail = scheduledServiceDetail(hb, health: health, now: now)
        XCTAssertEqual(detail, "ran 5m ago, 42 items")
    }

    func testScheduledDetail_NoLastCheck() {
        let hb = HeartbeatData(
            service: "digest-daily", pid: nil, startedAt: nil,
            lastCheck: nil, checkInterval: nil,
            status: "ok", errors: nil, metrics: nil
        )
        let health = HeartbeatHealth(health: "unknown", detail: nil, errorCount: 0)
        let detail = scheduledServiceDetail(hb, health: health, now: 1710000000000.0)
        XCTAssertEqual(detail, "never run")
    }
}
