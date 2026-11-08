import Foundation
import YapMedia
import YapStretch

extension CompositionAudio {
    public static let retimeImplementation = "retime-signalsmith-a670068d9aeb64913331d5cc29337b19a457a7df-exact-joint-48k-p1-follow-avconverter-rational-v1"

    public static func validateRetimeImplementation(_ bound: String?) throws {
        if let bound, bound != retimeImplementation {
            throw NativeFailure("PINNED_IMPLEMENTATION_UNAVAILABLE", "The bound audio retiming implementation is unavailable.")
        }
    }
    static func validateRetimeBinding(_ plan: CompositionAudioPlan) throws {
        try validateRetimeImplementation(plan.retimeImplementationId)
        for clip in plan.clips + (plan.state?.clips ?? []) where clip.source.kind == "range" {
            guard let range = clip.source.range else { throw invalid("A range clip requires source bounds.") }
            if !(try range.endUs.subtract(range.startUs)).equals(try clip.placement.endUs.subtract(clip.placement.startUs)) {
                guard plan.retimeImplementationId == retimeImplementation else {
                    throw NativeFailure("INTERNAL_ERROR", "Retimed audio requires a bound native implementation.")
                }
            }
        }
    }

    /// Resolves physical retained support and validates both ordinary and state inputs.
    /// No decoder, processing scratch, or output file is created by admission.
    public static func validate(_ plan: CompositionAudioPlan) async throws {
        try validateRetimeBinding(plan)
        let sources = Sources()
        _ = try await resolveState(plan, sources: sources)
        _ = try await graph(plan, sources: sources)
    }

    static func validateRetime(source: SourceTrack, context: Context, pitch: String) throws {
        let count = context.project.end - context.project.start
        if pitch == "preserve" {
            guard let input = Int(exactly: context.inputFrames), let output = Int(exactly: count) else {
                throw NativeFailure("LIMIT_EXCEEDED", "Retained retiming exceeds native sample capacity.")
            }
            do { try SignalsmithProcessor.validate(inputFrames: input, outputFrames: output, sampleRate: rate, channels: source.channels) }
            catch { throw NativeFailure("PREREQUISITE_MISSING", "The retained pitch-preserving run is unsupported by the exact processor.") }
        }
        _ = try ConvertedAudioInterval.configuration(source: source, start: context.sourceStart, outputRate: rate,
            owed: pitch == "follow" ? count : context.inputFrames, support: .finite(end: context.sourceEnd),
            playbackRate: pitch == "follow" ? context.playbackRate : ExactTime(1))
    }

    static func prepareRetime(_ graph: Graph, parent: URL) throws {
        for input in graph.inputs.values {
            guard let recipe = input.retimeRecipe else { continue }
            let pitch = recipe.pitch
            for context in input.contexts {
                let key = RetimeKey(assetId: recipe.assetId, streamId: recipe.streamId, source: input.source, context: context, pitch: pitch)
                if let existing = graph.sources.retimed[key] { input.prepared.append(existing) }
                else {
                    let run = try PreparedRetime(source: input.source, context: context, pitch: pitch, parent: parent, sources: graph.sources)
                    graph.sources.retimed[key] = run
                    input.prepared.append(run)
                }
            }
        }
    }

    /// Native origin disambiguates physical source segments. Policy and exact playback
    /// rate distinguish recipes even when they quantize to identical project boundaries.
    struct RetimeKey: Hashable {
        let assetId: String
        let streamId: String
        let sampleRate: Int
        let pitch: String
        let rateNumerator: Int128
        let rateDenominator: Int128
        let originNumerator: Int128
        let originDenominator: Int128
        let sourceStart: Int64
        let sourceEnd: Int64
        let inputFrames: Int64
        let projectStart: Int64
        let projectEnd: Int64
        init(assetId: String, streamId: String, source: SourceTrack, context: Context, pitch: String) {
            self.assetId = assetId; self.streamId = streamId
            self.pitch = pitch
            rateNumerator = context.playbackRate.numerator; rateDenominator = context.playbackRate.denominator
            sampleRate = source.sampleRate
            originNumerator = context.origin.numerator; originDenominator = context.origin.denominator
            sourceStart = context.sourceStart; sourceEnd = context.sourceEnd
            inputFrames = context.inputFrames
            projectStart = context.project.start; projectEnd = context.project.end
        }
    }

    final class PreparedRetime {
        let range: Plan.Samples
        let channels: Int
        let directory: URL
        let outputURL: URL
        init(source: SourceTrack, context: Context, pitch: String, parent: URL, sources: Sources) throws {
            range = context.project
            channels = source.channels
            let count = range.end - range.start
            directory = parent.appendingPathComponent(".retime-\(UUID().uuidString)", isDirectory: true)
            outputURL = directory.appendingPathComponent("output.f32")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            do {
                guard FileManager.default.createFile(atPath: outputURL.path, contents: nil) else {
                    throw invalid("Cannot create retiming scratch file.")
                }
                let output = try FileHandle(forUpdating: outputURL)
                defer { try? output.close() }
                let decoder = AudioSourceReader(input: source.input, asset: source.asset, track: source.track,
                    sampleRate: source.sampleRate, packetFrames: source.packetFrames, channels: source.channels)
                defer { sources.record(frames: decoder.decodedFrames, rate: source.sampleRate, channels: source.channels) }
                func render(to file: FileHandle, frames: Int64, playbackRate: ExactTime) throws {
                    let conversion = try ConvertedAudioInterval(source: source, decoder: decoder,
                        origin: context.origin, start: context.sourceStart, outputRate: rate,
                        owed: frames, support: .finite(end: context.sourceEnd), playbackRate: playbackRate)
                    var position: Int64 = 0
                    while position < frames {
                        try Task.checkCancellation()
                        try autoreleasepool {
                            let count = Int(min(8192, frames - position))
                            var samples = [Float](repeating: 0, count: count * source.channels)
                            try conversion.mix(into: &samples, at: 0, frames: count, gain: 1,
                                channelMap: Array(0..<source.channels))
                            guard samples.allSatisfy(\.isFinite) else { throw invalid("Retiming conversion produced non-finite samples.") }
                            try samples.withUnsafeBytes { try file.write(contentsOf: $0) }
                            position += Int64(count)
                        }
                    }
                }
                if pitch == "follow" {
                    try render(to: output, frames: count, playbackRate: context.playbackRate)
                } else {
                    let inputURL = directory.appendingPathComponent("input.f32")
                    guard FileManager.default.createFile(atPath: inputURL.path, contents: nil) else {
                        throw invalid("Cannot create retiming input scratch file.")
                    }
                    let input = try FileHandle(forUpdating: inputURL)
                    defer { try? input.close() }
                    try render(to: input, frames: context.inputFrames, playbackRate: ExactTime(1))
                    try SignalsmithProcessor.processFile(inputFD: input.fileDescriptor, firstFrame: 0,
                        inputFrames: Int(context.inputFrames), outputFD: output.fileDescriptor,
                        outputFrames: Int(count), sampleRate: rate, channels: source.channels,
                        checkCancellation: { try Task.checkCancellation() })
                    try FileManager.default.removeItem(at: inputURL)
                }
                guard try output.seekToEnd() == UInt64(count) * UInt64(source.channels) * 4 else {
                    throw invalid("Prepared retiming sample count differs from retained run.")
                }
            } catch {
                try? FileManager.default.removeItem(at: directory)
                throw error
            }
        }
        deinit {
            try? FileManager.default.removeItem(at: directory)
        }
        func mix(into samples: inout [Float], at destination: Int, position: Int64, count: Int) throws {
            try autoreleasepool {
                guard position >= range.start, position + Int64(count) <= range.end else {
                    throw invalid("Retimed PCM read exceeds retained run.")
                }
                // Completed runs own paths, not descriptors: thousands of retained runs
                // must not exhaust the process's file limit before playback starts.
                let output = try FileHandle(forReadingFrom: outputURL)
                defer { try? output.close() }
                try output.seek(toOffset: UInt64(position - range.start) * UInt64(channels) * 4)
                let data = try output.read(upToCount: count * channels * 4) ?? Data()
                guard data.count == count * channels * 4 else { throw invalid("Prepared retiming PCM is truncated.") }
                data.withUnsafeBytes { bytes in
                    for frame in 0..<count {
                        for channel in 0..<2 {
                            let sourceChannel = channels == 1 ? 0 : channel
                            let sample = bytes.loadUnaligned(fromByteOffset: (frame * channels + sourceChannel) * 4, as: Float.self)
                            samples[(destination + frame) * 2 + channel] += sample
                        }
                    }
                }
            }
        }
    }
}
