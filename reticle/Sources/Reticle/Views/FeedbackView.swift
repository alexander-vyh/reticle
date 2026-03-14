import SwiftUI

struct FeedbackView: View {
    @EnvironmentObject var gateway: GatewayClient
    @State private var candidates: [FeedbackCandidate] = []
    @State private var selectedId: String?
    @State private var editedDraft = ""
    @State private var copied = false
    @State private var weeklyTarget: Int = 3
    @State private var scanWindowHours: Int = 24
    @State private var deliveredThisWeek: Int = 0

    private var selected: FeedbackCandidate? {
        candidates.first { $0.id == selectedId }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Settings strip
            HStack(spacing: 12) {
                Text("Your standard:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Stepper(value: $weeklyTarget, in: 1...20) {
                    Text("\(weeklyTarget)/wk")
                        .font(.caption)
                        .monospacedDigit()
                }
                .labelsHidden()
                .onChange(of: weeklyTarget) { _, newValue in
                    Task { try? await gateway.updateFeedbackSettings(weeklyTarget: newValue) }
                }

                Text("·").foregroundStyle(.tertiary)

                Text("This week: \(deliveredThisWeek)")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Divider().frame(height: 14)

                Text("Scan:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Picker("", selection: $scanWindowHours) {
                    Text("24h").tag(24)
                    Text("48h").tag(48)
                    Text("72h").tag(72)
                    Text("14d").tag(336)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 160)
                .onChange(of: scanWindowHours) { _, newValue in
                    Task { try? await gateway.updateFeedbackSettings(scanWindowHours: newValue) }
                }

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.bar)

            Divider()

            // Candidate list + detail panel
            HSplitView {
                // Left: candidate list
                List(candidates, selection: $selectedId) { candidate in
                    CandidateRow(candidate: candidate)
                        .tag(candidate.id)
                }
                .frame(minWidth: 220, maxWidth: 280)
                .onChange(of: selectedId) { _, _ in
                    editedDraft = selected?.draft ?? ""
                    copied = false
                }

                // Right: detail panel
                if let candidate = selected {
                    FeedbackDetailView(
                        candidate: candidate,
                        editedDraft: $editedDraft,
                        copied: $copied,
                        onDelivered: {
                            Task {
                                try? await gateway.markDelivered(id: candidate.id)
                                await loadCandidates()
                                selectedId = nil
                            }
                        },
                        onSkipped: {
                            Task {
                                try? await gateway.markSkipped(id: candidate.id)
                                await loadCandidates()
                                selectedId = nil
                            }
                        }
                    )
                } else {
                    ContentUnavailableView(
                        "No Candidate Selected",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Select a feedback candidate to review.")
                    )
                }
            }
        }
        .navigationTitle("Feedback")
        .toolbar {
            ToolbarItem {
                Button(action: { Task { await loadCandidates() } }) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .task {
            await loadCandidates()
            if let settings = try? await gateway.fetchFeedbackSettings() {
                weeklyTarget = Int(settings.weeklyTarget ?? "3") ?? 3
                scanWindowHours = Int(settings.scanWindowHours ?? "24") ?? 24
            }
            if let stats = try? await gateway.fetchStats() {
                deliveredThisWeek = stats.weekly.values.reduce(0) { $0 + $1.delivered }
            }
        }
    }

    func loadCandidates() async {
        candidates = (try? await gateway.listCandidates()) ?? []
    }
}

struct CandidateRow: View {
    let candidate: FeedbackCandidate

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Circle()
                    .fill(candidate.feedbackType == "affirming" ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                Text(candidate.reportName)
                    .font(.headline)
            }
            Text(candidate.channel ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

struct FeedbackDetailView: View {
    let candidate: FeedbackCandidate
    @Binding var editedDraft: String
    @Binding var copied: Bool
    let onDelivered: () -> Void
    let onSkipped: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Header
                VStack(alignment: .leading, spacing: 4) {
                    Text(candidate.reportName)
                        .font(.title2).bold()
                    Text(candidate.channel ?? "")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Divider()

                // Raw artifact
                GroupBox("Observed") {
                    Text(candidate.rawArtifact)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                // Editable draft
                GroupBox("Draft (edit before sending)") {
                    TextEditor(text: $editedDraft)
                        .font(.body)
                        .frame(minHeight: 80)
                }

                // Actions
                HStack {
                    Button(copied ? "Copied!" : "Copy to clipboard") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(editedDraft, forType: .string)
                        copied = true
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(editedDraft.isEmpty)

                    Button("Mark Delivered") {
                        onDelivered()
                    }
                    .disabled(!copied)

                    Spacer()

                    Button("Skip") {
                        onSkipped()
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .padding()
        }
        .frame(minWidth: 400)
    }
}
