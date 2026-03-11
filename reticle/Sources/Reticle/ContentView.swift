import SwiftUI

enum SidebarSection: String, CaseIterable, Identifiable {
    case commitments = "Commitments"
    case people = "People"
    case feedback = "Feedback"
    case messages = "Messages"
    case todos = "To-dos"
    case goals = "Goals"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .commitments: return "list.bullet.clipboard"
        case .people: return "person.2"
        case .feedback: return "bubble.left.and.bubble.right"
        case .messages: return "envelope"
        case .todos: return "checklist"
        case .goals: return "target"
        }
    }

    var isAvailable: Bool {
        switch self {
        case .commitments, .people, .feedback: return true
        default: return false
        }
    }
}

struct ContentView: View {
    @State private var selectedSection: SidebarSection = .commitments

    var body: some View {
        NavigationSplitView {
            List(SidebarSection.allCases, selection: $selectedSection) { section in
                Label(section.rawValue, systemImage: section.icon)
                    .foregroundStyle(section.isAvailable ? .primary : .tertiary)
                    .tag(section)
            }
            .navigationSplitViewColumnWidth(160)
        } detail: {
            switch selectedSection {
            case .commitments:
                CommitmentsView()
            case .people:
                PeopleView()
            case .feedback:
                FeedbackView()
            default:
                ContentUnavailableView(
                    "\(selectedSection.rawValue) Coming Soon",
                    systemImage: selectedSection.icon,
                    description: Text("This section is under construction.")
                )
            }
        }
        .navigationTitle("Reticle")
        .background(WindowAccessor { NSApp.setActivationPolicy(.accessory) })
    }
}

struct WindowAccessor: NSViewRepresentable {
    let onClose: () -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.delegate = context.coordinator
            window.identifier = NSUserInterfaceItemIdentifier("management")
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onClose: onClose) }

    class Coordinator: NSObject, NSWindowDelegate {
        let onClose: () -> Void
        init(onClose: @escaping () -> Void) { self.onClose = onClose }

        func windowShouldClose(_ sender: NSWindow) -> Bool {
            sender.orderOut(nil)
            onClose()
            return false
        }
    }
}
