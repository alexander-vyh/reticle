import SwiftUI

struct PillView: View {
    @EnvironmentObject var state: PopupState

    var dotColor: Color {
        if state.isNow { return .red }
        return .yellow
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)

            Text(state.countdownText)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(state.isNow ? .red : state.isUrgent ? .yellow : .white)
                .monospacedDigit()
        }
        .frame(width: 80, height: 44)
        .background(
            Capsule()
                .fill(Color.black.opacity(0.95))
                .overlay(Capsule().stroke(Color.white.opacity(0.15), lineWidth: 1))
                .shadow(color: .black.opacity(0.5), radius: 8, y: 2)
        )
        .onTapGesture { state.expand() }
    }
}
