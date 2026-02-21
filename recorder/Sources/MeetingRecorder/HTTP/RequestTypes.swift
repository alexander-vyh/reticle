import Foundation

// MARK: - Request Types

struct StartRecordingRequest: Codable {
    let meetingId: String
    let title: String
    var attendees: [String]
    var startTime: String?
    var endTime: String?
    var deviceHint: String?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        meetingId = try container.decode(String.self, forKey: .meetingId)
        title = try container.decode(String.self, forKey: .title)
        attendees = try container.decodeIfPresent([String].self, forKey: .attendees) ?? []
        startTime = try container.decodeIfPresent(String.self, forKey: .startTime)
        endTime = try container.decodeIfPresent(String.self, forKey: .endTime)
        deviceHint = try container.decodeIfPresent(String.self, forKey: .deviceHint)
    }
}

struct StopRecordingRequest: Codable {
    let meetingId: String
}

// MARK: - Response Types

struct StatusResponse: Codable {
    let recording: Bool
    var meetingId: String?
    var title: String?
    var duration: Double?
    var deviceName: String?
}

struct HealthResponse: Codable {
    let ok: Bool
    let uptime: Double
    var pythonAvailable: Bool
}

struct ErrorResponse: Codable {
    let error: String
}

struct StopResponse: Codable {
    let stopped: Bool
    let meetingId: String
    var wavPath: String?
}

struct StartResponse: Codable {
    let started: Bool
    let meetingId: String
}
