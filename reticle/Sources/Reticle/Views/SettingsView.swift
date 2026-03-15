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

    // Notification fields (wired to gateway in Task 17)
    @State private var gmailInterval = 5
    @State private var followupInterval = 15
    @State private var emailEscalationHours = 48
    @State private var slackDmEscalationHours = 72
    @State private var slackMentionEscalationHours = 168

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
            Section("Gmail") {
                Picker("Check interval", selection: $gmailInterval) {
                    Text("1 min").tag(1)
                    Text("5 min").tag(5)
                    Text("15 min").tag(15)
                    Text("30 min").tag(30)
                }
                .pickerStyle(.segmented)
            }

            Section("Follow-ups") {
                Picker("Check interval", selection: $followupInterval) {
                    Text("5 min").tag(5)
                    Text("15 min").tag(15)
                    Text("30 min").tag(30)
                }
                .pickerStyle(.segmented)

                Stepper("Email escalation: \(emailEscalationHours)h",
                        value: $emailEscalationHours, in: 1...168)
                Stepper("Slack DM escalation: \(slackDmEscalationHours)h",
                        value: $slackDmEscalationHours, in: 1...168)
                Stepper("Slack mention escalation: \(slackMentionEscalationHours)h",
                        value: $slackMentionEscalationHours, in: 1...336)
            }

            // MARK: System
            Section("General") {
                Toggle("Launch at login", isOn: Binding(
                    get: { appState.isLoginItemEnabled },
                    set: { _ in appState.toggleLoginItem() }
                ))
            }

            Section("Services") {
                ForEach(serviceStore.services, id: \.definition.launchdLabel) { service in
                    HStack {
                        Circle()
                            .fill(serviceStatusColor(service))
                            .frame(width: 8, height: 8)
                        Text(service.definition.label)
                        Spacer()
                        Button(service.status == .running ? "Stop" : "Start") {
                            if service.status == .running {
                                serviceStore.stop(service.definition.launchdLabel)
                            } else {
                                serviceStore.start(service.definition.launchdLabel)
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .task {
            await loadAccounts()
            await loadSettings()
        }
        .onChange(of: gmailInterval) { _, newValue in
            Task {
                try? await gateway.updateSettings([
                    "polling": ["gmailIntervalMinutes": newValue]
                ])
            }
        }
        .onChange(of: followupInterval) { _, newValue in
            Task {
                try? await gateway.updateSettings([
                    "polling": ["followupCheckIntervalMinutes": newValue]
                ])
            }
        }
        .onChange(of: emailEscalationHours) { _, newValue in
            Task {
                try? await gateway.updateSettings([
                    "thresholds": ["followupEscalationEmailHours": newValue]
                ])
            }
        }
        .onChange(of: slackDmEscalationHours) { _, newValue in
            Task {
                try? await gateway.updateSettings([
                    "thresholds": ["followupEscalationSlackDmHours": newValue]
                ])
            }
        }
        .onChange(of: slackMentionEscalationHours) { _, newValue in
            Task {
                try? await gateway.updateSettings([
                    "thresholds": ["followupEscalationSlackMentionHours": newValue]
                ])
            }
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

    private func loadSettings() async {
        if let settings = try? await gateway.fetchSettings() {
            if let polling = settings.polling {
                gmailInterval = polling.gmailIntervalMinutes ?? 5
                followupInterval = polling.followupCheckIntervalMinutes ?? 15
            }
            if let thresholds = settings.thresholds {
                emailEscalationHours = thresholds.followupEscalationEmailHours ?? 48
                slackDmEscalationHours = thresholds.followupEscalationSlackDmHours ?? 72
                slackMentionEscalationHours = thresholds.followupEscalationSlackMentionHours ?? 168
            }
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

    // MARK: - Service status color

    private func serviceStatusColor(_ service: ServiceState) -> Color {
        let effective = serviceStore.effectiveStatus(service)
        switch effective {
        case .running: return .green
        case .error, .startupFailed: return .red
        case .unresponsive, .degraded: return .yellow
        default: return .gray
        }
    }
}
