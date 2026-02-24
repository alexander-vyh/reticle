import Foundation
import Network
import os

/// Minimal HTTP/1.1 server using Apple's Network framework (NWListener).
/// Handles JSON API requests for the meeting recorder daemon.
final class HTTPServer {
    private let logger = Logger(subsystem: "ai.openclaw.meeting-recorder", category: "HTTP")
    private let port: UInt16
    private var listener: NWListener?
    private let router: HTTPRouter
    private let queue = DispatchQueue(label: "ai.openclaw.meeting-recorder.http")
    private weak var daemon: RecorderDaemon?

    init(port: UInt16, daemon: RecorderDaemon) {
        self.port = port
        self.daemon = daemon
        self.router = HTTPRouter(daemon: daemon)
    }

    func start() {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        } catch {
            logger.error("Failed to create listener on port \(self.port): \(error.localizedDescription)")
            return
        }

        listener?.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                self.logger.notice("HTTP server listening on port \(self.port)")
            case .failed(let error):
                self.logger.error("HTTP server failed: \(error.localizedDescription)")
                self.listener?.cancel()
            default:
                break
            }
        }

        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener?.start(queue: queue)
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - Connection Handling

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)

        // Read the full HTTP request (headers + body)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                connection.cancel()
                return
            }

            if let error = error {
                self.logger.error("Connection error: \(error.localizedDescription)")
                connection.cancel()
                return
            }

            guard let data = data, !data.isEmpty else {
                connection.cancel()
                return
            }

            // Check for SSE request before normal routing
            let (method, path) = self.parseRequestLine(data: data)
            if method == "GET" && path == "/live" {
                self.handleSSEConnection(connection)
                return
            }

            let response = self.parseAndRoute(data: data)
            self.sendResponse(response, on: connection)
        }
    }

    private func parseAndRoute(data: Data) -> HTTPRouter.HTTPResponse {
        guard let raw = String(data: data, encoding: .utf8) else {
            return router.handle(method: "GET", path: "/", body: nil)
        }

        // Split headers from body at \r\n\r\n
        let parts = raw.components(separatedBy: "\r\n\r\n")
        let headerSection = parts.first ?? ""
        let bodyString = parts.count > 1 ? parts.dropFirst().joined(separator: "\r\n\r\n") : nil

        // Parse request line: "METHOD /path HTTP/1.1"
        let headerLines = headerSection.components(separatedBy: "\r\n")
        guard let requestLine = headerLines.first else {
            return router.handle(method: "GET", path: "/", body: nil)
        }

        let tokens = requestLine.split(separator: " ", maxSplits: 2)
        guard tokens.count >= 2 else {
            return router.handle(method: "GET", path: "/", body: nil)
        }

        let method = String(tokens[0])
        let path = String(tokens[1])

        var body: Data? = nil
        if let bodyString = bodyString, !bodyString.isEmpty {
            body = bodyString.data(using: .utf8)
        }

        return router.handle(method: method, path: path, body: body)
    }

    private func sendResponse(_ response: HTTPRouter.HTTPResponse, on connection: NWConnection) {
        let responseData = response.fullResponse
        connection.send(content: responseData, completion: .contentProcessed { [weak self] error in
            if let error = error {
                self?.logger.error("Failed to send response: \(error.localizedDescription)")
            }
            connection.cancel()
        })
    }

    // MARK: - SSE Support

    private func parseRequestLine(data: Data) -> (String, String) {
        guard let raw = String(data: data, encoding: .utf8) else { return ("GET", "/") }
        let headerSection = raw.components(separatedBy: "\r\n\r\n").first ?? ""
        let headerLines = headerSection.components(separatedBy: "\r\n")
        guard let requestLine = headerLines.first else { return ("GET", "/") }
        let tokens = requestLine.split(separator: " ", maxSplits: 2)
        guard tokens.count >= 2 else { return ("GET", "/") }
        return (String(tokens[0]), String(tokens[1]))
    }

    private func handleSSEConnection(_ connection: NWConnection) {
        let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n"
        guard let headerData = headers.data(using: .utf8) else {
            connection.cancel()
            return
        }

        connection.send(content: headerData, completion: .contentProcessed { [weak self] error in
            if let error = error {
                self?.logger.error("Failed to send SSE headers: \(error.localizedDescription)")
                connection.cancel()
                return
            }

            // Register as subscriber
            if let store = self?.daemon?.liveStore {
                store.addSubscriber(connection: connection)
            } else {
                // No active recording — send idle status and keep connection open
                let idle = "event: status\ndata: {\"state\":\"idle\"}\n\n"
                if let data = idle.data(using: .utf8) {
                    connection.send(content: data, completion: .contentProcessed { _ in })
                }
            }
        })
    }
}
