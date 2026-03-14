import SwiftUI

// MARK: - Reveal-toggle field helpers

private struct SecureRevealField: View {
    let label: String
    @Binding var text: String
    let onSubmit: () -> Void
    @State private var revealed = false

    var body: some View {
        HStack {
            if revealed {
                TextField(label, text: $text)
                    .font(.system(.body, design: .monospaced))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(onSubmit)
            } else {
                SecureField(label, text: $text)
                    .font(.system(.body, design: .monospaced))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(onSubmit)
            }
            Button {
                revealed.toggle()
            } label: {
                Image(systemName: revealed ? "eye.slash" : "eye")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
    }
}

// MARK: - SettingsView

struct SettingsView: View {
    @EnvironmentObject var gateway: GatewayClient
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var serviceStore: ServiceStore

    // Slack fields
    @State private var slackBotToken: String = ""
    @State private var slackAppToken: String = ""
    @State private var slackUserId: String = ""
    @State private var slackUsername: String = ""
    @State private var slackConnected: Bool = false

    // Gmail fields
    @State private var gmailAccount: String = ""
    @State private var gmailConnected: Bool = false

    // Jira fields
    @State private var jiraBaseUrl: String = ""
    @State private var jiraUserEmail: String = ""
    @State private var jiraApiToken: String = ""
    @State private var jiraConnected: Bool = false

    @State private var loadError: String? = nil

    var body: some View {
        Form {
            // MARK: Accounts
            Section("Slack") {
                LabeledContent("User ID") {
                    TextField("U0123ABCDEF", text: $slackUserId)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { saveSlack() }
                }
                LabeledContent("Username") {
                    TextField("@handle", text: $slackUsername)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { saveSlack() }
                }
                LabeledContent("Bot Token") {
                    SecureRevealField(
                        label: slackConnected ? "xoxb-••••••••" : "xoxb-…",
                        text: $slackBotToken,
                        onSubmit: saveSlack
                    )
                }
                LabeledContent("App Token") {
                    SecureRevealField(
                        label: slackConnected ? "xapp-••••••••" : "xapp-…",
                        text: $slackAppToken,
                        onSubmit: saveSlack
                    )
                }
                HStack(spacing: 4) {
                    Image(systemName: slackConnected ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .foregroundStyle(slackConnected ? .green : .orange)
                    Text(slackConnected ? "Connected" : "Not connected")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("Changes take effect after service restart")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            Section("Gmail") {
                LabeledContent("Account") {
                    TextField("you@example.com", text: $gmailAccount)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { saveGmail() }
                }
                HStack(spacing: 4) {
                    Image(systemName: gmailConnected ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .foregroundStyle(gmailConnected ? .green : .orange)
                    Text(gmailConnected ? "Connected" : "Not connected")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Jira") {
                LabeledContent("Base URL") {
                    TextField("https://yourorg.atlassian.net", text: $jiraBaseUrl)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { saveJira() }
                }
                LabeledContent("User Email") {
                    TextField("you@yourorg.com", text: $jiraUserEmail)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { saveJira() }
                }
                LabeledContent("API Token") {
                    SecureRevealField(
                        label: jiraConnected ? "••••••••" : "Paste token…",
                        text: $jiraApiToken,
                        onSubmit: saveJira
                    )
                }
                HStack(spacing: 4) {
                    Image(systemName: jiraConnected ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .foregroundStyle(jiraConnected ? .green : .orange)
                    Text(jiraConnected ? "Connected" : "Not connected")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("Changes take effect after service restart")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            // MARK: Notifications
            Section("Notifications") {
                Text("Coming in next task")
                    .foregroundStyle(.secondary)
            }

            // MARK: System
            Section("System") {
                Toggle("Launch at login", isOn: Binding(
                    get: { appState.isLoginItemEnabled },
                    set: { _ in appState.toggleLoginItem() }
                ))
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .task {
            await loadAccounts()
        }
    }

    // MARK: - Data loading

    private func loadAccounts() async {
        do {
            let accounts = try await gateway.fetchAccounts()
            slackConnected = accounts.slack.connected
            slackUserId = accounts.slack.userId ?? ""
            slackUsername = accounts.slack.username ?? ""
            // Tokens not returned by GET — leave as empty (user pastes new values to update)
            slackBotToken = ""
            slackAppToken = ""

            gmailConnected = accounts.gmail.connected
            gmailAccount = accounts.gmail.account ?? ""

            jiraConnected = accounts.jira.connected
            jiraBaseUrl = accounts.jira.baseUrl ?? ""
            jiraUserEmail = accounts.jira.userEmail ?? ""
            // Token not returned by GET
            jiraApiToken = ""

            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    // MARK: - Save helpers

    private func saveSlack() {
        var fields: [String: String] = [:]
        if !slackUserId.isEmpty { fields["slackUserId"] = slackUserId }
        if !slackUsername.isEmpty { fields["slackUsername"] = slackUsername }
        if !slackBotToken.isEmpty { fields["slackBotToken"] = slackBotToken }
        if !slackAppToken.isEmpty { fields["slackAppToken"] = slackAppToken }
        guard !fields.isEmpty else { return }
        Task { try? await gateway.updateAccounts(fields: fields) }
    }

    private func saveGmail() {
        var fields: [String: String] = [:]
        if !gmailAccount.isEmpty { fields["gmailAccount"] = gmailAccount }
        guard !fields.isEmpty else { return }
        Task { try? await gateway.updateAccounts(fields: fields) }
    }

    private func saveJira() {
        var fields: [String: String] = [:]
        if !jiraBaseUrl.isEmpty { fields["jiraBaseUrl"] = jiraBaseUrl }
        if !jiraUserEmail.isEmpty { fields["jiraUserEmail"] = jiraUserEmail }
        if !jiraApiToken.isEmpty { fields["jiraApiToken"] = jiraApiToken }
        guard !fields.isEmpty else { return }
        Task { try? await gateway.updateAccounts(fields: fields) }
    }
}
