import CryptoKit
import FluidAudio
import Foundation
import Darwin
import YapAudio
import YapMedia

/// One decoded window and its explicit primary ownership; context never becomes acquired silence.
public struct SpeechSegment: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable { case transcribed, skipped }
    public let ordinal: Int
    public let source: ExactRange
    public let state: State
    /// Why a segment was skipped: `too_short` when the engine cannot accept that little audio.
    public let reason: String?
    public let wordCount: Int
    public let owned: ExactRange
}

public struct SpeechOutput: Codable, Sendable, Equatable {
    public let file: String
    public let bytes: Int
    public let sha256: String
}

public struct SpeechResources: Codable, Sendable, Equatable {
    public let peakResidentBytes: Int64
    public let largestDecodedSamples: Int
}

public struct SpeechTranscript: Codable, Sendable, Equatable {
    public let output: SpeechOutput
    public let engine: SpeechEngine
    public let segments: [SpeechSegment]
    public let wordCount: Int
    public let details: SpeechResources
    public let execution: SpeechExecution
    public let available: [ExactRange]
}

/// A local problem with published evidence, in the issue vocabulary core validates
/// (`packages/composition/src/issues.ts`). `word` indexes the words of the raw line carrying it.
package struct SpeechIssue: Encodable, Equatable, Sendable {
    package enum Evidence: Equatable, Sendable {
        case boundaryUnresolved(boundaryUs: ExactTime, window: Int, observation: Int, text: String, published: Bool)
        case timingClamped(window: Int, observation: Int, decoded: ExactRange, startSeconds: Double, endSeconds: Double)
        case wordDropped(window: Int, token: Int, text: String, startSeconds: Double, endSeconds: Double, confidence: Float)
    }
    package let word: Int?
    package let range: ExactRange?
    package let evidence: Evidence

    package var code: String {
        switch evidence {
        case .boundaryUnresolved: "boundary-unresolved"
        case .timingClamped: "timing-clamped"
        case .wordDropped: "word-dropped"
        }
    }
    var message: String {
        func seconds(_ value: Double) -> String { String(format: "%.3f", value) }
        switch evidence {
        case let .boundaryUnresolved(boundaryUs, _, _, text, published):
            let at = seconds(Double(boundaryUs.numerator) / Double(boundaryUs.denominator) / 1_000_000)
            return published
                ? "'\(text)' has no unique peer across the \(at) s seam; the window whose core holds its start publishes it."
                : "'\(text)' has no unique peer across the \(at) s seam; it starts in the neighbouring window's core, so only raw evidence keeps it."
        case let .timingClamped(_, _, _, start, end):
            return "The engine estimate [\(seconds(start)), \(seconds(end))] s runs past its decoded window; it is clamped to the window edge."
        case let .wordDropped(_, token, text, _, _, _):
            return "Token \(token) of '\(text)' has a malformed engine estimate; the word is dropped and its neighbours publish."
        }
    }
    enum CodingKeys: String, CodingKey { case code, message, word, range, evidence }
    enum EvidenceKeys: String, CodingKey {
        case boundaryUs, window, observation, text, published, decoded, startSeconds, endSeconds, token, confidence
    }
    package func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(code, forKey: .code)
        try container.encode(message, forKey: .message)
        try container.encodeIfPresent(word, forKey: .word)
        try container.encodeIfPresent(range, forKey: .range)
        var details = container.nestedContainer(keyedBy: EvidenceKeys.self, forKey: .evidence)
        switch evidence {
        case let .boundaryUnresolved(boundaryUs, window, observation, text, published):
            try details.encode(boundaryUs, forKey: .boundaryUs); try details.encode(window, forKey: .window)
            try details.encode(observation, forKey: .observation); try details.encode(text, forKey: .text)
            try details.encode(published, forKey: .published)
        case let .timingClamped(window, observation, decoded, start, end):
            try details.encode(window, forKey: .window); try details.encode(observation, forKey: .observation)
            try details.encode(decoded, forKey: .decoded)
            try details.encode(start, forKey: .startSeconds); try details.encode(end, forKey: .endSeconds)
        case let .wordDropped(window, token, text, start, end, confidence):
            try details.encode(window, forKey: .window); try details.encode(token, forKey: .token)
            try details.encode(text, forKey: .text)
            try details.encode(start, forKey: .startSeconds); try details.encode(end, forKey: .endSeconds)
            try details.encode(confidence, forKey: .confidence)
        }
    }
}

/// Bounded selected-source windows retain untouched engine evidence, explicit context and original
/// source estimates. Unique shared-context correspondence settles primary ownership across seams;
/// local problems become issues on the published words, and raw evidence keeps every candidate.
public enum SourceTranscript {

    /// One line of `raw.jsonl` per segment: FluidAudio's own result, untouched, beside the words the
    /// evaluated merge produced from its tokens, in engine seconds and in source microseconds.
    package struct RawSegment: Encodable {
        let ordinal: Int
        let source: ExactRange
        let state: SpeechSegment.State
        let reason: String?
        let sampleRate: Int
        let samples: Int64
        let result: ASRResult?
        package internal(set) var words: [RawWord]
        package let owned: ExactRange
        let observations: [RawWord]
        package internal(set) var selectedObservationIndexes: [Int]
        var boundary: SpeechBoundaryResolution?
        package internal(set) var issues: [SpeechIssue]
    }

    /// Recognition and speech-bearing token estimates remain distinct. Neither estimate is
    /// independent audible ground truth or permission to cut the source. Engine seconds stay as
    /// reported; only `source` is clamped to the decoded window.
    package struct RawWord: Codable {
        package let text: String
        let startSeconds: TimeInterval
        let endSeconds: TimeInterval
        let spokenStartSeconds: TimeInterval
        let spokenEndSeconds: TimeInterval
        let confidence: Float
        package let source: TimeSpan
    }

    /// One decoded window's engine evidence before seam resolution settles which window publishes it.
    package struct WindowEvidence {
        let observations: [RawWord]
        /// Observations whose estimate ran past the decoded window and were clamped to its edge.
        let clamped: Set<Int>
        let dropped: [DroppedEngineWord]
        let result: ASRResult?
        let samples: Int64

        /// Maps the engine's grouped words onto the decoded window, clamping overruns.
        package init(words: [EngineWord], dropped: [DroppedEngineWord], in decoded: ExactRange,
            result: ASRResult? = nil, samples: Int64 = 0) throws
        {
            var observations: [RawWord] = [], clamped = Set<Int>()
            for (index, word) in words.enumerated() {
                // The merger only groups well-formed tokens, so every word it returns has a span.
                guard let span = try SourceTranscript.sourceSpan(from: word.spokenStart, to: word.spokenEnd, in: decoded) else {
                    throw NativeFailure("INVALID_SPEECH_TIMING", "Word \(index) has a malformed estimate [\(word.spokenStart),\(word.spokenEnd)].")
                }
                if span.clamped { clamped.insert(observations.count) }
                observations.append(RawWord(text: word.word, startSeconds: word.startTime, endSeconds: word.endTime,
                    spokenStartSeconds: word.spokenStart, spokenEndSeconds: word.spokenEnd, confidence: word.confidence,
                    source: span.source))
            }
            self.observations = observations; self.clamped = clamped; self.dropped = dropped
            self.result = result; self.samples = samples
        }
    }

    /// Streams windows in order, retaining only the previous one until its right seam is resolved.
    package struct Publication {
        let windows: [SpeechWindow]
        let execution: SpeechExecution
        private var pending: (segment: RawSegment, evidence: WindowEvidence, unresolved: [(Int, ExactTime)])?

        package init(windows: [SpeechWindow], execution: SpeechExecution) {
            self.windows = windows; self.execution = execution
        }

        /// Adds the next window; returns the previous one, now complete.
        package mutating func add(_ evidence: WindowEvidence?, ordinal: Int) throws -> RawSegment? {
            let window = windows[ordinal]
            let observations = evidence?.observations ?? []
            var selected: Set<Int> = []
            for (index, word) in observations.enumerated() {
                let start = ExactTime(Int128(word.source.startUs)), end = ExactTime(Int128(word.source.endUs))
                // Intersect outer selection edges without shortening original estimates. Internal
                // starts select the provisional owner until explicit peer resolution settles it.
                let lower = ordinal > 0 && windows[ordinal - 1].owned.endUs == window.owned.startUs
                    ? try start.compare(window.owned.startUs) != .orderedAscending
                    : try (start == end ? start.compare(window.owned.startUs) != .orderedAscending : end.compare(window.owned.startUs) == .orderedDescending)
                let terminalPoint = start == end && start == window.owned.endUs && execution.executionRange == nil && window.owned.endUs == window.decoded.endUs
                if try lower && (start.compare(window.owned.endUs) == .orderedAscending || terminalPoint) { selected.insert(index) }
            }
            var current = RawSegment(ordinal: ordinal, source: window.decoded,
                state: evidence?.result == nil ? .skipped : .transcribed, reason: evidence?.result == nil ? "too_short" : nil,
                sampleRate: ParakeetEngine.sampleRate, samples: evidence?.samples ?? 0, result: evidence?.result, words: [],
                owned: window.owned, observations: observations, selectedObservationIndexes: selected.sorted(), boundary: nil, issues: [])
            var unresolved: [(Int, ExactTime)] = []
            var finished: RawSegment?
            if var previous = pending {
                var previousIndexes = Set(previous.segment.selectedObservationIndexes)
                if previous.segment.owned.endUs == current.owned.startUs,
                   let shared = try previous.segment.source.intersection(current.source) {
                    let resolution = try SpeechBoundaryMerge.resolve(
                        left: previous.segment.observations.map { SpeechObservation(text: $0.text, source: $0.source) },
                        right: observations.map { SpeechObservation(text: $0.text, source: $0.source) },
                        boundaryUs: current.owned.startUs, shared: shared)
                    current.boundary = resolution
                    for pair in resolution.pairs {
                        if pair.selected == .left { previousIndexes.insert(pair.left); selected.remove(pair.right) }
                        else { previousIndexes.remove(pair.left); selected.insert(pair.right) }
                    }
                    for observation in resolution.unresolved {
                        if observation.side == .left { previous.unresolved.append((observation.index, resolution.boundaryUs)) }
                        else { unresolved.append((observation.index, resolution.boundaryUs)) }
                    }
                }
                previous.segment.selectedObservationIndexes = previousIndexes.sorted()
                finished = Self.complete(previous)
            }
            current.selectedObservationIndexes = selected.sorted()
            let retained = try evidence ?? WindowEvidence(words: [], dropped: [], in: window.decoded)
            pending = (current, retained, unresolved)
            return finished
        }

        package mutating func finish() -> RawSegment? {
            defer { pending = nil }
            return pending.map(Self.complete)
        }

        /// Publishes the selected observations and reports each local problem on the word it touches.
        private static func complete(_ entry: (segment: RawSegment, evidence: WindowEvidence, unresolved: [(Int, ExactTime)])) -> RawSegment {
            var segment = entry.segment
            let selected = segment.selectedObservationIndexes
            segment.words = selected.map { segment.observations[$0] }
            let position = Dictionary(uniqueKeysWithValues: selected.enumerated().map { ($1, $0) })
            var issues: [SpeechIssue] = []
            for (index, boundaryUs) in entry.unresolved {
                let word = segment.observations[index], published = position[index] != nil
                let span = word.source.startUs < word.source.endUs
                    ? ExactRange(startUs: ExactTime(Int128(word.source.startUs)), endUs: ExactTime(Int128(word.source.endUs))) : nil
                issues.append(SpeechIssue(word: position[index], range: published ? nil : span,
                    evidence: .boundaryUnresolved(boundaryUs: boundaryUs, window: segment.ordinal, observation: index,
                        text: word.text, published: published)))
            }
            for index in entry.evidence.clamped.sorted() {
                guard let word = position[index] else { continue }
                let observation = segment.observations[index]
                issues.append(SpeechIssue(word: word, range: nil, evidence: .timingClamped(window: segment.ordinal,
                    observation: index, decoded: segment.source,
                    startSeconds: observation.spokenStartSeconds, endSeconds: observation.spokenEndSeconds)))
            }
            for dropped in entry.evidence.dropped {
                issues.append(SpeechIssue(word: nil, range: segment.owned, evidence: .wordDropped(window: segment.ordinal,
                    token: dropped.token, text: dropped.text, startSeconds: dropped.startTime, endSeconds: dropped.endTime,
                    confidence: dropped.confidence)))
            }
            // Word order, then everything not on a published word; stable within each.
            segment.issues = issues.enumerated().sorted { ($0.element.word ?? .max, $0.offset) < ($1.element.word ?? .max, $1.offset) }.map(\.element)
            return segment
        }
    }

    public static func write(models: SpeechModelFiles, track: AudioSourceSelection, output: String,
        execution: SpeechExecution) async throws -> SpeechTranscript
    {
        try ParakeetEngine.checkList(models)
        try models.verify()
        let available = try await AudioPCMStream.readableIntervals(of: track)
        let windows = try SpeechWindows.plan(available: available, execution: execution)
        let destination = try NewFile(at: output, assembledAs: "raw.jsonl")
        defer { destination.discard() }
        let descriptor = Darwin.open(destination.url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o666)
        guard descriptor >= 0 else { throw NativeFailure("INVALID_OUTPUT", "Cannot create speech output.") }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Engine values stay as reported, including any nonfinite value behind a dropped word.
        encoder.nonConformingFloatEncodingStrategy = .convertToString(
            positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
        var engine: ParakeetEngine?
        var hash = SHA256()
        var totalBytes = 0
        var largestDecodedSamples = 0
        var segments: [SpeechSegment] = []
        var publication = Publication(windows: windows, execution: execution)
        func emit(_ segment: RawSegment) throws {
            let line: Data
            do { line = try encoder.encode(segment) + Data([10]) } catch {
                throw NativeFailure("INVALID_SPEECH_TIMING", "Segment \(segment.ordinal) engine evidence is not representable: \(error.localizedDescription)")
            }
            try handle.write(contentsOf: line)
            hash.update(data: line)
            totalBytes += line.count
            segments.append(SpeechSegment(ordinal: segment.ordinal, source: segment.source, state: segment.state,
                reason: segment.reason, wordCount: segment.words.count, owned: segment.owned))
        }
        for (ordinal, window) in windows.enumerated() {
            try Task.checkCancellation()
            let samples = try await monoSamples(of: track, in: window.decoded)
            largestDecodedSamples = max(largestDecodedSamples, samples.count)
            // A window too short for the engine is skipped unread, but still reports what it decoded.
            var evidence = try WindowEvidence(words: [], dropped: [], in: window.decoded, samples: Int64(samples.count))
            if samples.count >= ParakeetEngine.minimumSamples {
                if engine == nil { engine = try await ParakeetEngine.load(models) }
                let result = try await engine!.transcribe(samples)
                let merged = WordTimingMerger.mergeTokensIntoWords(result.tokenTimings ?? [])
                evidence = try WindowEvidence(words: merged.words, dropped: merged.dropped, in: window.decoded,
                    result: result, samples: Int64(samples.count))
            }
            if let finished = try publication.add(evidence, ordinal: ordinal) { try emit(finished) }
        }
        if let finished = publication.finish() { try emit(finished) }
        try handle.synchronize()
        let bytes = try destination.publish()
        return SpeechTranscript(output: SpeechOutput(file: output, bytes: bytes,
            sha256: hash.finalize().map { String(format: "%02x", $0) }.joined()),
            engine: ParakeetEngine.identity, segments: segments, wordCount: segments.reduce(0) { $0 + $1.wordCount },
            details: SpeechResources(peakResidentBytes: ProcessResources.peakResidentBytes(), largestDecodedSamples: largestDecodedSamples),
            execution: execution, available: available)
    }

    /// One interval as 16 kHz mono, read through the shared audio owner. Channels are averaged; the
    /// interval lies inside readable time, so the stream must report nothing unavailable.
    private static func monoSamples(of track: AudioSourceSelection, in interval: ExactRange) async throws
        -> [Float]
    {
        let stream = try await AudioPCMStream.open(
            source: track, spans: [interval], sampleRate: ParakeetEngine.sampleRate)
        guard stream.reports.allSatisfy({ $0.unavailable.isEmpty }) else {
            throw NativeFailure.decodeFailed("Source media changed while it was being read.")
        }
        let channels = stream.format.channels
        var samples: [Float] = []
        samples.reserveCapacity(Int(stream.frames))
        try await stream.consume { block in
            if channels == 1 {
                samples.append(contentsOf: block.samples)
                return
            }
            for frame in 0..<block.frameCount {
                var sum: Float = 0
                for channel in 0..<channels { sum += block.samples[frame * channels + channel] }
                samples.append(sum / Float(channels))
            }
        }
        return samples
    }

    /// Valid engine estimates offset the exact interval before the one integer-label projection. An
    /// estimate past the interval's end is clamped to it; a malformed one (nonfinite, negative or
    /// reversed) has no span.
    package static func sourceSpan(from start: TimeInterval, to end: TimeInterval, in interval: ExactRange)
        throws -> (source: TimeSpan, clamped: Bool)?
    {
        guard start.isFinite, end.isFinite, start >= 0, end >= start else { return nil }
        // No decoded window is longer than this, so a larger offset is past every edge.
        let longest = Double(SpeechWindows.windowUs + SpeechBoundaryMerge.contextUs * 2) / 1_000_000
        func offset(_ seconds: TimeInterval) throws -> ExactTime? {
            guard seconds <= longest else { return nil }
            let value = try interval.startUs.adding(ExactTime(seconds: seconds))
            return try value.compare(interval.endUs) == .orderedDescending ? nil : value
        }
        let lower = try offset(start), upper = try offset(end)
        return (try TimeSpan(startUs: (lower ?? interval.endUs).sample(1_000_000, nearest: true),
                             endUs: (upper ?? interval.endUs).sample(1_000_000, nearest: true)),
                upper == nil)
    }
}
