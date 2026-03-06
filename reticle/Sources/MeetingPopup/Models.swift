import Foundation

struct MeetingPopupData: Codable {
    var alertLevel: String   // tenMin, fiveMin, oneMin, start
    var meetings: [MeetingInfo]
}

struct MeetingInfo: Codable, Identifiable {
    let id: String
    let summary: String?
    let startTime: String
    var hasVideoLink: Bool
    var platform: String?
    var url: String?
    var joinLabel: String?
    let calendarLink: String?
    let attendees: [String]?

    var startDate: Date {
        ISO8601DateFormatter().date(from: startTime) ?? Date()
    }
}

struct EscalationMessage: Codable {
    let type: String
    let alertLevel: String?
    let meetings: [MeetingInfo]?
}
