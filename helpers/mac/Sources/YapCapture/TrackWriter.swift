@preconcurrency import AVFoundation
import Foundation

/// One track of a take on disk: its own movie writer and input, with the timing it has accepted.
/// Video counts source-clock ticks; packed PCM counts exact native frames.
final class TrackWriter {
    let role: String
    let file: String
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let sampleRate: Double?
    let channelCount: UInt32?
    let pcm: CapturePCM?
    var first: Int64?
    var lastAcceptedUs: Int64?
    var end: Int64?
    var samples = 0
    var physicalFrames: Int64 = 0
    var heldTailUs: Int64 = 0

    init(
        role: String, directory: String, settings: [String: Any], format: CMFormatDescription? = nil
    ) throws {
        self.role = role
        pcm = try role == "video" ? nil : format.map { try CapturePCM(format: $0) }
        sampleRate = format.flatMap {
            CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mSampleRate
        }
        channelCount = format.flatMap {
            CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mChannelsPerFrame
        }
        file = role == "video" ? "video.mov" : "\(role).packed.mov"
        writer = try AVAssetWriter(
            outputURL: URL(fileURLWithPath: directory).appendingPathComponent(file), fileType: .mov)
        // Video endpoints use source-clock ticks; packed PCM endpoints use exact native frames.
        let timescale: Int32
        if role == "video" { timescale = 1_000_000 }
        else {
            guard let rate = sampleRate.flatMap({ Int32(exactly: $0) }), rate > 0 else {
                throw CaptureFailure("INVALID_AUDIO_FORMAT", "PCM rate cannot identify its native sample grid.")
            }
            timescale = rate
        }
        writer.movieTimeScale = timescale
        writer.movieFragmentInterval = CMTime(value: 5, timescale: 1)
        writer.initialMovieFragmentInterval = CMTime(value: 1, timescale: 1)
        input = AVAssetWriterInput(
            mediaType: role == "video" ? .video : .audio, outputSettings: settings,
            sourceFormatHint: pcm?.format ?? format)
        if role == "video" { input.mediaTimeScale = timescale }
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            throw CaptureFailure("ENCODER_UNAVAILABLE", "Cannot encode \(role).")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw writer.error ?? CaptureFailure("WRITE_FAILED", "Cannot start \(role) writer.")
        }
        writer.startSession(atSourceTime: .zero)
    }
}
