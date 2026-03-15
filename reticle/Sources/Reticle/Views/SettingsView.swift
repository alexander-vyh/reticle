import SwiftUI

// MARK: - Reveal-toggle field helper

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

// MARK: - Accounts Section

private struct AccountsSection: View {
    let gateway: GatewayClient
    @Binding var slackBotToken: String
    @Binding var slackAppToken: String
    @Binding var slackUserId: String
    @Binding var slackUsername: String
    @Binding var slackConnected: Bool
    @Binding var gmailAccount: String
    @Binding var gmailConnected: Bool
    @Binding var jiraBaseUrl: String
    @Binding var jiraUserEmail: String
    @Binding var jiraApiToken: String
    @Binding var jiraConnected: Bool

    var body: some View {
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
            statusRow(connected: slackConnected, showRestartNote: true)
        }

        Section("Gmail") {
            LabeledContent("Account") {
                TextField("you@example.com", text: $gmailAccount)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { saveGmail() }
            }
            statusRow(connected: gmailConnected, showRestartNote: false)
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
            statusRow(connected: jiraConnected, showRestartNote: true)
        }
    }

    @ViewBuilder
    private func statusRow(connected: Bool, showRestartNote: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: connected ? "checkmark.circle.fill" : "exclamationmark.circle")
                .foregroundStyle(connected ? .green : .orange)
            Text(connected ? "Connected" : "Not connected")
                .foregroundStyle(.secondary)
            Spacer()
            if showRestartNote {
                Text("Changes take effect after service restart")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

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

// MARK: - Notifications Section

private struct NotificationsSection: View {
    let gateway: GatewayClient
    @Binding var gmailInterval: Int
    @Binding var followupInterval: Int
    @Binding var emailEscalationHours: Int
    @Binding var slackDmEscalationHours: Int
    @Binding var slackMentionEscalationHours: Int

    var body: some View {
        Section("Gmail Polling") {
            Picker("Check interval", selection: $gmailInterval) {
                Text("5 min").tag(5)
                Text("15 min").tag(15)
                Text("30 min").tag(30)
            }
            .pickerStyle(.segmented)
            .onChange(of: gmailInterval) { _, newValue in
                Task {
                    try? await gateway.updateSettings([
                        "polling": ["gmailIntervalMinutes": newValue]
                    ])
                }
            }
        }

        Section("Follow-ups") {
            Picker("Check interval", selection: $followupInterval) {
                Text("5 min").tag(5)
                Text("15 min").tag(15)
                Text("30 min").tag(30)
            }
            .pickerStyle(.segmented)
            .onChange(of: followupInterval) { _, newValue in
                Task {
                    try? await gateway.updateSettings([
                        "polling": ["followupCheckIntervalMinutes": newValue]
                    ])
                }
            }

            Stepper("Email escalation: \(emailEscalationHours)h",
                    value: $emailEscalationHours, in: 24...168)
            .onChange(of: emailEscalationHours) { _, newValue in
                Task {
                    try? await gateway.updateSettings([
                        "thresholds": ["followupEscalationEmailHours": newValue]
                    ])
                }
            }

            Stepper("Slack DM escalation: \(slackDmEscalationHours)h",
                    value: $slackDmEscalationHours, in: 8...168)
            .onChange(of: slackDmEscalationHours) { _, newValue in
                Task {
                    try? await gateway.updateSettings([
                        "thresholds": ["followupEscalationSlackDmHours": newValue]
                    ])
                }
            }

            Stepper("Slack mention escalation: \(slackMentionEscalationHours)h",
                    value: $slackMentionEscalationHours, in: 24...336)
            .onChange(of: slackMentionEscalationHours) { _, newValue in
                Task {
                    try? await gateway.updateSettings([
                        "thresholds": ["followupEscalationSlackMentionHours": newValue]
                    ])
                }
            }
        }
    }
}

// MARK: - System Section

private struct SystemSection: View {
    let appState: AppState
    let serviceStore: ServiceStore

    var body: some View {
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

// MARK: - SettingsView

struct SettingsView: View {
    @EnvironmentObject var gateway: GatewayClient
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var serviceStore: ServiceStore

    // Accounts state
    @State private var slackBotToken = ""
    @State private var slackAppToken = ""
    @State private var slackUserId = ""
    @State private var slackUsername = ""
    @State private var slackConnected = false
    @State private var gmailAccount = ""
    @State private var gmailConnected = false
    @State private var jiraBaseUrl = ""
    @State private var jiraUserEmail = ""
    @State private var jiraApiToken = ""
    @State private var jiraConnected = false

    // Notification state
    @State private var gmailInterval = 5
    @State private var followupInterval = 15
    @State private var emailEscalationHours = 48
    @State private var slackDmEscalationHours = 72
    @State private var slackMentionEscalationHours = 168

    var body: some View {
        Form {
            AccountsSection(
                gateway: gateway,
                slackBotToken: $slackBotToken,
                slackAppToken: $slackAppToken,
                slackUserId: $slackUserId,
                slackUsername: $slackUsername,
                slackConnected: $slackConnected,
                gmailAccount: $gmailAccount,
                gmailConnected: $gmailConnected,
                jiraBaseUrl: $jiraBaseUrl,
                jiraUserEmail: $jiraUserEmail,
                jiraApiToken: $jiraApiToken,
                jiraConnected: $jiraConnected
            )

            NotificationsSection(
                gateway: gateway,
                gmailInterval: $gmailInterval,
                followupInterval: $followupInterval,
                emailEscalationHours: $emailEscalationHours,
                slackDmEscalationHours: $slackDmEscalationHours,
                slackMentionEscalationHours: $slackMentionEscalationHours
            )

            SystemSection(
                appState: appState,
                serviceStore: serviceStore
            )
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .task {
            await loadAccounts()
            await loadSettings()
        }
    }

    private func loadAccounts() async {
        do {
            let accounts = try await gateway.fetchAccounts()
            slackConnected = accounts.slack.connected
            slackUserId = accounts.slack.userId ?? ""
            slackUsername = accounts.slack.username ?? ""
            slackBotToken = ""
            slackAppToken = ""
            gmailConnected = accounts.gmail.connected
            gmailAccount = accounts.gmail.account ?? ""
            jiraConnected = accounts.jira.connected
            jiraBaseUrl = accounts.jira.baseUrl ?? ""
            jiraUserEmail = accounts.jira.userEmail ?? ""
            jiraApiToken = ""
        } catch {
            // Non-fatal — gateway may be down
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
}
