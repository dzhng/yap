@preconcurrency import AVFoundation
import Foundation
import YapMedia

/// Lossless selected-source sink. Consumption finishes before publication.
public enum AudioWave {
    public static func write(_ stream: AudioPCMStream, to output: URL) async throws -> Int {
        let writer = try AudioWaveWriter(
            sampleRate: stream.format.sampleRate, frames: stream.frames,
            channels: stream.format.channels, output: output, sources: stream.sourceURLs)
        defer { writer.discard() }
        try await stream.consume { try writer.write($0) }
        try Task.checkCancellation()
        return try writer.finish()
    }
}

/// One float-WAVE sink shared by PCM producers. Closing the file
/// precedes publication so every receipt describes a completed header and payload.
final class AudioWaveWriter {
    private let format: AVAudioFormat
    private let destination: OutputFile
    private var file: AVAudioFile?

    init(sampleRate: Int, frames: Int64, channels: Int, output: URL, sources: [URL]) throws {
        // RIFF uses 32-bit sizes. Reserve bounded room for the platform's format/fact headers;
        // refusing before output creation is preferable to publishing a wrapped/truncated file.
        guard frames >= 0, Int128(frames) * Int128(channels) * 4 <= Int128(UInt32.max) - 4096 else {
            throw NativeFailure("LIMIT_EXCEEDED", "Float WAV exceeds the supported RIFF capacity (4 GiB minus 4096 header bytes).")
        }
        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: Double(sampleRate), channels: AVAudioChannelCount(channels),
                interleaved: true)
        else {
            throw NativeFailure.decodeFailed("Cannot describe audio output format.")
        }
        self.format = format
        destination = try OutputFile(output.path, assembledAs: "mix.wav", distinctFrom: sources)
        var settings = format.settings
        settings[AVAudioFileTypeKey] = kAudioFileWAVEType
        do {
            file = try AVAudioFile(
                forWriting: destination.url, settings: settings,
                commonFormat: .pcmFormatFloat32, interleaved: true)
        } catch {
            destination.discard()
            let message = "Cannot open audio output: \(error.localizedDescription)"
            // A process out of descriptors drains, so a retry can succeed; any other failure is final.
            throw descriptorsExhausted(error)
                ? NativeFailure("CAPACITY_EXCEEDED", message) : NativeFailure.decodeFailed(message)
        }
    }
    func write(_ block: AudioPCMBlock) throws {
        try autoreleasepool {
            guard let file,
                let buffer = AVAudioPCMBuffer(
                    pcmFormat: format,
                    frameCapacity: AVAudioFrameCount(block.frameCount))
            else {
                throw NativeFailure.decodeFailed("Cannot allocate WAVE block.")
            }
            buffer.frameLength = AVAudioFrameCount(block.frameCount)
            block.samples.withUnsafeBufferPointer {
                buffer.floatChannelData![0].update(from: $0.baseAddress!, count: $0.count)
            }
            do { try file.write(from: buffer) } catch {
                throw NativeFailure.decodeFailed(
                    "Cannot write audio: \(error.localizedDescription)")
            }
        }
    }
    func finish() throws -> Int {
        file = nil
        return try destination.finish()
    }
    func discard() {
        file = nil
        destination.discard()
    }
}

private func descriptorsExhausted(_ error: Error) -> Bool {
    let error = error as NSError
    return error.domain == NSPOSIXErrorDomain ? [EMFILE, ENFILE].contains(Int32(error.code))
        : error.code == Int(kAudio_TooManyFilesOpenError)
}
