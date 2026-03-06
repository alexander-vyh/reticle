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
        for window in NSApp.windows where window.title == "Reticle" {
            window.makeKeyAndOrderFront(nil)
            return
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
            // User can manage in System Settings
        }
    }
}
