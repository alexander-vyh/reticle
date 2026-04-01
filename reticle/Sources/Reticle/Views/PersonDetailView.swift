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
                AnchorIndicator(isAnchored: entity.isAnchored)

                VStack(alignment: .leading, spacing: 4) {
                    if let slackId = entity.slackId {
                        IdentityBadge(label: "Slack", value: slackId)
                    }
                    if let jiraId = entity.jiraId {
                        IdentityBadge(label: "Jira", value: jiraId)
                    }
                }
                Spacer()
                Button("Merge with\u{2026}") { showMergeSheet = true }
                    .buttonStyle(.bordered)
            }
            .padding()
            .background(.bar)

            Divider()

            if isLoading && commitments.isEmpty {
                ProgressView("Loading\u{2026}")
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
            MergeTargetPicker(sourceEntity: entity, onSelectTarget: { target in
                showMergeSheet = false
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
}

// MARK: - Merge Target Picker (step 1: choose who to merge with)

struct MergeTargetPicker: View {
    @EnvironmentObject var gateway: GatewayClient
    let sourceEntity: Entity
    let onSelectTarget: (Entity) -> Void

    @State private var entities: [Entity] = []
    @State private var search = ""
    @State private var selectedTarget: Entity?

    private var candidates: [Entity] {
        let others = entities.filter { $0.id != sourceEntity.id && $0.isActive }
        guard !search.isEmpty else { return others }
        return others.filter {
            $0.canonicalName.localizedCaseInsensitiveContains(search)
            || ($0.aliases ?? []).contains { alias in
                alias.localizedCaseInsensitiveContains(search)
            }
        }
    }

    var body: some View {
        if let target = selectedTarget {
            MergeReviewView(source: sourceEntity, target: target, onCancel: {
                selectedTarget = nil
            })
        } else {
            VStack(spacing: 0) {
                HStack {
                    Text("Merge \(sourceEntity.canonicalName) with\u{2026}")
                        .font(.headline)
                    Spacer()
                }
                .padding()

                TextField("Search people\u{2026}", text: $search)
                    .textFieldStyle(.roundedBorder)
                    .padding(.horizontal)
                    .padding(.bottom, 8)

                List(candidates) { entity in
                    Button {
                        selectedTarget = entity
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entity.canonicalName)
                                    .font(.body)
                                HStack(spacing: 8) {
                                    IdentityBadge(label: "Slack", value: entity.slackId)
                                    IdentityBadge(label: "Jira", value: entity.jiraId)
                                }
                                if entity.commitmentCount > 0 {
                                    Text("\(entity.commitmentCount) open commitments")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(minWidth: 400, minHeight: 420)
            .task { entities = (try? await gateway.listEntities()) ?? [] }
        }
    }
}

// MARK: - Merge Review View (step 2: side-by-side comparison + name picker)

struct MergeReviewView: View {
    @EnvironmentObject var gateway: GatewayClient
    @Environment(\.dismiss) var dismiss
    let source: Entity
    let target: Entity
    let onCancel: () -> Void

    @State private var preferredName: String
    @State private var isMerging = false
    @State private var error: String?

    init(source: Entity, target: Entity, onCancel: @escaping () -> Void) {
        self.source = source
        self.target = target
        self.onCancel = onCancel
        // Default to the target's name (the entity that survives)
        _preferredName = State(initialValue: target.canonicalName)
    }

    /// All unique name choices from both entities (canonical names + aliases).
    var nameChoices: [String] {
        MergeReviewView.collectNameChoices(source: source, target: target)
    }

    /// Pure function: collect all unique name choices from two entities.
    static func collectNameChoices(source: Entity, target: Entity) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for name in [target.canonicalName, source.canonicalName] + (target.aliases ?? []) + (source.aliases ?? []) {
            let trimmed = name.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
            seen.insert(trimmed)
            result.append(trimmed)
        }
        return result
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            Text("Merge Entities")
                .font(.headline)
                .padding(.top)

            // Side-by-side entity cards
            HStack(alignment: .top, spacing: 16) {
                EntityMergeCard(
                    entity: source,
                    role: "Will be merged away",
                    roleColor: .red
                )
                Image(systemName: "arrow.right")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                    .padding(.top, 30)
                EntityMergeCard(
                    entity: target,
                    role: "Will survive",
                    roleColor: .green
                )
            }
            .padding()

            Divider()

            // Preferred name picker
            VStack(alignment: .leading, spacing: 8) {
                Text("Preferred display name")
                    .font(.subheadline)
                    .fontWeight(.medium)

                ForEach(nameChoices, id: \.self) { name in
                    HStack(spacing: 8) {
                        Image(systemName: preferredName == name ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(preferredName == name ? Color.accentColor : Color.secondary)
                        Text(name)
                            .font(.body)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { preferredName = name }
                }
            }
            .padding()

            if let error = error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal)
            }

            Divider()

            // Action buttons
            HStack {
                Button("Back") { onCancel() }
                    .keyboardShortcut(.cancelAction)

                Spacer()

                Text("All facts, identities, and aliases will move to the surviving entity.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                Spacer()

                Button(isMerging ? "Merging\u{2026}" : "Merge") {
                    Task { await performMerge() }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .disabled(isMerging)
            }
            .padding()
        }
        .frame(minWidth: 500, minHeight: 400)
    }

    func performMerge() async {
        isMerging = true
        error = nil
        do {
            try await gateway.mergeEntity(
                sourceId: source.id,
                targetId: target.id,
                preferredName: preferredName
            )
            dismiss()
        } catch {
            self.error = "Merge failed: \(error.localizedDescription)"
        }
        isMerging = false
    }
}

// MARK: - Entity Merge Card

struct EntityMergeCard: View {
    let entity: Entity
    let role: String
    let roleColor: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Name
            Text(entity.canonicalName)
                .font(.title3)
                .fontWeight(.semibold)

            // Role label
            Text(role)
                .font(.caption)
                .foregroundStyle(roleColor)
                .fontWeight(.medium)

            Divider()

            // Identity badges
            VStack(alignment: .leading, spacing: 4) {
                Text("Identities")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fontWeight(.medium)

                IdentityBadge(label: "Slack", value: entity.slackId)
                IdentityBadge(label: "Jira", value: entity.jiraId)
            }

            // Aliases
            if let aliases = entity.aliases, !aliases.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    Text("Also known as")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fontWeight(.medium)
                    ForEach(aliases, id: \.self) { alias in
                        Text(alias)
                            .font(.caption)
                            .foregroundStyle(.primary)
                    }
                }
            }

            // Commitment count
            if entity.commitmentCount > 0 {
                Divider()
                Label("\(entity.commitmentCount) open commitments", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(.background))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator, lineWidth: 1))
    }
}
