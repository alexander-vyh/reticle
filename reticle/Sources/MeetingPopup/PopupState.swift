import SwiftUI

@MainActor
class PopupState: ObservableObject {
    @Published var data: MeetingPopupData
    @Published var isCollapsed: Bool
    @Published var countdownText: String = "--:--"
    @Published var isUrgent: Bool = false
    @Published var isNow: Bool = false
    @Published var shake: Bool = false

    private var timer: Timer?

    init(data: MeetingPopupData) {
        self.data = data
        self.isCollapsed = data.alertLevel == "tenMin"
        startCountdown()
    }

    func startCountdown() {
        updateCountdown()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateCountdown() }
        }
    }

    func updateCountdown() {
        guard let earliest = data.meetings.map({ $0.startDate }).min() else { return }
        let diff = earliest.timeIntervalSinceNow
        let absDiff = abs(diff)
        let min = Int(absDiff) / 60
        let sec = Int(absDiff) % 60

        if diff <= 0 {
            countdownText = "-\(min):\(String(format: "%02d", sec))"
            isNow = true; isUrgent = false
        } else if diff <= 300 {
            countdownText = "\(min):\(String(format: "%02d", sec))"
            isUrgent = true; isNow = false
        } else {
            countdownText = "\(min):\(String(format: "%02d", sec))"
            isUrgent = false; isNow = false
        }

        let diffMin = diff / 60
        if (diffMin <= 1.05 && diffMin > 0.95) || (diffMin <= 0.05 && diffMin > -0.05) {
            if !shake {
                shake = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    self?.shake = false
                }
            }
        }
    }

    func collapse() { isCollapsed = true }
    func expand() { isCollapsed = false }

    func handleEscalation(_ msg: EscalationMessage) {
        if let level = msg.alertLevel { data.alertLevel = level }
        if let meetings = msg.meetings { data.meetings = meetings }
        if isCollapsed { expand() }
    }

    func joinMeeting(_ meeting: MeetingInfo) {
        guard let urlStr = meeting.url, let url = URL(string: urlStr) else { return }
        NSWorkspace.shared.open(url)
    }

    func dismiss() {
        if data.alertLevel == "start" { return }
        collapse()
    }

    func scheduleAutoClose() {
        guard let earliest = data.meetings.map({ $0.startDate }).min() else { return }
        let delay = earliest.addingTimeInterval(5 * 60).timeIntervalSinceNow
        if delay <= 0 {
            NSApp.terminate(nil)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                NSApp.terminate(nil)
            }
        }
    }
}
