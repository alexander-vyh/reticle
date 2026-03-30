import Foundation
import CoreAudio
import AudioToolbox
import os

/// Monitors the local microphone for voice activity (RMS energy).
/// Used to determine when "self" is speaking for self/others segment tagging.
final class MicMonitor {
    private let logger = Logger(subsystem: "ai.reticle.meeting-recorder", category: "MicMonitor")

    private var audioUnit: AudioUnit?
    private var isRunning = false
    private var deviceFormat = AudioStreamBasicDescription()

    // Pre-allocated render buffer
    private var renderBuffer: UnsafeMutablePointer<Float32>?
    private var renderBufferSize: UInt32 = 0

    // Conversion buffer (Float32 -> Int16 16kHz mono)
    private var conversionBuffer: UnsafeMutablePointer<Int16>?
    private var conversionBufferSize: UInt32 = 0

    // Output format: 16kHz mono Int16 (matches ProcessTapCapture)
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

    /// Called on the audio thread with raw PCM data (16-bit, 16kHz, mono) for streaming.
    /// Same interface as ProcessTapCapture.onAudioChunk and CoreAudioRecorder.onAudioChunk.
    var onAudioChunk: ((_ data: Data) -> Void)?

    // Thread-safe VAD state
    private let lock = NSLock()
    private var _rmsEnergy: Float = 0.0
    private var _isSpeaking = false
    private var vadThreshold: Float

    // VAD history: array of (timestamp, isSpeaking) for segment attribution
    private var _vadHistory: [(time: TimeInterval, speaking: Bool)] = []
    private let historyLock = NSLock()
    private var startTime: Date?

    var rmsEnergy: Float {
        lock.lock()
        defer { lock.unlock() }
        return _rmsEnergy
    }

    var isSpeaking: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isSpeaking
    }

    init(vadThreshold: Float = 0.01) {
        self.vadThreshold = vadThreshold
    }

    deinit {
        stop()
    }

    // MARK: - Public Interface

    func start(deviceID: AudioDeviceID) throws {
        stop()
        startTime = Date()

        // Create AUHAL
        var desc = AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0
        )

        guard let component = AudioComponentFindNext(nil, &desc) else {
            throw MicMonitorError.audioUnitNotFound
        }

        var unit: AudioUnit?
        var status = AudioComponentInstanceNew(component, &unit)
        guard status == noErr, let audioUnit = unit else {
            throw MicMonitorError.setupFailed(status: status)
        }
        self.audioUnit = audioUnit

        // Enable input, disable output
        var enableInput: UInt32 = 1
        status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_EnableIO,
                                      kAudioUnitScope_Input, 1, &enableInput,
                                      UInt32(MemoryLayout<UInt32>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        var disableOutput: UInt32 = 0
        status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_EnableIO,
                                      kAudioUnitScope_Output, 0, &disableOutput,
                                      UInt32(MemoryLayout<UInt32>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Set device
        var device = deviceID
        status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_CurrentDevice,
                                      kAudioUnitScope_Global, 0, &device,
                                      UInt32(MemoryLayout<AudioDeviceID>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Get device format
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = AudioUnitGetProperty(audioUnit, kAudioUnitProperty_StreamFormat,
                                      kAudioUnitScope_Input, 1, &deviceFormat, &formatSize)
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Set callback format (Float32)
        var callbackFormat = AudioStreamBasicDescription(
            mSampleRate: deviceFormat.mSampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(MemoryLayout<Float32>.size) * deviceFormat.mChannelsPerFrame,
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(MemoryLayout<Float32>.size) * deviceFormat.mChannelsPerFrame,
            mChannelsPerFrame: deviceFormat.mChannelsPerFrame,
            mBitsPerChannel: 32,
            mReserved: 0
        )

        status = AudioUnitSetProperty(audioUnit, kAudioUnitProperty_StreamFormat,
                                      kAudioUnitScope_Output, 1, &callbackFormat,
                                      UInt32(MemoryLayout<AudioStreamBasicDescription>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Allocate render buffer
        let maxFrames: UInt32 = 4096
        let bufferSamples = maxFrames * deviceFormat.mChannelsPerFrame
        renderBuffer = UnsafeMutablePointer<Float32>.allocate(capacity: Int(bufferSamples))
        renderBufferSize = bufferSamples

        // Allocate conversion buffer (account for sample rate difference)
        let ratio = outputFormat.mSampleRate / max(deviceFormat.mSampleRate, 1.0)
        let maxOutputFrames = UInt32(Double(maxFrames) * ratio) + 1
        conversionBuffer = UnsafeMutablePointer<Int16>.allocate(capacity: Int(maxOutputFrames))
        conversionBufferSize = maxOutputFrames

        // Set callback
        var callbackStruct = AURenderCallbackStruct(
            inputProc: micInputCallback,
            inputProcRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_SetInputCallback,
                                      kAudioUnitScope_Global, 0, &callbackStruct,
                                      UInt32(MemoryLayout<AURenderCallbackStruct>.size))
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        // Start
        status = AudioUnitInitialize(audioUnit)
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        status = AudioOutputUnitStart(audioUnit)
        guard status == noErr else { throw MicMonitorError.setupFailed(status: status) }

        isRunning = true
        logger.notice("MicMonitor started on device \(deviceID)")
    }

    func stop() {
        guard let unit = audioUnit else { return }
        // Signal callback to bail early before stopping the unit
        isRunning = false
        // AudioOutputUnitStop waits for any in-flight callback to complete
        AudioOutputUnitStop(unit)
        AudioComponentInstanceDispose(unit)
        audioUnit = nil
        // Safe to deallocate now — no callback can be running
        renderBuffer?.deallocate()
        renderBuffer = nil
        renderBufferSize = 0

        conversionBuffer?.deallocate()
        conversionBuffer = nil
        conversionBufferSize = 0
    }

    /// Check if self was speaking during a time window (relative to recording start).
    /// Returns the fraction of VAD samples in the window that were "speaking".
    func selfSpeakingRatio(from startSec: Double, to endSec: Double) -> Double {
        historyLock.lock()
        defer { historyLock.unlock() }

        let relevant = _vadHistory.filter { $0.time >= startSec && $0.time <= endSec }
        guard !relevant.isEmpty else { return 0.0 }

        let speakingCount = relevant.filter(\.speaking).count
        return Double(speakingCount) / Double(relevant.count)
    }

    /// Clear VAD history (call on recording stop)
    func clearHistory() {
        historyLock.lock()
        _vadHistory.removeAll()
        startTime = nil
        historyLock.unlock()
    }

    // MARK: - Audio Callback

    fileprivate func handleMicInput(
        ioActionFlags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
        inTimeStamp: UnsafePointer<AudioTimeStamp>,
        inBusNumber: UInt32,
        inNumberFrames: UInt32
    ) -> OSStatus {
        guard let audioUnit = audioUnit, isRunning, let renderBuf = renderBuffer else {
            return noErr
        }

        let channelCount = deviceFormat.mChannelsPerFrame
        let requiredSamples = inNumberFrames * channelCount
        guard requiredSamples <= renderBufferSize else { return noErr }

        let bytesPerFrame = UInt32(MemoryLayout<Float32>.size) * channelCount
        let bufferSize = inNumberFrames * bytesPerFrame

        var bufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
                mNumberChannels: channelCount,
                mDataByteSize: bufferSize,
                mData: renderBuf
            )
        )

        let status = AudioUnitRender(audioUnit, ioActionFlags, inTimeStamp,
                                     inBusNumber, inNumberFrames, &bufferList)
        if status != noErr { return status }

        // Compute RMS
        guard let data = bufferList.mBuffers.mData else { return noErr }
        let samples = data.assumingMemoryBound(to: Float32.self)
        let totalSamples = Int(inNumberFrames) * Int(channelCount)
        guard totalSamples > 0 else { return noErr }

        var sum: Float = 0.0
        for i in 0..<totalSamples {
            let s = samples[i]
            sum += s * s
        }
        let rms = sqrt(sum / Float(totalSamples))
        let speaking = rms >= vadThreshold

        lock.lock()
        _rmsEnergy = rms
        _isSpeaking = speaking
        lock.unlock()

        // Record VAD event
        if let start = startTime {
            let elapsed = Date().timeIntervalSince(start)
            historyLock.lock()
            _vadHistory.append((time: elapsed, speaking: speaking))
            // Trim history older than 10 minutes to bound memory
            if _vadHistory.count > 60_000 {
                _vadHistory.removeFirst(_vadHistory.count - 60_000)
            }
            historyLock.unlock()
        }

        // Convert Float32 -> Int16 16kHz mono and send to callback
        if let onAudioChunk = onAudioChunk, let outputBuffer = conversionBuffer {
            let inputSampleRate = deviceFormat.mSampleRate
            let outputSampleRate = outputFormat.mSampleRate
            let inputChannels = Int(channelCount)

            let ratio = outputSampleRate / inputSampleRate
            let outputFrameCount = UInt32(Double(inNumberFrames) * ratio)

            guard outputFrameCount > 0, outputFrameCount <= conversionBufferSize else {
                return noErr
            }

            if inputSampleRate == outputSampleRate {
                // No resampling needed — just mix to mono and convert
                for i in 0..<Int(inNumberFrames) {
                    var sample: Float32 = 0
                    for ch in 0..<inputChannels {
                        sample += samples[i * inputChannels + ch]
                    }
                    sample /= Float32(inputChannels)
                    let scaled = sample * 32767.0
                    let clipped = max(-32768.0, min(32767.0, scaled))
                    outputBuffer[i] = Int16(clipped)
                }
            } else {
                // Downsample with linear interpolation (e.g. 48kHz -> 16kHz)
                for i in 0..<Int(outputFrameCount) {
                    let inputIndex = Double(i) / ratio
                    let inputIndexInt = Int(inputIndex)
                    let frac = Float32(inputIndex - Double(inputIndexInt))

                    let idx1 = min(inputIndexInt, Int(inNumberFrames) - 1)
                    let idx2 = min(inputIndexInt + 1, Int(inNumberFrames) - 1)

                    var sample: Float32 = 0
                    for ch in 0..<inputChannels {
                        let s1 = samples[idx1 * inputChannels + ch]
                        let s2 = samples[idx2 * inputChannels + ch]
                        sample += s1 + frac * (s2 - s1)
                    }
                    sample /= Float32(inputChannels)

                    let scaled = sample * 32767.0
                    let clipped = max(-32768.0, min(32767.0, scaled))
                    outputBuffer[i] = Int16(clipped)
                }
            }

            let actualFrames = (inputSampleRate == outputSampleRate) ? inNumberFrames : outputFrameCount
            let byteCount = Int(actualFrames) * MemoryLayout<Int16>.size
            let chunkData = Data(bytes: outputBuffer, count: byteCount)
            onAudioChunk(chunkData)
        }

        return noErr
    }
}

// MARK: - Callback

private let micInputCallback: AURenderCallback = { (
    inRefCon, ioActionFlags, inTimeStamp, inBusNumber, inNumberFrames, _
) -> OSStatus in
    let monitor = Unmanaged<MicMonitor>.fromOpaque(inRefCon).takeUnretainedValue()
    return monitor.handleMicInput(
        ioActionFlags: ioActionFlags,
        inTimeStamp: inTimeStamp,
        inBusNumber: inBusNumber,
        inNumberFrames: inNumberFrames
    )
}

// MARK: - Errors

enum MicMonitorError: LocalizedError {
    case audioUnitNotFound
    case setupFailed(status: OSStatus)

    var errorDescription: String? {
        switch self {
        case .audioUnitNotFound: return "HAL Output AudioUnit not found"
        case .setupFailed(let status): return "MicMonitor setup failed: \(status)"
        }
    }
}
