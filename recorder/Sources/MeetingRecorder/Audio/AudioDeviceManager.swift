import Foundation
import CoreAudio
import os

// Simplified from VoiceInk (GPL v3) — stripped ObservableObject/@Published/UserDefaults/priority mode
final class AudioDeviceManager {
    private let logger = Logger(subsystem: "ai.openclaw.meeting-recorder", category: "AudioDeviceManager")

    struct AudioDevice {
        let id: AudioDeviceID
        let uid: String
        let name: String
    }

    private(set) var availableDevices: [AudioDevice] = []

    /// Called when the device list changes (device plugged/unplugged)
    var onDeviceListChanged: (() -> Void)?

    init() {
        loadAvailableDevices()
        setupDeviceChangeNotifications()
    }

    deinit {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectRemovePropertyListener(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            deviceChangeCallback,
            Unmanaged.passUnretained(self).toOpaque()
        )
    }

    // MARK: - Device Discovery

    func loadAvailableDevices() {
        var propertySize: UInt32 = 0
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var result = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &propertySize
        )

        let deviceCount = Int(propertySize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)

        result = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &propertySize,
            &deviceIDs
        )

        if result != noErr {
            logger.error("Error getting audio devices: \(result)")
            return
        }

        availableDevices = deviceIDs.compactMap { deviceID -> AudioDevice? in
            guard let name = getDeviceName(deviceID: deviceID),
                  let uid = getDeviceUID(deviceID: deviceID),
                  isValidInputDevice(deviceID: deviceID) else {
                return nil
            }
            return AudioDevice(id: deviceID, uid: uid, name: name)
        }
    }

    // MARK: - Device Lookup

    /// Find a device by substring match on its name (case-insensitive).
    /// Useful for finding virtual meeting devices like "ZoomAudioDevice" or "BlackHole 2ch".
    func findDevice(byName query: String) -> AudioDeviceID? {
        let lowered = query.lowercased()
        return availableDevices.first(where: {
            $0.name.lowercased().contains(lowered)
        })?.id
    }

    /// Returns the current system default input device
    func getSystemDefaultDevice() -> AudioDeviceID? {
        var deviceID = AudioDeviceID(0)
        var propertySize = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &propertySize,
            &deviceID
        )

        guard status == noErr, deviceID != 0 else {
            logger.error("Failed to get system default device: \(status)")
            return nil
        }
        return deviceID
    }

    /// Find the best available device, preferring built-in microphone
    func findBestAvailableDevice() -> AudioDeviceID? {
        if let device = availableDevices.first(where: { isBuiltInDevice($0.id) }) {
            return device.id
        }
        if let device = availableDevices.first {
            logger.warning("No built-in device found, using: \(device.name)")
            return device.id
        }
        return nil
    }

    func getDeviceName(deviceID: AudioDeviceID) -> String? {
        getDeviceStringProperty(deviceID: deviceID, selector: kAudioDevicePropertyDeviceNameCFString)
    }

    func getDeviceUID(deviceID: AudioDeviceID) -> String? {
        getDeviceStringProperty(deviceID: deviceID, selector: kAudioDevicePropertyDeviceUID)
    }

    // MARK: - Device Change Notifications

    private func setupDeviceChangeNotifications() {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectAddPropertyListener(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            deviceChangeCallback,
            Unmanaged.passUnretained(self).toOpaque()
        )

        if status != noErr {
            logger.error("Failed to add device change listener: \(status)")
        }
    }

    fileprivate func handleDeviceListChange() {
        logger.notice("Device list change detected")
        loadAvailableDevices()
        onDeviceListChanged?()
    }

    // MARK: - Private Helpers

    private func isValidInputDevice(deviceID: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )

        var propertySize: UInt32 = 0
        var result = AudioObjectGetPropertyDataSize(
            deviceID,
            &address,
            0,
            nil,
            &propertySize
        )

        if result != noErr { return false }

        let bufferList = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(propertySize))
        defer { bufferList.deallocate() }

        result = AudioObjectGetPropertyData(
            deviceID,
            &address,
            0,
            nil,
            &propertySize,
            bufferList
        )

        if result != noErr { return false }
        return Int(bufferList.pointee.mNumberBuffers) > 0
    }

    private func isBuiltInDevice(_ deviceID: AudioDeviceID) -> Bool {
        guard let uid = getDeviceUID(deviceID: deviceID) else { return false }
        return uid.contains("BuiltIn")
    }

    private func getDeviceStringProperty(deviceID: AudioDeviceID,
                                         selector: AudioObjectPropertySelector) -> String? {
        guard deviceID != 0 else { return nil }

        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var propertySize = UInt32(MemoryLayout<Unmanaged<CFString>>.size)
        let ptr = UnsafeMutableRawPointer.allocate(
            byteCount: MemoryLayout<Unmanaged<CFString>>.size,
            alignment: MemoryLayout<Unmanaged<CFString>>.alignment
        )
        defer { ptr.deallocate() }

        let status = AudioObjectGetPropertyData(
            deviceID,
            &address,
            0,
            nil,
            &propertySize,
            ptr
        )

        guard status == noErr else { return nil }
        // CoreAudio returns an unretained CFStringRef for device properties
        let cfString = ptr.load(as: Unmanaged<CFString>.self).takeUnretainedValue()
        return cfString as String
    }
}

// MARK: - Device Change Callback (C function pointer)

private let deviceChangeCallback: AudioObjectPropertyListenerProc = { (_, _, _, userData) -> OSStatus in
    guard let userData = userData else { return noErr }
    let manager = Unmanaged<AudioDeviceManager>.fromOpaque(userData).takeUnretainedValue()
    // Dispatch off the CoreAudio thread
    DispatchQueue.global(qos: .utility).async {
        manager.handleDeviceListChange()
    }
    return noErr
}
