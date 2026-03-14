import SwiftUI

struct CommitmentsView: View {
    @EnvironmentObject var gateway: GatewayClient
    @State private var commitments: [Commitment] = []
    @State private var summary: CommitmentSummary?
    @State private var isLoading = false
    @State private var error: String?
    @State private var staleDays = 7

    private var grouped: [(String, [Commitment])] {
        let order = ["committed_to", "asked_to", "risk_flagged", "decision_made"]
        let dict = Dictionary(grouping: commitments) { $0.attribute }
        return order.compactMap { key in
            guard let items = dict[key], !items.isEmpty else { return nil }
            return (key, items)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if isLoading && commitments.isEmpty {
                ProgressView("Loading commitments...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = error, commitments.isEmpty {
                ContentUnavailableView(
                    "Unable to Load",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error)
                )
            } else if commitments.isEmpty {
                ContentUnavailableView(
                    "No Open Commitments",
                    systemImage: "checkmark.seal",
                    description: Text("All commitments are resolved.")
                )
            } else {
                if let summary = summary {
                    VStack(spacing: 0) {
                        SummaryBar(summary: summary)
                        HStack {
                            Spacer()
                            Text("Stale after:")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Picker("", selection: $staleDays) {
                                Text("3d").tag(3)
                                Text("5d").tag(5)
                                Text("7d").tag(7)
                                Text("14d").tag(14)
                                Text("30d").tag(30)
                            }
                            .pickerStyle(.menu)
                            .labelsHidden()
                        }
                        .padding(.horizontal)
                        .padding(.bottom, 4)
                        .background(.bar)
                    }
                }
                List {
                    ForEach(grouped, id: \.0) { attribute, items in
                        Section(header: Text(sectionTitle(for: attribute))) {
                            ForEach(items) { item in
                                CommitmentRow(item: item) {
                                    Task { await resolve(item) }
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Commitments")
        .toolbar {
            ToolbarItem {
                Button(action: { Task { await loadCommitments() } }) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .task { await loadCommitments() }
        .onChange(of: staleDays) { Task { await loadCommitments() } }
    }

    private func sectionTitle(for attribute: String) -> String {
        switch attribute {
        case "committed_to": return "Commitments"
        case "asked_to": return "Action Items"
        case "risk_flagged": return "Risks"
        case "decision_made": return "Decisions"
        default: return attribute.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    func loadCommitments() async {
        isLoading = true
        error = nil
        do {
            let response = try await gateway.listCommitments(staleDays: staleDays)
            commitments = response.commitments
            summary = response.summary
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func resolve(_ item: Commitment) async {
        do {
            try await gateway.resolveCommitment(id: item.id)
            await loadCommitments()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Summary Bar

struct SummaryBar: View {
    let summary: CommitmentSummary

    var body: some View {
        HStack(spacing: 16) {
            SummaryPill(label: "Total", count: summary.total, color: .primary)
            if let high = summary.byPriority["high"], high > 0 {
                SummaryPill(label: "High", count: high, color: .red)
            }
            if let normal = summary.byPriority["normal"], normal > 0 {
                SummaryPill(label: "Normal", count: normal, color: .secondary)
            }
            Spacer()
            ForEach(Array(summary.byAttribute.sorted(by: { $0.key < $1.key })), id: \.key) { key, count in
                Text("\(attributeShortName(key)): \(count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func attributeShortName(_ attr: String) -> String {
        switch attr {
        case "committed_to": return "Committed"
        case "asked_to": return "Asked"
        case "risk_flagged": return "Risks"
        case "decision_made": return "Decisions"
        default: return attr
        }
    }
}

struct SummaryPill: View {
    let label: String
    let count: Int
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Text("\(count)")
                .font(.title3)
                .fontWeight(.semibold)
                .foregroundStyle(color)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Commitment Row

struct CommitmentRow: View {
    let item: Commitment
    let onResolve: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(priorityColor)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(item.value)
                    .font(.body)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    Text(item.entityName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(ageLabel)
                        .font(.caption)
                        .foregroundStyle(item.isStale ? .red : .secondary)
                }
            }

            Spacer()

            Button("Mark Done") {
                onResolve()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.vertical, 2)
    }

    private var priorityColor: Color {
        item.priority == "high" ? .red : .blue
    }

    private var ageLabel: String {
        let days = item.ageDays
        if days == 0 { return "today" }
        if days == 1 { return "1 day ago" }
        return "\(days) days ago"
    }
}
