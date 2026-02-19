import Foundation
import os

/// Routes HTTP requests to daemon methods and produces JSON responses.
final class HTTPRouter {
    private let logger = Logger(subsystem: "ai.openclaw.meeting-recorder", category: "Router")
    private weak var daemon: RecorderDaemon?
    private let startTime = Date()

    init(daemon: RecorderDaemon) {
        self.daemon = daemon
    }

    struct HTTPResponse {
        let statusCode: Int
        let body: Data

        var statusLine: String {
            let reason: String
            switch statusCode {
            case 200: reason = "OK"
            case 400: reason = "Bad Request"
            case 404: reason = "Not Found"
            case 409: reason = "Conflict"
            case 500: reason = "Internal Server Error"
            default: reason = "Unknown"
            }
            return "HTTP/1.1 \(statusCode) \(reason)"
        }

        var fullResponse: Data {
            let header = """
            \(statusLine)\r
            Content-Type: application/json\r
            Content-Length: \(body.count)\r
            Connection: close\r
            \r

            """
            var data = header.data(using: .utf8) ?? Data()
            data.append(body)
            return data
        }
    }

    func handle(method: String, path: String, body: Data?) -> HTTPResponse {
        switch (method.uppercased(), path) {
        case ("POST", "/start"):
            return handleStart(body: body)
        case ("POST", "/stop"):
            return handleStop(body: body)
        case ("GET", "/status"):
            return handleStatus()
        case ("GET", "/health"):
            return handleHealth()
        default:
            return jsonResponse(statusCode: 404, ErrorResponse(error: "Not found: \(method) \(path)"))
        }
    }

    // MARK: - Route Handlers

    private func handleStart(body: Data?) -> HTTPResponse {
        guard let daemon = daemon else {
            return jsonResponse(statusCode: 500, ErrorResponse(error: "Daemon not available"))
        }

        guard let body = body else {
            return jsonResponse(statusCode: 400, ErrorResponse(error: "Request body required"))
        }

        let request: StartRecordingRequest
        do {
            request = try JSONDecoder().decode(StartRecordingRequest.self, from: body)
        } catch {
            return jsonResponse(statusCode: 400, ErrorResponse(error: "Invalid JSON: \(error.localizedDescription)"))
        }

        do {
            try daemon.startRecording(
                meetingId: request.meetingId,
                title: request.title,
                attendees: request.attendees,
                startTime: request.startTime,
                endTime: request.endTime,
                deviceHint: request.deviceHint
            )
            return jsonResponse(statusCode: 200, StartResponse(started: true, meetingId: request.meetingId))
        } catch RecorderError.alreadyRecording {
            return jsonResponse(statusCode: 409, ErrorResponse(error: "Already recording"))
        } catch {
            return jsonResponse(statusCode: 500, ErrorResponse(error: error.localizedDescription))
        }
    }

    private func handleStop(body: Data?) -> HTTPResponse {
        guard let daemon = daemon else {
            return jsonResponse(statusCode: 500, ErrorResponse(error: "Daemon not available"))
        }

        // meetingId in body is optional (we only have one active session)
        var meetingId = "unknown"
        if let body = body,
           let request = try? JSONDecoder().decode(StopRecordingRequest.self, from: body) {
            meetingId = request.meetingId
        }

        guard daemon.isRecording else {
            return jsonResponse(statusCode: 409, ErrorResponse(error: "Not recording"))
        }

        let wavPath = daemon.stopRecording()
        return jsonResponse(statusCode: 200, StopResponse(stopped: true, meetingId: meetingId, wavPath: wavPath))
    }

    private func handleStatus() -> HTTPResponse {
        guard let daemon = daemon else {
            return jsonResponse(statusCode: 500, ErrorResponse(error: "Daemon not available"))
        }

        let status = daemon.status
        let response = StatusResponse(
            recording: status["recording"] as? Bool ?? false,
            meetingId: status["meetingId"] as? String,
            title: status["title"] as? String,
            duration: status["duration"] as? Double,
            deviceName: status["deviceName"] as? String
        )
        return jsonResponse(statusCode: 200, response)
    }

    private func handleHealth() -> HTTPResponse {
        let config = RecorderConfig.load()
        let pythonAvailable = FileManager.default.fileExists(atPath: config.pythonPath)
        let uptime = Date().timeIntervalSince(startTime)

        let response = HealthResponse(
            ok: true,
            uptime: round(uptime * 10) / 10,
            pythonAvailable: pythonAvailable
        )
        return jsonResponse(statusCode: 200, response)
    }

    // MARK: - Helpers

    private func jsonResponse<T: Encodable>(statusCode: Int, _ value: T) -> HTTPResponse {
        let data = (try? JSONEncoder().encode(value)) ?? Data()
        return HTTPResponse(statusCode: statusCode, body: data)
    }
}
