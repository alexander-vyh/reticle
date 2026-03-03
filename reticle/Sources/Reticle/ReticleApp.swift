import SwiftUI

@main
struct ReticleApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Reticle")
                .frame(minWidth: 800, minHeight: 500)
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
    }
}
