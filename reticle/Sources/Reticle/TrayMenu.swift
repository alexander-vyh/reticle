import SwiftUI

struct TrayMenu: View {
    @EnvironmentObject var serviceStore: ServiceStore
    @EnvironmentObject var appState: AppState

    var body: some View {
        Button("Open Reticle") {
            appState.showManagementWindow()
        }
        .keyboardShortcut("r", modifiers: .command)

        Divider()

        let runningCount = serviceStore.services.filter { $0.status == .running }.count
        Text("Services — \(runningCount)/\(serviceStore.services.count) running")

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
}
