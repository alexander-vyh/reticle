import Foundation

/// Computes rolling heuristic metrics from tagged transcript segments.
struct MetricsEngine {

    struct TaggedSegment {
        let id: Int
        let text: String
        let start: Double
        let end: Double
        let speaker: Speaker

        enum Speaker: String, Codable {
            case selfSpeaker = "self"
            case others = "others"
        }

        var wordCount: Int {
            text.split(separator: " ").count
        }

        var duration: Double {
            max(end - start, 0)
        }
    }

    struct Snapshot: Codable {
        let selfWpm: Int
        let silenceRatio: Double
        let selfTalkTimeSec: Double
        let othersTalkTimeSec: Double
        let talkRatio: Double
        let longestMonologueSec: Double
        let longestSilenceSec: Double
        let segmentCount: Int
        let avgSegmentLenWords: Double
        let elapsedSec: Double
    }

    private var segments: [TaggedSegment] = []
    private let recordingStartTime: Date

    init(recordingStartTime: Date = Date()) {
        self.recordingStartTime = recordingStartTime
    }

    // MARK: - Mutating

    mutating func addSegment(_ segment: TaggedSegment) {
        segments.append(segment)
    }

    // MARK: - Computed Metrics

    func snapshot() -> Snapshot {
        let elapsed = Date().timeIntervalSince(recordingStartTime)
        guard !segments.isEmpty else {
            return Snapshot(
                selfWpm: 0, silenceRatio: 1.0,
                selfTalkTimeSec: 0, othersTalkTimeSec: 0, talkRatio: 0,
                longestMonologueSec: 0, longestSilenceSec: 0,
                segmentCount: 0, avgSegmentLenWords: 0, elapsedSec: elapsed
            )
        }

        let selfSegs = segments.filter { $0.speaker == .selfSpeaker }
        let othersSegs = segments.filter { $0.speaker == .others }

        let selfTalkTime = selfSegs.reduce(0.0) { $0 + $1.duration }
        let othersTalkTime = othersSegs.reduce(0.0) { $0 + $1.duration }
        let totalTalkTime = selfTalkTime + othersTalkTime

        // Self WPM: words in self-tagged segments from last 60s of speech
        let selfWpm = computeWpm(segments: selfSegs, windowSeconds: 60.0)

        // Silence ratio: time not covered by any segment / elapsed
        let silenceRatio = elapsed > 0 ? max(0, 1.0 - (totalTalkTime / elapsed)) : 0

        // Talk ratio: self / total
        let talkRatio = totalTalkTime > 0 ? selfTalkTime / totalTalkTime : 0

        // Longest self monologue: consecutive self segments with < 1.5s gaps
        let longestMonologue = computeLongestMonologue(segments: selfSegs)

        // Longest silence: largest gap between any consecutive segments
        let longestSilence = computeLongestSilence()

        // Avg segment length
        let totalWords = segments.reduce(0) { $0 + $1.wordCount }
        let avgLen = Double(totalWords) / Double(segments.count)

        return Snapshot(
            selfWpm: selfWpm,
            silenceRatio: round(silenceRatio * 1000) / 1000,
            selfTalkTimeSec: round(selfTalkTime * 10) / 10,
            othersTalkTimeSec: round(othersTalkTime * 10) / 10,
            talkRatio: round(talkRatio * 100) / 100,
            longestMonologueSec: round(longestMonologue * 10) / 10,
            longestSilenceSec: round(longestSilence * 10) / 10,
            segmentCount: segments.count,
            avgSegmentLenWords: round(avgLen * 10) / 10,
            elapsedSec: round(elapsed * 10) / 10
        )
    }

    // MARK: - Private Helpers

    private func computeWpm(segments: [TaggedSegment], windowSeconds: Double) -> Int {
        guard !segments.isEmpty else { return 0 }

        let now = Date().timeIntervalSince(recordingStartTime)
        let windowStart = now - windowSeconds

        // Get segments within the rolling window
        let windowed = segments.filter { $0.end >= windowStart }
        guard !windowed.isEmpty else { return 0 }

        let totalWords = windowed.reduce(0) { $0 + $1.wordCount }
        let spokenTime = windowed.reduce(0.0) { $0 + $1.duration }

        // WPM = words / spoken minutes (not elapsed minutes)
        let spokenMinutes = spokenTime / 60.0
        guard spokenMinutes > 0.05 else { return 0 } // need at least 3s of speech

        return Int(round(Double(totalWords) / spokenMinutes))
    }

    private func computeLongestMonologue(segments: [TaggedSegment]) -> Double {
        guard !segments.isEmpty else { return 0 }

        let sorted = segments.sorted { $0.start < $1.start }
        var longest = sorted[0].duration
        var current = sorted[0].duration

        for i in 1..<sorted.count {
            let gap = sorted[i].start - sorted[i - 1].end
            if gap < 1.5 {
                current += gap + sorted[i].duration
            } else {
                current = sorted[i].duration
            }
            longest = max(longest, current)
        }

        return longest
    }

    private func computeLongestSilence() -> Double {
        guard segments.count >= 2 else { return 0 }

        let sorted = segments.sorted { $0.start < $1.start }
        var longest = 0.0

        for i in 1..<sorted.count {
            let gap = sorted[i].start - sorted[i - 1].end
            if gap > longest {
                longest = gap
            }
        }

        return longest
    }
}
