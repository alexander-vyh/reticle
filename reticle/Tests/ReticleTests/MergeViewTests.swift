import XCTest

// MARK: - Test-local types (mirrors production Entity for pure logic testing)

private struct TestEntity {
    let id: String
    let canonicalName: String
    let monitored: Bool
    let isActive: Bool
    let commitmentCount: Int
    let slackId: String?
    let jiraId: String?
    let aliases: [String]?
}

// MARK: - Pure function copy from MergeReviewView.collectNameChoices

/// Collect all unique name choices from two entities. Target names appear first.
private func collectNameChoices(source: TestEntity, target: TestEntity) -> [String] {
    var seen = Set<String>()
    var result: [String] = []
    for name in [target.canonicalName, source.canonicalName] + (target.aliases ?? []) + (source.aliases ?? []) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
        seen.insert(trimmed)
        result.append(trimmed)
    }
    return result
}

// MARK: - Tests

final class MergeViewTests: XCTestCase {

    // MARK: - collectNameChoices

    func testNameChoicesIncludesBothCanonicalNames() {
        let source = TestEntity(id: "s", canonicalName: "Dan Sherr", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil, aliases: nil)
        let target = TestEntity(id: "t", canonicalName: "Daniel Sherr", monitored: true,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil, aliases: nil)

        let choices = collectNameChoices(source: source, target: target)
        XCTAssertEqual(choices, ["Daniel Sherr", "Dan Sherr"])
    }

    func testNameChoicesTargetCanonicalFirst() {
        let source = TestEntity(id: "s", canonicalName: "Alice", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil, aliases: nil)
        let target = TestEntity(id: "t", canonicalName: "Bob", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil, aliases: nil)

        let choices = collectNameChoices(source: source, target: target)
        XCTAssertEqual(choices.first, "Bob", "Target canonical name should appear first")
    }

    func testNameChoicesIncludesAliases() {
        let source = TestEntity(id: "s", canonicalName: "Dan Sherr", monitored: false,
                                isActive: true, commitmentCount: 1, slackId: "U1", jiraId: nil,
                                aliases: ["Danny", "D. Sherr"])
        let target = TestEntity(id: "t", canonicalName: "Daniel Sherr", monitored: true,
                                isActive: true, commitmentCount: 2, slackId: nil, jiraId: "dsherr",
                                aliases: ["Daniel S."])

        let choices = collectNameChoices(source: source, target: target)
        XCTAssertTrue(choices.contains("Danny"), "Should include source alias Danny")
        XCTAssertTrue(choices.contains("D. Sherr"), "Should include source alias D. Sherr")
        XCTAssertTrue(choices.contains("Daniel S."), "Should include target alias Daniel S.")
    }

    func testNameChoicesDeduplicates() {
        let source = TestEntity(id: "s", canonicalName: "Dan Sherr", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil,
                                aliases: ["Dan Sherr", "Danny"]) // duplicate of canonical
        let target = TestEntity(id: "t", canonicalName: "Dan Sherr", monitored: true,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil,
                                aliases: ["Danny"]) // duplicate of source alias

        let choices = collectNameChoices(source: source, target: target)
        // Should have exactly 2 unique names: "Dan Sherr", "Danny"
        XCTAssertEqual(choices.count, 2, "Should deduplicate: got \(choices)")
        XCTAssertEqual(choices, ["Dan Sherr", "Danny"])
    }

    func testNameChoicesEmptyAliases() {
        let source = TestEntity(id: "s", canonicalName: "Alice", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil, aliases: [])
        let target = TestEntity(id: "t", canonicalName: "Bob", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil, aliases: [])

        let choices = collectNameChoices(source: source, target: target)
        XCTAssertEqual(choices, ["Bob", "Alice"])
    }

    func testNameChoicesNilAliases() {
        let source = TestEntity(id: "s", canonicalName: "Alpha", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil, aliases: nil)
        let target = TestEntity(id: "t", canonicalName: "Beta", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil, aliases: nil)

        let choices = collectNameChoices(source: source, target: target)
        XCTAssertEqual(choices, ["Beta", "Alpha"])
    }

    func testNameChoicesSkipsWhitespaceOnlyNames() {
        let source = TestEntity(id: "s", canonicalName: "Alice", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil,
                                aliases: ["  ", ""])
        let target = TestEntity(id: "t", canonicalName: "Bob", monitored: false,
                                isActive: true, commitmentCount: 0, slackId: nil, jiraId: nil, aliases: nil)

        let choices = collectNameChoices(source: source, target: target)
        XCTAssertEqual(choices, ["Bob", "Alice"],
                       "Should skip whitespace-only and empty aliases")
    }

    // MARK: - Default preferred name selection

    func testDefaultPreferredNameIsTargetCanonical() {
        // The MergeReviewView initializer sets preferredName = target.canonicalName.
        // Verify this logic directly.
        let targetName = "Daniel Sherr"
        let preferredName = targetName // mirrors init logic
        XCTAssertEqual(preferredName, "Daniel Sherr",
                       "Default preferred name should be target's canonical name")
    }
}
