import XCTest

// MARK: - Test-local Entity model (mirrors GatewayClient.Entity)

struct TestEntity: Codable {
    let id: String
    let canonicalName: String
    let monitored: Bool
    let isActive: Bool
    let commitmentCount: Int
    let slackId: String?
    let jiraId: String?
    let isAnchored: Bool
}

// MARK: - Pure functions extracted from EntityRow for testing

func anchorIcon(isAnchored: Bool) -> String {
    isAnchored ? "pin.fill" : "icloud.slash"
}

func anchorLabel(isAnchored: Bool) -> String {
    isAnchored ? "Anchored" : "Floating"
}

func anchorAccessibilityLabel(canonicalName: String, isAnchored: Bool) -> String {
    "\(canonicalName), \(isAnchored ? "anchored identity" : "floating identity")"
}

// MARK: - Tests

final class AnchorIndicatorTests: XCTestCase {

    // ==========================================================
    // Outcome: "Can the user tell anchored from floating at a glance?"
    // ==========================================================

    func testAnchoredEntity_ShowsPinIcon() {
        let icon = anchorIcon(isAnchored: true)
        XCTAssertEqual(icon, "pin.fill", "Anchored entities should show pin icon")
    }

    func testFloatingEntity_ShowsCloudSlashIcon() {
        let icon = anchorIcon(isAnchored: false)
        XCTAssertEqual(icon, "icloud.slash", "Floating entities should show cloud-slash icon")
    }

    func testAnchoredEntity_LabelSaysAnchored() {
        XCTAssertEqual(anchorLabel(isAnchored: true), "Anchored")
    }

    func testFloatingEntity_LabelSaysFloating() {
        XCTAssertEqual(anchorLabel(isAnchored: false), "Floating")
    }

    func testAccessibilityLabel_Anchored() {
        let label = anchorAccessibilityLabel(canonicalName: "Alice", isAnchored: true)
        XCTAssertEqual(label, "Alice, anchored identity")
    }

    func testAccessibilityLabel_Floating() {
        let label = anchorAccessibilityLabel(canonicalName: "Bob", isAnchored: false)
        XCTAssertEqual(label, "Bob, floating identity")
    }

    // ==========================================================
    // Outcome: "Does JSON decoding handle isAnchored correctly?"
    // ==========================================================

    func testEntityDecoding_WithIsAnchored() throws {
        let json = """
        {
            "id": "ent-1",
            "canonicalName": "Alice",
            "monitored": true,
            "isActive": true,
            "commitmentCount": 3,
            "slackId": "U123",
            "jiraId": null,
            "isAnchored": true
        }
        """.data(using: .utf8)!

        let entity = try JSONDecoder().decode(TestEntity.self, from: json)
        XCTAssertEqual(entity.isAnchored, true)
        XCTAssertEqual(entity.canonicalName, "Alice")
    }

    func testEntityDecoding_FloatingEntity() throws {
        let json = """
        {
            "id": "ent-2",
            "canonicalName": "Unknown Person",
            "monitored": false,
            "isActive": true,
            "commitmentCount": 0,
            "slackId": null,
            "jiraId": null,
            "isAnchored": false
        }
        """.data(using: .utf8)!

        let entity = try JSONDecoder().decode(TestEntity.self, from: json)
        XCTAssertEqual(entity.isAnchored, false)
    }
}
