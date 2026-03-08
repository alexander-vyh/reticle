// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "MeetingRecorder",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "meeting-recorder",
            path: "Sources/MeetingRecorder",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("Network"),
            ]
        ),
        .testTarget(
            name: "MeetingRecorderTests",
            dependencies: [],
            path: "Tests/MeetingRecorderTests",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreAudio"),
            ]
        ),
    ]
)
