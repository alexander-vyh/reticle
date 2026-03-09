import XCTest
import Foundation

// Minimal replicas for testing capture types JSON encoding/decoding
private struct CaptureStartRequest: Codable {
    let mode: String
    var source: String?
}

private struct CaptureStartResponse: Codable {
    let captureId: String
    let streaming: Bool
}

private struct CaptureStopResponse: Codable {
    let captureId: String
    var transcript: String?
    var wavPath: String?
}

final class CaptureTypesTests: XCTestCase {

    // MARK: - CaptureStartRequest

    func testCaptureStartRequestDecodesModeAndSource() throws {
        let json = """
        {"mode": "dictation", "source": "mic"}
        """.data(using: .utf8)!

        let request = try JSONDecoder().decode(CaptureStartRequest.self, from: json)
        XCTAssertEqual(request.mode, "dictation")
        XCTAssertEqual(request.source, "mic")
    }

    func testCaptureStartRequestDecodesWithoutSource() throws {
        let json = """
        {"mode": "notes"}
        """.data(using: .utf8)!

        let request = try JSONDecoder().decode(CaptureStartRequest.self, from: json)
        XCTAssertEqual(request.mode, "notes")
        XCTAssertNil(request.source)
    }

    // MARK: - CaptureStartResponse

    func testCaptureStartResponseRoundTrips() throws {
        let original = CaptureStartResponse(captureId: "cap-test1234", streaming: true)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(CaptureStartResponse.self, from: data)

        XCTAssertEqual(decoded.captureId, original.captureId)
        XCTAssertEqual(decoded.streaming, original.streaming)
    }

    // MARK: - CaptureStopResponse

    func testCaptureStopResponseDictationModeNoWav() throws {
        let response = CaptureStopResponse(captureId: "cap-DICT0001", transcript: "Some dictated text")
        let data = try JSONEncoder().encode(response)
        let decoded = try JSONDecoder().decode(CaptureStopResponse.self, from: data)

        XCTAssertEqual(decoded.captureId, "cap-DICT0001")
        XCTAssertEqual(decoded.transcript, "Some dictated text")
        XCTAssertNil(decoded.wavPath)
    }

    func testCaptureStopResponseNotesModeWithWav() throws {
        let response = CaptureStopResponse(
            captureId: "cap-NOTE0001",
            transcript: "Meeting notes here",
            wavPath: "/path/to/capture.wav"
        )
        let data = try JSONEncoder().encode(response)
        let decoded = try JSONDecoder().decode(CaptureStopResponse.self, from: data)

        XCTAssertEqual(decoded.captureId, "cap-NOTE0001")
        XCTAssertNotNil(decoded.transcript)
        XCTAssertNotNil(decoded.wavPath)
    }

    func testCaptureStopResponseNilOptionalFields() throws {
        let response = CaptureStopResponse(captureId: "cap-ABCD1234")
        let data = try JSONEncoder().encode(response)
        let decoded = try JSONDecoder().decode(CaptureStopResponse.self, from: data)

        XCTAssertEqual(decoded.captureId, "cap-ABCD1234")
        XCTAssertNil(decoded.transcript)
        XCTAssertNil(decoded.wavPath)
    }
}
