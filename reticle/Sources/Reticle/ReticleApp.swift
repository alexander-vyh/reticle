import SwiftUI

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
            CommandGroup(replacing: .appSettings) {
                Button("Settings...") {
                    appState.showManagementWindow()
                }
                .keyboardShortcut(",", modifiers: .command)
            }
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            for window in NSApp.windows where window.identifier?.rawValue == "management" {
                window.makeKeyAndOrderFront(nil)
                return true
            }
        }
        return true
    }
}
