import Foundation

// MARK: - Request Types

struct StartRecordingRequest: Codable {
    let meetingId: String
    let title: String
    let attendees: [String]
    var startTime: String?
    var endTime: String?
    var deviceHint: String?
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
