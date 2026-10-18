@preconcurrency import AVFoundation
import Darwin
import Foundation
import YapMedia

public struct SelectedAudioConversionResult: Encodable, Sendable {
    public struct Format: Encodable, Sendable {
        public let sampleRate: Int
        public let channels: Int
        public let frames: Int64
    }
    public let file: String
    public let mediaType = "audio/wav"
    public let bytes: Int
    public let input: Format
    public let output: Format
    public let implementationId = "native-finite-pcm-v2"
    public let channelPolicy: String
    public let contextPolicy = "complete-selected-pcm-zero-origin"
}

/// Conversion starts after selection/mixing has finished. Its filter may spread selected samples
/// into selected zeroes; it never re-applies a contributor's availability mask to the mixed PCM.
public final class SelectedAudioConversion: AudioPCMSource {
    public let format: AudioPCMFormat
    public let frames: Int64
    public let input: SelectedAudioConversionResult.Format
    private let source: SourceTrack
    private var consumed = false

    public static func open(source url: URL, sampleRate: Int, channels: Int) async throws -> SelectedAudioConversion {
        guard (1...AudioLimits.maximumSampleRate).contains(sampleRate), (1...2).contains(channels) else {
            throw NativeFailure("INVALID_REQUEST", "Finite PCM conversion requires a supported rate and mono or stereo output.")
        }
        let file = try AVAudioFile(forReading: url)
        let basic = file.fileFormat.streamDescription.pointee
        guard basic.mFormatID == kAudioFormatLinearPCM,
            basic.mFormatFlags & kAudioFormatFlagIsFloat != 0,
            basic.mBitsPerChannel == 32, file.length > 0 else {
            throw NativeFailure("UNSUPPORTED_FORMAT", "Finite conversion requires nonempty Float32 selected PCM.")
        }
        let header = try FileHandle(forReadingFrom: url)
        defer { try? header.close() }
        // /dev/fd aliases share an offset with AVAudioFile's probe. Header inspection must
        // use positional reads so it neither depends on nor changes the borrowed offset.
        var signature = Data(count: 12)
        let read = signature.withUnsafeMutableBytes { pread(header.fileDescriptor, $0.baseAddress, 12, 0) }
        guard read == 12, String(decoding: signature[0..<4], as: UTF8.self) == "RIFF",
            String(decoding: signature[8..<12], as: UTF8.self) == "WAVE" else {
            throw NativeFailure("UNSUPPORTED_FORMAT", "Finite conversion requires a completed selected WAV.")
        }
        let declaredBytes = signature.withUnsafeBytes {
            UInt64(UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 4, as: UInt32.self))) + 8
        }
        var identity = stat()
        guard fstat(header.fileDescriptor, &identity) == 0, identity.st_size == declaredBytes else {
            throw NativeFailure.decodeFailed("Selected WAV is truncated or its RIFF extent is inconsistent.")
        }
        let source = try await SourceTrack.open(selection: AudioSourceSelection(source: url.path,
            sourceOffsetUs: ExactTime(0), available: []), strictWindowFormat: true, purpose: .streaming)
        return try SelectedAudioConversion(source: source, inputFrames: file.length,
            sampleRate: sampleRate, channels: channels)
    }

    private init(source: SourceTrack, inputFrames: Int64, sampleRate: Int, channels: Int) throws {
        let count = Int128(inputFrames) * Int128(sampleRate) / Int128(source.sampleRate)
        guard let frames = Int64(exactly: count), frames > 0 else {
            throw NativeFailure("INVALID_REQUEST", "Selected PCM produces no frames or exceeds frame capacity at this rate.")
        }
        self.source = source
        self.input = .init(sampleRate: source.sampleRate, channels: source.channels, frames: inputFrames)
        self.frames = frames
        self.format = AudioPCMFormat(sampleRate: sampleRate, channels: channels, layout: channels == 1 ? .mono : .stereo)
    }

    public func consume(_ sink: (AudioPCMBlock) async throws -> Void) async throws {
        try await consume(blockFrames: 8192, sink)
    }

    func consume(blockFrames: Int, _ sink: (AudioPCMBlock) async throws -> Void) async throws {
        guard !consumed, (1...8192).contains(blockFrames) else {
            throw NativeFailure("INVALID_REQUEST", "Finite PCM requires one consumption with bounded blocks.")
        }
        consumed = true
        let decoder = AudioSourceReader(input: source.input, asset: source.asset, track: source.track,
            sampleRate: source.sampleRate, packetFrames: source.packetFrames, channels: source.channels)
        let converter = try ConvertedAudioInterval(source: source, decoder: decoder,
            origin: ExactTime(0), start: 0, outputRate: format.sampleRate, owed: frames,
            support: .finite(end: input.frames))
        var position: Int64 = 0
        while position < frames {
            try Task.checkCancellation()
            let count = Int(min(Int64(blockFrames), frames - position))
            var samples = [Float](repeating: 0, count: count * input.channels)
            try converter.mix(into: &samples, at: 0, frames: count, gain: 1,
                channelMap: Array(0..<input.channels))
            guard samples.allSatisfy(\.isFinite) else {
                throw NativeFailure("INVALID_RESPONSE", "Selected PCM conversion produced non-finite samples.")
            }
            if input.channels == 2 && format.channels == 1 {
                // Sum in Double and round once to Float32: finite Float32 inputs cannot overflow
                // the intermediate sum. This average neither clips nor normalizes the signal.
                samples = stride(from: 0, to: samples.count, by: 2).map {
                    Float((Double(samples[$0]) + Double(samples[$0 + 1])) * 0.5)
                }
            } else if input.channels == 1 && format.channels == 2 {
                samples = samples.flatMap { [$0, $0] }
            }
            try await sink(AudioPCMBlock(startFrame: position, frameCount: count, samples: samples))
            position += Int64(count)
        }
        try Task.checkCancellation()
    }

    public func write(to output: URL) async throws -> SelectedAudioConversionResult {
        let writer = try AudioWaveWriter(sampleRate: format.sampleRate, frames: frames,
            channels: format.channels, output: output, sources: [source.url])
        defer { writer.discard() }
        try await consume { try writer.write($0) }
        try Task.checkCancellation()
        return SelectedAudioConversionResult(file: output.path, bytes: try writer.finish(), input: input,
            output: .init(sampleRate: format.sampleRate, channels: format.channels, frames: frames),
            channelPolicy: input.channels == format.channels ? "preserve" : format.channels == 1
                ? "equal-weight-double-rounded-float32" : "duplicate")
    }
}
