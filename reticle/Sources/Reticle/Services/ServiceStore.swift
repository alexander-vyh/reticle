import SwiftUI
import Combine

@MainActor
class ServiceStore: ObservableObject {
    @Published var services: [ServiceState] = []
    @Published var aggregateStatus: AggregateStatus = .unknown

    private var pollTimer: Timer?

    // MARK: - Enums

    enum AggregateStatus: Equatable {
        case healthy, degraded, error, unknown
    }

    enum EffectiveStatus: Equatable {
        case running, stopped, error, unloaded, unknown
        case unresponsive, degraded, startupFailed
    }

    // MARK: - Polling

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
        services = ServiceManager.getStatuses()
        aggregateStatus = Self.computeAggregate(services)
    }

    // MARK: - Effective status (mirrors tray/main.js:32-40)

    func effectiveStatus(_ state: ServiceState) -> EffectiveStatus {
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

    // MARK: - Aggregate status

    var statusColor: Color? {
        switch aggregateStatus {
        case .healthy: return nil
        case .degraded: return .yellow
        case .error: return .red
        case .unknown: return .yellow
        }
    }

    static func computeAggregate(_ services: [ServiceState]) -> AggregateStatus {
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

    // Static version for use in computeAggregate (no instance needed)
    private static func effectiveStatusFor(_ state: ServiceState) -> EffectiveStatus {
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

    // MARK: - Service actions

    func start(_ launchdLabel: String) {
        try? ServiceManager.startService(launchdLabel)
        scheduleDelayedRefresh()
    }

    func stop(_ launchdLabel: String) {
        try? ServiceManager.stopService(launchdLabel)
        scheduleDelayedRefresh()
    }

    func restart(_ launchdLabel: String) {
        try? ServiceManager.restartService(launchdLabel)
        scheduleDelayedRefresh()
    }

    func startAll() {
        for def in ServiceDefinition.all {
            try? ServiceManager.startService(def.launchdLabel)
        }
        scheduleDelayedRefresh()
    }

    func stopAll() {
        for def in ServiceDefinition.all {
            try? ServiceManager.stopService(def.launchdLabel)
        }
        scheduleDelayedRefresh()
    }

    // MARK: - Private

    private func scheduleDelayedRefresh() {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000) // 1.5s
            refresh()
        }
    }
}
