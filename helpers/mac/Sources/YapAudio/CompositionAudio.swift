@preconcurrency import AVFoundation
import Foundation
import YapMedia

public struct CompositionAudioReport: Codable, Sendable {
    public let sampleRate: Int
    public let channels: Int
    public let frames: Int64
    public let peak: Double
    public let clippedSamples: Int64
    public let maximumBlockFrames: Int
    public let peakResidentBytes: Int64
    public let decoderContext: DecoderContext
    /// Selected PCM admitted to the rate converter, measured in output-rate frames.
    /// Codec packet lookbehind is discarded by AudioSourceReader before this context.
    public struct DecoderContext: Codable, Sendable {
        let policy: String
        let sampleRate: Int
        let maximumPrerollFrames: Int64
        let maximumTailFrames: Int64
    }
    /// Request-cumulative source decoder/descriptor work, including preparation and discarded context.
    /// Excludes internal processing scratch I/O; unknownReadInputs prevents interpreting partial reads as totals.
    public let sourceWork: SourceWork?
    public struct SourceWork: Codable, Sendable {
        public struct Decoded: Codable, Sendable {
            let sampleRate: Int
            var frames: Int64
            var float32Bytes: Int64
        }
        let preparedRetimeRuns: Int
        let decoded: [Decoded]
        let descriptorReadBytes: Int64
        let descriptorDeliveredBytes: Int64
        let descriptorInputs: Int
        let unknownReadInputs: Int
    }
    public let unavailable: [Missing]
    public struct Missing: Codable, Sendable {
        let clipId: String
        let ranges: [CompositionAudioPlan.Samples]
    }
}

public struct CompositionAudioResult: Encodable, Sendable {
    public let file: String
    public let bytes: Int
    let report: CompositionAudioReport
    public func encode(to encoder: Encoder) throws {
        try report.encode(to: encoder)
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(file, forKey: .file)
        try container.encode(bytes, forKey: .bytes)
    }
    private enum Keys: String, CodingKey { case file, bytes }
}

public enum CompositionAudio {
    typealias Plan = CompositionAudioPlan
    static let rate = 48_000
    static func invalid(_ message: String) -> NativeFailure {
        NativeFailure("INVALID_REQUEST", message)
    }
    struct Context {
        let origin: ExactTime
        let sourceStart: Int64
        let sourceEnd: Int64
        let project: Plan.Samples
        let inputFrames: Int64
        let playbackRate: ExactTime
    }
    private static func retainedContexts(
        _ ranges: [Plan.Context], source: SourceTrack,
        clip: Plan.Clip
    ) throws -> [Context] {
        let selected = clip.source.range!
        let sourceDuration = try selected.endUs.subtract(selected.startUs)
        let projectDuration = try clip.placement.endUs.subtract(clip.placement.startUs)
        func product(_ a: Int128, _ b: Int128) throws -> Int128 {
            let value = a.multipliedReportingOverflow(by: b)
            guard !value.overflow else { throw invalid("Retiming exceeds exact arithmetic capacity.") }
            return value.partialValue
        }
        let playbackRate = ExactTime(try product(sourceDuration.numerator, projectDuration.denominator),
            try product(sourceDuration.denominator, projectDuration.numerator))
        func mapped(_ time: ExactTime) throws -> Int64 {
            let delta = try time.subtract(selected.startUs)
            let scaled = ExactTime(try product(delta.numerator, playbackRate.denominator),
                try product(delta.denominator, playbackRate.numerator))
            return try scaled.subtract(ExactTime(-clip.placement.startUs.numerator,
                clip.placement.startUs.denominator)).sample(rate)
        }
        var result: [Context] = []
        var previous = ExactTime(0)
        for compiled in ranges {
            let range = compiled.source
            guard compiled.sampleRange.valid,
                compiled.sampleRange.start == (try mapped(range.startUs)),
                compiled.sampleRange.end == (try mapped(range.endUs))
            else {
                throw invalid("Context sample bounds disagree with its source/project mapping.")
            }
            guard try range.startUs.subtract(previous).numerator >= 0,
                try range.endUs.subtract(range.startUs).numerator > 0
            else {
                throw invalid("Resampling context must be ordered positive source ranges.")
            }
            previous = range.endUs
            for occupied in source.available {
                let physicalStart = occupied.support.startUs
                let physicalEnd = occupied.support.endUs
                let start =
                    try range.startUs.subtract(physicalStart).numerator >= 0
                    ? range.startUs : physicalStart
                let end =
                    try range.endUs.subtract(physicalEnd).numerator <= 0 ? range.endUs : physicalEnd
                guard try end.subtract(start).numerator > 0 else { continue }
                let rawStart = try start.subtract(source.sourceOffsetUs)
                let rawEnd = try end.subtract(source.sourceOffsetUs)
                let sourceStart = try rawStart.subtract(occupied.nativeOrigin).sample(source.sampleRate, nearest: true)
                let sourceEnd = try rawEnd.subtract(occupied.nativeOrigin).sample(source.sampleRate, ceil: true)
                let project = Plan.Samples(
                    start: max(compiled.sampleRange.start, try mapped(start)),
                    end: min(compiled.sampleRange.end, try mapped(end)))
                if sourceEnd > sourceStart, project.end > project.start {
                    result.append(
                        Context(
                            origin: occupied.nativeOrigin, sourceStart: sourceStart, sourceEnd: sourceEnd,
                            project: project, inputFrames: try end.sample(rate) - start.sample(rate),
                            playbackRate: playbackRate))
                }
            }
        }
        return result
    }
    final class Input {
        let source: SourceTrack
        let sources: Sources
        var decoder: AudioSourceReader?
        let contexts: [Context]
        let intervals: [Plan.Samples]
        var prepared: [PreparedRetime]
        let retimeRecipe: (assetId: String, streamId: String, pitch: String)?
        var index = 0
        var conversion: ConvertedAudioInterval?
        var nextPosition: Int64?
        var maximumPreroll: Int64 = 0
        var maximumTail: Int64 = 0
        init(source: SourceTrack, contexts: [Context], intervals: [Plan.Samples], sources: Sources,
             prepared: [PreparedRetime] = [], retimeRecipe: (assetId: String, streamId: String, pitch: String)? = nil) {
            self.prepared = prepared
            self.retimeRecipe = retimeRecipe
            self.sources = sources
            self.source = source
            self.contexts = contexts
            self.intervals = intervals
        }
        private func releaseDecoder() {
            if let decoder {
                sources.record(frames: decoder.decodedFrames, rate: source.sampleRate, channels: source.channels)
            }
            conversion = nil
            decoder = nil
        }
        func suspend() { releaseDecoder(); nextPosition = nil }
        func mix(into samples: inout [Float], position: Int64, count: Int) throws {
            let end = position + Int64(count)
            if nextPosition != position { releaseDecoder() }
            nextPosition = end
            while index < intervals.count {
                let interval = intervals[index]
                if interval.end <= position {
                    index += 1
                    releaseDecoder()
                    continue
                }
                if interval.start >= end { break }
                let first = max(position, interval.start)
                let last = min(end, interval.end)
                if !prepared.isEmpty {
                    guard let run = prepared.first(where: { first >= $0.range.start && last <= $0.range.end }) else {
                        throw invalid("Prepared retiming does not cover readable support.")
                    }
                    try run.mix(into: &samples, at: Int(first - position), position: first, count: Int(last - first))
                    if interval.end <= end { index += 1; continue }
                    break
                }
                if conversion == nil {
                    let desired = first
                    var divisor = source.sampleRate
                    var remainder = rate
                    while remainder != 0 { (divisor, remainder) = (remainder, divisor % remainder) }
                    let inputPeriod = Int64(source.sampleRate / divisor)
                    let outputPeriod = Int64(rate / divisor)
                    guard
                        let contextRange = contexts.first(where: {
                            desired >= $0.project.start && desired < $0.project.end
                        })
                    else {
                        throw NativeFailure.decodeFailed("No retained context at requested sample.")
                    }
                    let segmentStart = contextRange.sourceStart
                    let segmentOutputStart = contextRange.project.start
                    let segmentOutputEnd = contextRange.project.end
                    // Phase is fixed by the compiler's retained run, not a preview window or
                    // clip identity. Converter input never crosses this selected/available run.
                    let context: Int64 = source.sampleRate == rate ? 0 : 1024
                    let periods = max(0, (desired - segmentOutputStart - context) / outputPeriod)
                    let startSample = segmentStart + periods * inputPeriod
                    let outputStart = segmentOutputStart + periods * outputPeriod
                    let skip = desired - outputStart
                    let owed = min(
                        segmentOutputEnd - outputStart, skip + interval.end - first + context)
                    maximumPreroll = max(maximumPreroll, skip)
                    maximumTail = max(maximumTail, max(0, owed - skip - interval.end + first))
                    let reader = AudioSourceReader(input: source.input, asset: source.asset, track: source.track,
                        sampleRate: source.sampleRate, packetFrames: source.packetFrames, channels: source.channels)
                    decoder = reader
                    conversion = try ConvertedAudioInterval(
                        source: source, decoder: reader,
                        origin: contextRange.origin, start: startSample,
                        outputRate: rate, owed: owed, support: .outputDuration(limit: contextRange.sourceEnd))
                    var remaining = skip
                    while remaining > 0 {
                        try Task.checkCancellation()
                        let count = Int(min(remaining, 8192))
                        var discarded = [Float](repeating: 0, count: count)
                        try conversion!.mix(
                            into: &discarded, at: 0, frames: count, gain: 1, channelMap: [0])
                        remaining -= Int64(count)
                    }
                }
                try conversion!.mix(
                    into: &samples, at: Int(first - position), frames: Int(last - first),
                    gain: 1, channelMap: source.channels == 1 ? [0, 0] : [0, 1])
                if interval.end <= end {
                    index += 1
                    releaseDecoder()
                } else {
                    break
                }
            }
        }
    }

    final class Sources {
        var opened: [[String]: SourceTrack] = [:]
        var retimed: [RetimeKey: PreparedRetime] = [:]
        var validatedRetime = Set<RetimeKey>()
        var retimeFormats = Set<[String]>()
        private var decoded: [Int: CompositionAudioReport.SourceWork.Decoded] = [:]
        func record(frames: Int64, rate: Int, channels: Int) {
            guard frames > 0 else { return }
            var value = decoded[rate] ?? .init(sampleRate: rate, frames: 0, float32Bytes: 0)
            value.frames += frames
            value.float32Bytes += frames * Int64(channels) * 4
            decoded[rate] = value
        }
        func report() -> CompositionAudioReport.SourceWork {
            var seen = Set<ObjectIdentifier>()
            var read: Int64 = 0, delivered: Int64 = 0
            var descriptors = 0, unknown = 0
            for source in opened.values where seen.insert(ObjectIdentifier(source.input)).inserted {
                if let work = source.input.readWork {
                    read += work.readBytes
                    delivered += work.deliveredBytes
                    descriptors += 1
                } else { unknown += 1 }
            }
            return .init(preparedRetimeRuns: retimed.count, decoded: decoded.values.sorted { $0.sampleRate < $1.sampleRate },
                descriptorReadBytes: read, descriptorDeliveredBytes: delivered,
                descriptorInputs: descriptors, unknownReadInputs: unknown)
        }
    }
    struct Graph {
        let sources: Sources
        let nodes: [CompositionProcessing]
        let inputs: [String: Input]
        let missing: [CompositionAudioReport.Missing]
        let byTarget: [CompositionProcessing.Target: Int]
        let children: [[Int]]
        let parents: [Int: Int]
        let childOrdinals: [Int: Int]
        let support: [Int: [(Plan.Samples, Bool)]]
        func stream(range: Plan.Samples, target: CompositionProcessing.Target, before: String? = nil,
                    prepared: PreparedState? = nil, reportSourceWork: Bool = false, endStepIndex: Int? = nil) -> Stream {
            Stream(range: range, graph: self, target: target, before: before, prepared: prepared, reportSourceWork: reportSourceWork, endStepIndex: endStepIndex)
        }
    }
    static func graph(_ plan: CompositionAudioPlan, forest: Bool = false,
                      sources: Sources) async throws -> Graph {
        guard plan.range.valid, plan.clips.count <= 10_000, !plan.processing.isEmpty,
            plan.processing.count <= 20_000, plan.assets.count <= 256,
            plan.clips.reduce(0, { $0 + $1.available.count + $1.context.count }) <= 20_000
        else {
            throw invalid("Audio plan exceeds bounds or has an empty range/tree.")
        }
        let clipById = Dictionary(grouping: plan.clips, by: \.clipId)
        guard clipById.values.allSatisfy({ $0.count == 1 }), !clipById.keys.contains("") else {
            throw invalid("Audio clip identities must be unique and nonempty.")
        }
        // Video branches remain compiler-owned but contribute no PCM to an output tap.
        let nodes = plan.processing.filter { $0.mediaKind != "video" }
        guard !nodes.isEmpty else {
            throw invalid("Audio execution requires an audio or output tap.")
        }
        let allTargets = Set(plan.processing.map(\.target))
        guard allTargets.count == plan.processing.count,
            plan.processing.allSatisfy({ node in node.inputs.allSatisfy { allTargets.contains($0) }
            })
        else {
            throw invalid("Processing inputs must name unique known targets.")
        }
        let audioTargets = Set(nodes.map(\.target))
        var seen = Set<CompositionProcessing.Target>()
        var used = Set<CompositionProcessing.Target>()
        var parentTargets: [CompositionProcessing.Target: CompositionProcessing.Target] = [:]
        var stepIds = Set<String>()
        for node in nodes {
            guard ["audio", "output"].contains(node.mediaKind),
                ["clip", "track", "group", "output"].contains(node.target.kind),
                node.target.kind == "output"
                    ? node.target.id == nil : !(node.target.id ?? "").isEmpty,
                seen.insert(node.target).inserted
            else { throw invalid("Invalid processing target.") }
            let inputs = node.inputs.filter { audioTargets.contains($0) }
            guard node.target.kind != "clip" || inputs.isEmpty else {
                throw invalid("Clip processing cannot have inputs.")
            }
            for input in inputs {
                guard input != node.target, seen.contains(input), used.insert(input).inserted else {
                    throw invalid(
                        "Processing must be a child-before-parent tree without shared inputs.")
                }
                parentTargets[input] = node.target
            }
            for step in node.steps {
                guard !step.id.isEmpty, stepIds.insert(step.id).inserted,
                    step.processor.type == "gain" || step.processor.stateRecipe != nil
                else { throw invalid("Unsupported audio processing step.") }
                if step.processor.type == "gain" {
                guard let gain = step.processor.gain else { throw invalid("Missing gain.") }
                switch gain {
                case .constant(let value):
                    guard value.isFinite, value >= 0, value <= Double(Float.greatestFiniteMagnitude)
                    else { throw invalid("Only finite nonnegative float gain is supported.") }
                case .program(let program): try program.validate()
                }
                } else {
                    try step.processor.stateRecipe?.validate()
                    guard step.processor.active != nil else { throw invalid("Missing state activation spans.") }
                    if let mix = step.processor.mix {
                        switch mix {
                        case .constant(let value):
                            guard value.isFinite, value >= 0, value <= 1 else { throw invalid("Denoise mix must be within [0,1].") }
                        case .program(let program): try program.validate()
                        }
                    }
                }
                if let active = step.processor.active {
                    var end: Int64 = 0
                    for span in active {
                        guard span.start >= end, span.end > span.start,
                            span.end <= TimeSpan.maximumMicroseconds
                        else { throw invalid("Invalid gain activation spans.") }
                        end = span.end
                    }
                }
            }
        }
        guard (forest || used.count == nodes.count - 1),
            Set(nodes.filter { $0.target.kind == "clip" }.compactMap { $0.target.id })
                == Set(clipById.keys)
        else { throw invalid("Every audio clip and node must belong to the requested tree.") }
        let assets = Dictionary(grouping: plan.assets, by: { [$0.assetId, $0.streamId] })
        guard assets.values.allSatisfy({ $0.count == 1 }) else {
            throw invalid("Duplicate asset stream.")
        }
        var inputs: [String: Input] = [:]
        var missing: [CompositionAudioReport.Missing] = []
        for clip in plan.clips {
            try Task.checkCancellation()
            guard (clip.sampleRange.valid || (forest && clip.sampleRange.start == clip.sampleRange.end && clip.sampleRange.start >= 0)), clip.sampleRange.start >= plan.range.start,
                clip.sampleRange.end <= plan.range.end, ["preserve", "follow"].contains(clip.pitch)
            else { throw invalid("Invalid compiled clip sample bounds or pitch policy.") }
            guard clip.sampleRange.start >= (try clip.placement.startUs.sample(rate)),
                clip.sampleRange.end <= (try clip.placement.endUs.sample(rate)),
                parentTargets[.init(kind: "clip", id: clip.clipId)] == .init(kind: "track", id: clip.trackId)
                    || (forest ? !used.contains(.init(kind: "clip", id: clip.clipId)) : nodes.last?.target == .init(kind: "clip", id: clip.clipId))
            else {
                throw invalid("Clip bounds or track do not match the compiled placement/tree.")
            }
            var previous = clip.sampleRange.start
            for part in clip.available {
                guard part.valid, part.start >= previous, part.end <= clip.sampleRange.end else {
                    throw invalid("Availability must be ordered within clip sample bounds.")
                }
                previous = part.end
            }
            if clip.source.kind == "silence" {
                guard clip.source.assetId == nil, clip.source.streamId == nil,
                    clip.source.range == nil, clip.context.isEmpty
                else {
                    throw invalid("Authored silence has no media identity.")
                }
                continue
            }
            guard clip.source.kind == "range", let assetId = clip.source.assetId,
                let streamId = clip.source.streamId, let range = clip.source.range,
                let asset = assets[[assetId, streamId]]?.first,
                asset.path.hasPrefix("/"), !asset.path.contains("\0"),
                try asset.originUs.compare(ExactTime(-Int128(TimeSpan.maximumMicroseconds))) != .orderedAscending,
                try asset.originUs.compare(ExactTime(Int128(TimeSpan.maximumMicroseconds))) != .orderedDescending
            else {
                throw invalid("A range clip requires its resolved absolute asset stream.")
            }
            let duration = try range.endUs.subtract(range.startUs)
            let placementDuration = try clip.placement.endUs.subtract(clip.placement.startUs)
            guard duration.numerator > 0, placementDuration.numerator > 0 else {
                throw invalid("Source and placement ranges must be positive.")
            }
            let retiming = !duration.equals(placementDuration)
            let source: SourceTrack
            if let existing = sources.opened[[assetId, streamId]] {
                source = existing
            } else {
                source = try await SourceTrack.open(selection: AudioSourceSelection(
                    source: asset.path, streamId: streamId,
                    sourceOffsetUs: ExactTime(0).subtract(asset.originUs),
                    available: [ExactRange(startUs: 0, endUs: TimeSpan.maximumMicroseconds)]))
                sources.opened[[assetId, streamId]] = source
            }
            if retiming, sources.retimeFormats.insert([assetId, streamId]).inserted {
                try SourceTrack.validateWindowFormats(try await source.track.load(.formatDescriptions))
            }
            guard source.channels <= 2 else {
                throw NativeFailure(
                    "UNSUPPORTED_FORMAT", "Audio needs an explicit map for more than two channels.")
            }
            let contexts = try retainedContexts(clip.context, source: source, clip: clip)
            if retiming {
                for context in contexts {
                    let key = RetimeKey(assetId: assetId, streamId: streamId, source: source, context: context, pitch: clip.pitch)
                    if sources.validatedRetime.insert(key).inserted {
                        try validateRetime(source: source, context: context, pitch: clip.pitch)
                    }
                }
            }
            let occupied = contexts.map(\.project)
            var readable: [Plan.Samples] = []
            var cursor = 0
            for available in clip.available {
                while cursor < occupied.count && occupied[cursor].end <= available.start {
                    cursor += 1
                }
                var index = cursor
                while index < occupied.count && occupied[index].start < available.end {
                    let first = max(available.start, occupied[index].start)
                    let last = min(available.end, occupied[index].end)
                    if first < last { readable.append(.init(start: first, end: last)) }
                    index += 1
                }
            }
            var absent: [Plan.Samples] = []
            let required = clip.required ?? [clip.sampleRange]
            var requiredEnd = clip.sampleRange.start
            for span in required {
                guard span.valid, span.start >= requiredEnd, span.end <= clip.sampleRange.end else {
                    throw invalid("Required support must be ordered within clip bounds.")
                }
                requiredEnd = span.end
                var position = span.start
                for part in readable where part.end > position && part.start < span.end {
                    if position < part.start { absent.append(.init(start: position, end: min(part.start, span.end))) }
                    position = min(span.end, max(position, part.end))
                }
                if position < span.end { absent.append(.init(start: position, end: span.end)) }
            }
            missing.append(.init(clipId: clip.clipId, ranges: absent))
            inputs[clip.clipId] = Input(
                source: source, contexts: contexts, intervals: readable, sources: sources,
                retimeRecipe: retiming ? (assetId, streamId, clip.pitch) : nil)
        }
        let byTarget = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.target, $0.offset) })
        let children = nodes.map { $0.inputs.compactMap { byTarget[$0] } }
        var parents: [Int: Int] = [:], childOrdinals: [Int: Int] = [:]
        for (parent, children) in children.enumerated() {
            for (ordinal, child) in children.enumerated() { parents[child] = parent; childOrdinals[child] = ordinal }
        }
        var support: [Int: [(Plan.Samples, Bool)]] = [:]
        for clip in plan.clips {
            guard let node = byTarget[.init(kind: "clip", id: clip.clipId)] else { continue }
            if let input = inputs[clip.clipId] { support[node] = input.intervals.map { ($0, true) } }
            else { support[node] = [(clip.sampleRange, false)] }
        }
        return Graph(sources: sources, nodes: nodes, inputs: inputs, missing: missing, byTarget: byTarget,
            children: children, parents: parents, childOrdinals: childOrdinals, support: support)
    }

    public static func open(_ plan: CompositionAudioPlan, held: [HeldState] = []) async throws -> Stream {
        try validateRetimeBinding(plan)
        let sources = Sources()
        let state = try await resolveState(plan, sources: sources)
        let graph = try await graph(plan, sources: sources)
        if let state { try prepareRetime(state.graph, parent: URL(fileURLWithPath: plan.output).deletingLastPathComponent()) }
        try prepareRetime(graph, parent: URL(fileURLWithPath: plan.output).deletingLastPathComponent())
        let prepared = try await prepareState(state, output: plan.output, held: held)
        return graph.stream(range: plan.range, target: graph.nodes.last!.target, prepared: prepared, reportSourceWork: true)
    }

    /// Prepares one bounded PCM source; neither the consumer nor a preview window owns its phase.
    public final class Stream: AudioPCMSource {
        public let format = AudioPCMFormat(sampleRate: rate, channels: 2, layout: .stereo)
        public private(set) var report: CompositionAudioReport?
        private let range: Plan.Samples
        private let graph: Graph
        private var inputs: [Int: Input] = [:]
        private let target: CompositionProcessing.Target
        private let before: String?
        private let endStepIndex: Int?
        private let prepared: PreparedState?
        private let reportSourceWork: Bool
        private var consumed = false

        init(
            range: Plan.Samples, graph: Graph, target: CompositionProcessing.Target,
            before: String?, prepared: PreparedState?, reportSourceWork: Bool, endStepIndex: Int?
        ) {
            self.range = range
            self.graph = graph
            self.target = target
            self.before = before
            self.endStepIndex = endStepIndex
            self.prepared = prepared
            self.reportSourceWork = reportSourceWork
        }
        public func consume(_ sink: (AudioPCMBlock) async throws -> Void) async throws {
            guard !consumed else { throw invalid("Composition PCM can only be consumed once.") }
            consumed = true
            let nodes = graph.nodes, children = graph.children
            defer { for input in inputs.values { input.suspend() } }
            guard let root = graph.byTarget[target] else { throw invalid("Unknown audio view target.") }
            let endpoint: Int
            if let endStepIndex {
                guard endStepIndex >= 0 && endStepIndex <= nodes[root].steps.count else {
                    throw invalid("Audio prefix endpoint exceeds its compiled stack.")
                }
                endpoint = endStepIndex
            } else if let before {
                guard let index = nodes[root].steps.firstIndex(where: { $0.id == before }) else {
                    throw invalid("Unknown exclusive audio prefix endpoint.")
                }
                endpoint = index
            } else { endpoint = nodes[root].steps.count }
            var viewNodes: [Int] = [], pendingNodes = [root]
            while let index = pendingNodes.popLast() {
                viewNodes.append(index)
                pendingNodes.append(contentsOf: children[index])
            }
            let limits = Dictionary(uniqueKeysWithValues: viewNodes.map {
                ($0, $0 == root ? endpoint : nodes[$0].steps.count)
            })
            // Index replacement changes once; each block visits only its needed routing subtree.
            typealias Event = (at: Int64, node: Int, step: Int, span: PreparedState.Span?)
            var events: [Event] = []
            var boundarySet = Set<Int64>()
            var supportEvents: [(at: Int64, node: Int, delta: Int, readable: Bool)] = []
            func support(_ node: Int, _ span: Plan.Samples, readable: Bool = false) {
                guard span.end > span.start else { return }
                supportEvents.append((span.start, node, 1, readable))
                supportEvents.append((span.end, node, -1, readable))
                boundarySet.insert(span.start); boundarySet.insert(span.end)
            }
            for index in viewNodes {
                for (span, readable) in graph.support[index] ?? [] { support(index, span, readable: readable) }
                let node = nodes[index]
                for (stepIndex, step) in node.steps.prefix(limits[index]!).enumerated() where step.enabled {
                    for span in prepared?.spans[step.id] ?? [] {
                        events.append((span.range.start, index, stepIndex, span))
                        events.append((span.range.end, index, stepIndex, nil))
                        support(index, span.range)
                    }
                    if step.processor.stateRecipe != nil {
                        for span in step.processor.active ?? [] { support(index, .init(start: span.start, end: span.end)) }
                    } else if step.processor.type == "gain", let gain = step.processor.gain,
                        gain.constant == nil || gain.constant!.sign == .minus {
                        // Curves can fail validation and negative-zero gain can change silent bits.
                        // Keep their authored activity even when no source contributes samples.
                        if let active = step.processor.active {
                            for span in active { support(index, .init(start: span.start, end: span.end)) }
                        } else { support(index, range) }
                    }
                }
            }
            events.sort { a, b in a.at != b.at ? a.at < b.at : a.span == nil && b.span != nil }
            supportEvents.sort { $0.at < $1.at }
            var supportIndex = 0
            var readableCounts = [Int: Int]()
            var supportCounts = [Int: Int]()
            var activeChildren = [Int: Set<Int>]()
            func changeSupport(_ node: Int, _ delta: Int) {
                var current = node
                while true {
                    let old = supportCounts[current] ?? 0
                    supportCounts[current, default: 0] += delta
                    guard current != root, let parent = graph.parents[current] else { break }
                    if old == 0 && supportCounts[current]! > 0 { activeChildren[parent, default: []].insert(current) }
                    if old > 0 && supportCounts[current]! == 0 { activeChildren[parent]?.remove(current) }
                    current = parent
                }
            }
            var eventIndex = 0
            var active = [Int: [Int: PreparedState.Span]]()
            var latest = [Int: (Int, PreparedState.Span)]()
            let boundaries = boundarySet.filter { $0 > range.start && $0 < range.end }.sorted()
            var boundaryIndex = 0
            var maximumBlockFrames = 0
            var liveInputs = Set<Int>()
            var schedule: [Int] = []
            var scheduledChildren: [Int: [Int]] = [:]
            var chosen: [Int: (Int, PreparedState.Span)] = [:]
            var scheduledAt: Int64? = nil
            var peak: Float = 0
            var clipped: Int64 = 0
            do {
                var position = range.start
                while position < range.end {
                    try Task.checkCancellation()
                    while boundaryIndex < boundaries.count && boundaries[boundaryIndex] <= position { boundaryIndex += 1 }
                    let end = min(range.end, boundaryIndex < boundaries.count ? boundaries[boundaryIndex] : range.end)
                    if scheduledAt == nil || scheduledAt! <= position {
                        while supportIndex < supportEvents.count && supportEvents[supportIndex].at <= position {
                            let event = supportEvents[supportIndex]
                            changeSupport(event.node, event.delta)
                            if event.readable { readableCounts[event.node, default: 0] += event.delta }
                            supportIndex += 1
                        }
                        while eventIndex < events.count && events[eventIndex].at <= position {
                            let (_, node, step, span) = events[eventIndex]
                            active[node, default: [:]][step] = span
                            latest[node] = active[node]?.max(by: { $0.key < $1.key }).map { ($0.key, $0.value) }
                            eventIndex += 1
                        }
                        chosen.removeAll(keepingCapacity: true)
                        scheduledChildren.removeAll(keepingCapacity: true)
                        var needed = Set<Int>(), pending = [root]
                        while let index = pending.popLast() {
                            guard needed.insert(index).inserted else { continue }
                            if let span = latest[index] { chosen[index] = span }
                            else {
                                let active = (activeChildren[index] ?? []).sorted { graph.childOrdinals[$0]! < graph.childOrdinals[$1]! }
                                scheduledChildren[index] = active
                                pending.append(contentsOf: active)
                            }
                        }
                        schedule = needed.sorted()
                        let selectedInputs = Set(schedule.filter {
                            chosen[$0] == nil && (readableCounts[$0] ?? 0) > 0
                        })
                        for index in liveInputs.subtracting(selectedInputs) { inputs[index]?.suspend() }
                        guard selectedInputs.count <= 256 else {
                            throw invalid("Audio view exceeds 256 simultaneously active source occurrences.")
                        }
                        liveInputs = selectedInputs
                        scheduledAt = end
                    }
                    // Only active routing buffers consume this budget; timeline metadata is separate.
                    let blockFrames = max(1, min(8192, 1_048_576 / schedule.count))
                    let count = Int(min(Int64(blockFrames), end - position))
                    maximumBlockFrames = max(maximumBlockFrames, count)
                    var buffers: [Int: [Float]] = [:]
                    for index in schedule {
                        try Task.checkCancellation()
                        let node = nodes[index]
                        var samples: [Float]
                        let firstStep: Int
                        if let (step, span) = chosen[index] {
                            samples = try prepared!.read(span, position: position, count: count)
                            firstStep = step + 1
                        } else {
                            samples = [Float](repeating: 0, count: count * 2)
                            firstStep = 0
                            if node.target.kind == "clip", let id = node.target.id {
                                if liveInputs.contains(index), inputs[index] == nil, let template = graph.inputs[id] {
                                    inputs[index] = Input(source: template.source, contexts: template.contexts, intervals: template.intervals, sources: graph.sources, prepared: template.prepared)
                                }
                                if liveInputs.contains(index), let input = inputs[index] {
                                    try input.mix(into: &samples, position: position, count: count)
                                }
                            } else {
                                var combined: [Float]?
                                for child in scheduledChildren[index] ?? [] {
                                    guard let input = buffers.removeValue(forKey: child) else { continue }
                                    if combined == nil { combined = input }
                                    else { for sample in input.indices { combined![sample] += input[sample] } }
                                }
                                if let combined { samples = combined }
                                // Every omitted child is proven +0. Preserve its IEEE addition effect.
                                if (scheduledChildren[index]?.count ?? 0) < children[index].count {
                                    for sample in samples.indices where samples[sample] == 0 { samples[sample] = 0 }
                                }
                            }
                        }
                        for step in node.steps[firstStep..<limits[index]!] where step.enabled {
                            if step.processor.type == "gain" {
                                try applyGain(step.processor, to: &samples, position: position)
                            } else if step.processor.stateRecipe != nil,
                                (step.processor.active ?? []).contains(where: { $0.start <= position && position < $0.end }) {
                                throw invalid("Active state processor has no prepared coverage.")
                            }
                        }
                        buffers[index] = samples
                    }
                    let samples = buffers[root] ?? [Float](repeating: 0, count: count * 2)
                    var sampleIndex = 0
                    while sampleIndex < samples.count {
                        let sample = samples[sampleIndex]
                        guard sample.isFinite else {
                            throw NativeFailure(
                                "INVALID_AUDIO", "Processing produced nonfinite PCM.")
                        }
                        peak = max(peak, abs(sample))
                        if abs(sample) > 1 { clipped += 1 }
                        sampleIndex += 1
                    }
                    try await sink(
                        AudioPCMBlock(
                            startFrame: position - range.start, frameCount: count, samples: samples)
                    )
                    position += Int64(count)
                }
            }
            try Task.checkCancellation()
            for input in inputs.values { input.suspend() }
            report = CompositionAudioReport(
                sampleRate: rate, channels: 2,
                frames: range.end - range.start, peak: Double(peak), clippedSamples: clipped,
                maximumBlockFrames: maximumBlockFrames,
                peakResidentBytes: ProcessResources.peakResidentBytes(),
                decoderContext: .init(
                    policy: "bounded-current-retained-run", sampleRate: rate,
                    maximumPrerollFrames: max(inputs.values.map(\.maximumPreroll).max() ?? 0, prepared?.maximumPreroll ?? 0),
                    maximumTailFrames: max(inputs.values.map(\.maximumTail).max() ?? 0, prepared?.maximumTail ?? 0)),
                sourceWork: reportSourceWork ? graph.sources.report() : nil, unavailable: graph.missing)
        }
    }

    public static func write(_ plan: CompositionAudioPlan, held: [HeldState] = []) async throws -> CompositionAudioResult {
        let stream = try await open(plan, held: held)
        let writer = try AudioWaveWriter(
            sampleRate: rate, frames: plan.range.end - plan.range.start, channels: 2,
            output: URL(fileURLWithPath: plan.output),
            sources: plan.assets.map { URL(fileURLWithPath: $0.path) })
        defer { writer.discard() }
        try await stream.consume { try writer.write($0) }
        try Task.checkCancellation()
        let bytes = try writer.finish()
        return CompositionAudioResult(file: plan.output, bytes: bytes, report: stream.report!)
    }
}
