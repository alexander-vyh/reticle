import SwiftUI

// MARK: - Tab Enum (for adding people)

enum PeopleTab: String, CaseIterable, Identifiable {
    case monitored = "Monitored"
    case directReports = "Direct Reports"
    case vips = "VIPs"
    case team = "Team"

    var id: String { rawValue }
}

// MARK: - Filter Enum

enum PeopleFilter: String, CaseIterable {
    case all = "All"
    case monitored = "Monitored"
}

// MARK: - Main View

struct PeopleView: View {
    @EnvironmentObject var gateway: GatewayClient
    @State private var entities: [Entity] = []
    @State private var filter: PeopleFilter = .all
    @State private var isLoading = false
    @State private var error: String?

    private var displayed: [Entity] {
        switch filter {
        case .all: return entities
        case .monitored: return entities.filter { $0.monitored }
        }
    }

    var body: some View {
        NavigationStack {
        VStack(alignment: .leading, spacing: 0) {
            Picker("Filter", selection: $filter) {
                ForEach(PeopleFilter.allCases, id: \.self) { f in
                    Text(f.rawValue).tag(f)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            if isLoading && entities.isEmpty {
                ProgressView("Loading people...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = error, entities.isEmpty {
                ContentUnavailableView(
                    "Unable to Load",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error)
                )
            } else if displayed.isEmpty {
                ContentUnavailableView(
                    filter == .monitored ? "No Monitored People" : "No People",
                    systemImage: "person.slash",
                    description: Text(filter == .monitored ? "Toggle monitor on people in the All tab." : "No entities found.")
                )
            } else {
                List(displayed) { entity in
                    NavigationLink(value: entity) {
                        EntityRow(entity: entity) {
                            Task { await toggle(entity) }
                        }
                    }
                    .buttonStyle(.plain)
                }
                .navigationDestination(for: Entity.self) { entity in
                    PersonDetailView(entity: entity)
                }
            }
        }
        .navigationTitle("People")
        .toolbar {
            ToolbarItem {
                Button(action: { Task { await loadEntities() } }) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .task { await loadEntities() }
        } // NavigationStack
    }

    func loadEntities() async {
        isLoading = true
        error = nil
        do {
            entities = try await gateway.listEntities()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func toggle(_ entity: Entity) async {
        do {
            if entity.monitored {
                try await gateway.unmonitorEntity(id: entity.id)
            } else {
                try await gateway.monitorEntity(id: entity.id)
            }
            await loadEntities()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Entity Row

struct EntityRow: View {
    let entity: Entity
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            AnchorIndicator(isAnchored: entity.isAnchored)

            VStack(alignment: .leading, spacing: 3) {
                Text(entity.canonicalName)
                    .font(.headline)
                HStack(spacing: 10) {
                    if let slackId = entity.slackId {
                        IdentityBadge(label: "Slack", value: slackId)
                    }
                    if let jiraId = entity.jiraId {
                        IdentityBadge(label: "Jira", value: jiraId)
                    }
                    if entity.commitmentCount > 0 {
                        Label("\(entity.commitmentCount) open", systemImage: "checkmark.circle")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()

            Button(entity.monitored ? "Unmonitor" : "Monitor") {
                onToggle()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(entity.monitored ? .secondary : .accentColor)
        }
        .padding(.vertical, 2)
        .opacity(entity.isActive ? 1 : 0.5)
        .accessibilityLabel("\(entity.canonicalName), \(entity.isAnchored ? "anchored identity" : "floating identity")")
    }
}

// MARK: - Monitored Person Row

struct MonitoredPersonRow: View {
    let person: Person

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(person.name ?? person.email)
                .font(.headline)
            Text(person.email)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                IdentityBadge(label: "Slack", value: person.slackId)
                IdentityBadge(label: "Jira", value: person.jiraId)
            }
        }
    }
}

// MARK: - Direct Report Row

struct DirectReportRow: View {
    @EnvironmentObject var gateway: GatewayClient
    let person: Person
    let onUpdate: () async -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(person.name ?? person.email)
                    .font(.headline)
                HStack(spacing: 4) {
                    Text(person.email)
                    if let slackId = person.slackId {
                        Text("·")
                        Text("@\(slackId)")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer()

            EscalationTierPicker(
                person: person,
                defaultTier: "4h",
                onUpdate: onUpdate
            )
            .environmentObject(gateway)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - VIP Row

struct VIPRow: View {
    @EnvironmentObject var gateway: GatewayClient
    let person: Person
    let onUpdate: () async -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(person.name ?? person.email)
                    .font(.headline)
                HStack(spacing: 4) {
                    if let title = person.title {
                        Text(title)
                    }
                    if person.title != nil {
                        Text("·")
                    }
                    Text(person.email)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer()

            EscalationTierPicker(
                person: person,
                defaultTier: "immediate",
                onUpdate: onUpdate
            )
            .environmentObject(gateway)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Team Member Row

struct TeamMemberRow: View {
    let person: Person

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(person.name ?? person.email)
                .font(.headline)
            HStack(spacing: 4) {
                if let team = person.team {
                    Text(team)
                        .foregroundColor(.accentColor)
                }
                if person.team != nil {
                    Text("·")
                        .foregroundStyle(.secondary)
                }
                Text(person.email)
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Escalation Tier Picker

struct EscalationTierPicker: View {
    @EnvironmentObject var gateway: GatewayClient
    let person: Person
    let defaultTier: String
    let onUpdate: () async -> Void

    private let tiers = ["immediate", "4h", "daily", "weekly"]

    private var currentTier: String {
        person.escalationTier ?? defaultTier
    }

    private var isOverridden: Bool {
        person.escalationTier != nil
    }

    var body: some View {
        HStack(spacing: 4) {
            if isOverridden {
                Circle()
                    .fill(Color.orange)
                    .frame(width: 7, height: 7)
                    .help("Overridden from role default")
            }
            Picker("Tier", selection: Binding(
                get: { currentTier },
                set: { newTier in
                    Task {
                        try? await gateway.updatePerson(
                            email: person.email,
                            fields: ["escalation_tier": newTier]
                        )
                        await onUpdate()
                    }
                }
            )) {
                ForEach(tiers, id: \.self) { tier in
                    Text(tierLabel(tier)).tag(tier)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
        }
    }

    private func tierLabel(_ tier: String) -> String {
        switch tier {
        case "immediate": return "Immediate"
        case "4h": return "4 hours"
        case "daily": return "Daily"
        case "weekly": return "Weekly"
        default: return tier
        }
    }
}

// MARK: - Add Person Form

struct AddPersonForm: View {
    @EnvironmentObject var gateway: GatewayClient
    let selectedTab: PeopleTab
    @Binding var isPresented: Bool
    let onAdd: () async -> Void

    @State private var email = ""
    @State private var name = ""
    @State private var slackId = ""
    @State private var title = ""
    @State private var team = ""

    private var canSubmit: Bool {
        switch selectedTab {
        case .monitored, .vips:
            return !email.isEmpty
        case .directReports, .team:
            return !email.isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add \(tabLabel)")
                .font(.headline)

            switch selectedTab {
            case .monitored:
                TextField("Email (required)", text: $email)
                    .textFieldStyle(.roundedBorder)
                TextField("Name", text: $name)
                    .textFieldStyle(.roundedBorder)

            case .directReports:
                TextField("Name", text: $name)
                    .textFieldStyle(.roundedBorder)
                TextField("Email (required)", text: $email)
                    .textFieldStyle(.roundedBorder)
                TextField("Slack ID", text: $slackId)
                    .textFieldStyle(.roundedBorder)

            case .vips:
                TextField("Email (required)", text: $email)
                    .textFieldStyle(.roundedBorder)
                TextField("Title", text: $title)
                    .textFieldStyle(.roundedBorder)

            case .team:
                TextField("Name", text: $name)
                    .textFieldStyle(.roundedBorder)
                TextField("Email (required)", text: $email)
                    .textFieldStyle(.roundedBorder)
                TextField("Team", text: $team)
                    .textFieldStyle(.roundedBorder)
            }

            HStack {
                Button("Cancel") {
                    isPresented = false
                }
                .keyboardShortcut(.cancelAction)

                Spacer()

                Button("Add") {
                    Task {
                        await submit()
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit)
            }
        }
        .padding()
        .frame(width: 280)
    }

    private var tabLabel: String {
        switch selectedTab {
        case .monitored: return "Person"
        case .directReports: return "Direct Report"
        case .vips: return "VIP"
        case .team: return "Team Member"
        }
    }

    private func submit() async {
        switch selectedTab {
        case .monitored:
            try? await gateway.addPerson(email: email, name: name)
        case .directReports:
            try? await gateway.addPerson(
                email: email, name: name, role: "direct_report"
            )
            if !slackId.isEmpty {
                try? await gateway.updatePerson(email: email, fields: ["slack_id": slackId])
            }
        case .vips:
            try? await gateway.addPerson(
                email: email, name: name, role: "vip",
                title: title.isEmpty ? nil : title
            )
        case .team:
            try? await gateway.addPerson(
                email: email, name: name,
                team: team.isEmpty ? nil : team
            )
        }

        await onAdd()
        isPresented = false
    }
}

// MARK: - Anchor Indicator

struct AnchorIndicator: View {
    let isAnchored: Bool

    var body: some View {
        Image(systemName: isAnchored ? "pin.fill" : "icloud.slash")
            .foregroundStyle(isAnchored ? .green : .orange)
            .imageScale(.medium)
            .help(isAnchored ? "Anchored — verified identity" : "Floating — no verified identity link")
    }
}

// MARK: - Identity Badge

struct IdentityBadge: View {
    let label: String
    let value: String?

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: value != nil ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(value != nil ? .green : .secondary)
                .imageScale(.small)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
