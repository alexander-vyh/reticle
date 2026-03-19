import SwiftUI
import AppKit
import Combine

/// NSPanel-based popup that bypasses SwiftUI WindowGroup.
/// WindowGroup does not auto-create windows for LSUIElement apps on macOS Sequoia.
/// NSPanel + NSHostingView is the reliable path for floating utility windows.
@main
class PopupAppDelegate: NSObject, NSApplicationDelegate {
    var panel: NSPanel!
    var state: PopupState!
    var sizeCancellable: AnyCancellable?

    static func main() {
        let app = NSApplication.shared
        let delegate = PopupAppDelegate()
        app.delegate = delegate
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        let data = Self.parseArgs()
        state = PopupState(data: data)

        let width: CGFloat = state.isCollapsed ? 80 : 300
        let height: CGFloat = state.isCollapsed ? 44 : 200

        let contentView = PopupContentView()
            .environmentObject(state)
            .frame(
                minWidth: 80, maxWidth: 400,
                minHeight: 44, maxHeight: 500
            )
            .fixedSize()
            .background(Color.black.opacity(0.001)) // hit-test target

        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.nonactivatingPanel, .fullSizeContentView, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isOpaque = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.animationBehavior = .utilityWindow
        panel.contentView = NSHostingView(rootView: contentView)

        positionPanel()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Hide dock icon after window is shown
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            NSApp.setActivationPolicy(.accessory)
        }

        // Resize panel when collapsed state changes
        sizeCancellable = state.$isCollapsed.sink { [weak self] _ in
            DispatchQueue.main.async { self?.resizePanel() }
        }

        state.scheduleAutoClose()
        listenForStdinEscalations()
    }

    private func positionPanel() {
        guard let screen = NSScreen.main else { return }
        let x = screen.visibleFrame.maxX - panel.frame.width - 20
        let y = screen.visibleFrame.maxY - panel.frame.height - 20
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func resizePanel() {
        guard let hostingView = panel.contentView else { return }
        let size = hostingView.fittingSize
        let frame = panel.frame
        // Anchor top-right: keep maxX and maxY stable
        let newOrigin = NSPoint(
            x: frame.maxX - size.width,
            y: frame.maxY - size.height
        )
        panel.setFrame(NSRect(origin: newOrigin, size: size), display: true, animate: true)
    }

    static func parseArgs() -> MeetingPopupData {
        let args = CommandLine.arguments
        let b64Arg = args.dropFirst().first { !$0.hasPrefix("-") }

        if let b64 = b64Arg,
           let data = Data(base64Encoded: b64),
           let decoded = try? JSONDecoder().decode(MeetingPopupData.self, from: data) {
            return decoded
        }
        return MeetingPopupData(alertLevel: "tenMin", meetings: [])
    }

    private func listenForStdinEscalations() {
        let fh = FileHandle.standardInput
        DispatchQueue.global(qos: .utility).async { [weak self] in
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
                            self?.state.handleEscalation(msg)
                        }
                    }
                }
            }
        }
    }
}
