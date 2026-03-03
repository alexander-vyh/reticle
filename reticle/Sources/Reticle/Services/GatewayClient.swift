import Foundation

// MARK: - Models

struct Person: Codable, Identifiable {
    let id: String?
    let email: String
    let name: String?
    let slackId: String?
    let jiraId: String?
    let resolvedAt: Int?

    enum CodingKeys: String, CodingKey {
        case id, email, name
        case slackId = "slack_id"
        case jiraId = "jira_id"
        case resolvedAt = "resolved_at"
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
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - People

    func listPeople() async throws -> [Person] {
        struct Response: Decodable { let people: [Person] }
        let res: Response = try await request("/people")
        return res.people
    }

    func addPerson(email: String, name: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let _: Response = try await request("/people", method: "POST", body: ["email": email, "name": name])
    }

    func removePerson(email: String) async throws {
        struct Response: Decodable { let ok: Bool }
        let encoded = email.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? email
        let _: Response = try await request("/people/\(encoded)", method: "DELETE")
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
}
