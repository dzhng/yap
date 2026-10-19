import Darwin
import CryptoKit
import Foundation
import YapMedia

public struct CaptureJournalHeader: Codable, Sendable {
    public init(
        schemaVersion: Int, sessionID: String, source: CaptureSource, width: Int, height: Int,
        microphone: Bool, systemAudio: Bool, cameraBinding: CameraCaptureBinding? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.sessionID = sessionID
        self.source = source
        self.width = width
        self.height = height
        self.microphone = microphone
        self.systemAudio = systemAudio
        self.cameraBinding = cameraBinding
    }

    public let schemaVersion: Int
    public let sessionID: String
    public let source: CaptureSource
    public let width: Int
    public let height: Int
    public let microphone: Bool
    public let systemAudio: Bool
    public let cameraBinding: CameraCaptureBinding?

    /// Whether the take asked for this role at all. A take always records video; audio roles are
    /// requested per take, and a role the header never asked for cannot have been lost.
    public func requested(_ role: String) -> Bool {
        switch role {
        case "narration": return microphone
        case "system": return systemAudio
        default: return true
        }
    }
}

public struct CaptureJournalSummary: Codable, Sendable {
    public let file = "capture.journal.jsonl"
    enum CodingKeys: String, CodingKey {
        case file, header, originHostUs, pauses, openPauseHostUs, lastLifecycle, lastSequence,
            incompleteTail,
            invalidAtSequence, finished, completion, cursorSamples, firstCursorSourceUs,
            lastCursorSourceUs,
            geometryEpochs, lastGeometry, zeroOriginHeight
    }
    public var header: CaptureJournalHeader?
    public var originHostUs: Int64?
    public var pauses: [PauseEvent] = []
    public var acquiredAudio: [String: [TimeSpan]] = [:]
    public var openPauseHostUs: Int64?
    /// Cursor evidence stays a count and a range here. A consumer that needs the samples
    /// themselves streams the journal file; a summary never grows with recording length.
    public var cursorSamples = 0
    public var firstCursorSourceUs: Int64?
    public var lastCursorSourceUs: Int64?
    public var geometryEpochs = 0
    public var lastGeometry: CaptureGeometry?
    /// The zero-origin display height the take last converted its pointer readings through, so a
    /// consumer checks the transform against the height this recording used rather than the one
    /// the display arrangement happens to have now.
    public var zeroOriginHeight: Double?
    /// The transition this take last reported to its service, and the journal sequence that
    /// reported it. A journal read after a crash shows what native last claimed, in the same
    /// numbering the live reports used.
    public var lastLifecycle: JournalLifecycle?
    public var lastSequence = 0
    /// The final line has no terminator: a crash cut the journal mid-record.
    public var incompleteTail = false
    /// A whole, terminated record would not decode. Records before it stand; nothing after it was
    /// read. Distinct from `incompleteTail` because a crash boundary and a corrupt record mean
    /// different things to a consumer deciding whether the take ended.
    public var invalidAtSequence: Int?
    public var finished = false
    public var completion: JournalCompletion?
    /// Internal mapping provenance; ordinary inspection never publishes this as acquisition.
    package var validatedPrefix: JournalPrefix?

    public init() {}
}

package struct JournalPrefix: Codable, Sendable, Equatable {
    @JournalInteger package var bytes: Int64
    package let sha256: String
    package init(bytes: Int64, sha256: String) { self.bytes = bytes; self.sha256 = sha256 }
}

// One capture queue owns append order. Media bytes never enter this journal.
public final class CaptureJournal {
    private static let maximumRecordBytes = 1_048_576
    private let handle: FileHandle
    package let lease: CaptureJournalLease
    private var sequence = 0
    private let header: CaptureJournalHeader
    package var schemaVersion: Int { header.schemaVersion }
    private var pcmState = JournalPCMState()

    public init(directory: String, header: CaptureJournalHeader) throws {
        self.header = header
        lease = try CaptureJournalLease.create(directory: directory)
        handle = FileHandle(fileDescriptor: lease.descriptor, closeOnDealloc: false)
        try append("header", data: header, durable: true)
    }

    package func recordPCMOrigin(_ origin: JournalPCMOrigin, placedPauses: [PauseEvent] = []) throws {
        var next = pcmState
        guard header.schemaVersion == 2 || header.schemaVersion == 3 else {
            throw CaptureFailure("INVALID_JOURNAL", "PCM mappings require schema2 or schema3.")
        }
        try next.origin(origin)
        try append("pcmOrigin", data: origin, durable: true)
        pcmState = next
        for pause in placedPauses { try append("pausePlaced", data: pause, durable: true) }
    }
    package func recordPCMTrack(_ track: JournalPCMTrack) throws {
        var next = pcmState
        guard header.schemaVersion == 2 || header.schemaVersion == 3 else {
            throw CaptureFailure("INVALID_JOURNAL", "PCM mappings require schema2 or schema3.")
        }
        try next.track(track, header: header)
        try append("pcmTrack", data: track, durable: true)
        pcmState = next
    }
    package func recordPCMAppend(_ accepted: JournalPCMAppend) throws {
        var next = pcmState
        guard header.schemaVersion == 2 || header.schemaVersion == 3 else {
            throw CaptureFailure("INVALID_JOURNAL", "PCM mappings require schema2 or schema3.")
        }
        try next.append(accepted)
        try append("pcmAppend", data: accepted)
        pcmState = next
    }

    // Each event's name, payload type and durability live here so the writer and `inspect` cannot
    // drift apart. Boundaries a recovery reads to place the take in time are synchronized when
    // written; per-buffer acquisition ranges use ordinary writes. Power-loss durability is unproven.
    public func recordOrigin(hostUs: Int64, placedPauses: [PauseEvent] = []) throws {
        guard header.schemaVersion == 1 else {
            throw CaptureFailure("INVALID_JOURNAL", "Packed PCM layout requires raw origin evidence.")
        }
        try append("origin", data: JournalHostTime(hostUs: hostUs), durable: true)
        // A placement is not another resume: a later pause may still be open when a delayed
        // frame supplies source zero. Each bounded record leaves that raw control state intact.
        for pause in placedPauses { try append("pausePlaced", data: pause, durable: true) }
    }
    public func recordPauseBegan(hostUs: Int64) throws {
        try append("pauseBegan", data: JournalHostTime(hostUs: hostUs), durable: true)
    }
    public func recordPauseEnded(hostUs: Int64, pause: PauseEvent?) throws {
        try append("pauseEnded", data: JournalPauseEnd(hostUs: hostUs, pause: pause), durable: true)
    }
    public func recordTrackStarted(
        role: String, file: String, firstSourceUs: Int64, sampleRate: Double?,
        channelCount: UInt32?
    ) throws {
        guard header.schemaVersion == 1 || role == "video" else {
            throw CaptureFailure("INVALID_JOURNAL", "Packed PCM layout requires a declared audio phase.")
        }
        try append(
            "trackStarted",
            data: JournalTrackStart(
                role: role, file: file, firstSourceUs: firstSourceUs, sampleRate: sampleRate,
                channelCount: channelCount), durable: true)
    }
    public func recordAudioSamples(role: String, startUs: Int64, endUs: Int64) throws {
        guard header.schemaVersion == 1 else {
            throw CaptureFailure("INVALID_JOURNAL", "Packed PCM layout requires accepted frame mappings.")
        }
        try append(
            "audioSamples", data: JournalAudioSamples(role: role, startUs: startUs, endUs: endUs))
    }
    /// Geometry epochs and cursor samples are ordinary writes, like per-buffer acquisition ranges:
    /// they are contemporaneous evidence rather than a boundary a recovery needs to place the take
    /// in time. Their file order still guarantees an epoch is written before the samples citing it.
    public func recordGeometry(
        epoch: Int, hostUs: Int64, sourceUs: Int64?, geometry: CaptureGeometry
    ) throws {
        try append(
            "geometry",
            data: JournalGeometry(
                epoch: epoch, hostUs: hostUs, sourceUs: sourceUs, geometry: geometry))
    }
    public func recordCursorSamples(_ samples: [CursorSample]) throws {
        guard !samples.isEmpty else { return }
        try append("cursorSamples", data: JournalCursorSamples(samples: samples))
    }
    public func recordDisplaySpace(hostUs: Int64, zeroOriginHeight: Double) throws {
        try append(
            "displaySpace",
            data: JournalDisplaySpace(hostUs: hostUs, zeroOriginHeight: zeroOriginHeight))
    }
    /// Appends one capture-time mark. Schema 3 is the first journal version that carries marks.
    /// A long stroke is decimated only as needed to keep this single record below the journal cap.
    public func recordMark(_ mark: JournalMark) throws {
        guard header.schemaVersion == 3 else {
            throw CaptureFailure("INVALID_JOURNAL", "Marks require schema3.")
        }
        var bounded = mark
        while true {
            do {
                try append("mark", data: bounded)
                return
            } catch let failure as CaptureFailure where failure.code == "JOURNAL_FAILED" && bounded.points.count > 2 {
                let retained = bounded.points.enumerated().compactMap { index, point in
                    index == 0 || index == bounded.points.count - 1 || index.isMultiple(of: 2) ? point : nil
                }
                bounded = JournalMark(hostUs: bounded.hostUs, sourceUs: bounded.sourceUs,
                    epoch: bounded.epoch, id: bounded.id, kind: bounded.kind, pin: bounded.pin,
                    points: retained, window: bounded.window, retracts: bounded.retracts)
            } catch {
                throw error
            }
        }
    }
    /// Records one device transition this take reports to its service and hands back the journal
    /// sequence that carries it. The journal is the single producer of these numbers, so a live
    /// report and the same take read back from disk cannot disagree about their order.
    public func recordLifecycle(state: String, reason: String?) throws -> Int {
        try append("lifecycle", data: JournalLifecycle(state: state, reason: reason), durable: true)
        return sequence
    }
    public func recordFinished(_ result: CaptureResult) throws {
        try append("finished", data: result, durable: true)
    }

    private func append<Event: Encodable>(_ event: String, data: Event, durable: Bool = false)
        throws
    {
        try lease.check()
        // The number is taken only once the record is in the file: a record that could not be
        // encoded or written must not leave a gap the reader would treat as corruption.
        let next = sequence + 1
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let record = try encoder.encode(JournalRecord(sequence: next, event: event, data: data))
        // The reader treats any longer run as corruption, which is only sound if no record is.
        guard record.count < Self.maximumRecordBytes else {
            throw CaptureFailure("JOURNAL_FAILED", "Journal record exceeds its size bound.")
        }
        try handle.write(contentsOf: record + Data([10]))
        sequence = next
        if durable { try handle.synchronize() }
    }

    /// How a pass over the journal's records ended.
    private enum RecordsEnd {
        /// Every byte was read or the reader asked to stop.
        case read
        /// The final line has no terminator: a crash boundary.
        case tornTail
        /// An unterminated run longer than any record the writer produces.
        case oversized
    }

    /// Reads terminated records in order until the reader stops or the file ends. Both the summary
    /// and the evidence stream read through this one loop so they cannot disagree about where a
    /// journal stops being believable.
    private static func readRecords(
        directory: String, maximumBytes: Int?, descriptor: Int32? = nil,
        throughBytes: Int64? = nil, _ body: (Data) throws -> Bool
    ) throws -> RecordsEnd {
        let url = URL(fileURLWithPath: directory).appendingPathComponent("capture.journal.jsonl")
        let input = descriptor ?? Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard input >= 0 else {
            let code = errno == ENOENT ? "JOURNAL_MISSING"
                : [ELOOP, ENOTDIR].contains(errno) ? "INVALID_JOURNAL" : "JOURNAL_UNAVAILABLE"
            throw CaptureFailure(code, "Cannot read capture journal.")
        }
        defer { if descriptor == nil { close(input) } }
        var pending = Data()
        var bytes: Int64 = 0
        while throughBytes.map({ bytes < $0 }) ?? true {
            try Task.checkCancellation()
            let capacity = Int(min(16_384, throughBytes.map { $0 - bytes } ?? 16_384))
            var chunk = Data(count: capacity)
            let count = chunk.withUnsafeMutableBytes { pread(input, $0.baseAddress!, capacity, off_t(bytes)) }
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw CaptureFailure("JOURNAL_UNAVAILABLE", "Cannot read journal bytes.") }
            if count == 0 { break }
            chunk.removeSubrange(count..<chunk.count)
            bytes += Int64(count)
            if let maximumBytes, bytes > maximumBytes {
                throw CaptureFailure("EVIDENCE_LIMIT", "Journal exceeds the evidence read budget.")
            }
            pending.append(chunk)
            while let end = pending.firstIndex(of: 10) {
                try Task.checkCancellation()
                let line = Data(pending[..<end])
                pending.removeSubrange(...end)
                // Foundation JSON bridging creates autoreleased objects. Drain each record so
                // a long worker request does not retain the entire parsed journal indirectly.
                guard try autoreleasepool(invoking: { try body(line) }) else { return .read }
            }
            // The writer never produces a record this long, so an unterminated run past the bound
            // is corruption wherever it sits, never a crash that cut a record short.
            guard pending.count <= maximumRecordBytes else { return .oversized }
        }
        return pending.isEmpty ? .read : .tornTail
    }

    /// Streams a take's placement evidence without retaining it. A take changes geometry as often
    /// as it delivers frames and samples the pointer sixty times a second, so the caller decides
    /// what to keep. The returned summary omits pause/audio arrays (those are streamed), so
    /// a consumer learns from that one pass both what the evidence was and where — at
    /// `invalidAtSequence` or an `incompleteTail` — the file stopped being believable. A stream
    /// that stopped early is otherwise indistinguishable from a short take.
    @discardableResult
    public static func streamEvidence(
        directory: String, geometry: (JournalGeometry) throws -> Void = { _ in },
        samples: ([CursorSample]) throws -> Void = { _ in },
        displaySpace: (JournalDisplaySpace) throws -> Void = { _ in },
        pause: (PauseEvent) throws -> Void = { _ in },
        audioAcquired: (JournalAudioSamples) throws -> Void = { _ in },
        mark: (JournalMark) throws -> Void = { _ in }
    ) throws -> CaptureJournalSummary {
        let layout = try CaptureJournal.layout(directory: directory)
        return try readEvidence(
            directory: directory, maximumBytes: nil, retainTiming: false,
            geometry: geometry, samples: samples, displaySpace: displaySpace,
            pause: pause, audioAcquired: audioAcquired, mark: mark, layout: layout)
    }

    /// Mapping evidence only. It is not proof of committed media or acquired source support.
    package static func streamAcceptedPCM(
        directory: String,
        through prefix: JournalPrefix? = nil,
        origin: (JournalPCMOrigin) throws -> Void = { _ in },
        track: (JournalPCMTrack) throws -> Void = { _ in },
        accepted: @escaping (JournalPCMAppend) throws -> Void
    ) throws -> CaptureJournalSummary {
        let layout = try CaptureJournal.layout(directory: directory)
        return try readEvidence(
            directory: directory, maximumBytes: nil, retainTiming: false,
            geometry: { _ in }, samples: { _ in }, displaySpace: { _ in },
            pcmOrigin: origin, pcmTrack: track, pcmAppend: accepted, through: prefix, layout: layout)
    }

    /// Callbacks are provisional until this returns: discard staged work on prefix or identity failure.
    package static func streamAcceptedPCM(
        lease: CaptureJournalLease, through prefix: JournalPrefix? = nil,
        origin: (JournalPCMOrigin) throws -> Void = { _ in },
        track: (JournalPCMTrack) throws -> Void = { _ in },
        accepted: @escaping (JournalPCMAppend) throws -> Void
    ) throws -> CaptureJournalSummary {
        try lease.check()
        let layout = try CaptureJournal.layout(directory: lease.directory)
        let summary = try readEvidence(
            directory: lease.directory, maximumBytes: nil, retainTiming: false,
            geometry: { _ in }, samples: { _ in }, displaySpace: { _ in },
            pcmOrigin: origin, pcmTrack: track, pcmAppend: accepted,
            through: prefix, descriptor: lease.descriptor, layout: layout)
        try lease.check()
        return summary
    }

    /// Both layouts retain/verify prefixes through the same decoded-record byte boundary.
    package static func readEvidence(
        directory: String, maximumBytes: Int?, retainTiming: Bool,
        geometry: (JournalGeometry) throws -> Void,
        samples: ([CursorSample]) throws -> Void,
        displaySpace: (JournalDisplaySpace) throws -> Void,
        pause: (PauseEvent) throws -> Void = { _ in },
        audioAcquired: (JournalAudioSamples) throws -> Void = { _ in },
        mark: (JournalMark) throws -> Void = { _ in },
        pcmOrigin: (JournalPCMOrigin) throws -> Void = { _ in },
        pcmTrack: (JournalPCMTrack) throws -> Void = { _ in },
        pcmAppend: ((JournalPCMAppend) throws -> Void)? = nil, retainPrefix: Bool = false,
        through prefix: JournalPrefix? = nil, descriptor: Int32? = nil, layout: Int = 1
    ) throws -> CaptureJournalSummary {
        if let prefix {
            guard prefix.bytes > 0,
                prefix.sha256.count == 64,
                prefix.sha256.allSatisfy({ $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) })
            else { throw CaptureFailure("INVALID_JOURNAL_PREFIX", "Invalid journal prefix token.") }
        }
        var summary = CaptureJournalSummary()
        var pcm = JournalPCMState()
        let retainsPrefix = retainPrefix || pcmAppend != nil || prefix != nil
        var prefixHash = retainsPrefix ? SHA256() : nil
        var prefixBytes: Int64 = 0
        // At most one pending interval per supported role; the stream never accumulates gaps.
        var pendingAudio: [String: JournalAudioSamples] = [:]
        func emitAudio(_ interval: JournalAudioSamples) throws {
            if retainTiming {
                summary.acquiredAudio[interval.role, default: []].append(
                    TimeSpan(startUs: interval.startUs, endUs: interval.endUs))
            }
            try audioAcquired(interval)
        }
        func emitPause(_ completed: PauseEvent) throws {
            if retainTiming { summary.pauses.append(completed) }
            try pause(completed)
        }
        let end = try readRecords(directory: directory, maximumBytes: maximumBytes,
                                  descriptor: descriptor, throughBytes: prefix?.bytes) {
            line in
            let record: JournalEntry
            do {
                let decoder = JSONDecoder()
                decoder.userInfo[.journalSchema] = summary.header?.schemaVersion ?? 1
                record = try decoder.decode(JournalEntry.self, from: line)
                try record.check(following: summary.lastSequence)
                let schema =
                    summary.header?.schemaVersion
                    ?? {
                        if case .header(let header) = record.event { return header.schemaVersion }
                        return 1
                    }()
                guard schema == layout else {
                    throw CaptureFailure("INVALID_JOURNAL", "Unsupported journal layout for this reader.")
                }
                switch record.event {
                case .pcmOrigin(let origin):
                    guard schema == 2 || schema == 3 else {
                        throw CaptureFailure("INVALID_JOURNAL", "Unexpected PCM origin.")
                    }
                    try pcm.origin(origin)
                case .pcmTrack(let track):
                    guard (schema == 2 || schema == 3), let header = summary.header else {
                        throw CaptureFailure("INVALID_JOURNAL", "Unexpected PCM track.")
                    }
                    try pcm.track(track, header: header)
                case .pcmAppend(let append):
                    guard schema == 2 || schema == 3 else {
                        throw CaptureFailure("INVALID_JOURNAL", "Unexpected PCM append.")
                    }
                    try pcm.append(append)
                case .origin, .audioSamples, .other:
                    guard schema == 1 else {
                        throw CaptureFailure("INVALID_JOURNAL", "Unexpected legacy journal event.")
                    }
                case .mark(let mark):
                    guard schema == 3, validMark(mark) else {
                        throw CaptureFailure("INVALID_JOURNAL", "Invalid schema3 mark.")
                    }
                default: break
                }
            } catch {
                summary.invalidAtSequence = summary.lastSequence + 1
                return false
            }
            summary.lastSequence = record.sequence
            switch record.event {
            case .header(let header): summary.header = header
            case .pcmOrigin(let origin):
                summary.originHostUs = origin.declaredHostUs
                try pcmOrigin(origin)
            case .pcmTrack(let track): try pcmTrack(track)
            case .pcmAppend(let accepted): try pcmAppend?(accepted)
            case .videoTrack: break
            case .origin(let hostUs): summary.originHostUs = hostUs
            case .pauseBegan(let hostUs): summary.openPauseHostUs = hostUs
            case .pauseEnded(let completed):
                summary.openPauseHostUs = nil
                if let completed { try emitPause(completed) }
            case .pausePlaced(let placed): try emitPause(placed)
            case .audioSamples(let next):
                if let previous = pendingAudio[next.role] {
                    // Acquisition timestamps are monotonic per role.
                    let span = TimeSpan(startUs: previous.startUs, endUs: previous.endUs)
                    let arriving = TimeSpan(startUs: next.startUs, endUs: next.endUs)
                    if span.isContinued(by: arriving) {
                        let merged = span.merged(with: arriving)
                        pendingAudio[next.role] = JournalAudioSamples(
                            role: next.role, startUs: merged.startUs, endUs: merged.endUs)
                    } else {
                        try emitAudio(previous)
                        pendingAudio[next.role] = next
                    }
                } else {
                    pendingAudio[next.role] = next
                }
            case .geometry(let observed):
                summary.geometryEpochs = observed.epoch
                summary.lastGeometry = observed.geometry
                try geometry(observed)
            case .cursorSamples(let batch):
                summary.cursorSamples += batch.count
                summary.firstCursorSourceUs = summary.firstCursorSourceUs ?? batch.first?.sourceUs
                summary.lastCursorSourceUs = batch.last?.sourceUs ?? summary.lastCursorSourceUs
                try samples(batch)
            case .displaySpace(let space):
                summary.zeroOriginHeight = space.zeroOriginHeight
                try displaySpace(space)
            case .mark(let observed):
                try mark(observed)
            case .lifecycle(let lifecycle): summary.lastLifecycle = lifecycle
            case .finished(let finished):
                summary.finished = true
                if let state = finished.state, let durationUs = finished.durationUs {
                    summary.completion = JournalCompletion(
                        sequence: record.sequence,
                        state: state, durationUs: durationUs, failureCode: finished.failure?.code,
                        failureMessage: finished.failure?.message.map { String(decoding: $0.utf16.prefix(4096), as: UTF16.self) })
                } else {
                    summary.completion = nil
                }
            case .other: break
            }
            if retainsPrefix {
                prefixHash?.update(data: line)
                prefixHash?.update(data: Data([10]))
                prefixBytes += Int64(line.count) + 1
            }
            return true
        }
        switch end {
        case .read: break
        case .tornTail: summary.incompleteTail = true
        case .oversized: summary.invalidAtSequence = summary.lastSequence + 1
        }
        for role in ["narration", "system"] {
            if let interval = pendingAudio[role] { try emitAudio(interval) }
        }
        if let digest = prefixHash?.finalize() {
            summary.validatedPrefix = JournalPrefix(
                bytes: prefixBytes, sha256: digest.map { String(format: "%02x", $0) }.joined())
        }
        if let prefix, summary.validatedPrefix != prefix || summary.incompleteTail || summary.invalidAtSequence != nil {
            throw CaptureFailure("INVALID_JOURNAL_PREFIX", "Journal does not match the declared validated prefix.")
        }
        return summary
    }

    /// Read only the persisted discriminant through the same bounded record decoder.
    package static func layout(directory: String) throws -> Int {
        var schema: Int?
        _ = try readRecords(directory: directory, maximumBytes: maximumRecordBytes) { line in
            do {
                let record = try JSONDecoder().decode(JournalEntry.self, from: line)
                try record.check(following: 0)
                if case .header(let header) = record.event { schema = header.schemaVersion }
            } catch {
                throw CaptureFailure("INVALID_JOURNAL", "Invalid journal header.")
            }
            return false
        }
        guard let schema else { throw CaptureFailure("INVALID_JOURNAL", "Missing journal header.") }
        return schema
    }

    /// The same read with nothing streamed, for a consumer that only wants the summary.
    public static func inspect(directory: String) throws -> CaptureJournalSummary {
        try readEvidence(
            directory: directory, maximumBytes: nil, retainTiming: true,
            geometry: { _ in }, samples: { _ in }, displaySpace: { _ in })
    }
}

private struct JournalRecord<Event: Encodable>: Encodable {
    let sequence: Int
    let event: String
    let data: Event
}

/// One journal line, decoded once through the payload type its event name declares. A payload
/// that will not decode through that type rejects the whole record rather than leaving a boundary
/// silently empty.
private struct JournalEntry: Decodable {
    enum Event {
        case header(CaptureJournalHeader)
        case pcmOrigin(JournalPCMOrigin)
        case pcmTrack(JournalPCMTrack)
        case pcmAppend(JournalPCMAppend)
        case videoTrack
        case origin(Int64)
        case pauseBegan(Int64)
        case pauseEnded(PauseEvent?)
        case pausePlaced(PauseEvent)
        case audioSamples(JournalAudioSamples)
        case geometry(JournalGeometry)
        case cursorSamples([CursorSample])
        case displaySpace(JournalDisplaySpace)
        case mark(JournalMark)
        case lifecycle(JournalLifecycle)
        case finished(JournalFinished)
        case other
    }

    private enum CodingKeys: String, CodingKey { case sequence, event, data }
    private struct AnyKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    let sequence: Int
    let name: String
    let event: Event

    init(from decoder: Decoder) throws {
        let record = try decoder.container(keyedBy: CodingKeys.self)
        sequence = try record.decode(Int.self, forKey: .sequence)
        name = try record.decode(String.self, forKey: .event)
        // Every event carries an object payload, including events this reader does not interpret.
        _ = try record.nestedContainer(keyedBy: AnyKey.self, forKey: .data)
        func payload<T: Decodable>(_ type: T.Type) throws -> T {
            try record.decode(type, forKey: .data)
        }
        func invalid(_ message: String) -> CaptureFailure {
            CaptureFailure("INVALID_JOURNAL", message)
        }
        switch name {
        case "header":
            let header = try payload(CaptureJournalHeader.self)
            guard [1, 2, 3].contains(header.schemaVersion) else { throw invalid("Invalid journal header.") }
            event = .header(header)
        case "pcmOrigin": event = .pcmOrigin(try payload(JournalPCMOrigin.self))
        case "pcmTrack": event = .pcmTrack(try payload(JournalPCMTrack.self))
        case "pcmAppend": event = .pcmAppend(try payload(JournalPCMAppend.self))
        case "trackStarted" where decoder.userInfo[.journalSchema] as? Int == 2 || decoder.userInfo[.journalSchema] as? Int == 3:
            let track = try payload(JournalTrackStart.self)
            guard track.role == "video", track.file == "video.mov", track.firstSourceUs >= 0 else {
                throw invalid("Invalid schema2 video track.")
            }
            event = .videoTrack
        case "origin": event = .origin(try payload(JournalHostTime.self).hostUs)
        case "pauseBegan": event = .pauseBegan(try payload(JournalHostTime.self).hostUs)
        case "pauseEnded":
            let ended = try payload(JournalPauseEnd.self)
            if let pause = ended.pause, pause.atSourceUs < 0 || pause.elapsedPauseUs < 0 {
                throw invalid("Invalid pause interval.")
            }
            event = .pauseEnded(ended.pause)
        case "pausePlaced":
            let pause = try payload(PauseEvent.self)
            guard pause.atSourceUs >= 0, pause.elapsedPauseUs >= 0 else {
                throw invalid("Invalid pause interval.")
            }
            event = .pausePlaced(pause)
        case "audioSamples":
            let samples = try payload(JournalAudioSamples.self)
            guard ["narration", "system"].contains(samples.role),
                samples.startUs >= 0, samples.endUs > samples.startUs
            else { throw invalid("Invalid audio acquisition interval.") }
            event = .audioSamples(samples)
        case "geometry": event = .geometry(try payload(JournalGeometry.self))
        case "cursorSamples": event = .cursorSamples(try payload(JournalCursorSamples.self).samples)
        case "displaySpace": event = .displaySpace(try payload(JournalDisplaySpace.self))
        case "lifecycle": event = .lifecycle(try payload(JournalLifecycle.self))
        case "finished":
            let finished = try payload(JournalFinished.self)
            guard finished.state == nil || ["complete", "interrupted"].contains(finished.state!),
                finished.durationUs == nil || (finished.state != nil && finished.durationUs! >= 0),
                finished.state != "complete" || finished.failure == nil
            else { throw invalid("Invalid journal completion.") }
            event = .finished(finished)
        case "mark": event = .mark(try payload(JournalMark.self))
        default: event = .other
        }
    }

    /// Records are numbered from one without gaps, and only the first is the header.
    func check(following lastSequence: Int) throws {
        guard sequence == lastSequence + 1, (sequence == 1) == (name == "header") else {
            throw CaptureFailure("INVALID_JOURNAL", "Invalid journal record.")
        }
    }
}

/// A device transition as native reported it.
public struct JournalLifecycle: Codable, Sendable {
    public let state: String
    public let reason: String?
}

struct JournalHostTime: Codable {
    let hostUs: Int64
}

struct JournalPauseEnd: Codable {
    let hostUs: Int64
    let pause: PauseEvent?
}

struct JournalTrackStart: Codable {
    let role: String
    let file: String
    let firstSourceUs: Int64
    let sampleRate: Double?
    let channelCount: UInt32?
}

public struct JournalAudioSamples: Codable, Sendable {
    public let role: String
    public let startUs: Int64
    public let endUs: Int64
}

/// A geometry observation and the raw frame evidence that explains it. An epoch can occur
/// twice: first without source time, then confirmed on a usable frame in source time.
public struct JournalGeometry: Codable, Sendable {
    public let epoch: Int
    public let hostUs: Int64
    /// Absent when the clock could not place the observed frame (before source zero or across a pause).
    public let sourceUs: Int64?
    public let geometry: CaptureGeometry
}

struct JournalCursorSamples: Codable {
    let samples: [CursorSample]
}

/// The zero-origin display height a take converted its pointer readings through, and when it
/// started doing so. Written whenever the height changes, so the conversion is re-derivable from
/// the journal instead of from whatever the display arrangement is when the evidence is read.
public struct JournalDisplaySpace: Codable, Sendable {
    public let hostUs: Int64
    public let zeroOriginHeight: Double
}

public struct JournalMarkPoint: Codable, Sendable, Equatable {
    public let x: Double
    public let y: Double
    public let hostUs: Int64
    public init(x: Double, y: Double, hostUs: Int64) {
        self.x = x; self.y = y; self.hostUs = hostUs
    }
}

public struct JournalMarkWindow: Codable, Sendable, Equatable {
    public let app: String
    public let title: String
    public let bounds: GeometryRect
    public init(app: String, title: String, bounds: GeometryRect) {
        self.app = app; self.title = title; self.bounds = bounds
    }
}

public struct JournalMark: Codable, Sendable, Equatable {
    public let hostUs: Int64
    public let sourceUs: Int64
    public let epoch: Int
    public let id: String
    public let kind: String
    public let pin: Int?
    public let points: [JournalMarkPoint]
    public let window: JournalMarkWindow?
    public let retracts: String?
    public init(
        hostUs: Int64, sourceUs: Int64, epoch: Int, id: String, kind: String, pin: Int? = nil,
        points: [JournalMarkPoint], window: JournalMarkWindow? = nil, retracts: String? = nil
    ) {
        self.hostUs = hostUs; self.sourceUs = sourceUs; self.epoch = epoch; self.id = id
        self.kind = kind; self.pin = pin; self.points = points; self.window = window
        self.retracts = retracts
    }
}

private func validMark(_ mark: JournalMark) -> Bool {
    guard mark.hostUs >= 0, mark.sourceUs >= 0, mark.epoch >= 0,
        !mark.id.isEmpty, mark.id.utf8.count <= 256,
        ["stroke", "pin", "click"].contains(mark.kind),
        mark.retracts == nil || (!mark.retracts!.isEmpty && mark.retracts!.utf8.count <= 256),
        mark.retracts == nil ? !mark.points.isEmpty : mark.points.isEmpty,
        mark.kind == "pin" ? (mark.pin ?? 0) > 0 : mark.pin == nil else { return false }
    guard mark.points.allSatisfy({ $0.hostUs >= 0 && $0.x.isFinite && $0.y.isFinite }) else { return false }
    if let window = mark.window {
        guard !window.app.isEmpty, window.app.utf8.count <= 256,
            window.title.utf8.count <= 4096,
            window.bounds.x.isFinite, window.bounds.y.isFinite,
            window.bounds.width.isFinite, window.bounds.height.isFinite else { return false }
    }
    return true
}

/// The finalized capture/video source endpoint, not the wall-clock instant a failure began.
/// Missing timing on a presence-only finished record supplies no completion boundary.
public struct JournalCompletion: Codable, Sendable {
    public let sequence: Int
    public let state: String
    public let durationUs: Int64
    public let failureCode: String?
    public let failureMessage: String?
}

private struct JournalFinished: Decodable {
    struct Failure: Decodable { let code: String; let message: String? }
    let state: String?
    let durationUs: Int64?
    let failure: Failure?
}

extension CodingUserInfoKey {
    fileprivate static let journalSchema = CodingUserInfoKey(rawValue: "captureJournalSchema")!
}
