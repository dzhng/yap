@preconcurrency import AVFoundation
import Foundation
import YapMedia

/// One source stream, opened once. Caller-supplied source-clock support is intersected with
/// occupied container segments; the offset maps between those two clocks.
struct SourceTrack {
    let sourceOffsetUs: ExactTime
    let url: URL
    let input: MediaInput
    let asset: AVURLAsset
    let track: AVAssetTrack
    let sampleRate: Int
    let packetFrames: Int
    let channels: Int
    struct Run {
        let support: ExactRange
        let nativeOrigin: ExactTime
    }
    let available: [Run]

    func frame(at time: ExactTime, in run: Run, ceil: Bool = false) throws -> Int64 {
        try time.subtract(sourceOffsetUs).subtract(run.nativeOrigin)
            .sample(sampleRate, ceil: ceil, nearest: !ceil)
    }

    static func open(selection: AudioSourceSelection, strictWindowFormat: Bool = false,
                     purpose: MediaInput.ReadPurpose = .inspection) async throws -> SourceTrack {
        let path = selection.source
        let streamId = selection.streamId
        let sourceOffsetUs = selection.sourceOffsetUs
        let source = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: source.path) else {
            throw NativeFailure.decodeFailed("No source media at \(source.path).")
        }
        let input = try MediaInput(url: source, purpose: purpose)
        let asset = input.asset
        let audio: AVAssetTrack
        let stream: AudioStreamBasicDescription
        let sampleRate: Int
        let segments: [SourceSegment]
        do {
            let tracks = try await asset.loadTracks(withMediaType: .audio)
            guard streamId != nil || tracks.count == 1 else {
                throw NativeFailure("INVALID_REQUEST", "An omitted stream ID requires exactly one audio stream.")
            }
            guard
                let track = tracks.first(where: {
                    streamId == nil || streamId == "track:\($0.trackID)"
                })
            else {
                throw NativeFailure.decodeFailed(
                    "Source has no matching audio track: \(source.path).")
            }
            let descriptions = try await track.load(.formatDescriptions)
            if strictWindowFormat { try Self.validateWindowFormats(descriptions) }
            // The native reader's fractional-to-integer conversion is not phase-stable when seeking.
            // Validate every description before any rate is converted to an integer.
            let rates = try descriptions.map { description in
                guard let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else {
                    throw NativeFailure.decodeFailed("Source audio format is unreadable: \(source.path).")
                }
                return try Self.nativeSampleRate(basic.mSampleRate)
            }
            guard let description = descriptions.first, let rate = rates.first,
                let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee
            else {
                throw NativeFailure.decodeFailed(
                    "Source audio format is unreadable: \(source.path).")
            }
            audio = track
            stream = basic
            sampleRate = rate
            segments = SourceSegment.occupied(of: try await track.load(.segments))
            try input.requireSelfContainedStorage(of: track)
        } catch let failure as NativeFailure {
            if let detail = input.failure { throw detail }
            throw failure
        } catch {
            if let detail = input.failure { throw detail }
            throw NativeFailure.decodeFailed(
                "Cannot open \(source.path): \(error.localizedDescription)")
        }
        let channels = Int(stream.mChannelsPerFrame)
        guard (1...32_768).contains(stream.mFramesPerPacket) else {
            throw NativeFailure("UNSUPPORTED_FORMAT", "Audio decoding requires a fixed packet size of at most 32768 native frames.")
        }
        guard (1...AudioLimits.maximumChannels).contains(channels)
        else {
            throw NativeFailure(
                "LIMIT_EXCEEDED",
                "Source \(source.lastPathComponent) reports \(sampleRate) Hz and \(channels) channels, outside the excerpt bounds."
            )
        }
        // Empty edits hold no sample. AVFoundation would read them back as silence, which is
        // indistinguishable from recorded quiet, so absence is decided from the container's own
        // occupied segments rather than from the samples it is willing to produce.
        let occupied = try segments.map { segment in
            let origin = try ExactTime(segment.asset.start)
            return Run(support: ExactRange(
                startUs: try origin.adding(sourceOffsetUs),
                endUs: try ExactTime(CMTimeRangeGetEnd(segment.asset)).adding(sourceOffsetUs)), nativeOrigin: origin)
        }
        // Adjacent declarations describe continuous capture, so they must not restart decoding.
        // Even a one-microsecond hole remains a real exclusion; physical segment edges stay intact.
        var continuous: [ExactRange] = []
        for interval in selection.available {
            if let previous = continuous.last, previous.endUs == interval.startUs {
                continuous[continuous.count - 1] = ExactRange(
                    startUs: previous.startUs, endUs: interval.endUs)
            } else {
                continuous.append(interval)
            }
        }
        var available: [Run] = []
        var a = 0, b = 0
        while a < continuous.count && b < occupied.count {
            let mask = continuous[a], run = occupied[b]
            if let support = try mask.intersection(run.support) {
                available.append(Run(support: support, nativeOrigin: run.nativeOrigin))
            }
            if try mask.endUs.subtract(run.support.endUs).numerator < 0 { a += 1 }
            else { b += 1 }
        }
        try input.beginStreaming()
        return SourceTrack(
            sourceOffsetUs: sourceOffsetUs, url: input.url, input: input, asset: asset,
            track: audio, sampleRate: sampleRate, packetFrames: Int(stream.mFramesPerPacket), channels: channels,
            // Physical occupancy is not acquisition evidence. Recording callers supply acquired
            // intervals here; composition execution additionally intersects its retained domains.
            available: available)
    }

    private static func nativeSampleRate(_ rate: Double) throws -> Int {
        guard rate.isFinite, rate.rounded() == rate else {
            throw NativeFailure("UNSUPPORTED_FORMAT", "Audio execution requires an integral native sample rate.")
        }
        guard (1...Double(AudioLimits.maximumSampleRate)).contains(rate) else {
            throw NativeFailure("LIMIT_EXCEEDED", "Native audio sample rate is outside the supported bounds.")
        }
        return Int(rate)
    }

    static func validateWindowFormats(_ descriptions: [CMAudioFormatDescription]) throws {
        var signature: [Double]?
        for description in descriptions {
            guard let value = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
                (try? nativeSampleRate(value.mSampleRate)) != nil,
                value.mChannelsPerFrame == 1 || value.mChannelsPerFrame == 2
            else { throw NativeFailure("UNSUPPORTED_FORMAT", "Source windows require an integral native rate and mono or stereo audio.") }
            let current = [value.mSampleRate, Double(value.mChannelsPerFrame)]
            guard signature == nil || signature == current else {
                throw NativeFailure("UNSUPPORTED_FORMAT", "Source format changes within the stream.")
            }
            signature = current
            guard let layout = CMAudioFormatDescriptionGetChannelLayout(description, sizeOut: nil) else { continue }
            let tag = layout.pointee.mChannelLayoutTag
            let channels = value.mChannelsPerFrame
            var conventional = tag == (channels == 1 ? kAudioChannelLayoutTag_Mono : kAudioChannelLayoutTag_Stereo)
            if tag == kAudioChannelLayoutTag_UseChannelBitmap {
                conventional = layout.pointee.mChannelBitmap == (channels == 1 ? AudioChannelBitmap.bit_Center : AudioChannelBitmap.bit_Left.union(.bit_Right))
            } else if tag == kAudioChannelLayoutTag_UseChannelDescriptions, layout.pointee.mNumberChannelDescriptions == channels {
                let pointer = UnsafeRawPointer(layout).advanced(by: MemoryLayout<AudioChannelLayout>.offset(of: \.mChannelDescriptions)!).assumingMemoryBound(to: AudioChannelDescription.self)
                conventional = channels == 1
                    ? [kAudioChannelLabel_Mono, kAudioChannelLabel_Center].contains(pointer[0].mChannelLabel)
                    : pointer[0].mChannelLabel == kAudioChannelLabel_Left && pointer[1].mChannelLabel == kAudioChannelLabel_Right
            }
            guard conventional else { throw NativeFailure("UNSUPPORTED_FORMAT", "Source channel layout is not conventional mono or stereo.") }
        }
    }

}

final class ConvertedAudioInterval {
    enum InputSupport {
        case outputDuration(limit: Int64?)
        case finite(end: Int64)
    }
    private let sourceInput: MediaInput
    private let converter: AVAudioConverter
    private let input: ConversionInput
    private let converted: AVAudioPCMBuffer
    private let channels: Int
    private var offset = 0
    private var exhausted = false
    private var paddingFrames: Int

    /// Validates exact source demand and the platform format without decoding PCM.
    static func configuration(source: SourceTrack, start: Int64, outputRate: Int,
        owed: Int64, support: InputSupport, playbackRate: ExactTime
    ) throws -> (converter: AVAudioConverter, format: AVAudioFormat, end: Int64, padding: Int) {
        func product(_ a: Int128, _ b: Int128) throws -> Int128 {
            let result = a.multipliedReportingOverflow(by: b)
            guard !result.overflow else { throw NativeFailure.decodeFailed("Audio rate exceeds exact arithmetic capacity.") }
            return result.partialValue
        }
        guard outputRate > 0, playbackRate.numerator > 0, playbackRate.denominator > 0 else {
            throw NativeFailure.decodeFailed("Audio playback rate must be positive.")
        }
        // Only the platform format uses floating point. Source demand and allowed final
        // quantization padding use the same exact rational rate as the project mapping.
        let outputNumerator = try product(Int128(outputRate), playbackRate.denominator)
        let inputNumerator = try product(Int128(source.sampleRate), playbackRate.numerator)
        let effectiveRate = Double(outputNumerator) / Double(playbackRate.numerator)
        guard effectiveRate.isFinite, effectiveRate > 0 else {
            throw NativeFailure.decodeFailed("Audio playback rate cannot be represented by the converter.")
        }
        guard
            let sourceFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: Double(source.sampleRate),
                channels: AVAudioChannelCount(source.channels), interleaved: true),
            let excerptFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: effectiveRate,
                channels: AVAudioChannelCount(source.channels), interleaved: true),
            // Both sides carry this file's own channel count, so the converter changes rate only and
            // the explicit map below places the channels; a remix matrix would restate the gains.
            let converter = AVAudioConverter(from: sourceFormat, to: excerptFormat),
            converter.outputFormat.sampleRate == effectiveRate
        else {
            throw NativeFailure.decodeFailed(
                "Cannot convert \(source.sampleRate) Hz \(source.channels) channel \(source.url.lastPathComponent) to \(outputRate) Hz."
            )
        }
        // Cumulative layout rounding owns the duration, including a last frame rounded up.
        let demand = try product(Int128(owed), inputNumerator)
        let duration = demand / outputNumerator + (demand % outputNumerator == 0 ? 0 : 1)
        let requested = Int128(start).addingReportingOverflow(duration)
        guard !requested.overflow, let requestedEnd = Int64(exactly: requested.partialValue) else {
            throw NativeFailure.decodeFailed("Audio selection exceeds native frame capacity.")
        }
        let end: Int64
        switch support {
        case .outputDuration(let limit): end = limit.map { min($0, requestedEnd) } ?? requestedEnd
        case .finite(let allowedEnd): end = allowedEnd
        }
        let covered = try product(Int128(max(0, end - start)), outputNumerator) / inputNumerator
        guard let padding = Int(exactly: max(0, Int128(owed) - covered)) else {
            throw NativeFailure.decodeFailed("Audio quantization padding exceeds native capacity.")
        }
        return (converter, excerptFormat, end, padding)
    }

    init(
        source: SourceTrack, decoder: AudioSourceReader, origin: ExactTime, start: Int64,
        outputRate: Int, owed: Int64, support: InputSupport = .outputDuration(limit: nil),
        playbackRate: ExactTime = ExactTime(1)
    ) throws {
        sourceInput = source.input
        let configuration = try Self.configuration(source: source, start: start, outputRate: outputRate,
            owed: owed, support: support, playbackRate: playbackRate)
        let converter = configuration.converter
        let excerptFormat = configuration.format
        let end = configuration.end
        paddingFrames = configuration.padding
        try decoder.begin(origin: origin, at: start, end: end)
        let openedInput = ConversionInput(reader: decoder)
        guard let converted = AVAudioPCMBuffer(pcmFormat: excerptFormat, frameCapacity: 8_192)
        else { throw NativeFailure.decodeFailed("Cannot allocate audio conversion buffer.") }
        self.converter = converter
        self.input = openedInput
        self.converted = converted
        self.channels = source.channels
    }

    func mix(
        into samples: inout [Float], at destination: Int, frames: Int,
        gain: Float, channelMap: [Int]
    ) throws {
        var written = 0
        while written < frames {
            if offset == Int(converted.frameLength) {
                if exhausted, frames - written <= paddingFrames, input.reachedSelectionEnd {
                    paddingFrames -= frames - written
                    return
                }
                guard !exhausted else {
                    if let detail = sourceInput.failure {
                        throw detail
                    }
                    throw NativeFailure.decodeFailed(
                        "Audio interval ended before its quantized output boundary.")
                }
                var failure: NSError?
                let input = self.input
                let outcome = converter.convert(to: converted, error: &failure) { _, status in
                    input.next(status)
                }
                // convert replaces the buffer, including an empty end-of-stream result.
                // A later mix call must not reuse the previous buffer's consumed offset.
                offset = 0
                if let error = input.failure { throw error }
                if outcome == .endOfStream, converted.frameLength == 0,
                    frames - written <= paddingFrames, input.reachedSelectionEnd
                {
                    paddingFrames -= frames - written
                    exhausted = true
                    return
                }
                guard outcome != .error, !input.readerFailed,
                    converted.frameLength > 0
                else {
                    if let detail = sourceInput.failure {
                        throw detail
                    }
                    throw NativeFailure.decodeFailed(
                        "Audio conversion made no progress: \(failure?.localizedDescription ?? "short decoded coverage")"
                    )
                }
                exhausted = outcome == .endOfStream
            }
            let count = min(frames - written, Int(converted.frameLength) - offset)
            let decoded = converted.floatChannelData![0]
            samples.withUnsafeMutableBufferPointer { output in
                for channel in channelMap.indices {
                    let sourceChannel = channelMap[channel]
                    var frame = 0
                    while frame < count {
                        output[(destination + written + frame) * channelMap.count + channel] +=
                            gain * decoded[(offset + frame) * channels + sourceChannel]
                        frame += 1
                    }
                }
            }
            offset += count
            written += count
        }
    }
}

/// A fresh converter sees only one selected interval and an explicit end-of-stream flush.
/// Its input callback runs synchronously inside convert; no other thread advances this reader.
private final class ConversionInput: @unchecked Sendable {
    private let reader: AudioSourceReader
    private var supplied: AVAudioPCMBuffer?
    private(set) var failure: Error?
    var readerFailed: Bool { reader.failed }
    var reachedSelectionEnd: Bool { reader.reachedSelectionEnd }

    init(reader: AudioSourceReader) { self.reader = reader }

    func next(_ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioPCMBuffer? {
        do {
            let buffer = try autoreleasepool { try reader.next() }
            guard let buffer else {
                status.pointee = .endOfStream
                return nil
            }
            supplied = buffer
            status.pointee = .haveData
            return buffer
        } catch {
            failure = error
            status.pointee = .endOfStream
            return nil
        }
    }
}
