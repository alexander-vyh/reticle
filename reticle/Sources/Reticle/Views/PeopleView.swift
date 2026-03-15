import SwiftUI

// MARK: - Tab Enum

enum PeopleTab: String, CaseIterable, Identifiable {
    case monitored = "Monitored"
    case directReports = "Direct Reports"
    case vips = "VIPs"
    case team = "Team"

    var id: String { rawValue }
}

// MARK: - Main View

struct PeopleView: View {
    @EnvironmentObject var gateway: GatewayClient
    @State private var people: [Person] = []
    @State private var selectedTab: PeopleTab = .monitored
    @State private var showingAddForm = false
    @State private var companyDomain = ""
    @State private var groupEmail = ""
    @State private var filtersExpanded = false

    private var filteredPeople: [Person] {
        switch selectedTab {
        case .monitored:
            return people.filter { $0.role == "peer" && $0.team == nil }
        case .directReports:
            return people.filter { $0.role == "direct_report" }
        case .vips:
            return people.filter { $0.role == "vip" }
        case .team:
            return people.filter { $0.team != nil && $0.role == "peer" }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Tab", selection: $selectedTab) {
                ForEach(PeopleTab.allCases) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            Divider()

            List {
                ForEach(filteredPeople) { person in
                    rowView(for: person)
                }
                .onDelete { offsets in
                    for index in offsets {
                        let email = filteredPeople[index].email
                        Task {
                            try? await gateway.removePerson(email: email)
                            await loadPeople()
                        }
                    }
                }
            }
            .listStyle(.inset)

            DisclosureGroup("Monitoring Filters", isExpanded: $filtersExpanded) {
                LabeledContent("Company domain") {
                    TextField("example.com", text: $companyDomain)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { saveFilters() }
                }
                LabeledContent("Group email") {
                    TextField("team@example.com", text: $groupEmail)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { saveFilters() }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
        }
        .navigationTitle("People")
        .toolbar {
            ToolbarItem {
                Button {
                    showingAddForm = true
                } label: {
                    Image(systemName: "plus")
                }
                .popover(isPresented: $showingAddForm, arrowEdge: .bottom) {
                    AddPersonForm(
                        selectedTab: selectedTab,
                        isPresented: $showingAddForm,
                        onAdd: { await loadPeople() }
                    )
                    .environmentObject(gateway)
                }
            }
        }
        .task {
            await loadPeople()
            await loadFilters()
        }
    }

    @ViewBuilder
    private func rowView(for person: Person) -> some View {
        switch selectedTab {
        case .monitored:
            MonitoredPersonRow(person: person)
        case .directReports:
            DirectReportRow(person: person, onUpdate: { await loadPeople() })
                .environmentObject(gateway)
        case .vips:
            VIPRow(person: person, onUpdate: { await loadPeople() })
                .environmentObject(gateway)
        case .team:
            TeamMemberRow(person: person)
        }
    }

    func loadPeople() async {
        people = (try? await gateway.listPeople()) ?? []
    }

    private func loadFilters() async {
        if let filters = try? await gateway.fetchFilters() {
            companyDomain = filters.companyDomain ?? ""
            groupEmail = filters.dwGroupEmail ?? ""
        }
    }

    private func saveFilters() {
        Task {
            try? await gateway.updateFilters(
                companyDomain: companyDomain.isEmpty ? nil : companyDomain,
                dwGroupEmail: groupEmail.isEmpty ? nil : groupEmail
            )
        }
    }
}

// MARK: - Monitored Row

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
        .padding(.vertical, 4)
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
        try? await gateway.addPerson(email: email, name: name)

        var extraFields: [String: Any] = [:]

        switch selectedTab {
        case .monitored:
            break
        case .directReports:
            extraFields["role"] = "direct_report"
            if !slackId.isEmpty { extraFields["slack_id"] = slackId }
        case .vips:
            extraFields["role"] = "vip"
            if !title.isEmpty { extraFields["title"] = title }
        case .team:
            extraFields["team"] = team.isEmpty ? nil : team
        }

        if !extraFields.isEmpty {
            try? await gateway.updatePerson(email: email, fields: extraFields)
        }

        await onAdd()
        isPresented = false
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
