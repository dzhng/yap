@preconcurrency import AVFoundation
import Foundation

/// Decodes ordered intervals with one bounded sample buffer. Conversion remains interval-local:
/// excluded samples can be decoded while skipping forward, but never enter a resampling filter.
package final class AudioSourceReader {
    private let input: MediaInput
    private let asset: AVAsset
    private let track: AVAssetTrack
    private let sampleRate: Int
    private let packetFrames: Int
    private let channels: Int
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var pending: CMSampleBuffer?
    private let format: AVAudioFormat
    private var origin: ExactTime?
    private var position: Int64 = 0
    private var end: Int64 = 0
    private var openedEnd: Int64 = 0
    private var intervalStart: Int64 = 0
    private var packetStart: Int64 = 0
    private var nextPacketStart: Int64 = 0
    private var expectedStamp = CMTime.zero
    private var reopened = false
    package private(set) var decodedFrames: Int64 = 0
    package var failed: Bool { reader?.status == .failed }
    package var reachedSelectionEnd: Bool { position >= end }

    package init(input: MediaInput, asset: AVAsset, track: AVAssetTrack, sampleRate: Int, packetFrames: Int, channels: Int) {
        self.input = input
        self.asset = asset
        self.track = track
        self.sampleRate = sampleRate
        self.packetFrames = packetFrames
        self.channels = channels
        self.format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate),
            channels: AVAudioChannelCount(channels), interleaved: true)!
    }

    deinit { reader?.cancelReading() }

    package func begin(origin: ExactTime, at start: Int64, end: Int64) throws {
        // Nearby selections in the same physical run can share a decoded packet. A mask does
        // not establish a new sample origin; seek again when the run or bounded scan changes.
        if end > start && (reader == nil || self.origin?.equals(origin) != true || start < packetStart
            || Int128(start) - Int128(position) > Int128(sampleRate)) {
            self.origin = origin
            try open(at: start, through: end)
        }
        self.position = start
        self.end = end
        intervalStart = start
        reopened = false
    }

    package static func seekTime(origin: ExactTime, frame: Int64, sampleRate: Int) throws -> CMTime {
        let cell = try origin.subtract(ExactTime(-Int128(frame) * 1_000_000, Int128(sampleRate)))
        let boundary = try cell.sample(1_000_000, ceil: true)
        let inside = boundary.addingReportingOverflow(1)
        guard !inside.overflow else { throw NativeFailure.decodeFailed("Audio seek exceeds native bounds.") }
        // At <=192kHz each native sample cell exceeds 5us. This integer-us point is >0 and
        // <=2us after its exact start, strictly inside without an unrepresentable CMTime LCM.
        return CMTime(value: inside.partialValue, timescale: 1_000_000)
    }

    private func open(at start: Int64, through demandEnd: Int64) throws {
        reader?.cancelReading()
        pending = nil
        let opened: AVAssetReader
        do { opened = try AVAssetReader(asset: asset) } catch {
            if let detail = input.failure { throw detail }
            throw NativeFailure.decodeFailed(
                "Cannot read \(input.url.path): \(error.localizedDescription)")
        }
        // Seeking inside the last compressed packet can refuse or omit its PCM. Two packet
        // widths include the preceding packet even when start lies inside a packet. next()
        // discards this bounded context before any selected samples reach the converter.
        let first = max(0, start - Int64(packetFrames) * 2)
        let seek = try Self.seekTime(origin: origin!, frame: first, sampleRate: sampleRate)
        let limit = try Self.seekTime(origin: origin!, frame: demandEnd, sampleRate: sampleRate)
        let duration = limit.value.subtractingReportingOverflow(seek.value)
        guard !duration.overflow, duration.partialValue > 0 else {
            throw NativeFailure.decodeFailed("Audio demand exceeds finite reader range capacity.")
        }
        opened.timeRange = CMTimeRange(start: seek,
            duration: CMTime(value: duration.partialValue, timescale: seek.timescale))
        packetStart = first
        nextPacketStart = first
        expectedStamp = CMTime(value: try ExactTime(seek).sample(sampleRate),
            timescale: CMTimeScale(sampleRate))
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: channels, AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ])
        output.alwaysCopiesSampleData = false
        guard opened.canAdd(output) else {
            throw NativeFailure.decodeFailed("Cannot decode audio track.")
        }
        opened.add(output)
        guard opened.startReading() else {
            if let detail = input.failure { throw detail }
            throw NativeFailure.decodeFailed("Cannot start audio reader.")
        }
        openedEnd = demandEnd
        self.reader = opened
        self.output = output
    }

    package func next() throws -> AVAudioPCMBuffer? {
        guard position < end else { return nil }
        while true {
            try Task.checkCancellation()
            if pending == nil {
                pending = output?.copyNextSampleBuffer()
                if let pending {
                    let frames = CMSampleBufferGetNumSamples(pending)
                    let stamp = CMSampleBufferGetPresentationTimeStamp(pending)
                    guard stamp.isNumeric, frames > 0, frames <= 65_536,
                        CMTimeConvertScale(CMTimeSubtract(stamp, expectedStamp),
                            timescale: CMTimeScale(sampleRate), method: .roundHalfAwayFromZero).value == 0
                    else { throw NativeFailure.decodeFailed("Decoded audio has discontinuous sample packets.") }
                    packetStart = nextPacketStart
                    nextPacketStart += Int64(frames)
                    expectedStamp = CMTimeAdd(stamp, CMTime(value: Int64(frames), timescale: CMTimeScale(sampleRate)))
                    decodedFrames += Int64(frames)
                }
            }
            guard let sample = pending else {
                if let detail = input.failure { throw detail }
                if failed { throw NativeFailure.decodeFailed("Audio reader failed.") }
                // A later selection can reuse pending PCM, then extend only after exhausting
                // the prior finite demand. This is not the codec's premature-tail retry.
                if reader?.status == .completed, openedEnd < end, position >= openedEnd {
                    try open(at: position, through: end)
                    continue
                }
                // A completed AAC reader can stop before its declared end while a seek still
                // returns the real tail. Retry only once, at the exact next sample, never padding.
                if reader?.status == .completed, !reopened, position > intervalStart, position < end {
                    reopened = true
                    try open(at: position, through: end)
                    continue
                }
                return nil
            }
            let frames = CMSampleBufferGetNumSamples(sample)
            let first = Int(max(0, position - packetStart))
            let last = Int(min(Int64(frames), end - packetStart))
            if first >= frames {
                pending = nil
                continue
            }
            if last <= first { return nil }
            var list = AudioBufferList()
            var block: CMBlockBuffer?
            guard frames > 0, frames <= 65_536,
                CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                    sample, bufferListSizeNeededOut: nil, bufferListOut: &list,
                    bufferListSize: MemoryLayout<AudioBufferList>.size, blockBufferAllocator: nil,
                    blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &block) == noErr,
                let decoded = list.mBuffers.mData?.assumingMemoryBound(to: Float.self),
                let buffer = AVAudioPCMBuffer(
                    pcmFormat: format, frameCapacity: AVAudioFrameCount(last - first))
            else { throw NativeFailure.decodeFailed("Cannot read decoded audio buffer.") }
            buffer.frameLength = AVAudioFrameCount(last - first)
            buffer.floatChannelData![0].update(
                from: decoded + first * channels,
                count: (last - first) * channels)
            position = packetStart + Int64(last)
            // Keep this packet until the next request: cumulative output rounding can make
            // successive intervals legitimately share a boundary source sample.
            return buffer
        }
    }
}
