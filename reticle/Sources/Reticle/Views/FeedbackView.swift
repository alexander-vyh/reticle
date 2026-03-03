import SwiftUI

struct FeedbackView: View {
    @EnvironmentObject var gateway: GatewayClient
    @State private var candidates: [FeedbackCandidate] = []
    @State private var selectedId: String?
    @State private var editedDraft = ""
    @State private var copied = false

    private var selected: FeedbackCandidate? {
        candidates.first { $0.id == selectedId }
    }

    var body: some View {
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
        .navigationTitle("Feedback")
        .toolbar {
            ToolbarItem {
                Button(action: { Task { await loadCandidates() } }) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .task { await loadCandidates() }
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
