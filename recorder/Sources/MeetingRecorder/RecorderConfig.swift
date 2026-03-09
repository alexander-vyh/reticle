import Foundation
import os

struct RecorderConfig: Codable {
    var httpPort: UInt16 = 9847
    var preferredDevices: [String] = ["BlackHole 2ch", "ZoomAudioDevice"]
    var chunkDurationSeconds: Double = 0.1
    var transcriptsDir: String = "~/.config/reticle/transcripts"
    var recordingsDir: String = "~/.config/reticle/recordings"
    var pythonVenvPath: String = "~/.config/reticle/recorder-venv"
    var whisperModel: String = "mlx-community/whisper-large-v3-turbo"
    var language: String = "auto"
    var micDevice: String = ""
    var micVadThreshold: Double = 0.01
    var maxRecordingDurationSeconds: Int = 14400
    var heartbeatDir: String = "~/.reticle/heartbeats"
    var meetingApps: [String] = [
        "us.zoom.xos",              // Zoom
        "com.microsoft.teams2",     // Teams
        "com.tinyspeck.slackmacgap" // Slack
    ]
    var browserApps: [String] = [
        "com.apple.Safari",
        "com.google.Chrome",
        "org.mozilla.firefox",
        "company.thebrowser.Browser" // Arc
    ]

    // Custom decoder: all fields optional so partial JSON configs work
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        httpPort = try c.decodeIfPresent(UInt16.self, forKey: .httpPort) ?? 9847
        preferredDevices = try c.decodeIfPresent([String].self, forKey: .preferredDevices) ?? ["BlackHole 2ch", "ZoomAudioDevice"]
        chunkDurationSeconds = try c.decodeIfPresent(Double.self, forKey: .chunkDurationSeconds) ?? 0.1
        transcriptsDir = try c.decodeIfPresent(String.self, forKey: .transcriptsDir) ?? "~/.config/reticle/transcripts"
        recordingsDir = try c.decodeIfPresent(String.self, forKey: .recordingsDir) ?? "~/.config/reticle/recordings"
        pythonVenvPath = try c.decodeIfPresent(String.self, forKey: .pythonVenvPath) ?? "~/.config/reticle/recorder-venv"
        whisperModel = try c.decodeIfPresent(String.self, forKey: .whisperModel) ?? "mlx-community/whisper-large-v3-turbo"
        language = try c.decodeIfPresent(String.self, forKey: .language) ?? "auto"
        micDevice = try c.decodeIfPresent(String.self, forKey: .micDevice) ?? ""
        micVadThreshold = try c.decodeIfPresent(Double.self, forKey: .micVadThreshold) ?? 0.01
        maxRecordingDurationSeconds = try c.decodeIfPresent(Int.self, forKey: .maxRecordingDurationSeconds) ?? 14400
        heartbeatDir = try c.decodeIfPresent(String.self, forKey: .heartbeatDir) ?? "~/.reticle/heartbeats"
        meetingApps = try c.decodeIfPresent([String].self, forKey: .meetingApps) ?? [
            "us.zoom.xos", "com.microsoft.teams2", "com.tinyspeck.slackmacgap"
        ]
        browserApps = try c.decodeIfPresent([String].self, forKey: .browserApps) ?? [
            "com.apple.Safari", "com.google.Chrome", "org.mozilla.firefox", "company.thebrowser.Browser"
        ]
    }

    init() {}

    static let configPath = NSString("~/.config/reticle/recorder.json").expandingTildeInPath
    private static let logger = Logger(subsystem: "ai.reticle.meeting-recorder", category: "Config")

    var resolvedTranscriptsDir: String {
        NSString(string: transcriptsDir).expandingTildeInPath
    }

    var resolvedRecordingsDir: String {
        NSString(string: recordingsDir).expandingTildeInPath
    }

    var resolvedHeartbeatDir: String {
        NSString(string: heartbeatDir).expandingTildeInPath
    }

    var resolvedPythonVenvPath: String {
        NSString(string: pythonVenvPath).expandingTildeInPath
    }

    var pythonPath: String {
        "\(resolvedPythonVenvPath)/bin/python3"
    }

    var scriptsDir: String {
        // Scripts are bundled alongside the binary in development,
        // or in a known location for installed builds
        let bundleScripts = Bundle.main.bundlePath + "/../scripts"
        if FileManager.default.fileExists(atPath: bundleScripts) {
            return bundleScripts
        }
        // Fallback: relative to the binary's package source
        let devScripts = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // MeetingRecorder/
            .deletingLastPathComponent() // Sources/
            .deletingLastPathComponent() // recorder/
            .appendingPathComponent("scripts")
            .path
        return devScripts
    }

    static func load() -> RecorderConfig {
        let path = configPath
        guard FileManager.default.fileExists(atPath: path) else {
            logger.notice("No config file at \(path), using defaults")
            return RecorderConfig()
        }

        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let config = try JSONDecoder().decode(RecorderConfig.self, from: data)
            logger.notice("Loaded config from \(path)")
            return config
        } catch {
            logger.error("Failed to load config: \(error.localizedDescription), using defaults")
            return RecorderConfig()
        }
    }

    func ensureDirectories() throws {
        let fm = FileManager.default
        for dir in [resolvedTranscriptsDir, resolvedRecordingsDir, resolvedHeartbeatDir] {
            if !fm.fileExists(atPath: dir) {
                try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            }
        }
    }
}
