// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Reticle",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "Reticle",
            path: "Sources/Reticle"
        )
    ]
)
