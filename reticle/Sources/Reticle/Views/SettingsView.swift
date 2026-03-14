import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var gateway: GatewayClient
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var serviceStore: ServiceStore

    var body: some View {
        Form {
            Section("Accounts") {
                Text("Coming in next task")
                    .foregroundStyle(.secondary)
            }
            Section("Notifications") {
                Text("Coming in next task")
                    .foregroundStyle(.secondary)
            }
            Section("System") {
                Toggle("Launch at login", isOn: Binding(
                    get: { appState.isLoginItemEnabled },
                    set: { _ in appState.toggleLoginItem() }
                ))
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
    }
}
