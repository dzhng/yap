import Foundation
import Darwin
import YapDenoise
import YapMedia

extension CompositionAudio {
    /// Identifies the compiled model and the complete fixed sample recipe, not a selectable quality preset.
    public static let rnnoiseImplementation = "rnnoise-70f1d256-d6021b7697677c4d2274c912975e143765552b0e6f25500aa660fdb4a9849be5-f480-s32768-flush2-delay960-independent-channels-v2"

    public static let statePreparationImplementation = "native-audio-state-domains-v1"
    public struct HeldState {
        let domainIndex: Int
        let recipe: AudioStateRecipe
        let sampleRange: Plan.Samples
        let source: RetainedPCMSource
        public init(domainIndex: Int, recipe: AudioStateRecipe, sampleRange: CompositionAudioPlan.Samples, source: RetainedPCMSource) {
            self.domainIndex = domainIndex; self.recipe = recipe; self.sampleRange = sampleRange; self.source = source
        }
    }
    final class PreparedState {
        struct Span {
            let range: Plan.Samples
            enum Storage { case planar(UInt64, UInt64); case retained(RetainedPCMSource, Int64) }
            let storage: Storage
        }
        let directory: URL
        let input: FileHandle
        let output: FileHandle
        var spans: [String: [Span]] = [:]
        var maximumPreroll: Int64 = 0
        var maximumTail: Int64 = 0
        init(parent: URL) throws {
            directory = parent.appendingPathComponent(".audio-state-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            do {
                let a = directory.appendingPathComponent("input.f32")
                let b = directory.appendingPathComponent("output.f32")
                guard FileManager.default.createFile(atPath: a.path, contents: nil),
                    FileManager.default.createFile(atPath: b.path, contents: nil) else {
                    throw invalid("Cannot create state scratch files.")
                }
                input = try FileHandle(forUpdating: a)
                output = try FileHandle(forUpdating: b)
            } catch {
                try? FileManager.default.removeItem(at: directory)
                throw error
            }
        }
        deinit {
            try? input.close()
            try? output.close()
            try? FileManager.default.removeItem(at: directory)
        }
        func read(_ span: Span, position: Int64, count: Int) throws -> [Float] {
            // FileHandle's Objective-C temporaries must drain per chunk, not per full program.
            try autoreleasepool {
                guard position >= span.range.start, position + Int64(count) <= span.range.end else {
                    throw invalid("Prepared state read exceeds its component.")
                }
                if case .retained(let source, let fileStart) = span.storage {
                    return try source.readFrames(position: fileStart + position - span.range.start, count: count)
                }
                guard case .planar(let left, let right) = span.storage else { throw invalid("Unknown prepared storage.") }
                var result = [Float](repeating: 0, count: count * 2)
                for (channel, offset) in [left, right].enumerated() {
                    try output.seek(toOffset: offset + UInt64(position - span.range.start) * 4)
                    let data = try output.read(upToCount: count * 4) ?? Data()
                    guard data.count == count * 4 else { throw invalid("Prepared state PCM is truncated.") }
                    data.withUnsafeBytes { bytes in
                        for index in 0..<count {
                            result[index * 2 + channel] = bytes.loadUnaligned(fromByteOffset: index * 4, as: Float.self)
                        }
                    }
                }
                return result
            }
        }
    }

    struct StatePreparation {
        let state: Plan.State
        let nodes: [CompositionProcessing.Target: [CompositionProcessing]]
        let order: [Int]
        let graph: Graph
    }
    static func resolveState(_ plan: Plan, sources: Sources) async throws -> StatePreparation? {
        guard let state = plan.state else { return nil }
        if plan.statePreparationImplementationId != nil || state.domains.contains(where: { $0.recipe != .rnnoise && $0.sampleRange.end > $0.sampleRange.start }) {
            guard plan.statePreparationImplementationId == statePreparationImplementation else {
                throw NativeFailure(plan.statePreparationImplementationId == nil ? "INTERNAL_ERROR" : "PINNED_IMPLEMENTATION_UNAVAILABLE", "The bound audio state preparation implementation is unavailable.")
            }
        }
        guard state.implementationId == rnnoiseImplementation, !state.domains.isEmpty,
            state.domains.count <= 20_000, state.domains.reduce(0, { $0 + $1.members.count }) <= 20_000, state.formats.count <= 10_000 else {
            throw invalid("Unknown RNNoise implementation or invalid state plan bounds.")
        }
        let nodes = Dictionary(grouping: state.processing, by: \.target)
        guard nodes.values.allSatisfy({ $0.count == 1 }) else { throw invalid("Duplicate state target.") }
        var memberships: [String: [Plan.Samples]] = [:]
        for (index, domain) in state.domains.enumerated() {
            try Task.checkCancellation()
            try domain.recipe.validate()
            guard domain.sampleRange.start >= 0, domain.sampleRange.end >= domain.sampleRange.start,
                domain.sampleRange.end <= TimeSpan.maximumMicroseconds, !domain.members.isEmpty,
                domain.dependencies.allSatisfy({ $0 >= 0 && $0 < state.domains.count && $0 != index }),
                Set(domain.dependencies).count == domain.dependencies.count else {
                throw invalid("State components must have bounded samples and valid dependencies.")
            }
            var position = domain.sampleRange.start
            for member in domain.members {
                guard member.sampleRange.start == position, member.sampleRange.end >= position,
                    member.sampleRange.end <= domain.sampleRange.end,
                    let node = nodes[member.target]?.first,
                    let step = node.steps.first(where: { $0.id == member.stepId }),
                    step.enabled, let recipe = step.processor.stateRecipe,
                    domain.recipe.matches(recipe, memberTarget: member.target, detectorTarget: member.detector?.target,
                                          beforeStepIndex: member.detector?.beforeStepIndex) else {
                    throw invalid("State members must cover their component with the bound recipe.")
                }
                let requiresDetector: Bool
                if case .compressor(let recipe) = domain.recipe { requiresDetector = recipe.detector.kind != "input" }
                else { requiresDetector = false }
                guard requiresDetector == (member.detector != nil) else { throw invalid("State detector membership is incomplete.") }
                if let detector = member.detector {
                    guard let endpoint = nodes[detector.target]?.first, detector.beforeStepIndex >= 0,
                        detector.beforeStepIndex <= endpoint.steps.count,
                        endpoint.mediaKind == "audio" || endpoint.mediaKind == "output" else {
                        throw invalid("State detector endpoint differs from its compiled audio graph.")
                    }
                    if case .compressor(let recipe) = domain.recipe, recipe.detector.kind == "tap" {
                        guard recipe.detector.tap?.target == detector.target else { throw invalid("State detector target differs from its recipe.") }
                    }
                }
                position = member.sampleRange.end
                memberships[member.stepId, default: []].append(member.sampleRange)
            }
            guard position == domain.sampleRange.end else { throw invalid("State members do not cover their component.") }
        }
        var byStep: [String: [(Int, Plan.Samples)]] = [:]
        for (index, domain) in state.domains.enumerated() {
            try Task.checkCancellation()
            for member in domain.members { byStep[member.stepId, default: []].append((index, member.sampleRange)) }
        }
        for node in state.processing {
            for step in node.steps where step.enabled && step.processor.stateRecipe != nil {
                let expected = (byStep[step.id] ?? []).map { $0.1 }.filter { $0.end > $0.start }.sorted { $0.start < $1.start }
                let actual = (step.processor.active ?? []).map { Plan.Samples(start: $0.start, end: $0.end) }
                guard expected == actual else { throw invalid("State activation differs from component membership.") }
            }
        }
        var order: [Int] = []
        var status = [UInt8](repeating: 0, count: state.domains.count)
        for start in state.domains.indices where status[start] == 0 {
            var pending = [(start, 0)]
            status[start] = 1
            while let (index, next) = pending.last {
                try Task.checkCancellation()
                if next == state.domains[index].dependencies.count {
                    status[index] = 2
                    order.append(index)
                    pending.removeLast()
                } else {
                    let dependency = state.domains[index].dependencies[next]
                    pending[pending.count - 1].1 += 1
                    guard status[dependency] != 1 else { throw invalid("State dependency cycle.") }
                    if status[dependency] == 0 { status[dependency] = 1; pending.append((dependency, 0)) }
                }
            }
        }
        for ranges in memberships.values {
            var previous: Int64 = 0
            for range in ranges.sorted(by: { $0.start < $1.start }) {
                guard range.start >= previous else { throw invalid("Overlapping state membership.") }
                previous = range.end
            }
        }
        // The forest is opened once. Every view clones decoder cursors, retaining one validated
        // source binding and the compiler's existing resampling-context policy.
        let bounds = Plan.Samples(start: 0, end: max(1, state.domains.map(\.sampleRange.end).max() ?? 1))
        let prerequisite = Plan(output: plan.output, range: bounds, clips: state.clips,
            processing: state.processing, assets: plan.assets)
        let graph = try await graph(prerequisite, forest: true, sources: sources)
        // The compiler splits state domains at every source gap, so a plan whose state still
        // requires unavailable support is malformed; state never learns across a gap.
        guard graph.missing.allSatisfy({ $0.ranges.isEmpty }) else {
            throw invalid("Compiled state domains require unavailable source support.")
        }
        var formats: [[String]: Plan.State.Format] = [:]
        for format in state.formats {
            let key = [format.assetId, format.streamId]
            if let previous = formats[key], previous.channels != format.channels || previous.sampleRate != format.sampleRate {
                throw invalid("Conflicting source format provenance.")
            }
            formats[key] = format
        }
        for (key, source) in sources.opened {
            guard let format = formats[key], (source.channels == 1 || source.channels == 2),
                format.channels == source.channels, format.sampleRate == source.sampleRate else {
                throw NativeFailure("NOT_READY", "State processing requires verified mono or stereo provenance matching the opened stream.")
            }
        }
        return StatePreparation(state: state, nodes: nodes, order: order, graph: graph)
    }

    static func prepareState(_ resolution: StatePreparation?, output: String, held: [HeldState] = [], selected: Set<Int>? = nil) async throws -> PreparedState? {
        guard let resolution else {
            guard held.isEmpty else { throw invalid("Held state has no compiled state plan.") }
            return nil
        }
        let state = resolution.state, nodes = resolution.nodes, order = resolution.order, graph = resolution.graph
        var heldByDomain: [Int: HeldState] = [:]
        for span in held {
            guard state.domains.indices.contains(span.domainIndex), heldByDomain[span.domainIndex] == nil else {
                throw invalid("Held state must identify distinct compiled domains.")
            }
            let domain = state.domains[span.domainIndex]
            guard domain.recipe != .rnnoise, span.recipe == domain.recipe, span.sampleRange == domain.sampleRange,
                span.source.frameCount == domain.sampleRange.end - domain.sampleRange.start else {
                throw invalid("Held state recipe, range or count differs from its compiled domain.")
            }
            heldByDomain[span.domainIndex] = span
        }
        let prepared = try PreparedState(parent: URL(fileURLWithPath: output).deletingLastPathComponent())
        for index in order {
            if let selected, !selected.contains(index) { continue }
            let domain = state.domains[index]
            try Task.checkCancellation()
            let count = domain.sampleRange.end - domain.sampleRange.start
            if count == 0 { continue }
            if domain.recipe != .rnnoise {
                guard let span = heldByDomain[index] else {
                    throw NativeFailure("NOT_READY", "The compiled state domain has no held prepared coverage.")
                }
                for member in domain.members where member.sampleRange.end > member.sampleRange.start {
                    prepared.spans[member.stepId, default: []].append(.init(range: member.sampleRange,
                        storage: .retained(span.source, member.sampleRange.start - domain.sampleRange.start)))
                }
                continue
            }
            try prepared.input.truncate(atOffset: 0)
            try prepared.input.seek(toOffset: 0)
            var received: Int64 = 0
            for member in domain.members where member.sampleRange.end > member.sampleRange.start {
                let stream = graph.stream(range: member.sampleRange, target: member.target,
                    before: member.stepId, prepared: prepared)
                try await stream.consume { block in
                    try block.samples.withUnsafeBytes { try prepared.input.write(contentsOf: $0) }
                    received += Int64(block.frameCount)
                }
                prepared.maximumPreroll = max(prepared.maximumPreroll, stream.report?.decoderContext.maximumPrerollFrames ?? 0)
                prepared.maximumTail = max(prepared.maximumTail, stream.report?.decoderContext.maximumTailFrames ?? 0)
            }
            guard received == count, try prepared.input.offset() == UInt64(count) * 8 else {
                throw invalid("State prefix sample count differs from component.")
            }
            let mixes = domain.members.map { member in
                nodes[member.target]!.first!.steps.first(where: { $0.id == member.stepId })!.processor.mix
            }
            let fullWet = mixes.allSatisfy { $0 == nil || $0?.constant == 1 }
            var offsets: [UInt64] = []
            // The rendition has two lanes, each with its own instance of the fixed mono algorithm;
            // no component is exposed if either lane fails or cancellation interrupts the pair.
            for channel in 0..<2 {
                try Task.checkCancellation()
                try prepared.input.seek(toOffset: 0)
                let offset = try prepared.output.seekToEnd()
                var written: Int64 = 0
                var memberIndex = 0
                try RNNoiseProcessor.process(sampleCount: count, sampleRate: rate, channels: 1, read: { buffer in
                    try autoreleasepool {
                        let data = try prepared.input.read(upToCount: buffer.count * 8) ?? Data()
                        guard data.count % 8 == 0 else { throw invalid("Unaligned stereo state input PCM.") }
                        data.withUnsafeBytes { bytes in
                            for index in 0..<(bytes.count / 8) {
                                buffer[index] = bytes.loadUnaligned(fromByteOffset: index * 8 + channel * 4, as: Float.self)
                            }
                        }
                        return data.count / 8
                    }
                }, write: { buffer in
                    try autoreleasepool {
                        if fullWet {
                            try prepared.output.write(contentsOf: Data(buffer: buffer))
                        } else {
                            // Positional reads preserve the adapter's independent read cursor and
                            // pair latency-aligned output with the exact ordered upstream signal.
                            var dry = [Float](repeating: 0, count: buffer.count * 2)
                            try dry.withUnsafeMutableBytes { bytes in
                                var copied = 0
                                while copied < bytes.count {
                                    let received = pread(prepared.input.fileDescriptor,
                                        bytes.baseAddress!.advanced(by: copied), bytes.count - copied,
                                        off_t(written * 8 + Int64(copied)))
                                    if received < 0 && errno == EINTR { continue }
                                    guard received > 0 else { throw invalid("Denoise dry input is unreadable or truncated.") }
                                    copied += received
                                }
                            }
                            var mixed = Array(buffer)
                            for frame in buffer.indices {
                                let position = domain.sampleRange.start + written + Int64(frame)
                                while domain.members[memberIndex].sampleRange.end <= position { memberIndex += 1 }
                                let amount = mixes[memberIndex]?.sample(position) ?? 1
                                guard amount.isFinite, amount >= 0, amount <= 1 else {
                                    throw invalid("Denoise mix produced a value outside [0,1].")
                                }
                                if amount == 0 { mixed[frame] = dry[frame * 2 + channel] }
                                else if amount != 1 {
                                    mixed[frame] = Float((1 - amount) * Double(dry[frame * 2 + channel]) + amount * Double(buffer[frame]))
                                }
                            }
                            try mixed.withUnsafeBytes { try prepared.output.write(contentsOf: $0) }
                        }
                    }
                    written += Int64(buffer.count)
                }, checkCancellation: { try Task.checkCancellation() })
                guard written == count, try prepared.output.offset() == offset + UInt64(count) * 4 else {
                    throw invalid("State lane output count differs from component.")
                }
                offsets.append(offset)
            }
            for member in domain.members where member.sampleRange.end > member.sampleRange.start {
                let displacement = UInt64(member.sampleRange.start - domain.sampleRange.start) * 4
                prepared.spans[member.stepId, default: []].append(.init(range: member.sampleRange,
                    storage: .planar(offsets[0] + displacement, offsets[1] + displacement)))
            }
        }
        return prepared
    }
}
