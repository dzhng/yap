@preconcurrency import AVFoundation
import CryptoKit
import Foundation

public struct ProbedDecodedAudioRun: Encodable, Sendable {
    public let startUs: ExactTime
    public var endUs: ExactTime
    public var frames: Int64
}

public struct ProbedDecodedAudio: Encodable, Sendable {
    public let sampleRate: Int
    public let channels: Int
    public let frames: Int64
    public let runs: [ProbedDecodedAudioRun]
    public let pcmSha256: String
    public let trimming: String
}

/// Observes actual decoder output, without a requested time range, resampling,
/// edit mask or synthesized padding. Container support remains separate evidence.
enum DecodedAudioInspection {
    static func inspect(input: MediaInput, track: AVAssetTrack,
                        formats: [CMFormatDescription], originUs: ExactTime) throws -> ProbedDecodedAudio {
        guard formats.count == 1,
            let source = CMAudioFormatDescriptionGetStreamBasicDescription(formats[0])?.pointee,
            source.mSampleRate.isFinite, source.mSampleRate.rounded() == source.mSampleRate,
            (1...192_000).contains(source.mSampleRate),
            source.mChannelsPerFrame == 1 || source.mChannelsPerFrame == 2
        else { throw NativeFailure("UNSUPPORTED_MEDIA", "Decoded audio inspection requires one integral native-rate mono/stereo format.") }
        let rate = Int(source.mSampleRate), channels = Int(source.mChannelsPerFrame)
        let reader = try AVAssetReader(asset: input.asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: rate,
            AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw NativeFailure("UNSUPPORTED_MEDIA", "Selected audio cannot supply native-rate PCM.")
        }
        reader.add(output)
        guard reader.startReading() else {
            if let failure = input.failure { throw failure }
            throw NativeFailure.decodeFailed("Cannot inspect decoded source audio.")
        }
        defer { reader.cancelReading() }
        var frames: Int64 = 0
        var runs: [ProbedDecodedAudioRun] = []
        var hash = SHA256()
        while let sample = autoreleasepool(invoking: { output.copyNextSampleBuffer() }) {
            try Task.checkCancellation()
            let count = CMSampleBufferGetNumSamples(sample)
            let stamp = CMSampleBufferGetPresentationTimeStamp(sample)
            let duration = CMSampleBufferGetDuration(sample)
            let empty = CMGetAttachment(sample, key: kCMSampleBufferAttachmentKey_EmptyMedia,
                attachmentModeOut: nil) as? Bool == true
            let drain = CMGetAttachment(sample, key: kCMSampleBufferAttachmentKey_DrainAfterDecoding,
                attachmentModeOut: nil) as? Bool == true
            // Recognized no-payload decoder markers contribute no PCM. Actual gaps
            // still come from the emitted sample positions and declared edit segments.
            if count == 0, sample.isValid, sample.dataBuffer == nil, empty != drain { continue }
            // Observe the decoder's priming/edit treatment in the PCM it emits.
            // A residual trim attachment is a different, unqualified contract: never double-trim it.
            guard CMGetAttachment(sample, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart,
                        attachmentModeOut: nil) == nil,
                  CMGetAttachment(sample, key: kCMSampleBufferAttachmentKey_TrimDurationAtEnd,
                        attachmentModeOut: nil) == nil,
                  count > 0, count <= 65_536, stamp.isNumeric, duration.isNumeric,
                  CMTimeCompare(duration, CMTime(value: Int64(count), timescale: CMTimeScale(rate))) == 0,
                  let decoded = CMSampleBufferGetFormatDescription(sample),
                  let basic = CMAudioFormatDescriptionGetStreamBasicDescription(decoded)?.pointee,
                  basic.mFormatID == kAudioFormatLinearPCM,
                  basic.mSampleRate == Double(rate), basic.mChannelsPerFrame == channels,
                  basic.mBitsPerChannel == 32,
                  basic.mFormatFlags & kAudioFormatFlagIsFloat != 0,
                  basic.mFormatFlags & (kAudioFormatFlagIsBigEndian | kAudioFormatFlagIsNonInterleaved) == 0
            else { throw NativeFailure("UNSUPPORTED_MEDIA", "Decoded audio has unqualified format, timing or residual trimming.") }
            let start = try ExactTime(stamp).subtract(originUs)
            let end = try start.adding(ExactTime(Int128(count) * 1_000_000, Int128(rate)))
            if let previous = runs.last, try start.subtract(previous.endUs).numerator < 0 {
                throw NativeFailure("UNSUPPORTED_MEDIA", "Decoded audio sample runs overlap.")
            }
            if let previous = runs.last, previous.endUs.equals(start) {
                runs[runs.count - 1].endUs = end
                runs[runs.count - 1].frames += Int64(count)
            } else {
                runs.append(ProbedDecodedAudioRun(startUs: start, endUs: end, frames: Int64(count)))
            }
            let total = frames.addingReportingOverflow(Int64(count))
            guard !total.overflow, total.partialValue <= 9_007_199_254_740_991 else {
                throw NativeFailure("LIMIT_EXCEEDED", "Decoded audio frame count exceeds exact capacity.")
            }
            frames = total.partialValue
            var list = AudioBufferList()
            var retained: CMBlockBuffer?
            let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sample, bufferListSizeNeededOut: nil, bufferListOut: &list,
                bufferListSize: MemoryLayout<AudioBufferList>.size,
                blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
                flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &retained)
            let bytes = count * channels * MemoryLayout<Float>.size
            guard status == noErr, list.mNumberBuffers == 1,
                  list.mBuffers.mNumberChannels == channels, list.mBuffers.mDataByteSize == bytes,
                  let pointer = list.mBuffers.mData else {
                throw NativeFailure.decodeFailed("Cannot retain decoded audio sample bytes.")
            }
            try withExtendedLifetime(retained) {
                let samples = pointer.assumingMemoryBound(to: Float.self)
                for index in 0..<(count * channels) where !samples[index].isFinite {
                    throw NativeFailure("UNSUPPORTED_MEDIA", "Decoded audio includes nonfinite samples.")
                }
                hash.update(data: Data(bytes: pointer, count: bytes))
            }
        }
        if let failure = input.failure { throw failure }
        guard reader.status == .completed else {
            throw NativeFailure.decodeFailed("Decoded audio inspection did not complete.")
        }
        return ProbedDecodedAudio(sampleRate: rate, channels: channels, frames: frames, runs: runs,
            pcmSha256: hash.finalize().map { String(format: "%02x", $0) }.joined(),
            trimming: "decoder-output-attachment-free")
    }
}
