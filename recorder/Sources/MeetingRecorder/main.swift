import Foundation
import os

let logger = Logger(subsystem: "ai.openclaw.meeting-recorder", category: "Main")

// MARK: - CLI Argument Parsing

let args = CommandLine.arguments
let config = RecorderConfig.load()

func printUsage() {
    let name = (args.first as NSString?)?.lastPathComponent ?? "meeting-recorder"
    print("""
    Usage: \(name) [options]

    Modes:
      (no args)              Start the HTTP daemon (default)
      --list-devices         List available audio input devices and exit
      --device <name>        Record from device matching <name> (substring match)
        --duration <secs>    Duration in seconds (required with --device)
        --output <path>      Output WAV path (default: /tmp/meeting-recorder-test.wav)

    Options:
      --port <port>          HTTP port (default: \(config.httpPort))
      --help                 Show this help
    """)
}

// --help
if args.contains("--help") || args.contains("-h") {
    printUsage()
    exit(0)
}

// --list-devices
if args.contains("--list-devices") {
    let manager = AudioDeviceManager()
    let devices = manager.availableDevices
    if devices.isEmpty {
        print("No audio input devices found.")
    } else {
        print("Available audio input devices:")
        print(String(repeating: "-", count: 70))
        for device in devices {
            let recorder = CoreAudioRecorder()
            let transport = recorder.getTransportType(deviceID: device.id)
            print("  [\(device.id)] \(device.name)")
            print("        UID: \(device.uid)")
            print("        Transport: \(transport)")
        }
        print(String(repeating: "-", count: 70))
        print("\(devices.count) device(s) found")
    }
    exit(0)
}

// --device <name> --duration <secs> [--output <path>]
if let deviceIdx = args.firstIndex(of: "--device") {
    guard deviceIdx + 1 < args.count else {
        print("Error: --device requires a device name argument")
        exit(1)
    }
    let deviceQuery = args[deviceIdx + 1]

    guard let durationIdx = args.firstIndex(of: "--duration"),
          durationIdx + 1 < args.count,
          let duration = Double(args[durationIdx + 1]),
          duration > 0 else {
        print("Error: --device requires --duration <seconds>")
        exit(1)
    }

    var outputPath = "/tmp/meeting-recorder-test.wav"
    if let outputIdx = args.firstIndex(of: "--output"), outputIdx + 1 < args.count {
        outputPath = args[outputIdx + 1]
    }

    // Find device
    let manager = AudioDeviceManager()
    guard let deviceID = manager.findDevice(byName: deviceQuery) else {
        let available = manager.availableDevices.map(\.name).joined(separator: ", ")
        print("Error: No device matching '\(deviceQuery)'. Available: \(available)")
        exit(1)
    }

    let deviceName = manager.getDeviceName(deviceID: deviceID) ?? "Unknown"
    print("Recording from '\(deviceName)' for \(Int(duration))s -> \(outputPath)")

    let recorder = CoreAudioRecorder()
    let outputURL = URL(fileURLWithPath: outputPath)

    do {
        try recorder.startRecording(toOutputFile: outputURL, deviceID: deviceID)
    } catch {
        print("Error starting recording: \(error)")
        exit(1)
    }

    // Record for the specified duration
    Thread.sleep(forTimeInterval: duration)
    recorder.stopRecording()

    // Verify output
    let fm = FileManager.default
    if fm.fileExists(atPath: outputPath),
       let attrs = try? fm.attributesOfItem(atPath: outputPath),
       let size = attrs[.size] as? UInt64 {
        let sizeMB = Double(size) / 1_048_576.0
        print("Done. Wrote \(String(format: "%.2f", sizeMB)) MB to \(outputPath)")
    } else {
        print("Warning: Output file may not have been written correctly")
    }
    exit(0)
}

// MARK: - Daemon Mode

logger.notice("Starting meeting-recorder daemon")

do {
    try config.ensureDirectories()
} catch {
    logger.error("Failed to create directories: \(error.localizedDescription)")
    exit(1)
}

// Parse optional port override
var port = config.httpPort
if let portIdx = args.firstIndex(of: "--port"), portIdx + 1 < args.count,
   let customPort = UInt16(args[portIdx + 1]) {
    port = customPort
}

let deviceManager = AudioDeviceManager()
let daemon = RecorderDaemon(config: config, deviceManager: deviceManager)

// Set up signal handlers for graceful shutdown
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let shutdown = {
    logger.notice("Shutting down...")
    daemon.stop()
    exit(0)
}

sigintSource.setEventHandler(handler: shutdown)
sigtermSource.setEventHandler(handler: shutdown)
sigintSource.resume()
sigtermSource.resume()

// Start the HTTP server and recording daemon
daemon.start(port: port)

logger.notice("meeting-recorder listening on port \(port)")

// Keep the process alive
dispatchMain()
