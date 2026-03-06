import XCTest
import Foundation

// MARK: - Test-local copies of MeetingPopup pure types
// These mirror the production Codable types from MeetingPopup/Models.swift.

private struct MeetingPopupData: Codable {
    var alertLevel: String
    var meetings: [MeetingInfo]
}

private struct MeetingInfo: Codable, Identifiable {
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

private struct EscalationMessage: Codable {
    let type: String
    let alertLevel: String?
    let meetings: [MeetingInfo]?
}

// MARK: - Pure function copies from PopupState

/// Compute countdown text from a time difference (seconds from now to meeting start).
/// Positive = meeting in the future, negative = meeting started.
private func computeCountdown(diff: TimeInterval) -> (text: String, isUrgent: Bool, isNow: Bool) {
    let absDiff = abs(diff)
    let min = Int(absDiff) / 60
    let sec = Int(absDiff) % 60

    if diff <= 0 {
        return ("-\(min):\(String(format: "%02d", sec))", false, true)
    } else if diff <= 300 {
        return ("\(min):\(String(format: "%02d", sec))", true, false)
    } else {
        return ("\(min):\(String(format: "%02d", sec))", false, false)
    }
}

/// Parse base64-encoded JSON from CLI args (mirrors MeetingPopupApp.parseArgs)
private func parseArgs(_ args: [String]) -> MeetingPopupData {
    let b64Arg = args.dropFirst().first { !$0.hasPrefix("-") }

    if let b64 = b64Arg,
       let data = Data(base64Encoded: b64),
       let decoded = try? JSONDecoder().decode(MeetingPopupData.self, from: data) {
        return decoded
    }
    return MeetingPopupData(alertLevel: "tenMin", meetings: [])
}

/// Determine initial collapsed state from alert level
private func initialCollapsed(alertLevel: String) -> Bool {
    return alertLevel == "tenMin"
}

/// Determine if dismiss is allowed at this alert level
private func canDismiss(alertLevel: String) -> Bool {
    return alertLevel != "start"
}

/// Handle escalation message (pure version)
private func handleEscalation(_ data: inout MeetingPopupData, msg: EscalationMessage) -> Bool {
    if let level = msg.alertLevel { data.alertLevel = level }
    if let meetings = msg.meetings { data.meetings = meetings }
    // Returns whether popup should expand
    return true
}

// MARK: - Tests

final class MeetingPopupTests: XCTestCase {

    // ==========================================================
    // Outcome: "Does the popup correctly receive meeting data?"
    // ==========================================================

    func testParseArgs_ValidBase64() {
        let meeting = MeetingInfo(
            id: "evt1", summary: "Standup", startTime: "2026-03-06T10:00:00Z",
            hasVideoLink: true, platform: "zoom", url: "https://zoom.us/j/123",
            joinLabel: "Join Zoom", calendarLink: nil, attendees: ["Alice", "Bob"]
        )
        let popupData = MeetingPopupData(alertLevel: "fiveMin", meetings: [meeting])
        let json = try! JSONEncoder().encode(popupData)
        let b64 = json.base64EncodedString()

        let result = parseArgs(["MeetingPopup", b64])
        XCTAssertEqual(result.alertLevel, "fiveMin")
        XCTAssertEqual(result.meetings.count, 1)
        XCTAssertEqual(result.meetings[0].summary, "Standup")
        XCTAssertEqual(result.meetings[0].attendees, ["Alice", "Bob"])
    }

    func testParseArgs_Base64AsFirstArg_WithTrailingFlags() {
        // meeting-alert-monitor.js always passes base64 as first arg;
        // any macOS-injected flags come after. parseArgs picks the first non-dash arg.
        let meeting = MeetingInfo(
            id: "evt1", summary: "Test", startTime: "2026-03-06T10:00:00Z",
            hasVideoLink: false, platform: nil, url: nil,
            joinLabel: nil, calendarLink: nil, attendees: nil
        )
        let popupData = MeetingPopupData(alertLevel: "tenMin", meetings: [meeting])
        let json = try! JSONEncoder().encode(popupData)
        let b64 = json.base64EncodedString()

        let result = parseArgs(["MeetingPopup", b64, "-NSDocumentRevisionsDebugMode", "YES"])
        XCTAssertEqual(result.meetings.count, 1, "Base64 as first non-dash arg should work")
    }

    func testParseArgs_InvalidBase64_FallsBack() {
        let result = parseArgs(["MeetingPopup", "not-valid-base64!!!"])
        XCTAssertEqual(result.alertLevel, "tenMin")
        XCTAssertTrue(result.meetings.isEmpty, "Invalid input should produce empty meetings")
    }

    func testParseArgs_NoArgs_FallsBack() {
        let result = parseArgs(["MeetingPopup"])
        XCTAssertEqual(result.alertLevel, "tenMin")
        XCTAssertTrue(result.meetings.isEmpty)
    }

    func testParseArgs_ValidBase64ButWrongShape_FallsBack() {
        // Valid base64 but not the expected JSON structure
        let json = "{\"foo\": \"bar\"}".data(using: .utf8)!
        let b64 = json.base64EncodedString()
        let result = parseArgs(["MeetingPopup", b64])
        XCTAssertEqual(result.alertLevel, "tenMin", "Malformed JSON should fall back")
    }

    // ==========================================================
    // Outcome: "Does the countdown show the right time?"
    // ==========================================================

    func testCountdown_10MinutesAway() {
        let (text, isUrgent, isNow) = computeCountdown(diff: 600)
        XCTAssertEqual(text, "10:00")
        XCTAssertFalse(isUrgent)
        XCTAssertFalse(isNow)
    }

    func testCountdown_5MinutesAway_IsUrgent() {
        let (text, isUrgent, isNow) = computeCountdown(diff: 300)
        XCTAssertEqual(text, "5:00")
        XCTAssertTrue(isUrgent, "5 minutes = urgent threshold")
        XCTAssertFalse(isNow)
    }

    func testCountdown_1MinuteAway_IsUrgent() {
        let (text, isUrgent, isNow) = computeCountdown(diff: 60)
        XCTAssertEqual(text, "1:00")
        XCTAssertTrue(isUrgent)
        XCTAssertFalse(isNow)
    }

    func testCountdown_30SecondsAway_IsUrgent() {
        let (text, isUrgent, isNow) = computeCountdown(diff: 30)
        XCTAssertEqual(text, "0:30")
        XCTAssertTrue(isUrgent)
    }

    func testCountdown_MeetingStarted_ShowsNegative() {
        let (text, isUrgent, isNow) = computeCountdown(diff: -120)
        XCTAssertEqual(text, "-2:00")
        XCTAssertFalse(isUrgent)
        XCTAssertTrue(isNow, "Past start time = isNow")
    }

    func testCountdown_ExactlyAtStart() {
        let (text, _, isNow) = computeCountdown(diff: 0)
        XCTAssertEqual(text, "-0:00")
        XCTAssertTrue(isNow)
    }

    func testCountdown_301Seconds_NotUrgent() {
        // 301 seconds (5:01) is just outside the urgent window
        let (text, isUrgent, _) = computeCountdown(diff: 301)
        XCTAssertEqual(text, "5:01")
        XCTAssertFalse(isUrgent, "301s is outside the 300s urgent threshold")
    }

    // ==========================================================
    // Outcome: "Does ISO8601 date parsing work correctly?"
    // ==========================================================

    func testMeetingInfo_StartDateParsesISO8601() {
        let meeting = MeetingInfo(
            id: "evt1", summary: "Test", startTime: "2026-03-06T14:30:00Z",
            hasVideoLink: false, platform: nil, url: nil,
            joinLabel: nil, calendarLink: nil, attendees: nil
        )
        let cal = Calendar(identifier: .gregorian)
        var components = cal.dateComponents(in: TimeZone(identifier: "UTC")!, from: meeting.startDate)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 3)
        XCTAssertEqual(components.day, 6)
        XCTAssertEqual(components.hour, 14)
        XCTAssertEqual(components.minute, 30)
    }

    func testMeetingInfo_InvalidStartTime_FallsBackToNow() {
        let meeting = MeetingInfo(
            id: "evt1", summary: "Test", startTime: "not-a-date",
            hasVideoLink: false, platform: nil, url: nil,
            joinLabel: nil, calendarLink: nil, attendees: nil
        )
        // Should fall back to Date() — just verify it doesn't crash
        // and produces a date within a second of now
        let diff = abs(meeting.startDate.timeIntervalSinceNow)
        XCTAssertLessThan(diff, 2.0, "Invalid date should fall back to ~now")
    }

    func testMeetingInfo_StartDateWithTimezone() {
        let meeting = MeetingInfo(
            id: "evt1", summary: "Test", startTime: "2026-03-06T10:00:00-08:00",
            hasVideoLink: false, platform: nil, url: nil,
            joinLabel: nil, calendarLink: nil, attendees: nil
        )
        // 10:00 PST = 18:00 UTC
        let cal = Calendar(identifier: .gregorian)
        let components = cal.dateComponents(in: TimeZone(identifier: "UTC")!, from: meeting.startDate)
        XCTAssertEqual(components.hour, 18)
    }

    // ==========================================================
    // Outcome: "Does dismiss gating protect the user?"
    // ==========================================================

    func testDismiss_AtStartLevel_Blocked() {
        XCTAssertFalse(canDismiss(alertLevel: "start"),
            "Can't dismiss at start — meeting is happening NOW")
    }

    func testDismiss_AtTenMin_Allowed() {
        XCTAssertTrue(canDismiss(alertLevel: "tenMin"))
    }

    func testDismiss_AtFiveMin_Allowed() {
        XCTAssertTrue(canDismiss(alertLevel: "fiveMin"))
    }

    func testDismiss_AtOneMin_Allowed() {
        XCTAssertTrue(canDismiss(alertLevel: "oneMin"))
    }

    // ==========================================================
    // Outcome: "Does the popup start in the right state?"
    // ==========================================================

    func testInitialState_TenMin_StartsCollapsed() {
        XCTAssertTrue(initialCollapsed(alertLevel: "tenMin"),
            "10-minute warning starts as pill (collapsed)")
    }

    func testInitialState_FiveMin_StartsExpanded() {
        XCTAssertFalse(initialCollapsed(alertLevel: "fiveMin"),
            "5-minute warning demands attention (expanded)")
    }

    func testInitialState_OneMin_StartsExpanded() {
        XCTAssertFalse(initialCollapsed(alertLevel: "oneMin"))
    }

    func testInitialState_Start_StartsExpanded() {
        XCTAssertFalse(initialCollapsed(alertLevel: "start"))
    }

    // ==========================================================
    // Outcome: "Does escalation update the popup correctly?"
    // ==========================================================

    func testEscalation_UpdatesAlertLevel() {
        var data = MeetingPopupData(alertLevel: "tenMin", meetings: [])
        let msg = EscalationMessage(type: "escalate", alertLevel: "fiveMin", meetings: nil)
        _ = handleEscalation(&data, msg: msg)
        XCTAssertEqual(data.alertLevel, "fiveMin")
    }

    func testEscalation_UpdatesMeetings() {
        var data = MeetingPopupData(alertLevel: "tenMin", meetings: [])
        let newMeeting = MeetingInfo(
            id: "evt2", summary: "Updated", startTime: "2026-03-06T10:00:00Z",
            hasVideoLink: true, platform: "teams", url: "https://teams.microsoft.com/l/123",
            joinLabel: "Join Teams", calendarLink: nil, attendees: ["Charlie"]
        )
        let msg = EscalationMessage(type: "escalate", alertLevel: nil, meetings: [newMeeting])
        _ = handleEscalation(&data, msg: msg)
        XCTAssertEqual(data.meetings.count, 1)
        XCTAssertEqual(data.meetings[0].summary, "Updated")
    }

    func testEscalation_NilFieldsPreserveExisting() {
        var data = MeetingPopupData(alertLevel: "fiveMin", meetings: [])
        let msg = EscalationMessage(type: "escalate", alertLevel: nil, meetings: nil)
        _ = handleEscalation(&data, msg: msg)
        XCTAssertEqual(data.alertLevel, "fiveMin", "Nil alertLevel should not change existing")
    }

    // ==========================================================
    // Outcome: "Does the JSON contract between Node.js and Swift hold?"
    // ==========================================================

    func testHeartbeatJSON_DecodesNodeOutput() {
        // This is the exact JSON shape that lib/heartbeat.js:write() produces
        let nodeJSON = """
        {
            "service": "gmail-monitor",
            "pid": 12345,
            "startedAt": 1741276800000,
            "lastCheck": 1741276830000,
            "uptime": 30,
            "checkInterval": 30000,
            "status": "ok",
            "errors": {
                "lastError": null,
                "lastErrorAt": null,
                "countSinceStart": 0
            },
            "metrics": {}
        }
        """
        // HeartbeatData from ServiceManager — test-local copy
        struct HeartbeatData: Codable {
            let service: String?
            let pid: Int?
            let startedAt: Double?
            let lastCheck: Double?
            let checkInterval: Double?
            let status: String?
            let errors: HeartbeatErrors?
        }
        struct HeartbeatErrors: Codable {
            let lastError: String?
            let lastErrorAt: Double?
            let countSinceStart: Int
        }

        let data = nodeJSON.data(using: .utf8)!
        let decoded = try? JSONDecoder().decode(HeartbeatData.self, from: data)
        XCTAssertNotNil(decoded, "Swift must decode Node.js heartbeat JSON")
        XCTAssertEqual(decoded?.service, "gmail-monitor")
        XCTAssertEqual(decoded?.pid, 12345)
        XCTAssertEqual(decoded?.lastCheck, 1741276830000)
        XCTAssertEqual(decoded?.checkInterval, 30000)
        XCTAssertEqual(decoded?.status, "ok")
        XCTAssertEqual(decoded?.errors?.countSinceStart, 0)
    }

    func testHeartbeatJSON_DecodesWithErrors() {
        let nodeJSON = """
        {
            "service": "slack-events",
            "pid": 54321,
            "startedAt": 1741276800000,
            "lastCheck": 1741276830000,
            "uptime": 300,
            "checkInterval": 30000,
            "status": "degraded",
            "errors": {
                "lastError": "Slack API rate limited",
                "lastErrorAt": 1741276825000,
                "countSinceStart": 3
            },
            "metrics": {"messagesProcessed": 142}
        }
        """
        struct HeartbeatData: Codable {
            let service: String?
            let pid: Int?
            let startedAt: Double?
            let lastCheck: Double?
            let checkInterval: Double?
            let status: String?
            let errors: HeartbeatErrors?
        }
        struct HeartbeatErrors: Codable {
            let lastError: String?
            let lastErrorAt: Double?
            let countSinceStart: Int
        }

        let data = nodeJSON.data(using: .utf8)!
        let decoded = try! JSONDecoder().decode(HeartbeatData.self, from: data)
        XCTAssertEqual(decoded.status, "degraded")
        XCTAssertEqual(decoded.errors?.lastError, "Slack API rate limited")
        XCTAssertEqual(decoded.errors?.countSinceStart, 3)
    }

    func testMeetingPopupJSON_RoundTrips() {
        // Verify the JSON contract between meeting-alert-monitor.js and MeetingPopup
        let nodeJSON = """
        {
            "alertLevel": "fiveMin",
            "meetings": [{
                "id": "abc123",
                "summary": "Weekly Sync",
                "startTime": "2026-03-06T14:00:00Z",
                "hasVideoLink": true,
                "platform": "zoom",
                "url": "https://zoom.us/j/123456",
                "joinLabel": "Join Zoom Meeting",
                "calendarLink": "https://calendar.google.com/event?eid=abc",
                "attendees": ["Alice Smith", "Bob Jones"]
            }]
        }
        """
        let data = nodeJSON.data(using: .utf8)!
        let decoded = try? JSONDecoder().decode(MeetingPopupData.self, from: data)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.alertLevel, "fiveMin")
        XCTAssertEqual(decoded?.meetings.count, 1)
        XCTAssertEqual(decoded?.meetings[0].id, "abc123")
        XCTAssertEqual(decoded?.meetings[0].platform, "zoom")
        XCTAssertEqual(decoded?.meetings[0].attendees?.count, 2)
    }

    func testMeetingPopupJSON_MinimalMeeting() {
        // Node.js may send meetings with minimal fields
        let nodeJSON = """
        {
            "alertLevel": "tenMin",
            "meetings": [{
                "id": "min1",
                "summary": null,
                "startTime": "2026-03-06T14:00:00Z",
                "hasVideoLink": false,
                "calendarLink": null,
                "attendees": null
            }]
        }
        """
        let data = nodeJSON.data(using: .utf8)!
        let decoded = try? JSONDecoder().decode(MeetingPopupData.self, from: data)
        XCTAssertNotNil(decoded, "Minimal meetings must still decode")
        XCTAssertNil(decoded?.meetings[0].summary)
        XCTAssertNil(decoded?.meetings[0].url)
        XCTAssertFalse(decoded?.meetings[0].hasVideoLink ?? true)
    }

    func testEscalationJSON_Decodes() {
        let nodeJSON = """
        {"type": "escalate", "alertLevel": "oneMin", "meetings": null}
        """
        let data = nodeJSON.data(using: .utf8)!
        let decoded = try? JSONDecoder().decode(EscalationMessage.self, from: data)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.type, "escalate")
        XCTAssertEqual(decoded?.alertLevel, "oneMin")
        XCTAssertNil(decoded?.meetings)
    }
}
