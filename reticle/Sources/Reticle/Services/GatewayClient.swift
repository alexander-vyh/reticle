import Foundation

// MARK: - Models

struct Person: Codable, Identifiable {
    let id: String?
    let email: String
    let name: String?
    let slackId: String?
    let jiraId: String?
    let role: String?           // "vip", "direct_report", "peer"
    let escalationTier: String? // "immediate", "4h", "daily", "weekly" — null = role default
    let title: String?          // VIP title
    let team: String?           // Team affiliation
    let resolvedAt: Int?
    let createdAt: Int?

    enum CodingKeys: String, CodingKey {
        case id, email, name, title, team, role
        case slackId = "slack_id"
        case jiraId = "jira_id"
        case escalationTier = "escalation_tier"
        case resolvedAt = "resolved_at"
        case createdAt = "created_at"
    }
}

struct FeedbackCandidate: Codable, Identifiable, Hashable {
    let id: String
    let reportName: String
    let channel: String?
    let rawArtifact: String
    let draft: String?
    let feedbackType: String?
    let status: String
    let createdAt: Int

    enum CodingKeys: String, CodingKey {
        case id, channel, status, draft
        case reportName = "report_name"
        case rawArtifact = "raw_artifact"
        case feedbackType = "feedback_type"
        case createdAt = "created_at"
    }
}

struct FeedbackStats: Codable {
    let weekly: [String: ReportCounts]
    let monthly: [String: ReportCounts]
    let ratios: [String: ReportRatio]
}

struct ReportCounts: Codable {
    let delivered: Int
    let skipped: Int
}

struct ReportRatio: Codable {
    let affirming: Int
    let adjusting: Int
    let total: Int
}

struct Commitment: Codable, Identifiable {
    let id: String
    let attribute: String
    let value: String
    let entityName: String
    let priority: String
    let ageDays: Int
    let isStale: Bool
    let source: String?
    let channelName: String?
    let sourceUrl: String?
}

struct CommitmentSummary: Codable {
    let total: Int
    let byAttribute: [String: Int]
    let byPriority: [String: Int]
}

struct CommitmentsResponse: Codable {
    let commitments: [Commitment]
    let summary: CommitmentSummary
}

struct FeedbackSettingsResponse: Codable {
    let weeklyTarget: String?
    let scanWindowHours: String?
}

struct FilterPatterns: Codable {
    let companyDomain: String?
    let dwGroupEmail: String?
}

struct SlackAccountInfo: Codable {
    let identifier: String?
    let connected: Bool
    let hasToken: Bool?
    let hasAppToken: Bool?
    let userId: String?
    let username: String?
}

struct GmailAccountInfo: Codable {
    let identifier: String?
    let connected: Bool
    let account: String?
}

struct JiraAccountInfo: Codable {
    let identifier: String?
    let connected: Bool
    let baseUrl: String?
    let userEmail: String?
    let hasToken: Bool?
}

struct AccountsResponse: Codable {
    let slack: SlackAccountInfo
    let gmail: GmailAccountInfo
    let jira: JiraAccountInfo
}

struct ReticleSettings: Codable {
    var polling: PollingSettings?
    var thresholds: ThresholdSettings?

    struct PollingSettings: Codable {
        var gmailIntervalMinutes: Int?
        var followupCheckIntervalMinutes: Int?
    }
    struct ThresholdSettings: Codable {
        var followupEscalationEmailHours: Int?
        var followupEscalationSlackDmHours: Int?
        var followupEscalationSlackMentionHours: Int?
    }
}

struct Entity: Codable, Identifiable, Hashable {
    let id: String
    let canonicalName: String
    let monitored: Bool
    let isActive: Bool
    let commitmentCount: Int
    let slackId: String?
    let jiraId: String?
    let isAnchored: Bool
    let aliases: [String]?
}

struct EntitiesResponse: Codable {
    let entities: [Entity]
}

// MARK: - Client

@MainActor
class GatewayClient: ObservableObject {
    private let baseURL: String

    init(port: Int = 3001) {
        self.baseURL = "http://localhost:\(port)"
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        guard let url = URL(string: baseURL + path) else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body = body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        if let httpResponse = response as? HTTPURLResponse,
           !(200...299).contains(httpResponse.statusCode) {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - People

    func listPeople() async throws -> [Person] {
        struct Response: Decodable { let people: [Person] }
        let res: Response = try await request("/people")
        return res.people
    }

    func addPerson(email: String, name: String, role: String? = nil, title: String? = nil, team: String? = nil) async throws {
        struct Response: Decodable { let ok: Bool }
        var body: [String: Any] = ["email": email, "name": name]
        if let role = role { body["role"] = role }
        if let title = title { body["title"] = title }
        if let team = team { body["team"] = team }
        let _: Response = try await request("/people", method: "POST", body: body)
    }

    func removePerson(email: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let encoded = email.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? email
        let _: Response = try await request("/people/\(encoded)", method: "DELETE")
    }

    func updatePerson(email: String, fields: [String: Any]) async throws {
        struct Response: Decodable { let ok: Bool }
        let encoded = email.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? email
        let _: Response = try await request("/people/\(encoded)", method: "PATCH", body: fields)
    }

    // MARK: - Feedback

    func listCandidates() async throws -> [FeedbackCandidate] {
        struct Response: Decodable { let candidates: [FeedbackCandidate] }
        let res: Response = try await request("/feedback/candidates")
        return res.candidates
    }

    func markDelivered(id: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/feedback/candidates/\(id)/delivered", method: "POST")
    }

    func markSkipped(id: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/feedback/candidates/\(id)/skipped", method: "POST")
    }

    func fetchStats() async throws -> FeedbackStats {
        return try await request("/feedback/stats")
    }

    func fetchFeedbackSettings() async throws -> FeedbackSettingsResponse {
        return try await request("/feedback/settings")
    }

    func updateFeedbackSettings(weeklyTarget: Int? = nil, scanWindowHours: Int? = nil) async throws {
        var body: [String: Any] = [:]
        if let t = weeklyTarget { body["weeklyTarget"] = t }
        if let s = scanWindowHours { body["scanWindowHours"] = s }
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/feedback/settings", method: "PATCH", body: body)
    }

    // MARK: - Filters

    func fetchFilters() async throws -> FilterPatterns {
        return try await request("/config/filters")
    }

    func updateFilters(companyDomain: String? = nil, dwGroupEmail: String? = nil) async throws {
        var body: [String: Any] = [:]
        if let d = companyDomain { body["companyDomain"] = d }
        if let g = dwGroupEmail { body["dwGroupEmail"] = g }
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/config/filters", method: "PATCH", body: body)
    }

    // MARK: - Commitments

    func listCommitments(staleDays: Int = 7) async throws -> CommitmentsResponse {
        return try await request("/api/commitments?staleDays=\(staleDays)")
    }

    func resolveCommitment(id: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request(
            "/api/commitments/\(id)/resolve",
            method: "POST",
            body: ["resolution": "completed"]
        )
    }

    // MARK: - Settings

    func fetchSettings() async throws -> ReticleSettings {
        return try await request("/settings")
    }

    func updateSettings(_ settings: [String: Any]) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/settings", method: "PATCH", body: settings)
    }

    // MARK: - Accounts

    func fetchAccounts() async throws -> AccountsResponse {
        return try await request("/config/accounts")
    }

    func updateAccounts(fields: [String: String]) async throws {
        struct Response: Decodable { let ok: Bool }
        let body: [String: Any] = fields
        let _: Response = try await request("/config/accounts", method: "PATCH", body: body)
    }

    // MARK: - Entities

    func listEntities() async throws -> [Entity] {
        let res: EntitiesResponse = try await request("/api/entities")
        return res.entities
    }

    func getEntity(id: String) async throws -> Entity {
        struct Response: Decodable { let entity: Entity }
        let res: Response = try await request("/api/entities/\(id)")
        return res.entity
    }

    func listEntityCommitments(id: String) async throws -> [Commitment] {
        struct Response: Decodable { let commitments: [Commitment] }
        let res: Response = try await request("/api/entities/\(id)/commitments")
        return res.commitments
    }

    func mergeEntity(sourceId: String, targetId: String, preferredName: String? = nil) async throws {
        struct Response: Decodable { let ok: Bool }
        var body: [String: Any] = ["targetId": targetId]
        if let name = preferredName { body["preferredName"] = name }
        let _: Response = try await request("/api/entities/\(sourceId)/merge", method: "POST", body: body)
    }

    func monitorEntity(id: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/api/entities/\(id)/monitor", method: "POST")
    }

    func unmonitorEntity(id: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/api/entities/\(id)/unmonitor", method: "POST")
    }
}
