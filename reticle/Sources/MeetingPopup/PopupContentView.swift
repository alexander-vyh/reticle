import SwiftUI

struct PopupContentView: View {
    @EnvironmentObject var state: PopupState

    var body: some View {
        ZStack {
            if state.isCollapsed {
                PillView()
            } else {
                ExpandedPopupView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: state.isCollapsed)
    }
}

struct ExpandedPopupView: View {
    @EnvironmentObject var state: PopupState

    var headerColor: Color {
        if state.isNow { return .red }
        if state.isUrgent { return .yellow }
        return Color.white.opacity(0.2)
    }

    var headerTextColor: Color {
        if state.isNow { return .white }
        if state.isUrgent { return Color(red: 0.2, green: 0.2, blue: 0.2) }
        return Color.white.opacity(0.6)
    }

    var headerText: String {
        if state.isNow { return "MEETING NOW" }
        return "MEETING IN \(state.countdownText)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header badge
            Text(headerText)
                .font(.system(size: 11, weight: .bold))
                .tracking(1)
                .foregroundStyle(headerTextColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(headerColor)
                .clipShape(RoundedRectangle(cornerRadius: 4))

            // Meeting cards
            ForEach(state.data.meetings) { meeting in
                MeetingCard(meeting: meeting)
            }

            // Dismiss/Minimize button
            if state.data.alertLevel != "start" {
                Button(action: { state.dismiss() }) {
                    Text(state.data.alertLevel == "tenMin" ? "Dismiss" : "Minimize")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.white.opacity(0.4))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.black.opacity(0.95))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.5), radius: 16, y: 4)
        )
        .offset(x: state.shake ? -4 : 0)
        .animation(
            state.shake ? .easeInOut(duration: 0.1).repeatCount(6, autoreverses: true) : .default,
            value: state.shake
        )
    }
}

struct MeetingCard: View {
    @EnvironmentObject var state: PopupState
    let meeting: MeetingInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(meeting.summary ?? "Untitled Meeting")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(.white)
                .lineLimit(1)

            Text(state.countdownText)
                .font(.system(size: 24, weight: .light))
                .foregroundStyle(state.isNow ? .red : state.isUrgent ? .yellow : .white)
                .monospacedDigit()

            if let attendees = meeting.attendees, !attendees.isEmpty {
                let shown = attendees.prefix(3).joined(separator: ", ")
                let suffix = attendees.count > 3 ? " +\(attendees.count - 3) more" : ""
                Text("with \(shown)\(suffix)")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.white.opacity(0.5))
                    .lineLimit(1)
            }

            // Action buttons
            HStack(spacing: 6) {
                if meeting.hasVideoLink {
                    Button(action: { state.joinMeeting(meeting) }) {
                        Text(meeting.joinLabel ?? "Join Meeting")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 8)
                            .background(Color.green)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)

                    if let urlStr = meeting.url {
                        Button(action: {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(urlStr, forType: .string)
                        }) {
                            Text("Copy")
                                .font(.system(size: 13))
                                .foregroundStyle(Color.white.opacity(0.7))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(Color.white.opacity(0.1))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    Text("No video link")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.yellow)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Color.yellow.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }

                if let calLink = meeting.calendarLink, let url = URL(string: calLink) {
                    Button(action: { NSWorkspace.shared.open(url) }) {
                        Text("Cal")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.white.opacity(0.7))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)
        }
        .padding(.bottom, 12)
    }
}
