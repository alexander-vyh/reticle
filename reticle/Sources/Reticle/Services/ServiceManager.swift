import Foundation

// MARK: - Types

enum ServiceStatus: String, Equatable, Codable {
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

struct ServiceDefinition {
    let label: String
    let launchdLabel: String
    let heartbeatName: String?
    let scheduled: Bool

    static let all: [ServiceDefinition] = [
        ServiceDefinition(label: "Gmail Monitor",     launchdLabel: "ai.reticle.gmail-monitor",      heartbeatName: "gmail-monitor",      scheduled: false),
        ServiceDefinition(label: "Slack Events",      launchdLabel: "ai.reticle.slack-events",       heartbeatName: "slack-events",       scheduled: false),
        ServiceDefinition(label: "Meeting Alerts",    launchdLabel: "ai.reticle.meeting-alerts",     heartbeatName: "meeting-alerts",     scheduled: false),
        ServiceDefinition(label: "Follow-up Checker", launchdLabel: "ai.reticle.followup-checker",   heartbeatName: "followup-checker",   scheduled: false),
        ServiceDefinition(label: "Meeting Recorder",  launchdLabel: "ai.reticle.meeting-recorder",   heartbeatName: "meeting-recorder",   scheduled: false),
        ServiceDefinition(label: "Gateway",           launchdLabel: "ai.reticle.gateway",            heartbeatName: "gateway",            scheduled: false),
        ServiceDefinition(label: "Daily Digest",      launchdLabel: "ai.reticle.digest-daily",       heartbeatName: "digest-daily",       scheduled: true),
        ServiceDefinition(label: "Weekly Digest",     launchdLabel: "ai.reticle.digest-weekly",      heartbeatName: "digest-weekly",      scheduled: true),
    ]
}

struct ServiceState {
    let definition: ServiceDefinition
    let status: ServiceStatus
    let pid: Int?
    let exitCode: Int?
    let heartbeat: HeartbeatData?
    let heartbeatHealth: HeartbeatHealth
}

// MARK: - ServiceManager

class ServiceManager {

    private static let heartbeatDir: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.reticle/heartbeats"
    }()

    private static var cachedUID: String?

    // MARK: - Pure functions

    static func parseLaunchctlList(_ output: String) -> [String: LaunchctlEntry] {
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

    static func statusFromEntry(_ entry: LaunchctlEntry?) -> ServiceStatus {
        guard let entry = entry else { return .unloaded }
        if entry.pid != nil { return .running }
        return entry.exitCode == 0 ? .stopped : .error
    }

    static func evaluateHeartbeat(_ hb: HeartbeatData?, now: Double? = nil) -> HeartbeatHealth {
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

    // MARK: - I/O operations

    static func getUID() -> String {
        if let cached = cachedUID { return cached }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/id")
        process.arguments = ["-u"]
        let pipe = Pipe()
        process.standardOutput = pipe
        try? process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let uid = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "501"
        cachedUID = uid
        return uid
    }

    static func readHeartbeat(launchdLabel: String) -> HeartbeatData? {
        // Find heartbeat name from service definitions
        guard let def = ServiceDefinition.all.first(where: { $0.launchdLabel == launchdLabel }),
              let name = def.heartbeatName else {
            return nil
        }
        let filePath = "\(heartbeatDir)/\(name).json"
        guard let data = FileManager.default.contents(atPath: filePath) else { return nil }
        return try? JSONDecoder().decode(HeartbeatData.self, from: data)
    }

    static func getStatuses() -> [ServiceState] {
        let output: String
        do {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["list"]
            let pipe = Pipe()
            process.standardOutput = pipe
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            output = String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ServiceDefinition.all.map { def in
                ServiceState(
                    definition: def,
                    status: .unknown,
                    pid: nil,
                    exitCode: nil,
                    heartbeat: nil,
                    heartbeatHealth: .unknown
                )
            }
        }

        let parsed = parseLaunchctlList(output)

        return ServiceDefinition.all.map { def in
            let entry = parsed[def.launchdLabel]
            let hb = readHeartbeat(launchdLabel: def.launchdLabel)
            let hbHealth = evaluateHeartbeat(hb)
            return ServiceState(
                definition: def,
                status: statusFromEntry(entry),
                pid: entry?.pid,
                exitCode: entry?.exitCode,
                heartbeat: hb,
                heartbeatHealth: hbHealth
            )
        }
    }

    static func startService(_ launchdLabel: String) throws {
        let uid = getUID()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "gui/\(uid)/\(launchdLabel)"]
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            throw ServiceManagerError.launchctlFailed(label: launchdLabel, code: Int(process.terminationStatus))
        }
    }

    static func stopService(_ launchdLabel: String) throws {
        let uid = getUID()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kill", "SIGTERM", "gui/\(uid)/\(launchdLabel)"]
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            throw ServiceManagerError.launchctlFailed(label: launchdLabel, code: Int(process.terminationStatus))
        }
    }

    static func restartService(_ launchdLabel: String) throws {
        let uid = getUID()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "-k", "gui/\(uid)/\(launchdLabel)"]
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            throw ServiceManagerError.launchctlFailed(label: launchdLabel, code: Int(process.terminationStatus))
        }
    }
}

enum ServiceManagerError: Error, LocalizedError {
    case launchctlFailed(label: String, code: Int)

    var errorDescription: String? {
        switch self {
        case .launchctlFailed(let label, let code):
            return "launchctl failed for \(label) with exit code \(code)"
        }
    }
}
