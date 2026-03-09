import AppKit
import Carbon.HIToolbox
import Foundation
import os

/// Manages global hotkeys for voice capture (dictation/notes) and communicates
/// with the meeting-recorder daemon's /capture/* endpoints.
@MainActor
class CaptureManager: ObservableObject {
    private let logger = Logger(subsystem: "ai.reticle.app", category: "CaptureManager")
    private let recorderPort: Int = 9847

    // MARK: - Published State

    @Published var isCapturing = false
    @Published var captureMode: String? = nil  // "dictation" or "notes"

    // MARK: - Hotkey Monitors

    private var globalMonitor: Any?
    private var localMonitor: Any?

    // MARK: - Streaming

    private var streamPollTimer: Timer?
    private var lastSegmentCount = 0

    // MARK: - Hotkey Config

    /// Stored in UserDefaults for future UI editing.
    struct HotkeyConfig {
        var dictationKeyCode: UInt16
        var dictationModifiers: NSEvent.ModifierFlags
        var notesKeyCode: UInt16
        var notesModifiers: NSEvent.ModifierFlags

        static let `default` = HotkeyConfig(
            dictationKeyCode: UInt16(kVK_ANSI_D),
            dictationModifiers: .option,
            notesKeyCode: UInt16(kVK_ANSI_N),
            notesModifiers: .option
        )
    }

    private var hotkeyConfig = HotkeyConfig.default

    // MARK: - Lifecycle

    func registerHotkeys() {
        // Load saved hotkeys from UserDefaults if available
        loadHotkeyConfig()

        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            Task { @MainActor in
                self?.handleKeyEvent(event)
            }
        }

        // Local monitor catches events when our own app is focused
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            Task { @MainActor in
                self?.handleKeyEvent(event)
            }
            return event
        }

        logger.notice("Global hotkeys registered: Option+D (dictation), Option+N (notes)")
    }

    func unregisterHotkeys() {
        if let monitor = globalMonitor {
            NSEvent.removeMonitor(monitor)
            globalMonitor = nil
        }
        if let monitor = localMonitor {
            NSEvent.removeMonitor(monitor)
            localMonitor = nil
        }
    }

    // MARK: - Key Handling

    private func handleKeyEvent(_ event: NSEvent) {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

        if event.keyCode == hotkeyConfig.dictationKeyCode
            && modifiers == hotkeyConfig.dictationModifiers
        {
            toggleCapture(mode: "dictation")
        } else if event.keyCode == hotkeyConfig.notesKeyCode
            && modifiers == hotkeyConfig.notesModifiers
        {
            toggleCapture(mode: "notes")
        }
    }

    // MARK: - Capture Toggle

    private func toggleCapture(mode: String) {
        if isCapturing {
            stopCapture()
        } else {
            startCapture(mode: mode)
        }
    }

    /// Check (and trigger prompt for) Accessibility permission. Returns true if granted.
    private func ensureAccessibility() -> Bool {
        let trusted = AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
        if !trusted {
            logger.warning("Accessibility permission not granted — dictation text injection disabled")
        }
        return trusted
    }

    private func startCapture(mode: String) {
        guard !isCapturing else { return }

        // Dictation needs Accessibility for text injection — prompt once if needed
        if mode == "dictation" && !ensureAccessibility() {
            return
        }

        Task {
            do {
                let body: [String: Any] = ["mode": mode, "source": "mic"]
                let response: CaptureStartResponse = try await recorderRequest(
                    "POST", "/capture/start", body: body)
                logger.notice("Capture started: \(response.captureId), mode=\(mode)")

                isCapturing = true
                captureMode = mode
                lastSegmentCount = 0

                if mode == "dictation" {
                    startStreamPolling()
                }
            } catch {
                logger.error("Failed to start capture: \(error.localizedDescription)")
            }
        }
    }

    private func stopCapture() {
        guard isCapturing else { return }

        stopStreamPolling()

        Task {
            do {
                let response: CaptureStopResponse = try await recorderRequest(
                    "POST", "/capture/stop")
                logger.notice("Capture stopped: \(response.captureId)")

                // Notes mode: transcript is saved to file by the daemon
                // Dictation mode: final transcript already typed live

                isCapturing = false
                captureMode = nil
            } catch {
                logger.error("Failed to stop capture: \(error.localizedDescription)")
                // Reset state even on error
                isCapturing = false
                captureMode = nil
            }
        }
    }

    // MARK: - Stream Polling (Dictation)

    private func startStreamPolling() {
        streamPollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) {
            [weak self] _ in
            Task { @MainActor in
                self?.pollStream()
            }
        }
    }

    private func stopStreamPolling() {
        streamPollTimer?.invalidate()
        streamPollTimer = nil
    }

    private func pollStream() {
        Task {
            do {
                let response: CaptureStreamResponse = try await recorderRequest(
                    "GET", "/capture/stream")
                let segments = response.segments

                // Type any new segments since last poll
                if segments.count > lastSegmentCount {
                    let newSegments = Array(segments[lastSegmentCount...])
                    for segment in newSegments {
                        typeText(segment + " ")
                    }
                    lastSegmentCount = segments.count
                }
            } catch {
                // Non-fatal — stream poll can fail transiently
            }
        }
    }

    // MARK: - Text Injection

    /// Type text at the current cursor position using CGEvent keystroke simulation.
    private func typeText(_ text: String) {
        let source = CGEventSource(stateID: .hidSystemState)

        // CGEventKeyboardSetUnicodeString handles up to ~20 chars per event.
        // For longer strings, chunk into slices.
        let chars = Array(text.utf16)
        let chunkSize = 20

        for start in stride(from: 0, to: chars.count, by: chunkSize) {
            let end = min(start + chunkSize, chars.count)
            let chunk = Array(chars[start..<end])

            guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            else { continue }

            keyDown.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            keyUp.keyboardSetUnicodeString(stringLength: 0, unicodeString: [])

            keyDown.post(tap: .cghidEventTap)
            keyUp.post(tap: .cghidEventTap)
        }
    }

    // MARK: - Recorder HTTP Client

    private struct CaptureStartResponse: Decodable {
        let captureId: String
        let streaming: Bool
    }

    private struct CaptureStopResponse: Decodable {
        let captureId: String
        let transcript: String?
        let wavPath: String?
    }

    private struct CaptureStreamResponse: Decodable {
        let segments: [String]
    }

    private func recorderRequest<T: Decodable>(
        _ method: String, _ path: String, body: [String: Any]? = nil
    ) async throws -> T {
        guard let url = URL(string: "http://localhost:\(recorderPort)\(path)") else {
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
            !(200...299).contains(httpResponse.statusCode)
        {
            let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
            throw NSError(
                domain: "CaptureManager", code: httpResponse.statusCode,
                userInfo: [NSLocalizedDescriptionKey: errorBody])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - UserDefaults Persistence

    private func loadHotkeyConfig() {
        let defaults = UserDefaults.standard
        if let dk = defaults.object(forKey: "captureHotkey.dictation.keyCode") as? Int,
            let dm = defaults.object(forKey: "captureHotkey.dictation.modifiers") as? UInt
        {
            hotkeyConfig.dictationKeyCode = UInt16(dk)
            hotkeyConfig.dictationModifiers = NSEvent.ModifierFlags(rawValue: dm)
        }
        if let nk = defaults.object(forKey: "captureHotkey.notes.keyCode") as? Int,
            let nm = defaults.object(forKey: "captureHotkey.notes.modifiers") as? UInt
        {
            hotkeyConfig.notesKeyCode = UInt16(nk)
            hotkeyConfig.notesModifiers = NSEvent.ModifierFlags(rawValue: nm)
        }
    }

    func saveHotkeyConfig() {
        let defaults = UserDefaults.standard
        defaults.set(Int(hotkeyConfig.dictationKeyCode), forKey: "captureHotkey.dictation.keyCode")
        defaults.set(
            hotkeyConfig.dictationModifiers.rawValue, forKey: "captureHotkey.dictation.modifiers")
        defaults.set(Int(hotkeyConfig.notesKeyCode), forKey: "captureHotkey.notes.keyCode")
        defaults.set(
            hotkeyConfig.notesModifiers.rawValue, forKey: "captureHotkey.notes.modifiers")
    }
}
