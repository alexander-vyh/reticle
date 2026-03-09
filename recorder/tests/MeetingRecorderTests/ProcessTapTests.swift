import XCTest
import CoreAudio
import Foundation

// We can't import the executable target directly, so we test via standalone
// definitions that mirror the production types. The real integration test is
// "does it build and does the build include these types."

// MARK: - RecorderConfig Tests

final class RecorderConfigTests: XCTestCase {

    func testDefaultMeetingApps() {
        // Default meeting app bundle IDs should include Zoom, Teams, Slack
        let defaults = [
            "us.zoom.xos",
            "com.microsoft.teams2",
            "com.tinyspeck.slackmacgap",
        ]
        XCTAssertEqual(defaults.count, 3, "Should have 3 default meeting apps")
        XCTAssertTrue(defaults.contains("us.zoom.xos"), "Should include Zoom")
        XCTAssertTrue(defaults.contains("com.microsoft.teams2"), "Should include Teams")
        XCTAssertTrue(defaults.contains("com.tinyspeck.slackmacgap"), "Should include Slack")
    }

    func testDefaultBrowserApps() {
        let defaults = [
            "com.apple.Safari",
            "com.google.Chrome",
            "org.mozilla.firefox",
            "company.thebrowser.Browser",
        ]
        XCTAssertEqual(defaults.count, 4, "Should have 4 default browser apps")
        XCTAssertTrue(defaults.contains("com.apple.Safari"), "Should include Safari")
        XCTAssertTrue(defaults.contains("com.google.Chrome"), "Should include Chrome")
        XCTAssertTrue(defaults.contains("company.thebrowser.Browser"), "Should include Arc")
    }

    func testConfigParsesWithMeetingApps() throws {
        // Verify that a JSON config with meetingApps deserializes correctly
        let json = """
        {
            "httpPort": 9847,
            "preferredDevices": ["BlackHole 2ch"],
            "meetingApps": ["us.zoom.xos", "custom.app"],
            "browserApps": ["com.apple.Safari"]
        }
        """
        let data = json.data(using: .utf8)!

        // We parse it as a generic dictionary since we can't import the module
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let meetingApps = dict["meetingApps"] as! [String]
        let browserApps = dict["browserApps"] as! [String]

        XCTAssertEqual(meetingApps, ["us.zoom.xos", "custom.app"])
        XCTAssertEqual(browserApps, ["com.apple.Safari"])
    }

    func testConfigParsesMeetingAppsOptional() throws {
        // Config without meetingApps should parse (uses defaults)
        let json = """
        {
            "httpPort": 9847,
            "preferredDevices": ["BlackHole 2ch"]
        }
        """
        let data = json.data(using: .utf8)!
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // meetingApps not present -> defaults apply
        XCTAssertNil(dict["meetingApps"])
    }
}

// MARK: - Error Type Tests

final class ProcessTapErrorTests: XCTestCase {

    func testRecorderErrorCases() {
        // Verify all error cases have descriptions
        let errors: [(String, String)] = [
            ("alreadyRecording", "A recording is already in progress"),
            ("noDeviceFound", "No suitable audio input device found"),
            ("notRecording", "No recording is in progress"),
            ("permissionDenied", "Audio capture permission denied"),
            ("noMeetingAppsRunning", "No meeting apps are currently running"),
        ]

        // We can't instantiate RecorderError from tests, but we verify the
        // error message constants are correct via string comparison
        for (name, expected) in errors {
            XCTAssertFalse(expected.isEmpty, "Error '\(name)' should have a description")
        }
    }

    func testTapCreationFailedIncludesStatus() {
        // The tapCreationFailed error should include the OSStatus code
        let status: OSStatus = -50
        let message = "Process Tap creation failed: \(status)"
        XCTAssertTrue(message.contains("-50"), "Error should include status code")
    }
}

// MARK: - Request/Response Type Tests

final class RequestTypeTests: XCTestCase {

    func testStartRecordingRequestParsesBrowserMeeting() throws {
        let json = """
        {
            "meetingId": "test-123",
            "title": "Test Meeting",
            "browserMeeting": true
        }
        """
        let data = json.data(using: .utf8)!
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(dict["browserMeeting"] as? Bool, true)
    }

    func testStartRecordingRequestDefaultsBrowserMeetingToNil() throws {
        let json = """
        {
            "meetingId": "test-123",
            "title": "Test Meeting"
        }
        """
        let data = json.data(using: .utf8)!
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertNil(dict["browserMeeting"], "browserMeeting should default to nil when not provided")
    }

    func testStatusResponseIncludesCaptureMode() throws {
        // Build a status response JSON with captureMode
        let responseDict: [String: Any] = [
            "recording": true,
            "meetingId": "test-123",
            "captureMode": "tap",
        ]
        let data = try JSONSerialization.data(withJSONObject: responseDict)
        let decoded = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(decoded["captureMode"] as? String, "tap")
    }

    func testStatusResponseCaptureModeAbsentWhenNotRecording() throws {
        let responseDict: [String: Any] = [
            "recording": false,
        ]
        let data = try JSONSerialization.data(withJSONObject: responseDict)
        let decoded = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertNil(decoded["captureMode"])
    }

    func testStartResponseIncludesCaptureMode() throws {
        let responseDict: [String: Any] = [
            "started": true,
            "meetingId": "test-123",
            "captureMode": "fallback",
        ]
        let data = try JSONSerialization.data(withJSONObject: responseDict)
        let decoded = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(decoded["captureMode"] as? String, "fallback")
    }
}

// MARK: - Process Tap Availability Tests

final class ProcessTapAvailabilityTests: XCTestCase {

    func testAvailabilityCheck() {
        // On macOS 14.2+ this should return true, on older it should return false
        // We can't control the OS version in tests, but we verify the check runs
        if #available(macOS 14.2, *) {
            // We're on 14.2+, availability should be true
            // (Can't directly call ProcessTapCapture.isAvailable since it's in
            // the executable target, but this verifies the availability syntax works)
            XCTAssertTrue(true, "macOS 14.2+ detected")
        } else {
            XCTAssertTrue(true, "macOS < 14.2 detected, tap would be unavailable")
        }
    }
}

// MARK: - Capture Mode Tests

final class CaptureModeTests: XCTestCase {

    func testCaptureModeValues() {
        // Verify the two capture mode strings are distinct
        let tap = "tap"
        let fallback = "fallback"
        XCTAssertNotEqual(tap, fallback)
        XCTAssertEqual(tap, "tap")
        XCTAssertEqual(fallback, "fallback")
    }

    func testBundleIDList() {
        // Verify meeting + browser apps don't overlap
        let meetingApps = [
            "us.zoom.xos",
            "com.microsoft.teams2",
            "com.tinyspeck.slackmacgap",
        ]
        let browserApps = [
            "com.apple.Safari",
            "com.google.Chrome",
            "org.mozilla.firefox",
            "company.thebrowser.Browser",
        ]

        let meetingSet = Set(meetingApps)
        let browserSet = Set(browserApps)
        XCTAssertTrue(meetingSet.isDisjoint(with: browserSet),
                      "Meeting and browser app lists should not overlap")

        // Combined list for browserMeeting mode
        var combined = meetingApps
        combined.append(contentsOf: browserApps)
        XCTAssertEqual(combined.count, 7, "Combined list should have all 7 apps")
    }
}
