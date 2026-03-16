import SwiftUI

struct TrayMenu: View {
    @EnvironmentObject var serviceStore: ServiceStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var captureManager: CaptureManager
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Open Reticle") {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "reticle-main")
        }
        .keyboardShortcut("r", modifiers: .command)

        if captureManager.isCapturing, let mode = captureManager.captureMode {
            Text("Capturing (\(mode))...")
                .foregroundColor(.secondary)
        }

        Divider()

        let persistent = serviceStore.services.filter { !$0.definition.scheduled }
        let scheduled = serviceStore.services.filter { $0.definition.scheduled }
        let runningCount = persistent.filter { $0.status == .running }.count
        Text("Services — \(runningCount)/\(persistent.count) running")

        ForEach(persistent, id: \.definition.launchdLabel) { svc in
            serviceMenuItem(svc)
        }

        if !scheduled.isEmpty {
            Divider()
            Text("Scheduled")

            ForEach(scheduled, id: \.definition.launchdLabel) { svc in
                scheduledMenuItem(svc)
            }
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
        .onReceive(NotificationCenter.default.publisher(for: .openManagementWindow)) { _ in
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "reticle-main")
        }
    }

    // MARK: - Persistent service menu item (existing behavior)

    @ViewBuilder
    private func serviceMenuItem(_ svc: ServiceState) -> some View {
        let effective = serviceStore.effectiveStatus(svc)
        let emoji = effectiveEmoji(effective)
        let detail = serviceDetail(svc, effective: effective)
        let permWarning = permissionWarning(svc)
        let label = "\(emoji)  \(svc.definition.label)\(detail.isEmpty ? "" : "  (\(detail))")\(permWarning)"

        Menu(label) {
            if svc.status == .running {
                Button("Stop") { serviceStore.stop(svc.definition.launchdLabel) }
                Button("Restart") { serviceStore.restart(svc.definition.launchdLabel) }
            } else {
                Button("Start") { serviceStore.start(svc.definition.launchdLabel) }
            }
        }
    }

    // MARK: - Scheduled service menu item

    @ViewBuilder
    private func scheduledMenuItem(_ svc: ServiceState) -> some View {
        let emoji = scheduledEmoji(svc)
        let detail = scheduledServiceDetail(svc)
        let label = "\(emoji)  \(svc.definition.label) — \(detail)"

        Menu(label) {
            Button("Run Now") { serviceStore.start(svc.definition.launchdLabel) }
        }
    }

    // MARK: - Scheduled service helpers

    private func scheduledEmoji(_ svc: ServiceState) -> String {
        let effective = serviceStore.effectiveStatus(svc)
        switch effective {
        case .degraded: return "◐"
        case .error, .startupFailed: return "✖"
        default:
            // Has a heartbeat with lastCheck? Ran successfully at some point.
            if svc.heartbeat?.lastCheck != nil {
                return "●"
            }
            return "○"
        }
    }

    private func scheduledServiceDetail(_ svc: ServiceState) -> String {
        guard let hb = svc.heartbeat, let lastCheck = hb.lastCheck else {
            return "never run"
        }

        var parts: [String] = []

        parts.append("ran \(relativeTime(from: lastCheck))")

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

    // MARK: - Shared helpers

    /// Returns a warning suffix if the meeting recorder has a denied TCC permission.
    private func permissionWarning(_ svc: ServiceState) -> String {
        guard svc.definition.heartbeatName == "meeting-recorder",
              let hb = svc.heartbeat,
              let metrics = hb.metrics,
              let permStatus = metrics.permissionStatus,
              permStatus == "denied" else {
            return ""
        }
        return "  [mic-only]"
    }

    private func effectiveEmoji(_ status: ServiceStore.EffectiveStatus) -> String {
        switch status {
        case .running: return "●"
        case .stopped, .unloaded: return "○"
        case .error, .startupFailed: return "✖"
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

    private func relativeTime(from epochMs: Double) -> String {
        let now = Date().timeIntervalSince1970 * 1000
        let ageSec = Int((now - epochMs) / 1000)
        if ageSec < 60 { return "\(ageSec)s ago" }
        let ageMin = ageSec / 60
        if ageMin < 60 { return "\(ageMin)m ago" }
        let ageHr = ageMin / 60
        if ageHr < 24 { return "\(ageHr)h ago" }
        let ageDays = ageHr / 24
        return "\(ageDays)d ago"
    }
}
