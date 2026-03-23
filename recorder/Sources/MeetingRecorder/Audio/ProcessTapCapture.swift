import AppKit
import AudioToolbox
import CoreAudio
import Foundation
import os

/// Captures audio from specific processes using Core Audio Process Taps (macOS 14.2+).
/// Process Taps intercept audio from apps like Zoom/Teams regardless of output device.
///
/// This class runs SIMULTANEOUSLY with MicMonitor — ProcessTapCapture captures meeting
/// audio (other participants) while MicMonitor captures the user's microphone. This
/// dual-stream architecture enables self/others attribution for live analytics.
final class ProcessTapCapture {

    // MARK: - Types

    enum CaptureError: LocalizedError {
        case noMeetingAppsRunning
        case tapCreationFailed(OSStatus)
        case permissionDenied
        case aggregateDeviceFailed
        case unavailable  // macOS < 14.2

        var errorDescription: String? {
            switch self {
            case .noMeetingAppsRunning:
                return "No meeting apps are currently running"
            case .tapCreationFailed(let status):
                return "Process Tap creation failed: \(status)"
            case .permissionDenied:
                return "Audio capture permission denied (TCC)"
            case .aggregateDeviceFailed:
                return "Failed to create aggregate device for tap"
            case .unavailable:
                return "Process Taps require macOS 14.2 or later"
            }
        }
    }

    // MARK: - Properties

    private let logger = Logger(subsystem: "ai.reticle.meeting-recorder", category: "ProcessTap")

    private let bundleIDs: [String]
    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    private var ioProcID: AudioDeviceIOProcID?
    private var isRunning = false

    // Audio format from the aggregate device
    private var streamFormat = AudioStreamBasicDescription()

    // Audio metering for silence detection (thread-safe, same pattern as CoreAudioRecorder)
    private let meterLock = NSLock()
    private var _lastNonSilentTime: Date?

    /// Last time audio above the silence threshold was observed. Nil until first non-silent frame.
    var lastNonSilentTime: Date? {
        meterLock.lock()
        defer { meterLock.unlock() }
        return _lastNonSilentTime
    }

    // Pre-allocated render buffer
    private var renderBuffer: UnsafeMutablePointer<Float32>?
    private var renderBufferSize: UInt32 = 0

    /// Called on the audio thread with raw PCM data (16-bit, 16kHz, mono) for streaming.
    /// Same interface as CoreAudioRecorder.onAudioChunk.
    var onAudioChunk: ((_ data: Data) -> Void)?

    // Conversion buffer (Float32 -> Int16 16kHz mono)
    private var conversionBuffer: UnsafeMutablePointer<Int16>?
    private var conversionBufferSize: UInt32 = 0

    // Output format: 16kHz mono Int16 (matches CoreAudioRecorder)
    private let outputFormat = AudioStreamBasicDescription(
        mSampleRate: 16000.0,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 2,
        mFramesPerPacket: 1,
        mBytesPerFrame: 2,
        mChannelsPerFrame: 1,
        mBitsPerChannel: 16,
        mReserved: 0
    )

    // ExtAudioFile for WAV output
    private var audioFile: ExtAudioFileRef?

    // MARK: - Initialization

    /// Create a ProcessTapCapture targeting processes with the given bundle IDs.
    /// - Parameter bundleIDs: Array of bundle identifiers to tap (e.g. ["us.zoom.xos"])
    init(bundleIDs: [String]) {
        self.bundleIDs = bundleIDs
    }

    deinit {
        stop()
    }

    // MARK: - Availability Check

    /// Returns true if Process Tap APIs are available (macOS 14.2+).
    static var isAvailable: Bool {
        if #available(macOS 14.2, *) {
            return true
        }
        return false
    }

    // MARK: - Permission Probing

    /// Probe TCC permission by creating a minimal tap and immediately destroying it.
    /// Returns "authorized", "denied", or "unknown".
    @available(macOS 14.2, *)
    static func checkPermission() -> String {
        // Find a running audio process to use as a tap target.
        // We can't use our own PID directly as an AudioObjectID — we need
        // a real AudioObjectID from the process object list.
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var propertySize: UInt32 = 0
        var queryStatus = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propertySize
        )
        guard queryStatus == noErr, propertySize > 0 else { return "unknown" }

        let count = Int(propertySize) / MemoryLayout<AudioObjectID>.size
        var processObjects = [AudioObjectID](repeating: 0, count: count)
        queryStatus = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propertySize, &processObjects
        )
        guard queryStatus == noErr, !processObjects.isEmpty else { return "unknown" }

        // Use the first audio process object as probe target
        let desc = CATapDescription(stereoMixdownOfProcesses: [processObjects[0]])
        desc.isPrivate = true
        var tapID: AudioObjectID = kAudioObjectUnknown
        let status = AudioHardwareCreateProcessTap(desc, &tapID)
        if status == noErr && tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            return "authorized"
        }
        if status == -1 { return "denied" }
        return "unknown"
    }

    /// Non-availability-gated wrapper for permission probing.
    /// Returns "authorized", "denied", "unknown", or "unavailable".
    static func probePermissionStatus() -> String {
        guard isAvailable else { return "unavailable" }
        if #available(macOS 14.2, *) {
            return checkPermission()
        }
        return "unknown"
    }

    // MARK: - Process Enumeration

    /// Find AudioObjectIDs for running processes matching our target bundle IDs.
    /// Returns the PIDs of matching running apps.
    func findTargetProcessPIDs() -> [pid_t] {
        let runningApps = NSWorkspace.shared.runningApplications
        var pids: [pid_t] = []

        for app in runningApps {
            guard let bundleID = app.bundleIdentifier else { continue }
            if bundleIDs.contains(bundleID) {
                pids.append(app.processIdentifier)
                logger.notice("Found target process: \(bundleID) (PID \(app.processIdentifier))")
            }
        }

        return pids
    }

    /// Translate PIDs to CoreAudio AudioObjectIDs via kAudioHardwarePropertyProcessObjectList.
    private func audioObjectIDs(for pids: [pid_t]) -> [AudioObjectID] {
        // Get all process objects from the system
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var propertySize: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0, nil,
            &propertySize
        )
        guard status == noErr, propertySize > 0 else {
            logger.error("Failed to get process object list size: \(status)")
            return []
        }

        let count = Int(propertySize) / MemoryLayout<AudioObjectID>.size
        var processObjects = [AudioObjectID](repeating: 0, count: count)

        status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0, nil,
            &propertySize,
            &processObjects
        )
        guard status == noErr else {
            logger.error("Failed to get process object list: \(status)")
            return []
        }

        // Match process objects to our target PIDs
        var matched: [AudioObjectID] = []
        for obj in processObjects {
            var pidAddress = AudioObjectPropertyAddress(
                mSelector: kAudioProcessPropertyPID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )

            var pid: pid_t = 0
            var pidSize = UInt32(MemoryLayout<pid_t>.size)
            let pidStatus = AudioObjectGetPropertyData(obj, &pidAddress, 0, nil, &pidSize, &pid)
            if pidStatus == noErr && pids.contains(pid) {
                matched.append(obj)
            }
        }

        return matched
    }

    // MARK: - Start / Stop

    /// Start capturing audio from target processes.
    /// - Parameter outputFile: URL to write WAV output to
    /// - Throws: CaptureError if tap creation fails
    func start(outputFile: URL) throws {
        guard ProcessTapCapture.isAvailable else {
            throw CaptureError.unavailable
        }

        guard !isRunning else { return }

        // Step 1: Find running meeting app processes
        let pids = findTargetProcessPIDs()
        guard !pids.isEmpty else {
            throw CaptureError.noMeetingAppsRunning
        }

        // Step 1b: Translate PIDs to CoreAudio AudioObjectIDs
        let processObjectIDs = audioObjectIDs(for: pids)
        guard !processObjectIDs.isEmpty else {
            logger.warning("Found meeting PIDs but no matching CoreAudio process objects")
            throw CaptureError.noMeetingAppsRunning
        }

        if #available(macOS 14.2, *) {
            try startTap(processObjectIDs: processObjectIDs, outputFile: outputFile)
        }
    }

    @available(macOS 14.2, *)
    private func startTap(processObjectIDs: [AudioObjectID], outputFile: URL) throws {
        // Step 2: Create Process Tap — capture all system audio except our own process
        // stereoGlobalTapButExcludeProcesses captures everything, which is more reliable
        // than stereoMixdownOfProcesses which can deliver zero buffers on some configurations
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let ownAudioObjects = audioObjectIDs(for: [ownPID])
        let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: ownAudioObjects)
        tapDescription.muteBehavior = .unmuted  // Don't mute the user's speakers
        tapDescription.isPrivate = true          // Hidden from system device list

        var tapObjectID: AudioObjectID = kAudioObjectUnknown
        let tapStatus = AudioHardwareCreateProcessTap(tapDescription, &tapObjectID)

        if tapStatus == -1 {
            logger.error("Process Tap creation denied — likely TCC permission issue")
            throw CaptureError.permissionDenied
        }

        guard tapStatus == noErr, tapObjectID != kAudioObjectUnknown else {
            logger.error("Process Tap creation failed: \(tapStatus)")
            throw CaptureError.tapCreationFailed(tapStatus)
        }

        tapID = tapObjectID
        logger.notice("Process Tap created: objectID=\(tapObjectID)")

        // Step 2b: Query the tap's UID string (needed for aggregate device config)
        let tapUID = queryTapUID(tapID: tapObjectID)
        guard let tapUID = tapUID else {
            logger.error("Failed to get tap UID string")
            AudioHardwareDestroyProcessTap(tapObjectID)
            tapID = kAudioObjectUnknown
            throw CaptureError.aggregateDeviceFailed
        }
        logger.notice("Process Tap UID: \(tapUID)")

        // Step 3: Create private aggregate device with the tap attached
        do {
            try createAggregateDevice(tapUID: tapUID)
        } catch {
            // Clean up tap on failure
            AudioHardwareDestroyProcessTap(tapObjectID)
            tapID = kAudioObjectUnknown
            throw error
        }

        // Step 4: Get stream format from the aggregate device
        do {
            try queryStreamFormat()
        } catch {
            destroyAggregateAndTap()
            throw error
        }

        // Step 5: Allocate buffers
        allocateBuffers()

        // Step 6: Create output WAV file
        do {
            try createOutputFile(at: outputFile)
        } catch {
            freeBuffers()
            destroyAggregateAndTap()
            throw error
        }

        // Step 7: Set up IOProc callback on the aggregate device
        do {
            try setupIOProc()
        } catch {
            closeOutputFile()
            freeBuffers()
            destroyAggregateAndTap()
            throw error
        }

        // Step 8: Start the IOProc
        guard let procID = ioProcID else {
            closeOutputFile()
            freeBuffers()
            destroyAggregateAndTap()
            throw CaptureError.aggregateDeviceFailed
        }

        let startStatus = AudioDeviceStart(aggregateDeviceID, procID)
        guard startStatus == noErr else {
            logger.error("Failed to start IOProc: \(startStatus)")
            AudioDeviceDestroyIOProcID(aggregateDeviceID, procID)
            ioProcID = nil
            closeOutputFile()
            freeBuffers()
            destroyAggregateAndTap()
            throw CaptureError.aggregateDeviceFailed
        }

        isRunning = true
        logger.notice("Process Tap capture started — tapping \(processObjectIDs.count) process(es)")
    }

    /// Stop capturing and tear down all resources.
    /// Teardown order is critical: IOProc -> aggregate device -> tap
    func stop() {
        guard isRunning || tapID != kAudioObjectUnknown else { return }

        logger.notice("Stopping Process Tap capture")

        // 1. Stop IOProc
        if let procID = ioProcID {
            AudioDeviceStop(aggregateDeviceID, procID)
            // 2. Destroy IOProc
            AudioDeviceDestroyIOProcID(aggregateDeviceID, procID)
            ioProcID = nil
        }

        // Close audio file
        closeOutputFile()

        // Free buffers
        freeBuffers()

        // 3 & 4. Destroy aggregate device, then tap
        destroyAggregateAndTap()

        isRunning = false
        onAudioChunk = nil

        meterLock.lock()
        _lastNonSilentTime = nil
        meterLock.unlock()

        logger.notice("Process Tap capture stopped")
    }

    var isCurrentlyRunning: Bool { isRunning }

    // MARK: - Tap UID

    /// Query the tap's persistent UID string via kAudioTapPropertyUID.
    /// The aggregate device's sub-tap list requires this UID, NOT the numeric AudioObjectID.
    private func queryTapUID(tapID: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var uidRef: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &uidRef)

        guard status == noErr, let uid = uidRef?.takeRetainedValue() else {
            logger.error("Failed to query tap UID: \(status)")
            return nil
        }

        return uid as String
    }

    // MARK: - Aggregate Device

    private func createAggregateDevice(tapUID: String) throws {
        guard let outputUID = getDefaultOutputDeviceUID() else {
            logger.error("Cannot get default output device UID for clock source")
            throw CaptureError.aggregateDeviceFailed
        }
        logger.notice("Using output device as clock source: \(outputUID)")

        let aggregateDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Reticle Process Tap",
            kAudioAggregateDeviceUIDKey: "ai.reticle.process-tap-\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [
                [kAudioSubDeviceUIDKey: outputUID]
            ],
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: tapUID,
                ]
            ],
        ]

        var aggDeviceID: AudioObjectID = kAudioObjectUnknown
        let status = AudioHardwareCreateAggregateDevice(aggregateDesc as CFDictionary, &aggDeviceID)

        guard status == noErr, aggDeviceID != kAudioObjectUnknown else {
            logger.error("Failed to create aggregate device: \(status)")
            throw CaptureError.aggregateDeviceFailed
        }

        aggregateDeviceID = aggDeviceID
        logger.notice("Aggregate device created: objectID=\(aggDeviceID)")
    }

    private func getDefaultOutputDeviceUID() -> String? {
        var deviceID = AudioDeviceID(0)
        var propertySize = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address, 0, nil, &propertySize, &deviceID
        )
        guard status == noErr, deviceID != 0 else { return nil }

        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: Unmanaged<CFString>?
        var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let uidStatus = AudioObjectGetPropertyData(
            deviceID, &uidAddress, 0, nil, &uidSize, &uid
        )
        guard uidStatus == noErr, let uidString = uid?.takeRetainedValue() else { return nil }
        return uidString as String
    }

    private func queryStreamFormat() throws {
        // Try aggregate device input format first
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )

        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var status = AudioObjectGetPropertyData(
            aggregateDeviceID,
            &address,
            0, nil,
            &formatSize,
            &streamFormat
        )

        // Fallback: query the tap's own format property
        if status != noErr {
            logger.warning("Aggregate device format query failed (\(status)), trying tap format")
            var tapAddress = AudioObjectPropertyAddress(
                mSelector: kAudioTapPropertyFormat,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            status = AudioObjectGetPropertyData(
                tapID,
                &tapAddress,
                0, nil,
                &formatSize,
                &streamFormat
            )
        }

        guard status == noErr else {
            logger.error("Failed to query stream format from aggregate or tap: \(status)")
            throw CaptureError.aggregateDeviceFailed
        }

        let sr = streamFormat.mSampleRate
        let ch = streamFormat.mChannelsPerFrame
        let bits = streamFormat.mBitsPerChannel
        logger.notice("Tap stream format: sampleRate=\(sr), channels=\(ch), bits=\(bits)")
    }

    // MARK: - IOProc

    private func setupIOProc() throws {
        var procID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcID(
            aggregateDeviceID,
            ioProc,
            Unmanaged.passUnretained(self).toOpaque(),
            &procID
        )

        guard status == noErr, let id = procID else {
            logger.error("Failed to create IOProc: \(status)")
            throw CaptureError.aggregateDeviceFailed
        }

        ioProcID = id
    }

    // MARK: - Audio Callback

    /// IOProc callback — runs on the audio thread.
    private let ioProc: AudioDeviceIOProc = { (
        device,
        now,
        inputData,
        inputTime,
        outputData,
        outputTime,
        clientData
    ) -> OSStatus in
        guard let clientData = clientData else { return noErr }
        let capture = Unmanaged<ProcessTapCapture>.fromOpaque(clientData).takeUnretainedValue()
        return capture.handleIOProc(inputData: inputData, inputTime: inputTime)
    }

    private func handleIOProc(
        inputData: UnsafePointer<AudioBufferList>?,
        inputTime: UnsafePointer<AudioTimeStamp>?
    ) -> OSStatus {
        guard isRunning, let inputData = inputData else { return noErr }

        let bufferList = inputData.pointee
        guard bufferList.mNumberBuffers > 0 else { return noErr }

        let buffer = bufferList.mBuffers
        guard let data = buffer.mData else { return noErr }

        let frameCount = buffer.mDataByteSize / (UInt32(MemoryLayout<Float32>.size) * buffer.mNumberChannels)
        guard frameCount > 0 else { return noErr }

        let samples = data.assumingMemoryBound(to: Float32.self)

        let inputChannels = buffer.mNumberChannels

        // Calculate audio metering for silence watchdog (same algorithm as CoreAudioRecorder)
        let totalSamples = Int(frameCount) * Int(inputChannels)
        if totalSamples > 0 {
            var sum: Float = 0.0
            for i in 0..<totalSamples {
                let sample = abs(samples[i])
                sum += sample * sample
            }
            let rms = sqrt(sum / Float(totalSamples))
            let avgDb = 20.0 * log10(max(rms, 0.000001))
            if avgDb > CoreAudioRecorder.silenceThresholdDb {
                meterLock.lock()
                _lastNonSilentTime = Date()
                meterLock.unlock()
            }
        }

        let inputSampleRate = streamFormat.mSampleRate
        let outputSampleRate = outputFormat.mSampleRate

        // Calculate output frame count
        let ratio = outputSampleRate / inputSampleRate
        let outputFrameCount = UInt32(Double(frameCount) * ratio)

        guard outputFrameCount > 0,
              let outputBuffer = conversionBuffer,
              outputFrameCount <= conversionBufferSize else { return noErr }

        // Convert Float32 multi-channel -> Int16 mono with sample rate conversion
        if inputSampleRate == outputSampleRate {
            for i in 0..<Int(frameCount) {
                var sample: Float32 = 0
                for ch in 0..<Int(inputChannels) {
                    sample += samples[i * Int(inputChannels) + ch]
                }
                sample /= Float32(inputChannels)
                let scaled = sample * 32767.0
                let clipped = max(-32768.0, min(32767.0, scaled))
                outputBuffer[i] = Int16(clipped)
            }
        } else {
            for i in 0..<Int(outputFrameCount) {
                let inputIndex = Double(i) / ratio
                let inputIndexInt = Int(inputIndex)
                let frac = Float32(inputIndex - Double(inputIndexInt))

                var sample: Float32 = 0
                let idx1 = min(inputIndexInt, Int(frameCount) - 1)
                let idx2 = min(inputIndexInt + 1, Int(frameCount) - 1)

                for ch in 0..<Int(inputChannels) {
                    let s1 = samples[idx1 * Int(inputChannels) + ch]
                    let s2 = samples[idx2 * Int(inputChannels) + ch]
                    sample += s1 + frac * (s2 - s1)
                }
                sample /= Float32(inputChannels)

                let scaled = sample * 32767.0
                let clipped = max(-32768.0, min(32767.0, scaled))
                outputBuffer[i] = Int16(clipped)
            }
        }

        // Write to WAV file
        let actualFrames = (inputSampleRate == outputSampleRate) ? frameCount : outputFrameCount
        writeToFile(buffer: outputBuffer, frameCount: actualFrames)

        // Send to streaming callback
        if let onAudioChunk = onAudioChunk {
            let byteCount = Int(actualFrames) * MemoryLayout<Int16>.size
            let chunkData = Data(bytes: outputBuffer, count: byteCount)
            onAudioChunk(chunkData)
        }

        return noErr
    }

    // MARK: - File Output

    private func createOutputFile(at url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }

        var format = outputFormat
        var fileRef: ExtAudioFileRef?
        let status = ExtAudioFileCreateWithURL(
            url as CFURL,
            kAudioFileWAVEType,
            &format,
            nil,
            AudioFileFlags.eraseFile.rawValue,
            &fileRef
        )

        guard status == noErr, let file = fileRef else {
            logger.error("Failed to create WAV file at \(url.path): \(status)")
            throw CaptureError.aggregateDeviceFailed
        }

        var clientFormat = outputFormat
        let setStatus = ExtAudioFileSetProperty(
            file,
            kExtAudioFileProperty_ClientDataFormat,
            UInt32(MemoryLayout<AudioStreamBasicDescription>.size),
            &clientFormat
        )

        guard setStatus == noErr else {
            ExtAudioFileDispose(file)
            logger.error("Failed to set client format on WAV file: \(setStatus)")
            throw CaptureError.aggregateDeviceFailed
        }

        audioFile = file
    }

    private func writeToFile(buffer: UnsafeMutablePointer<Int16>, frameCount: UInt32) {
        guard let file = audioFile else { return }

        var bufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
                mNumberChannels: 1,
                mDataByteSize: frameCount * 2,
                mData: buffer
            )
        )

        let status = ExtAudioFileWrite(file, frameCount, &bufferList)
        if status != noErr {
            logger.error("ExtAudioFileWrite failed: \(status)")
        }
    }

    private func closeOutputFile() {
        if let file = audioFile {
            ExtAudioFileDispose(file)
            audioFile = nil
        }
    }

    // MARK: - Buffer Management

    private func allocateBuffers() {
        let maxFrames: UInt32 = 4096
        let channels = max(streamFormat.mChannelsPerFrame, 1)

        let renderSamples = maxFrames * channels
        renderBuffer = UnsafeMutablePointer<Float32>.allocate(capacity: Int(renderSamples))
        renderBufferSize = renderSamples

        // Conversion buffer — account for sample rate difference
        let ratio = outputFormat.mSampleRate / max(streamFormat.mSampleRate, 1.0)
        let maxOutputFrames = UInt32(Double(maxFrames) * ratio) + 1
        conversionBuffer = UnsafeMutablePointer<Int16>.allocate(capacity: Int(maxOutputFrames))
        conversionBufferSize = maxOutputFrames
    }

    private func freeBuffers() {
        renderBuffer?.deallocate()
        renderBuffer = nil
        renderBufferSize = 0

        conversionBuffer?.deallocate()
        conversionBuffer = nil
        conversionBufferSize = 0
    }

    // MARK: - Teardown Helpers

    private func destroyAggregateAndTap() {
        // Order matters: aggregate device first, then tap
        if aggregateDeviceID != kAudioObjectUnknown {
            let status = AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            if status != noErr {
                logger.warning("Failed to destroy aggregate device: \(status)")
            }
            aggregateDeviceID = kAudioObjectUnknown
        }

        if tapID != kAudioObjectUnknown {
            if #available(macOS 14.2, *) {
                let status = AudioHardwareDestroyProcessTap(tapID)
                if status != noErr {
                    logger.warning("Failed to destroy process tap: \(status)")
                }
            }
            tapID = kAudioObjectUnknown
        }
    }
}
