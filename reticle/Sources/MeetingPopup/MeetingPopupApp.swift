import SwiftUI

@main
struct MeetingPopupApp: App {
    @StateObject private var state: PopupState

    init() {
        let data = Self.parseArgs()
        _state = StateObject(wrappedValue: PopupState(data: data))
    }

    var body: some Scene {
        WindowGroup {
            PopupContentView()
                .environmentObject(state)
                .frame(width: state.isCollapsed ? 80 : 300, height: state.isCollapsed ? 44 : 200)
                .background(Color.black.opacity(0.95))
                .foregroundStyle(.white)
                .onAppear {
                    configureMainWindow()
                    state.scheduleAutoClose()
                    listenForStdinEscalations()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
    }

    private static func parseArgs() -> MeetingPopupData {
        let args = CommandLine.arguments
        let b64Arg = args.dropFirst().first { !$0.hasPrefix("-") }

        if let b64 = b64Arg,
           let data = Data(base64Encoded: b64),
           let decoded = try? JSONDecoder().decode(MeetingPopupData.self, from: data) {
            return decoded
        }
        return MeetingPopupData(alertLevel: "tenMin", meetings: [])
    }

    private func configureMainWindow() {
        DispatchQueue.main.async {
            guard let window = NSApp.windows.first else { return }
            window.level = .floating
            window.isMovableByWindowBackground = true
            window.backgroundColor = .clear
            window.hasShadow = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.isOpaque = false
            if let screen = NSScreen.main {
                let x = screen.visibleFrame.maxX - window.frame.width - 20
                let y = screen.visibleFrame.maxY - window.frame.height - 20
                window.setFrameOrigin(NSPoint(x: x, y: y))
            }
        }
    }

    private func listenForStdinEscalations() {
        let fh = FileHandle.standardInput
        DispatchQueue.global(qos: .utility).async {
            var buffer = ""
            while true {
                let data = fh.availableData
                if data.isEmpty { break }
                guard let chunk = String(data: data, encoding: .utf8) else { continue }
                buffer += chunk
                var lines = buffer.components(separatedBy: "\n")
                buffer = lines.removeLast()
                for line in lines {
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    if trimmed.isEmpty { continue }
                    guard let lineData = trimmed.data(using: .utf8),
                          let msg = try? JSONDecoder().decode(EscalationMessage.self, from: lineData) else { continue }
                    if msg.type == "escalate" {
                        Task { @MainActor in
                            self.state.handleEscalation(msg)
                        }
                    }
                }
            }
        }
    }
}
