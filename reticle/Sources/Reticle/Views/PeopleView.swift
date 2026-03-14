import SwiftUI

enum PeopleFilter: String, CaseIterable {
    case all = "All"
    case monitored = "Monitored"
}

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
    }
}

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
