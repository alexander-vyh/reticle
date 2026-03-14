import SwiftUI

extension NSNotification.Name {
    static let openManagementWindow = NSNotification.Name("ai.reticle.openManagementWindow")
}

@main
struct ReticleApp: App {
    @StateObject private var gateway = GatewayClient()
    @StateObject private var serviceStore = ServiceStore()
    @StateObject private var appState = AppState()
    @StateObject private var captureManager = CaptureManager()
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        MenuBarExtra {
            TrayMenu()
                .environmentObject(serviceStore)
                .environmentObject(appState)
                .environmentObject(captureManager)
                .onAppear {
                    serviceStore.startPolling()
                    captureManager.registerHotkeys()
                }
        } label: {
            Image(nsImage: ReticleIcon.menuBarImage(statusColor: serviceStore.statusColor))
        }

        WindowGroup("Reticle", id: "reticle-main") {
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
}

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            NotificationCenter.default.post(name: .openManagementWindow, object: nil)
        }
        return true
    }
}
