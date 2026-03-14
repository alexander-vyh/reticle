import SwiftUI

struct PersonDetailView: View {
    @EnvironmentObject var gateway: GatewayClient
    let entity: Entity

    @State private var commitments: [Commitment] = []
    @State private var isLoading = false
    @State private var error: String?
    @State private var showMergeSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Identity header
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    if let slackId = entity.slackId {
                        IdentityBadge(label: "Slack", value: slackId)
                    }
                    if let jiraId = entity.jiraId {
                        IdentityBadge(label: "Jira", value: jiraId)
                    }
                }
                Spacer()
                Button("Merge into…") { showMergeSheet = true }
                    .buttonStyle(.bordered)
            }
            .padding()
            .background(.bar)

            Divider()

            if isLoading && commitments.isEmpty {
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if commitments.isEmpty {
                ContentUnavailableView(
                    "No Open Commitments",
                    systemImage: "checkmark.seal",
                    description: Text("Nothing open for \(entity.canonicalName).")
                )
            } else {
                List(commitments) { item in
                    CommitmentRow(item: item) {
                        Task { await resolve(item) }
                    }
                }
            }
        }
        .navigationTitle(entity.canonicalName)
        .task { await load() }
        .sheet(isPresented: $showMergeSheet) {
            MergeSheet(sourceEntity: entity, onMerge: { targetId in
                showMergeSheet = false
                Task { await mergeInto(targetId: targetId) }
            })
        }
    }

    func load() async {
        isLoading = true
        error = nil
        commitments = (try? await gateway.listEntityCommitments(id: entity.id)) ?? []
        isLoading = false
    }

    func resolve(_ item: Commitment) async {
        try? await gateway.resolveCommitment(id: item.id)
        await load()
    }

    func mergeInto(targetId: String) async {
        do {
            try await gateway.mergeEntity(sourceId: entity.id, targetId: targetId)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Merge Sheet

struct MergeSheet: View {
    @EnvironmentObject var gateway: GatewayClient
    let sourceEntity: Entity
    let onMerge: (String) -> Void

    @State private var entities: [Entity] = []
    @State private var search = ""
    @State private var confirmTarget: Entity?

    private var candidates: [Entity] {
        let others = entities.filter { $0.id != sourceEntity.id && $0.isActive }
        guard !search.isEmpty else { return others }
        return others.filter { $0.canonicalName.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Merge \(sourceEntity.canonicalName) into…")
                    .font(.headline)
                Spacer()
            }
            .padding()

            TextField("Search people…", text: $search)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal)
                .padding(.bottom, 8)

            List(candidates) { entity in
                Button {
                    confirmTarget = entity
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entity.canonicalName)
                            .font(.body)
                        if entity.commitmentCount > 0 {
                            Text("\(entity.commitmentCount) open commitments")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .frame(minWidth: 360, minHeight: 420)
        .task { entities = (try? await gateway.listEntities()) ?? [] }
        .confirmationDialog(
            confirmTarget.map { "Merge \(sourceEntity.canonicalName) into \($0.canonicalName)?" } ?? "",
            isPresented: Binding(get: { confirmTarget != nil }, set: { if !$0 { confirmTarget = nil } }),
            titleVisibility: .visible
        ) {
            if let target = confirmTarget {
                Button("Merge", role: .destructive) { onMerge(target.id) }
                Button("Cancel", role: .cancel) { confirmTarget = nil }
            }
        } message: {
            if let target = confirmTarget {
                Text("All commitments and identities from \(sourceEntity.canonicalName) will move to \(target.canonicalName). This cannot be undone.")
            }
        }
    }
}
