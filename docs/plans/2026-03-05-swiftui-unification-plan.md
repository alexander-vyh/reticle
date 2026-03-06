# SwiftUI Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Electron tray app and meeting popup with native SwiftUI, producing two executables (Reticle.app and MeetingPopup) that unify all UI.

**Architecture:** Single Swift package with two executable targets sharing no code. Reticle.app provides MenuBarExtra (tray icon + service monitoring) and WindowGroup (management UI). MeetingPopup is a standalone floating panel spawned by the Node.js meeting-alert-monitor. All Node.js background services remain unchanged.

**Tech Stack:** Swift 5.9+, SwiftUI, AppKit (NSPanel, NSWindow), macOS 14+, ServiceManagement (SMAppService)

**Design doc:** `docs/plans/2026-03-05-swiftui-unification-design.md`

---

## Task 1: Add Test Target to Package.swift

The Swift package currently has only an executable target. We need a test target for TDD on the testable logic (service manager parsing, data models).

**Files:**
- Modify: `reticle/Package.swift`
- Create: `reticle/Tests/ReticleTests/ServiceManagerTests.swift` (placeholder)

**Step 1: Update Package.swift with test target**

```swift
// reticle/Package.swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Reticle",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "Reticle",
            path: "Sources/Reticle"
        ),
        .executableTarget(
            name: "MeetingPopup",
            path: "Sources/MeetingPopup"
        ),
        .testTarget(
            name: "ReticleTests",
            dependencies: ["Reticle"],
            path: "Tests/ReticleTests"
        ),
    ]
)
```

**Important:** The `Reticle` target is an executable with `@main`. To make it importable by tests, we'll need to extract testable logic into separate files that don't use `@main`. The test target imports `@testable import Reticle`. Swift Package Manager handles this — the `@main` attribute is only invoked when running the executable, not when importing as a dependency.

**Step 2: Create placeholder test file**

```swift
// reticle/Tests/ReticleTests/ServiceManagerTests.swift
import XCTest
@testable import Reticle

final class ServiceManagerTests: XCTestCase {
    func testPlaceholder() {
        XCTAssertTrue(true, "Test target compiles")
    }
}
```

**Step 3: Create MeetingPopup source placeholder**

The package won't compile without source for the MeetingPopup target:

```swift
// reticle/Sources/MeetingPopup/MeetingPopupApp.swift
import SwiftUI

// Placeholder — will be implemented in Task 10
@main
struct MeetingPopupApp: App {
    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
```

**Step 4: Verify it compiles**

Run: `cd reticle && swift build 2>&1 | tail -5`
Expected: Build succeeds with both targets.

Run: `cd reticle && swift test 2>&1 | tail -5`
Expected: 1 test passes.

**Step 5: Commit**

```bash
git add reticle/Package.swift reticle/Tests/ reticle/Sources/MeetingPopup/
git commit -m "chore: add MeetingPopup target and test target to Swift package"
```

---

## Task 2: ServiceManager — Launchctl Parsing (TDD)

Port the launchctl output parsing from `tray/service-manager.js:33-52` to Swift. This is pure logic with no side effects — ideal for TDD.

**Files:**
- Create: `reticle/Sources/Reticle/Services/ServiceManager.swift`
- Modify: `reticle/Tests/ReticleTests/ServiceManagerTests.swift`

**Reference:** `tray/service-manager.js` — `parseLaunchctlList()`, `statusFromEntry()`, `SERVICES` array, `HEARTBEAT_NAMES` map.

**Step 1: Write failing tests for launchctl parsing**

```swift
// reticle/Tests/ReticleTests/ServiceManagerTests.swift
import XCTest
@testable import Reticle

final class ServiceManagerTests: XCTestCase {

    // Test parsing launchctl list output into structured data
    func testParseLaunchctlOutput() {
        let output = """
        PID\tStatus\tLabel
        1234\t0\tai.reticle.gmail-monitor
        -\t0\tai.reticle.digest-daily
        -\t78\tai.reticle.slack-events
        5678\t0\tai.reticle.meeting-alerts
        """

        let entries = ServiceManager.parseLaunchctlList(output)

        XCTAssertEqual(entries.count, 4)

        // Running service: has PID
        let gmail = entries["ai.reticle.gmail-monitor"]
        XCTAssertNotNil(gmail)
        XCTAssertEqual(gmail?.pid, 1234)
        XCTAssertEqual(gmail?.exitCode, 0)

        // Stopped service: no PID, exit 0
        let daily = entries["ai.reticle.digest-daily"]
        XCTAssertNotNil(daily)
        XCTAssertNil(daily?.pid)
        XCTAssertEqual(daily?.exitCode, 0)

        // Error service: no PID, non-zero exit
        let slack = entries["ai.reticle.slack-events"]
        XCTAssertNotNil(slack)
        XCTAssertNil(slack?.pid)
        XCTAssertEqual(slack?.exitCode, 78)
    }

    func testStatusFromEntry() {
        // No entry = unloaded
        XCTAssertEqual(ServiceManager.statusFromEntry(nil), .unloaded)

        // Has PID = running
        let running = ServiceManager.LaunchctlEntry(pid: 1234, exitCode: 0)
        XCTAssertEqual(ServiceManager.statusFromEntry(running), .running)

        // No PID, exit 0 = stopped
        let stopped = ServiceManager.LaunchctlEntry(pid: nil, exitCode: 0)
        XCTAssertEqual(ServiceManager.statusFromEntry(stopped), .stopped)

        // No PID, non-zero exit = error
        let errored = ServiceManager.LaunchctlEntry(pid: nil, exitCode: 78)
        XCTAssertEqual(ServiceManager.statusFromEntry(errored), .error)
    }

    func testEmptyLaunchctlOutput() {
        let entries = ServiceManager.parseLaunchctlList("")
        XCTAssertTrue(entries.isEmpty)
    }

    func testHeaderOnlyOutput() {
        let entries = ServiceManager.parseLaunchctlList("PID\tStatus\tLabel\n")
        XCTAssertTrue(entries.isEmpty)
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `cd reticle && swift test 2>&1 | tail -20`
Expected: Compilation error — `ServiceManager` type not found.

**Step 3: Implement ServiceManager with parsing logic**

```swift
// reticle/Sources/Reticle/Services/ServiceManager.swift
import Foundation

enum ServiceStatus: String, Equatable {
    case running
    case stopped
    case error
    case unloaded
    case unknown
}

struct ServiceDefinition {
    let label: String
    let launchdLabel: String
    let heartbeatName: String?
    let scheduled: Bool

    static let all: [ServiceDefinition] = [
        ServiceDefinition(label: "Gmail Monitor", launchdLabel: "ai.reticle.gmail-monitor", heartbeatName: "gmail-monitor", scheduled: false),
        ServiceDefinition(label: "Slack Events", launchdLabel: "ai.reticle.slack-events", heartbeatName: "slack-events", scheduled: false),
        ServiceDefinition(label: "Meeting Alerts", launchdLabel: "ai.reticle.meeting-alerts", heartbeatName: "meeting-alerts", scheduled: false),
        ServiceDefinition(label: "Follow-up Checker", launchdLabel: "ai.reticle.followup-checker", heartbeatName: "followup-checker", scheduled: false),
        ServiceDefinition(label: "Meeting Recorder", launchdLabel: "ai.openclaw.meeting-recorder", heartbeatName: nil, scheduled: false),
        ServiceDefinition(label: "Gateway", launchdLabel: "ai.openclaw.gateway", heartbeatName: nil, scheduled: false),
        ServiceDefinition(label: "Daily Digest", launchdLabel: "ai.reticle.digest-daily", heartbeatName: "digest-daily", scheduled: true),
        ServiceDefinition(label: "Weekly Digest", launchdLabel: "ai.reticle.digest-weekly", heartbeatName: "digest-weekly", scheduled: true),
    ]
}

struct ServiceState {
    let definition: ServiceDefinition
    var status: ServiceStatus
    var pid: Int?
    var exitCode: Int?
    var heartbeat: HeartbeatData?
    var heartbeatHealth: HeartbeatHealth
}

struct HeartbeatData: Codable {
    let status: String?
    let lastCheck: Double?
    let checkInterval: Double?
    let errors: HeartbeatErrors?
}

struct HeartbeatErrors: Codable {
    let lastError: String?
    let countSinceStart: Int?
}

struct HeartbeatHealth: Equatable {
    let health: String  // healthy, unresponsive, startup-failed, error, degraded, unknown, shutting-down
    let detail: String?
    let errorCount: Int

    static let unknown = HeartbeatHealth(health: "unknown", detail: nil, errorCount: 0)
}

class ServiceManager {

    struct LaunchctlEntry: Equatable {
        let pid: Int?
        let exitCode: Int
    }

    private let heartbeatDir: String
    private var cachedUID: String?

    init(heartbeatDir: String? = nil) {
        self.heartbeatDir = heartbeatDir ?? "\(NSHomeDirectory())/.reticle/heartbeats"
    }

    // MARK: - Pure parsing (testable)

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

    static func evaluateHeartbeat(_ hb: HeartbeatData?) -> HeartbeatHealth {
        guard let hb = hb else {
            return .unknown
        }
        if hb.status == "startup-failed" {
            return HeartbeatHealth(
                health: "startup-failed",
                detail: hb.errors?.lastError ?? "Unknown error",
                errorCount: 0
            )
        }
        if hb.status == "error" || hb.status == "degraded" {
            return HeartbeatHealth(
                health: hb.status ?? "error",
                detail: hb.errors?.lastError,
                errorCount: hb.errors?.countSinceStart ?? 0
            )
        }
        if hb.status == "shutting-down" {
            return HeartbeatHealth(health: "shutting-down", detail: nil, errorCount: 0)
        }
        guard let lastCheck = hb.lastCheck, let interval = hb.checkInterval else {
            return .unknown
        }
        let ageMs = Date().timeIntervalSince1970 * 1000 - lastCheck
        if ageMs > interval * 3 {
            let ageMin = Int(ageMs / 60000)
            return HeartbeatHealth(
                health: "unresponsive",
                detail: "No heartbeat for \(ageMin)m",
                errorCount: 0
            )
        }
        return HeartbeatHealth(
            health: "healthy",
            detail: nil,
            errorCount: hb.errors?.countSinceStart ?? 0
        )
    }

    // MARK: - I/O operations

    func getUID() -> String {
        if let cached = cachedUID { return cached }
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/id")
        process.arguments = ["-u"]
        process.standardOutput = pipe
        try? process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        cachedUID = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return cachedUID ?? "501"
    }

    func readHeartbeat(for definition: ServiceDefinition) -> HeartbeatData? {
        guard let name = definition.heartbeatName else { return nil }
        let path = "\(heartbeatDir)/\(name).json"
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? JSONDecoder().decode(HeartbeatData.self, from: data)
    }

    func getStatuses() -> [ServiceState] {
        let output: String
        do {
            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["list"]
            process.standardOutput = pipe
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            output = String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ServiceDefinition.all.map {
                ServiceState(definition: $0, status: .unknown, pid: nil, exitCode: nil, heartbeat: nil, heartbeatHealth: .unknown)
            }
        }

        let entries = Self.parseLaunchctlList(output)

        return ServiceDefinition.all.map { def in
            let entry = entries[def.launchdLabel]
            let hb = readHeartbeat(for: def)
            let hbHealth = Self.evaluateHeartbeat(hb)
            return ServiceState(
                definition: def,
                status: Self.statusFromEntry(entry),
                pid: entry?.pid,
                exitCode: entry?.exitCode,
                heartbeat: hb,
                heartbeatHealth: hbHealth
            )
        }
    }

    func startService(_ launchdLabel: String) throws {
        let uid = getUID()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "gui/\(uid)/\(launchdLabel)"]
        try process.run()
        process.waitUntilExit()
    }

    func stopService(_ launchdLabel: String) throws {
        let uid = getUID()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kill", "SIGTERM", "gui/\(uid)/\(launchdLabel)"]
        try process.run()
        process.waitUntilExit()
    }

    func restartService(_ launchdLabel: String) throws {
        let uid = getUID()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "-k", "gui/\(uid)/\(launchdLabel)"]
        try process.run()
        process.waitUntilExit()
    }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd reticle && swift test 2>&1 | tail -20`
Expected: All 4 tests pass.

**Step 5: Commit**

```bash
git add reticle/Sources/Reticle/Services/ServiceManager.swift reticle/Tests/ReticleTests/ServiceManagerTests.swift
git commit -m "feat: add ServiceManager with launchctl parsing and heartbeat evaluation"
```

---

## Task 3: ServiceManager — Heartbeat Evaluation Tests

Add TDD tests for the heartbeat evaluation logic ported from `tray/service-manager.js:71-87`.

**Files:**
- Modify: `reticle/Tests/ReticleTests/ServiceManagerTests.swift`

**Step 1: Write failing tests for heartbeat evaluation**

Add these tests to `ServiceManagerTests`:

```swift
    func testEvaluateHeartbeatNil() {
        let health = ServiceManager.evaluateHeartbeat(nil)
        XCTAssertEqual(health, .unknown)
    }

    func testEvaluateHeartbeatStartupFailed() {
        let hb = HeartbeatData(
            status: "startup-failed",
            lastCheck: nil,
            checkInterval: nil,
            errors: HeartbeatErrors(lastError: "Missing token", countSinceStart: nil)
        )
        let health = ServiceManager.evaluateHeartbeat(hb)
        XCTAssertEqual(health.health, "startup-failed")
        XCTAssertEqual(health.detail, "Missing token")
    }

    func testEvaluateHeartbeatHealthy() {
        let now = Date().timeIntervalSince1970 * 1000
        let hb = HeartbeatData(
            status: "running",
            lastCheck: now - 5000,  // 5 seconds ago
            checkInterval: 30000,   // 30 second interval
            errors: HeartbeatErrors(lastError: nil, countSinceStart: 0)
        )
        let health = ServiceManager.evaluateHeartbeat(hb)
        XCTAssertEqual(health.health, "healthy")
        XCTAssertEqual(health.errorCount, 0)
    }

    func testEvaluateHeartbeatUnresponsive() {
        let now = Date().timeIntervalSince1970 * 1000
        let hb = HeartbeatData(
            status: "running",
            lastCheck: now - 300000,  // 5 minutes ago
            checkInterval: 30000,     // 30 second interval (5min >> 3*30s)
            errors: nil
        )
        let health = ServiceManager.evaluateHeartbeat(hb)
        XCTAssertEqual(health.health, "unresponsive")
    }

    func testEvaluateHeartbeatDegraded() {
        let hb = HeartbeatData(
            status: "degraded",
            lastCheck: nil,
            checkInterval: nil,
            errors: HeartbeatErrors(lastError: "Rate limited", countSinceStart: 3)
        )
        let health = ServiceManager.evaluateHeartbeat(hb)
        XCTAssertEqual(health.health, "degraded")
        XCTAssertEqual(health.errorCount, 3)
    }
```

**Step 2: Run tests to verify they pass** (implementation already exists from Task 2)

Run: `cd reticle && swift test 2>&1 | tail -20`
Expected: All 9 tests pass. If any fail, fix the implementation.

**Step 3: Commit**

```bash
git add reticle/Tests/ReticleTests/ServiceManagerTests.swift
git commit -m "test: add heartbeat evaluation tests for ServiceManager"
```

---

## Task 4: ReticleIcon — Port Tray Icon to SwiftUI Canvas

Port the 5-layer reticle icon from `tray/icons.js` to SwiftUI Canvas. This renders the menu bar icon at 22x22pt.

**Reference:** `tray/icons.js` — 24x24 SVG viewBox with:
- Outer ring (r=10.4 outer, r=7.6 inner) with 4 gap masks at cardinal points
- Status fill circle (r=7.6) with color
- Inner arcs (r=6.6, 90-degree arcs, opposing quadrants)
- Center star (bezier 4-point, r~2.3)

**Files:**
- Create: `reticle/Sources/Reticle/Services/ReticleIcon.swift`

**Step 1: Create the icon renderer**

The SVG viewBox is 24x24. We scale to render at the menu bar's 22x22pt. All coordinates below are in the 24x24 space and drawn with a scale transform.

```swift
// reticle/Sources/Reticle/Services/ReticleIcon.swift
import SwiftUI

struct ReticleIcon: View {
    let statusColor: Color?  // nil = green (no fill), Color.yellow, Color.red
    let arcRotation: Double  // degrees

    // Canonical viewBox dimensions (from icons.js SVG)
    private let vb: CGFloat = 24
    private let center: CGFloat = 12

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / vb
            context.scaleBy(x: scale, y: scale)

            // Layer 1: Outer ring with gap masks
            drawOuterRing(context: &context)

            // Layer 2: Status fill circle
            if let color = statusColor {
                let fillCircle = Path(ellipseIn: CGRect(
                    x: center - 7.6, y: center - 7.6,
                    width: 15.2, height: 15.2
                ))
                context.fill(fillCircle, with: .color(color))
            }

            // Layer 3: Inner arcs (rotatable)
            drawInnerArcs(context: &context, rotation: arcRotation)

            // Layer 4: Center star
            drawStar(context: &context)
        }
        .frame(width: 22, height: 22)
    }

    private func drawOuterRing(context: inout GraphicsContext) {
        // Outer ring: annulus from r=7.6 to r=10.4
        var ring = Path()
        ring.addEllipse(in: CGRect(x: center - 10.4, y: center - 10.4, width: 20.8, height: 20.8))
        ring.addEllipse(in: CGRect(x: center - 7.6, y: center - 7.6, width: 15.2, height: 15.2))

        // Use even-odd fill for the annulus
        context.clipToLayer { clipCtx in
            // Draw the ring shape
            clipCtx.fill(ring, with: .color(.white), style: FillStyle(eoFill: true))

            // Cut out 4 cardinal gaps (masks from icons.js)
            let gaps = [
                CGRect(x: 19.2, y: 11.27, width: 3.6, height: 1.46),  // 3 o'clock
                CGRect(x: 11.27, y: 1.2, width: 1.46, height: 3.6),   // 12 o'clock
                CGRect(x: 1.2, y: 11.27, width: 3.6, height: 1.46),   // 9 o'clock
                CGRect(x: 11.27, y: 19.2, width: 1.46, height: 3.6),  // 6 o'clock
            ]
            for gap in gaps {
                clipCtx.fill(Path(gap), with: .color(.black))
            }
        }

        // Now fill the clipped region
        // Actually, clipToLayer works differently. Let's use a different approach:
        // Draw the ring, then punch out the gaps by drawing them with .clear blend mode.

        // Draw full annulus
        context.fill(ring, with: .color(.white), style: FillStyle(eoFill: true))

        // Punch out gaps with clear blend mode
        var gapContext = context
        gapContext.blendMode = .clear
        let gaps = [
            CGRect(x: 19.2, y: 11.27, width: 3.6, height: 1.46),
            CGRect(x: 11.27, y: 1.2, width: 1.46, height: 3.6),
            CGRect(x: 1.2, y: 11.27, width: 3.6, height: 1.46),
            CGRect(x: 11.27, y: 19.2, width: 1.46, height: 3.6),
        ]
        for gap in gaps {
            gapContext.fill(Path(gap), with: .color(.white))
        }
    }

    private func drawInnerArcs(context: inout GraphicsContext, rotation: Double) {
        // Two 90-degree arcs on r=6.6 circle, opposing quadrants
        // Arc 1: from 9 o'clock to 12 o'clock (180° to 270° in standard coords)
        // Arc 2: from 3 o'clock to 6 o'clock (0° to 90°)
        // In SVG: "M 5.4 12 A 6.6 6.6 0 0 1 12 5.4" = left to top
        //         "M 18.6 12 A 6.6 6.6 0 0 1 12 18.6" = right to bottom

        var arcs = Path()
        // Arc 1: from (5.4, 12) to (12, 5.4) — 9 o'clock to 12 o'clock
        arcs.move(to: CGPoint(x: 5.4, y: center))
        arcs.addArc(center: CGPoint(x: center, y: center), radius: 6.6,
                     startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        // Arc 2: from (18.6, 12) to (12, 18.6) — 3 o'clock to 6 o'clock
        arcs.move(to: CGPoint(x: 18.6, y: center))
        arcs.addArc(center: CGPoint(x: center, y: center), radius: 6.6,
                     startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)

        var rotatedContext = context
        rotatedContext.rotate(by: .degrees(rotation), anchor: CGPoint(x: center, y: center))
        rotatedContext.stroke(arcs, with: .color(.white), style: StrokeStyle(lineWidth: 0.6, lineCap: .round))
    }

    private func drawStar(context: inout GraphicsContext) {
        // 4-point star from icons.js bezier paths
        // M 12,9.7  C 12.2,11.1 12.9,11.8 14.3,12
        // C 12.9,12.2 12.2,12.9 12,14.3
        // C 11.8,12.9 11.1,12.2 9.7,12
        // C 11.1,11.8 11.8,11.1 12,9.7 Z
        var star = Path()
        star.move(to: CGPoint(x: 12, y: 9.7))
        star.addCurve(to: CGPoint(x: 14.3, y: 12),
                      control1: CGPoint(x: 12.2, y: 11.1),
                      control2: CGPoint(x: 12.9, y: 11.8))
        star.addCurve(to: CGPoint(x: 12, y: 14.3),
                      control1: CGPoint(x: 12.9, y: 12.2),
                      control2: CGPoint(x: 12.2, y: 12.9))
        star.addCurve(to: CGPoint(x: 9.7, y: 12),
                      control1: CGPoint(x: 11.8, y: 12.9),
                      control2: CGPoint(x: 11.1, y: 12.2))
        star.addCurve(to: CGPoint(x: 12, y: 9.7),
                      control1: CGPoint(x: 11.1, y: 11.8),
                      control2: CGPoint(x: 11.8, y: 11.1))
        star.closeSubpath()
        context.fill(star, with: .color(.white))
    }
}

// Convenience for generating NSImage for MenuBarExtra
extension ReticleIcon {
    @MainActor
    static func menuBarImage(statusColor: Color?, arcRotation: Double = 0) -> NSImage {
        let renderer = ImageRenderer(content: ReticleIcon(statusColor: statusColor, arcRotation: arcRotation))
        renderer.scale = 2.0  // Retina
        guard let cgImage = renderer.cgImage else {
            return NSImage(systemSymbolName: "circle", accessibilityDescription: "Reticle") ?? NSImage()
        }
        let image = NSImage(cgImage: cgImage, size: NSSize(width: 22, height: 22))
        image.isTemplate = false  // We handle coloring ourselves
        return image
    }
}
```

**Step 2: Verify it compiles**

Run: `cd reticle && swift build 2>&1 | tail -5`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add reticle/Sources/Reticle/Services/ReticleIcon.swift
git commit -m "feat: port reticle tray icon to SwiftUI Canvas renderer"
```

**Note:** Visual verification happens when the app runs in Task 8. The icon math is a direct port of the SVG coordinates from `tray/icons.js` — same numbers, same paths. If it looks wrong, the fix will be in the coordinate mapping, not the approach.

---

## Task 5: ServiceStore — Observable Service State

Create the `@Observable` class that polls service state on a timer, used by both the tray menu and (eventually) a services panel in the management window.

**Files:**
- Create: `reticle/Sources/Reticle/Services/ServiceStore.swift`

**Step 1: Implement ServiceStore**

```swift
// reticle/Sources/Reticle/Services/ServiceStore.swift
import SwiftUI
import Combine

@MainActor
class ServiceStore: ObservableObject {
    @Published var services: [ServiceState] = []
    @Published var aggregateStatus: AggregateStatus = .unknown

    private let manager = ServiceManager()
    private var pollTimer: Timer?

    enum AggregateStatus {
        case healthy    // All persistent services running + healthy
        case degraded   // Some degraded/unresponsive
        case error      // Any stopped/error/startup-failed
        case unknown
    }

    func startPolling(interval: TimeInterval = 10) {
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func refresh() {
        services = manager.getStatuses()
        aggregateStatus = computeAggregate(services)
    }

    private func computeAggregate(_ states: [ServiceState]) -> AggregateStatus {
        let persistent = states.filter { !$0.definition.scheduled }
        let effectives = persistent.map { effectiveStatus($0) }

        if effectives.contains(.error) || effectives.contains(.stopped) || effectives.contains(.startupFailed) {
            return .error
        }
        if effectives.contains(.unresponsive) || effectives.contains(.degraded) {
            return .degraded
        }
        if effectives.allSatisfy({ $0 == .running || $0 == .unloaded || $0 == .unknown }) {
            return .healthy
        }
        return .degraded
    }

    enum EffectiveStatus {
        case running, stopped, error, unloaded, unknown
        case unresponsive, degraded, startupFailed
    }

    func effectiveStatus(_ state: ServiceState) -> EffectiveStatus {
        if state.status != .running {
            switch state.status {
            case .stopped: return .stopped
            case .error: return .error
            case .unloaded: return .unloaded
            default: return .unknown
            }
        }
        switch state.heartbeatHealth.health {
        case "healthy": return .running
        case "unresponsive": return .unresponsive
        case "startup-failed": return .startupFailed
        case "degraded": return .degraded
        case "error": return .error
        default: return .running
        }
    }

    var statusColor: Color? {
        switch aggregateStatus {
        case .healthy: return nil         // green = no fill
        case .degraded: return .yellow
        case .error: return .red
        case .unknown: return .yellow
        }
    }

    // MARK: - Actions

    func start(_ label: String) {
        try? manager.startService(label)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.refresh()
        }
    }

    func stop(_ label: String) {
        try? manager.stopService(label)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.refresh()
        }
    }

    func restart(_ label: String) {
        try? manager.restartService(label)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.refresh()
        }
    }

    func startAll() {
        for svc in services where svc.status != .running {
            try? manager.startService(svc.definition.launchdLabel)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.refresh()
        }
    }

    func stopAll() {
        for svc in services where svc.status == .running {
            try? manager.stopService(svc.definition.launchdLabel)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.refresh()
        }
    }
}
```

**Step 2: Verify it compiles**

Run: `cd reticle && swift build 2>&1 | tail -5`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add reticle/Sources/Reticle/Services/ServiceStore.swift
git commit -m "feat: add ServiceStore for observable service state polling"
```

---

## Task 6: AppState — Lifecycle Management

Manages window visibility, activation policy toggling, and login item registration.

**Files:**
- Create: `reticle/Sources/Reticle/AppState.swift`

**Step 1: Implement AppState**

```swift
// reticle/Sources/Reticle/AppState.swift
import SwiftUI
import ServiceManagement

@MainActor
class AppState: ObservableObject {
    @Published var isManagementWindowVisible = false
    @Published var isLoginItemEnabled = false

    init() {
        isLoginItemEnabled = SMAppService.mainApp.status == .enabled
    }

    func showManagementWindow() {
        isManagementWindowVisible = true
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        // Find and show the management window
        for window in NSApp.windows {
            if window.title == "Reticle" || window.identifier?.rawValue == "management" {
                window.makeKeyAndOrderFront(nil)
                return
            }
        }

        // If no window found, open a new one via WindowGroup
        if let url = URL(string: "reticle://management") {
            NSWorkspace.shared.open(url)
        }
    }

    func hideManagementWindow() {
        isManagementWindowVisible = false
        NSApp.setActivationPolicy(.accessory)
    }

    func toggleLoginItem() {
        do {
            if isLoginItemEnabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
            isLoginItemEnabled = SMAppService.mainApp.status == .enabled
        } catch {
            // Silently fail — user can manage in System Settings
        }
    }
}
```

**Step 2: Verify it compiles**

Run: `cd reticle && swift build 2>&1 | tail -5`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add reticle/Sources/Reticle/AppState.swift
git commit -m "feat: add AppState for window lifecycle and login item management"
```

---

## Task 7: TrayMenu — MenuBarExtra View

The tray menu that appears when clicking the menu bar icon. Replaces `tray/main.js:181-268`.

**Files:**
- Create: `reticle/Sources/Reticle/TrayMenu.swift`

**Step 1: Implement TrayMenu**

```swift
// reticle/Sources/Reticle/TrayMenu.swift
import SwiftUI

struct TrayMenu: View {
    @EnvironmentObject var serviceStore: ServiceStore
    @EnvironmentObject var appState: AppState

    private let statusEmoji: [String: String] = [
        "running": "●",
        "stopped": "○",
        "error": "✖",
        "unloaded": "○",
        "unknown": "?",
        "unresponsive": "◐",
        "degraded": "◐",
        "startup-failed": "✖",
    ]

    var body: some View {
        Button("Open Reticle") {
            appState.showManagementWindow()
        }
        .keyboardShortcut("r", modifiers: .command)

        Divider()

        let persistent = serviceStore.services.filter { !$0.definition.scheduled }
        let runningCount = persistent.filter { $0.status == .running }.count
        Text("Services — \(runningCount)/\(persistent.count) running")

        ForEach(serviceStore.services, id: \.definition.launchdLabel) { svc in
            serviceMenuItem(svc)
        }

        Divider()

        Button("Start All") { serviceStore.startAll() }
        Button("Stop All") { serviceStore.stopAll() }

        Divider()

        Toggle("Start at Login", isOn: Binding(
            get: { appState.isLoginItemEnabled },
            set: { _ in appState.toggleLoginItem() }
        ))

        Divider()

        Button("Quit Reticle") {
            NSApplication.shared.terminate(nil)
        }
    }

    @ViewBuilder
    private func serviceMenuItem(_ svc: ServiceState) -> some View {
        let effective = serviceStore.effectiveStatus(svc)
        let emoji = effectiveEmoji(effective)
        let detail = serviceDetail(svc, effective: effective)
        let label = "\(emoji)  \(svc.definition.label)\(detail.isEmpty ? "" : "  (\(detail))")"

        Menu(label) {
            if svc.status == .running {
                Button("Stop") { serviceStore.stop(svc.definition.launchdLabel) }
                Button("Restart") { serviceStore.restart(svc.definition.launchdLabel) }
            } else {
                Button("Start") { serviceStore.start(svc.definition.launchdLabel) }
            }
        }
    }

    private func effectiveEmoji(_ status: ServiceStore.EffectiveStatus) -> String {
        switch status {
        case .running: return "●"
        case .stopped: return "○"
        case .error, .startupFailed: return "✖"
        case .unloaded: return "○"
        case .unresponsive, .degraded: return "◐"
        case .unknown: return "?"
        }
    }

    private func serviceDetail(_ svc: ServiceState, effective: ServiceStore.EffectiveStatus) -> String {
        if svc.status == .running, let hb = svc.heartbeat, let lastCheck = hb.lastCheck {
            let age = Int((Date().timeIntervalSince1970 * 1000 - lastCheck) / 1000)
            let ageStr = age < 60 ? "\(age)s ago" : "\(age / 60)m ago"
            var detail = "PID \(svc.pid ?? 0), \(ageStr)"
            if svc.heartbeatHealth.errorCount > 0 {
                detail += ", \(svc.heartbeatHealth.errorCount) errors"
            }
            return detail
        } else if svc.status == .running, let pid = svc.pid {
            return "PID \(pid)"
        } else if effective == .startupFailed {
            return svc.heartbeatHealth.detail ?? "startup failed"
        } else if svc.status == .error, let exit = svc.exitCode {
            return "exit \(exit)"
        }
        return ""
    }
}
```

**Step 2: Verify it compiles**

Run: `cd reticle && swift build 2>&1 | tail -5`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add reticle/Sources/Reticle/TrayMenu.swift
git commit -m "feat: add TrayMenu view for MenuBarExtra context menu"
```

---

## Task 8: Rewrite ReticleApp.swift — MenuBarExtra + WindowGroup

Wire together all components: MenuBarExtra with animated icon, WindowGroup with hide-not-close, AppDelegate for second-launch handling.

**Files:**
- Modify: `reticle/Sources/Reticle/ReticleApp.swift`
- Modify: `reticle/Sources/Reticle/ContentView.swift` (add WindowAccessor)

**Step 1: Add WindowAccessor to ContentView**

Add a background modifier to ContentView that intercepts window close:

```swift
// reticle/Sources/Reticle/ContentView.swift
// Add this struct at the bottom of the file, after ContentView:

struct WindowAccessor: NSViewRepresentable {
    let onClose: () -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.delegate = context.coordinator
            window.identifier = NSUserInterfaceItemIdentifier("management")
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onClose: onClose) }

    class Coordinator: NSObject, NSWindowDelegate {
        let onClose: () -> Void
        init(onClose: @escaping () -> Void) { self.onClose = onClose }

        func windowShouldClose(_ sender: NSWindow) -> Bool {
            sender.orderOut(nil)
            onClose()
            return false
        }
    }
}
```

Then modify the `ContentView` body to include the WindowAccessor:

```swift
// In ContentView, at the end of the NavigationSplitView chain, add:
        .background(
            WindowAccessor {
                NSApp.setActivationPolicy(.accessory)
            }
        )
```

**Step 2: Rewrite ReticleApp.swift**

```swift
// reticle/Sources/Reticle/ReticleApp.swift
import SwiftUI

@main
struct ReticleApp: App {
    @StateObject private var gateway = GatewayClient()
    @StateObject private var serviceStore = ServiceStore()
    @StateObject private var appState = AppState()

    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // Menu bar tray icon
        MenuBarExtra {
            TrayMenu()
                .environmentObject(serviceStore)
                .environmentObject(appState)
        } label: {
            Image(nsImage: ReticleIcon.menuBarImage(statusColor: serviceStore.statusColor))
        }

        // Management window
        WindowGroup("Reticle") {
            ContentView()
                .environmentObject(gateway)
                .environmentObject(serviceStore)
                .environmentObject(appState)
                .frame(minWidth: 800, minHeight: 500)
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }

    init() {
        // Start as accessory app (no dock icon) — will show dock when window opens
        NSApp?.setActivationPolicy(.accessory)
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Second launch or dock icon click — show management window
        if !flag {
            // Find the AppState and show the window
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)

            // Open a new window via the WindowGroup
            for window in NSApp.windows {
                if window.title == "Reticle" || window.identifier?.rawValue == "management" {
                    window.makeKeyAndOrderFront(nil)
                    return true
                }
            }
        }
        return true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide dock icon on launch — tray only
        NSApp.setActivationPolicy(.accessory)
    }
}
```

**Step 3: Verify it compiles**

Run: `cd reticle && swift build 2>&1 | tail -10`
Expected: Build succeeds.

**Step 4: Test the app launches**

Run: `cd reticle && .build/debug/Reticle &`
Expected: A reticle icon appears in the menu bar. Clicking it shows the context menu with service statuses. Check the "Open Reticle" menu item opens the management window.

Kill the test: `killall Reticle`

**Step 5: Commit**

```bash
git add reticle/Sources/Reticle/ReticleApp.swift reticle/Sources/Reticle/ContentView.swift
git commit -m "feat: rewrite ReticleApp with MenuBarExtra, WindowGroup, and hide-not-close"
```

---

## Task 9: MeetingPopup — Data Models

The meeting popup receives base64-encoded JSON via CLI argument. Define the Swift models.

**Files:**
- Create: `reticle/Sources/MeetingPopup/Models.swift`

**Reference:** `meeting-popup-window.js:10-24` — meetingData structure. `meeting-popup.html:288-298` — expected fields.

**Step 1: Implement models**

```swift
// reticle/Sources/MeetingPopup/Models.swift
import Foundation

struct MeetingPopupData: Codable {
    var alertLevel: String   // tenMin, fiveMin, oneMin, start
    var meetings: [MeetingInfo]
}

struct MeetingInfo: Codable, Identifiable {
    let id: String
    let summary: String?
    let startTime: String
    var hasVideoLink: Bool
    var platform: String?
    var url: String?
    var joinLabel: String?
    let calendarLink: String?
    let attendees: [String]?

    var startDate: Date {
        ISO8601DateFormatter().date(from: startTime) ?? Date()
    }
}

struct EscalationMessage: Codable {
    let type: String
    let alertLevel: String?
    let meetings: [MeetingInfo]?
}
```

**Step 2: Verify it compiles**

Run: `cd reticle && swift build 2>&1 | tail -5`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add reticle/Sources/MeetingPopup/Models.swift
git commit -m "feat: add MeetingPopup data models for CLI argument parsing"
```

---

## Task 10: MeetingPopup — NSPanel Window

The floating popup window that sits above everything. Replaces `meeting-popup-window.js`.

**Files:**
- Modify: `reticle/Sources/MeetingPopup/MeetingPopupApp.swift`
- Create: `reticle/Sources/MeetingPopup/PopupWindow.swift`
- Create: `reticle/Sources/MeetingPopup/PopupState.swift`

**Step 1: Create PopupState (drives the UI)**

```swift
// reticle/Sources/MeetingPopup/PopupState.swift
import SwiftUI

@MainActor
class PopupState: ObservableObject {
    @Published var data: MeetingPopupData
    @Published var isCollapsed: Bool
    @Published var countdownText: String = "--:--"
    @Published var isUrgent: Bool = false
    @Published var isNow: Bool = false
    @Published var shake: Bool = false

    private var timer: Timer?

    init(data: MeetingPopupData) {
        self.data = data
        self.isCollapsed = data.alertLevel == "tenMin"
        startCountdown()
    }

    func startCountdown() {
        updateCountdown()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.updateCountdown()
            }
        }
    }

    func updateCountdown() {
        guard let earliest = data.meetings.map({ $0.startDate }).min() else { return }
        let diff = earliest.timeIntervalSinceNow
        let absDiff = abs(diff)
        let min = Int(absDiff) / 60
        let sec = Int(absDiff) % 60

        if diff <= 0 {
            countdownText = "-\(min):\(String(format: "%02d", sec))"
            isNow = true
            isUrgent = false
        } else if diff <= 300 {
            countdownText = "\(min):\(String(format: "%02d", sec))"
            isUrgent = true
            isNow = false
        } else {
            countdownText = "\(min):\(String(format: "%02d", sec))"
            isUrgent = false
            isNow = false
        }

        // Shake at 1 minute and at start
        let diffMin = diff / 60
        if (diffMin <= 1.05 && diffMin > 0.95) || (diffMin <= 0.05 && diffMin > -0.05) {
            if !shake {
                shake = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    self?.shake = false
                }
            }
        }
    }

    func collapse() {
        isCollapsed = true
    }

    func expand() {
        isCollapsed = false
    }

    func handleEscalation(_ msg: EscalationMessage) {
        if let level = msg.alertLevel {
            data.alertLevel = level
        }
        if let meetings = msg.meetings {
            data.meetings = meetings
        }
        if isCollapsed {
            expand()
        }
    }

    func joinMeeting(_ meeting: MeetingInfo) {
        guard let urlStr = meeting.url, let url = URL(string: urlStr) else { return }
        NSWorkspace.shared.open(url)
    }

    func dismiss() {
        if data.alertLevel == "start" { return }
        collapse()
    }

    func scheduleAutoClose() {
        guard let earliest = data.meetings.map({ $0.startDate }).min() else { return }
        let autoCloseAt = earliest.addingTimeInterval(5 * 60)
        let delay = autoCloseAt.timeIntervalSinceNow
        if delay <= 0 {
            NSApp.terminate(nil)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                NSApp.terminate(nil)
            }
        }
    }
}
```

**Step 2: Create PopupWindow (NSPanel wrapper)**

```swift
// reticle/Sources/MeetingPopup/PopupWindow.swift
import AppKit
import SwiftUI

class PopupPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

class PopupWindowController {
    var panel: PopupPanel?
    let state: PopupState

    init(state: PopupState) {
        self.state = state
    }

    func show(content: some View) {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let screenWidth = screen.visibleFrame.maxX

        let startAsPill = state.isCollapsed
        let width: CGFloat = startAsPill ? 80 : 300
        let height: CGFloat = startAsPill ? 44 : min(CGFloat(100 + state.data.meetings.count * 150), 500)

        let x = screenWidth - width - 20
        let y = screen.visibleFrame.maxY - height - 20

        let panel = PopupPanel(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false

        let hostingView = NSHostingView(rootView: content)
        panel.contentView = hostingView

        panel.orderFrontRegardless()
        self.panel = panel
    }

    func resize(width: CGFloat, height: CGFloat) {
        guard let panel = panel else { return }
        var frame = panel.frame
        let rightEdge = frame.maxX
        frame.size = NSSize(width: width, height: height)
        frame.origin.x = rightEdge - width
        panel.setFrame(frame, display: true, animate: true)
    }
}
```

**Step 3: Rewrite MeetingPopupApp.swift**

```swift
// reticle/Sources/MeetingPopup/MeetingPopupApp.swift
import SwiftUI

@main
struct MeetingPopupApp: App {
    @StateObject private var state: PopupState

    init() {
        let data = Self.parseArgs()
        _state = StateObject(wrappedValue: PopupState(data: data))
    }

    var body: some Scene {
        WindowGroup {
            PopupContentView()
                .environmentObject(state)
                .frame(
                    width: state.isCollapsed ? 80 : 300,
                    height: state.isCollapsed ? 44 : min(CGFloat(100 + state.data.meetings.count * 150), 500)
                )
                .background(Color.clear)
                .onAppear {
                    // Configure window as floating panel
                    configureMainWindow()
                    state.scheduleAutoClose()
                    listenForStdinEscalations()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
    }

    private static func parseArgs() -> MeetingPopupData {
        let args = CommandLine.arguments
        // Find the base64 argument (not a flag, not the executable path)
        let b64Arg = args.dropFirst().first { !$0.hasPrefix("-") }

        if let b64 = b64Arg,
           let data = Data(base64Encoded: b64),
           let decoded = try? JSONDecoder().decode(MeetingPopupData.self, from: data) {
            return decoded
        }

        // Try direct JSON as last arg
        if let lastArg = args.last,
           let data = lastArg.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(MeetingPopupData.self, from: data) {
            return decoded
        }

        // Fallback empty
        return MeetingPopupData(alertLevel: "tenMin", meetings: [])
    }

    private func configureMainWindow() {
        DispatchQueue.main.async {
            guard let window = NSApp.windows.first else { return }
            window.level = .floating
            window.isMovableByWindowBackground = true
            window.backgroundColor = .clear
            window.hasShadow = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.isOpaque = false

            // Position top-right
            if let screen = NSScreen.main {
                let x = screen.visibleFrame.maxX - window.frame.width - 20
                let y = screen.visibleFrame.maxY - window.frame.height - 20
                window.setFrameOrigin(NSPoint(x: x, y: y))
            }
        }
    }

    private func listenForStdinEscalations() {
        let fh = FileHandle.standardInput
        DispatchQueue.global(qos: .utility).async {
            var buffer = ""
            while true {
                let data = fh.availableData
                if data.isEmpty { break }  // EOF
                guard let chunk = String(data: data, encoding: .utf8) else { continue }
                buffer += chunk
                var lines = buffer.components(separatedBy: "\n")
                buffer = lines.removeLast()  // Keep incomplete line

                for line in lines {
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    if trimmed.isEmpty { continue }
                    guard let lineData = trimmed.data(using: .utf8),
                          let msg = try? JSONDecoder().decode(EscalationMessage.self, from: lineData) else {
                        continue
                    }
                    if msg.type == "escalate" {
                        Task { @MainActor in
                            self.state.handleEscalation(msg)
                        }
                    }
                }
            }
        }
    }
}
```

**Step 4: Verify it compiles**

Run: `cd reticle && swift build 2>&1 | tail -10`
Expected: Compilation error — `PopupContentView` doesn't exist yet. That's Task 11.

**Step 5: Commit (partial — views in next task)**

Do NOT commit yet. Continue to Task 11.

---

## Task 11: MeetingPopup — Views (Expanded + Pill)

The actual popup UI. Ports `meeting-popup.html` to SwiftUI.

**Files:**
- Create: `reticle/Sources/MeetingPopup/PopupContentView.swift`
- Create: `reticle/Sources/MeetingPopup/PillView.swift`

**Step 1: Create PopupContentView (expanded mode)**

```swift
// reticle/Sources/MeetingPopup/PopupContentView.swift
import SwiftUI

struct PopupContentView: View {
    @EnvironmentObject var state: PopupState

    var body: some View {
        ZStack {
            if state.isCollapsed {
                PillView()
            } else {
                ExpandedPopupView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: state.isCollapsed)
    }
}

struct ExpandedPopupView: View {
    @EnvironmentObject var state: PopupState

    var headerColor: Color {
        if state.isNow { return .red }
        if state.isUrgent { return .yellow }
        return Color.white.opacity(0.2)
    }

    var headerTextColor: Color {
        if state.isNow { return .white }
        if state.isUrgent { return Color(red: 0.2, green: 0.2, blue: 0.2) }
        return Color.white.opacity(0.6)
    }

    var headerText: String {
        if state.isNow { return "MEETING NOW" }
        return "MEETING IN \(state.countdownText)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header badge
            Text(headerText)
                .font(.system(size: 11, weight: .bold))
                .tracking(1)
                .foregroundStyle(headerTextColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(headerColor)
                .clipShape(RoundedRectangle(cornerRadius: 4))

            // Meeting cards
            ForEach(state.data.meetings) { meeting in
                MeetingCard(meeting: meeting)
            }

            // Dismiss button
            if state.data.alertLevel != "start" {
                Button(action: { state.dismiss() }) {
                    Text(state.data.alertLevel == "tenMin" ? "Dismiss" : "Minimize")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.white.opacity(0.4))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.black.opacity(0.95))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.5), radius: 16, y: 4)
        )
        .offset(x: state.shake ? -4 : 0)
        .animation(
            state.shake
                ? .easeInOut(duration: 0.1).repeatCount(6, autoreverses: true)
                : .default,
            value: state.shake
        )
    }
}

struct MeetingCard: View {
    @EnvironmentObject var state: PopupState
    let meeting: MeetingInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Title
            Text(meeting.summary ?? "Untitled Meeting")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(.white)
                .lineLimit(1)
                .truncationMode(.tail)

            // Countdown
            Text(state.countdownText)
                .font(.system(size: 24, weight: .light))
                .foregroundStyle(
                    state.isNow ? .red :
                    state.isUrgent ? .yellow : .white
                )
                .monospacedDigit()
                .opacity(state.isNow ? (Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 1) < 0.5 ? 0.5 : 1.0) : 1.0)

            // Attendees
            if let attendees = meeting.attendees, !attendees.isEmpty {
                let shown = attendees.prefix(3).joined(separator: ", ")
                let suffix = attendees.count > 3 ? " +\(attendees.count - 3) more" : ""
                Text("with \(shown)\(suffix)")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.white.opacity(0.5))
                    .lineLimit(1)
            }

            // Action buttons
            HStack(spacing: 6) {
                if meeting.hasVideoLink {
                    Button(action: { state.joinMeeting(meeting) }) {
                        Text(meeting.joinLabel ?? "Join Meeting")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 8)
                            .background(Color.green)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)

                    if let urlStr = meeting.url {
                        Button(action: {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(urlStr, forType: .string)
                        }) {
                            Text("Copy")
                                .font(.system(size: 13))
                                .foregroundStyle(Color.white.opacity(0.7))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(Color.white.opacity(0.1))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    Text("⚠ No video link")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.yellow)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Color.yellow.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }

                if let calLink = meeting.calendarLink, let url = URL(string: calLink) {
                    Button(action: { NSWorkspace.shared.open(url) }) {
                        Text("Cal")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.white.opacity(0.7))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)
        }
        .padding(.bottom, 12)
    }
}
```

**Step 2: Create PillView (collapsed mode)**

```swift
// reticle/Sources/MeetingPopup/PillView.swift
import SwiftUI

struct PillView: View {
    @EnvironmentObject var state: PopupState
    @State private var dragOffset = CGSize.zero

    var dotColor: Color {
        if state.isNow { return .red }
        if state.isUrgent { return .yellow }
        return .yellow
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)

            Text(state.countdownText)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(
                    state.isNow ? .red :
                    state.isUrgent ? .yellow : .white
                )
                .monospacedDigit()
        }
        .frame(width: 80, height: 44)
        .background(
            Capsule()
                .fill(Color.black.opacity(0.95))
                .overlay(
                    Capsule()
                        .stroke(Color.white.opacity(0.15), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.5), radius: 8, y: 2)
        )
        .onTapGesture {
            state.expand()
        }
    }
}
```

**Step 3: Verify both targets compile**

Run: `cd reticle && swift build 2>&1 | tail -10`
Expected: Build succeeds for both Reticle and MeetingPopup targets.

**Step 4: Quick smoke test of MeetingPopup**

```bash
cd reticle
echo '{"alertLevel":"fiveMin","meetings":[{"id":"test1","summary":"Standup","startTime":"'$(date -u -v+5M +%Y-%m-%dT%H:%M:%SZ)'","hasVideoLink":true,"platform":"zoom","url":"https://zoom.us/j/123","joinLabel":"Join Zoom","calendarLink":null,"attendees":["Alice","Bob"]}]}' | base64 | xargs .build/debug/MeetingPopup
```

Expected: A floating dark popup appears in the top-right corner showing "Standup" with a 5-minute countdown and a green "Join Zoom" button. Close it with Cmd+Q.

**Step 5: Commit all MeetingPopup files**

```bash
git add reticle/Sources/MeetingPopup/
git commit -m "feat: implement MeetingPopup SwiftUI executable with expanded and pill views"
```

---

## Task 12: Update meeting-alert-monitor.js Spawn Path

Change the popup spawn from Electron to the new SwiftUI binary.

**Files:**
- Modify: `meeting-alert-monitor.js`

**Step 1: Find the spawn call**

Search for `spawn(` in `meeting-alert-monitor.js`. The current code spawns Electron:
```javascript
const CONFIG = {
  electronPath: path.join(__dirname, 'node_modules', '.bin', 'electron'),
  popupScript: path.join(__dirname, 'meeting-popup-window.js')
};
```

And later spawns with:
```javascript
spawn(CONFIG.electronPath, [CONFIG.popupScript, dataB64])
```

**Step 2: Update CONFIG to use SwiftUI binary**

Replace the `electronPath` and `popupScript` config entries:

```javascript
// In CONFIG object, replace:
//   electronPath: path.join(__dirname, 'node_modules', '.bin', 'electron'),
//   popupScript: path.join(__dirname, 'meeting-popup-window.js')
// With:
  popupBinary: path.join(os.homedir(), '.reticle', 'MeetingPopup.app', 'Contents', 'MacOS', 'MeetingPopup')
```

**Step 3: Update the spawn call**

Find every place that spawns the popup (search for `activePopups` assignments). Replace:
```javascript
spawn(CONFIG.electronPath, [CONFIG.popupScript, dataB64])
```
With:
```javascript
spawn(CONFIG.popupBinary, [dataB64])
```

**Step 4: Run the meeting-alert-monitor tests (if any) or verify syntax**

Run: `node -c meeting-alert-monitor.js`
Expected: No syntax errors.

**Step 5: Commit**

```bash
git add meeting-alert-monitor.js
git commit -m "feat: update meeting popup spawn to use SwiftUI binary"
```

---

## Task 13: Update bin/deploy with Swift Build Phase

Add the Swift build + .app bundle assembly to the deploy script.

**Files:**
- Modify: `bin/deploy`

**Step 1: Add Swift build phase after npm install (Step 6) and before launchd plists (Step 7)**

Insert after the "Install production dependencies" section (line ~108) and before "Generate launchd plists" (line ~111):

```bash
# --- Step 6.5: Build Swift targets and assemble .app bundles ---
info "Building Swift targets..."
cd "$REPO_DIR/reticle"
swift build -c release 2>&1 | tail -3

# Assemble Reticle.app
RETICLE_APP="$RETICLE_HOME/Reticle.app"
info "Assembling Reticle.app..."
mkdir -p "$RETICLE_APP/Contents/MacOS"
mkdir -p "$RETICLE_APP/Contents/Resources"
cp .build/release/Reticle "$RETICLE_APP/Contents/MacOS/"

cat > "$RETICLE_APP/Contents/Info.plist" <<INFOPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>ai.reticle.app</string>
  <key>CFBundleName</key>
  <string>Reticle</string>
  <key>CFBundleExecutable</key>
  <string>Reticle</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
</dict>
</plist>
INFOPLIST

codesign --sign - --force "$RETICLE_APP"

# Assemble MeetingPopup.app
POPUP_APP="$RETICLE_HOME/MeetingPopup.app"
info "Assembling MeetingPopup.app..."
mkdir -p "$POPUP_APP/Contents/MacOS"
cp .build/release/MeetingPopup "$POPUP_APP/Contents/MacOS/"

cat > "$POPUP_APP/Contents/Info.plist" <<INFOPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>ai.reticle.meeting-popup</string>
  <key>CFBundleName</key>
  <string>MeetingPopup</string>
  <key>CFBundleExecutable</key>
  <string>MeetingPopup</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
</dict>
</plist>
INFOPLIST

codesign --sign - --force "$POPUP_APP"
```

**Step 2: Add Reticle.app launch at the end of deploy**

After the status report section, before the final "Deploy complete!" message:

```bash
# --- Step 11: Launch Reticle.app ---
info "Launching Reticle.app..."
open "$RETICLE_HOME/Reticle.app"
```

**Step 3: Verify script syntax**

Run: `bash -n bin/deploy`
Expected: No syntax errors.

**Step 4: Commit**

```bash
git add bin/deploy
git commit -m "feat: add Swift build phase and .app bundle assembly to deploy script"
```

---

## Task 14: Remove Electron Files

Clean up the Electron tray app and popup files that are now replaced.

**Files:**
- Delete: `tray/` (entire directory)
- Delete: `meeting-popup.html`
- Delete: `meeting-popup-window.js`

**Step 1: Verify no remaining references to deleted files**

Search for references before deleting:

Run: `grep -r "meeting-popup-window\|meeting-popup\.html\|tray/main\|tray/service-manager\|tray/icons" --include='*.js' --include='*.json' --include='*.md' .`

Expected: Only hits in:
- `CLAUDE.md` (documentation — will update)
- `meeting-alert-monitor.js` (already updated in Task 12)
- `package.json` (check if it references tray)

**Step 2: Update CLAUDE.md architecture table**

In the Architecture section, remove the Electron tray row and update:

```markdown
| Component | Path | Purpose |
|-----------|------|---------|
| Reticle App | `reticle/Sources/Reticle/` | SwiftUI menu bar tray + management window |
| Meeting Popup | `reticle/Sources/MeetingPopup/` | SwiftUI floating panel for meeting alerts |
| Gateway API | `gateway.js` | Express REST API — people, feedback, Slack reader |
| Meeting Recorder | `recorder/` | Swift macOS daemon — CoreAudio capture + transcription |
```

Remove from the Key Files section:
- `tray/main.js`
- `tray/service-manager.js`
- `tray/icons.js`
- `meeting-popup.html`
- `meeting-popup-window.js`

**Step 3: Delete the files**

```bash
rm -rf tray/
rm meeting-popup.html meeting-popup-window.js
```

**Step 4: Update root package.json if it has tray-related scripts**

Check `package.json` for any `tray` references and remove them.

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove Electron tray app and meeting popup (replaced by SwiftUI)"
```

---

## Task 15: End-to-End Verification

Verify the complete workflow works.

**Step 1: Build from clean**

```bash
cd reticle && swift build -c release 2>&1 | tail -5
```
Expected: Both targets build successfully.

**Step 2: Run Swift tests**

```bash
cd reticle && swift test 2>&1 | tail -10
```
Expected: All tests pass.

**Step 3: Run Node.js tests**

```bash
npm test
```
Expected: All tests pass.

**Step 4: Deploy**

```bash
bin/deploy --skip-pull
```
Expected: Deploy completes, services start, Reticle.app launches with tray icon.

**Step 5: Manual verification checklist**

- [ ] Reticle icon visible in menu bar
- [ ] Click icon → context menu shows service statuses
- [ ] "Open Reticle" menu item opens management window
- [ ] Close management window → window hides, tray persists
- [ ] Re-click "Open Reticle" → window reappears
- [ ] Service start/stop/restart work from tray menu
- [ ] "Start at Login" toggle works
- [ ] "Quit Reticle" terminates the app

**Step 6: Commit any fixes and finalize**

```bash
git add -A
git commit -m "fix: address issues found during end-to-end verification"
```

---

## Dependency Graph

```
Task 1 (Package.swift)
  ├── Task 2 (ServiceManager parsing) → Task 3 (heartbeat tests)
  ├── Task 4 (ReticleIcon)
  ├── Task 5 (ServiceStore) ← depends on Task 2
  ├── Task 6 (AppState)
  └── Task 7 (TrayMenu) ← depends on Tasks 5, 6
       └── Task 8 (ReticleApp rewrite) ← depends on Tasks 4, 5, 6, 7
            └── Task 12 (meeting-alert-monitor.js update)
                 └── Task 13 (bin/deploy update)
                      └── Task 14 (remove Electron)
                           └── Task 15 (E2E verification)

Task 9 (MeetingPopup models) ← from Task 1
  └── Task 10 (MeetingPopup window + state) ← depends on Task 9
       └── Task 11 (MeetingPopup views) ← depends on Task 10
            └── Task 12 (meeting-alert-monitor.js update)
```

Tasks 2-4 and Task 9 can run in parallel after Task 1.
Tasks 5+6 can run in parallel.
Task 7 depends on 5+6.
Task 8 depends on 4+7.
Tasks 10+11 depend on 9.
Task 12 depends on 8+11.
Tasks 13, 14, 15 are sequential.
