import XCTest
import Foundation

// Minimal replica of RecorderConfig for testing JSON parsing behavior.
// This must stay in sync with Sources/MeetingRecorder/RecorderConfig.swift.
private struct RecorderConfig: Codable {
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
    var maxRecordingDurationSeconds: Int = 7200
    var silenceOnsetTimeoutSeconds: Double = 90
    var silenceExtendedTimeoutSeconds: Double = 300
    var heartbeatDir: String = "~/.reticle/heartbeats"

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        httpPort = try container.decodeIfPresent(UInt16.self, forKey: .httpPort) ?? 9847
        preferredDevices = try container.decodeIfPresent([String].self, forKey: .preferredDevices) ?? ["BlackHole 2ch", "ZoomAudioDevice"]
        chunkDurationSeconds = try container.decodeIfPresent(Double.self, forKey: .chunkDurationSeconds) ?? 0.1
        transcriptsDir = try container.decodeIfPresent(String.self, forKey: .transcriptsDir) ?? "~/.config/reticle/transcripts"
        recordingsDir = try container.decodeIfPresent(String.self, forKey: .recordingsDir) ?? "~/.config/reticle/recordings"
        pythonVenvPath = try container.decodeIfPresent(String.self, forKey: .pythonVenvPath) ?? "~/.config/reticle/recorder-venv"
        whisperModel = try container.decodeIfPresent(String.self, forKey: .whisperModel) ?? "mlx-community/whisper-large-v3-turbo"
        language = try container.decodeIfPresent(String.self, forKey: .language) ?? "auto"
        micDevice = try container.decodeIfPresent(String.self, forKey: .micDevice) ?? ""
        micVadThreshold = try container.decodeIfPresent(Double.self, forKey: .micVadThreshold) ?? 0.01
        maxRecordingDurationSeconds = try container.decodeIfPresent(Int.self, forKey: .maxRecordingDurationSeconds) ?? 7200
        silenceOnsetTimeoutSeconds = try container.decodeIfPresent(Double.self, forKey: .silenceOnsetTimeoutSeconds) ?? 90
        silenceExtendedTimeoutSeconds = try container.decodeIfPresent(Double.self, forKey: .silenceExtendedTimeoutSeconds) ?? 300
        heartbeatDir = try container.decodeIfPresent(String.self, forKey: .heartbeatDir) ?? "~/.reticle/heartbeats"
    }
}

final class RecorderConfigZombieTests: XCTestCase {

    func testDefaultMaxRecordingDuration() throws {
        let config = RecorderConfig()
        XCTAssertEqual(config.maxRecordingDurationSeconds, 7200,
                       "Default max recording duration should be 7200 seconds (2 hours)")
    }

    func testDefaultSilenceOnsetTimeout() throws {
        let config = RecorderConfig()
        XCTAssertEqual(config.silenceOnsetTimeoutSeconds, 90,
                       "Default silence onset timeout should be 90 seconds")
    }

    func testDefaultSilenceExtendedTimeout() throws {
        let config = RecorderConfig()
        XCTAssertEqual(config.silenceExtendedTimeoutSeconds, 300,
                       "Default silence extended timeout should be 300 seconds")
    }

    func testParseMaxRecordingDurationFromJSON() throws {
        let json = """
        {
            "maxRecordingDurationSeconds": 3600
        }
        """.data(using: .utf8)!

        let config = try JSONDecoder().decode(RecorderConfig.self, from: json)
        XCTAssertEqual(config.maxRecordingDurationSeconds, 3600,
                       "Should parse custom maxRecordingDurationSeconds from JSON")
        XCTAssertEqual(config.httpPort, 9847)
    }

    func testParseSilenceTimeoutsFromJSON() throws {
        let json = """
        {
            "silenceOnsetTimeoutSeconds": 60,
            "silenceExtendedTimeoutSeconds": 180
        }
        """.data(using: .utf8)!

        let config = try JSONDecoder().decode(RecorderConfig.self, from: json)
        XCTAssertEqual(config.silenceOnsetTimeoutSeconds, 60,
                       "Should parse custom silenceOnsetTimeoutSeconds")
        XCTAssertEqual(config.silenceExtendedTimeoutSeconds, 180,
                       "Should parse custom silenceExtendedTimeoutSeconds")
        // Other fields should still have defaults
        XCTAssertEqual(config.maxRecordingDurationSeconds, 7200)
    }

    func testParseEmptyJSONUsesDefaults() throws {
        let json = "{}".data(using: .utf8)!
        let config = try JSONDecoder().decode(RecorderConfig.self, from: json)
        XCTAssertEqual(config.maxRecordingDurationSeconds, 7200)
        XCTAssertEqual(config.silenceOnsetTimeoutSeconds, 90)
        XCTAssertEqual(config.silenceExtendedTimeoutSeconds, 300)
        XCTAssertEqual(config.heartbeatDir, "~/.reticle/heartbeats")
    }
}
