import Foundation
import os

struct RecorderConfig: Codable {
    var httpPort: UInt16 = 9847
    var preferredDevices: [String] = ["ZoomAudioDevice", "BlackHole 2ch"]
    var chunkDurationSeconds: Double = 0.1
    var transcriptsDir: String = "~/.config/claudia/transcripts"
    var recordingsDir: String = "~/.config/claudia/recordings"
    var pythonVenvPath: String = "~/.config/claudia/recorder-venv"
    var whisperModel: String = "mlx-community/whisper-large-v3-turbo"
    var language: String = "auto"

    static let configPath = NSString("~/.config/claudia/recorder.json").expandingTildeInPath
    private static let logger = Logger(subsystem: "ai.openclaw.meeting-recorder", category: "Config")

    var resolvedTranscriptsDir: String {
        NSString(string: transcriptsDir).expandingTildeInPath
    }

    var resolvedRecordingsDir: String {
        NSString(string: recordingsDir).expandingTildeInPath
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
        for dir in [resolvedTranscriptsDir, resolvedRecordingsDir] {
            if !fm.fileExists(atPath: dir) {
                try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            }
        }
    }
}
