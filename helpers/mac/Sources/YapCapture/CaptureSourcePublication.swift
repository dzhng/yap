import CryptoKit
import Darwin
import Foundation
import YapMedia

/// Bounded immutable authority for one source; timing samples remain in its journal and media proofs.
public struct CapturePublishedSource: Codable, Sendable {
    public enum Kind: String, Codable, Sendable { case primary, camera }
    public struct Journal: Codable, Sendable, Equatable {
        public let file: String
        public let bytes: Int64
        public let sha256: String
        public let lastSequence: Int
        public let layout: Int
    }
    public struct Take: Codable, Sendable, Equatable {
        public enum Kind: String, Codable, Sendable { case display, window, region, camera }
        public let kind: Kind
    }
    public struct Marks: Codable, Sendable, Equatable {
        public let pins: Bool
        public let strokes: Bool
    }
    public let take: Take?
    public let marks: Marks?
    public let kind: Kind
    public let sourceId: String
    public let sourceDurationUs: Int64
    public let originHostUs: Int64
    public let binding: CameraCaptureBinding?
    public let diagnostic: CaptureFailure?
    public let journal: Journal
    fileprivate let members: [String: CaptureMediaIdentity]

    /// Recovery consumes the same persisted authority as live publication, independently per source.
    public static func recover(directory: String) async throws -> CapturePublishedSource {
        let lease = try CaptureJournalLease(directory: directory)
        defer { lease.release() }
        let receipt = try CaptureSourcePublication.read(lease: lease)
        try await CaptureSourcePublication.verifyStored(receipt, lease: lease)
        try Task.checkCancellation()
        return receipt.source
    }
}

public enum CaptureSourcePublicationOutcome: Codable, Sendable {
    case pending(CaptureFinalizationError)
    case published(CapturePublishedSource)
    case unavailable(CaptureFailure)

    private enum Keys: String, CodingKey { case state, error, source }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        switch try values.decode(String.self, forKey: .state) {
        case "pending": self = .pending(try values.decode(CaptureFinalizationError.self, forKey: .error))
        case "published": self = .published(try values.decode(CapturePublishedSource.self, forKey: .source))
        case "unavailable": self = .unavailable(try values.decode(CaptureFailure.self, forKey: .error))
        default: throw DecodingError.dataCorruptedError(forKey: .state, in: values, debugDescription: "Invalid source outcome")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: Keys.self)
        switch self {
        case .pending(let error): try values.encode("pending", forKey: .state); try values.encode(error, forKey: .error)
        case .published(let source): try values.encode("published", forKey: .state); try values.encode(source, forKey: .source)
        case .unavailable(let error): try values.encode("unavailable", forKey: .state); try values.encode(error, forKey: .error)
        }
    }
    public func wireValue() throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) }
}

public struct CapturePublicationObservation: Codable, Sendable {
    public let generation: UUID
    public let sourceId: String
    public var inputsClosed: Bool
    public var primary: CaptureSourcePublicationOutcome?
    public var camera: CaptureSourcePublicationOutcome?

    private enum Keys: String, CodingKey { case generation, sourceId, inputsClosed, primary, camera }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: Keys.self)
        try values.encode(generation, forKey: .generation); try values.encode(sourceId, forKey: .sourceId)
        try values.encode(inputsClosed, forKey: .inputsClosed)
        try values.encode(primary, forKey: .primary); try values.encode(camera, forKey: .camera)
    }
    public func wireValue() throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as! [String: Any]
    }
}

package struct CaptureRecoveryAuthority: Codable, Sendable {
    package let kind: CapturePublishedSource.Kind
    package let sourceId: String
    package let binding: CameraCaptureBinding?
    package init(kind: CapturePublishedSource.Kind, sourceId: String, binding: CameraCaptureBinding? = nil) {
        self.kind = kind; self.sourceId = sourceId; self.binding = binding
    }
}

package struct CaptureSourceAuthorityExpectation: Codable, Sendable {
    package let source: CapturePublishedSource
    package let receipt: CaptureMediaIdentity
    package init(source: CapturePublishedSource, receipt: CaptureMediaIdentity) { self.source = source; self.receipt = receipt }
}

/// The source receipt adds no publication queue: its caller already owns the capture journal lease.
package enum CaptureSourcePublication {
    private static let receiptFile = "source.publication.json"
    private static let recoveredDiagnostic = CaptureFailure("CAPTURE_RECOVERED", "Source support recovered without trusted ordinary completion.")

    fileprivate struct RecoveryBasis: Codable, Sendable {
        let original: CaptureMediaIdentity
        let prefix: JournalPrefix
        let lastSequence: Int
        let finished: Bool
        let incompleteTail: Bool
        let invalidAtSequence: Int?
        let supportSHA256: String
    }
    fileprivate struct StoredReceipt: Codable, Sendable {
        let source: CapturePublishedSource
        let recovery: RecoveryBasis?
        private enum Keys: String, CodingKey { case recovery }
        init(source: CapturePublishedSource, recovery: RecoveryBasis?) { self.source = source; self.recovery = recovery }
        init(from decoder: Decoder) throws {
            source = try CapturePublishedSource(from: decoder)
            recovery = try decoder.container(keyedBy: Keys.self).decodeIfPresent(RecoveryBasis.self, forKey: .recovery)
        }
        func encode(to encoder: Encoder) throws {
            try source.encode(to: encoder)
            var values = encoder.container(keyedBy: Keys.self)
            try values.encodeIfPresent(recovery, forKey: .recovery)
        }
    }

    package static func validateAuthority(_ authority: CaptureRecoveryAuthority) throws {
        try authority.binding?.validate()
        guard !authority.sourceId.isEmpty, authority.sourceId.utf16.count <= 256,
            (authority.kind == .camera) == (authority.binding != nil),
            authority.binding.map({ $0.sourceId == authority.sourceId }) ?? true else {
            throw invalid("Recovery requires bounded allocated source/device authority.")
        }
    }

    package static func validateAuthority(_ authority: CaptureRecoveryAuthority, lease: CaptureJournalLease, layout: Int) throws {
        let (facts, _) = try summary(lease: lease, descriptor: lease.descriptor, layout: layout)
        try validateAuthority(authority)
        guard
            facts.header?.sessionID == authority.sourceId,
            facts.header?.cameraBinding == authority.binding,
            authority.kind != .camera || facts.header?.source.kind == "camera",
            authority.kind == .camera ? JournalSchema.isCompanion(layout) : JournalSchema.isPacked(layout) else {
            throw invalid("Recovery differs from allocated source/device authority.")
        }
    }

    package static func recover(lease: CaptureJournalLease, authority: CaptureRecoveryAuthority,
        layout: Int, tracks: [RecoveredTrack]) async throws -> CapturePublishedSource {
        try validateAuthority(authority, lease: lease, layout: layout)
        if try lease.hasMember(receiptFile) {
            let stored = try read(lease: lease)
            guard stored.source.kind == authority.kind, stored.source.sourceId == authority.sourceId,
                stored.source.binding == authority.binding else { throw invalid("Stored authority differs from allocated source.") }
            try await verifyStored(stored, lease: lease)
            try Task.checkCancellation()
            return stored.source
        }
        try lease.synchronize()
        let (facts, marks) = try summary(lease: lease, descriptor: lease.descriptor, layout: layout)
        guard let header = facts.header, let origin = facts.originHostUs,
            let prefix = facts.validatedPrefix, prefix.bytes > 0 else { throw invalid("Recovery has no source placement provenance.") }
        let video = try await support(kind: authority.kind, lease: lease)
        try Task.checkCancellation()
        let duration = video.last?.endUs ?? 0
        guard duration > 0 else { throw CaptureFailure("INVALID_MEDIA", "Source has no verified recoverable video.") }
        var names = ["video.mov"]
        if authority.kind == .camera { names += ["camera.publication.json", CameraMedia.mappingFile] }
        else {
            for role in ["narration", "system"] where tracks.contains(where: { $0.role == role && $0.acquisitionVerified && !$0.intervals.isEmpty }) {
                names += ["\(role).mov", "\(role).publication.json"]
            }
        }
        if let completion = facts.completion, !facts.incompleteTail, facts.invalidAtSequence == nil {
            let diagnostic = completion.failureCode.map { CaptureFailure($0, completion.failureMessage ?? "") }
            let represented = tracks.map { CapturedTrack(role: $0.role, file: $0.file,
                firstSampleUs: $0.intervals.first?.startUs, lastSampleEndUs: $0.intervals.last?.endUs,
                samples: $0.intervals.isEmpty ? 0 : 1, droppedSamples: 0, omittedSamples: 0,
                heldTailUs: 0, sampleRate: nil, channelCount: nil) }
            return try await publish(kind: authority.kind, durationUs: duration, originHostUs: origin,
                tracks: represented, diagnostic: diagnostic, lease: lease, layout: layout)
        }
        let original = try CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(lease.descriptor)"))
        let journalFile = authority.kind == .primary ? "source.journal.jsonl" : "capture.journal.jsonl"
        if authority.kind == .primary, try !lease.hasMember(journalFile) {
            let sourceDescriptor = lease.descriptor
            try lease.publishMember(journalFile) { output in
                var offset: Int64 = 0
                while offset < original.bytes {
                    try Task.checkCancellation()
                    var data = Data(count: Int(min(65536, original.bytes - offset)))
                    let count = data.withUnsafeMutableBytes { pread(sourceDescriptor, $0.baseAddress, $0.count, offset) }
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw invalid("Recovery journal ended before its full identity.") }
                    data.count = count; try write(data, to: output, offset: offset); offset += Int64(count)
                }
            }
        }
        guard try memberIdentity(journalFile, lease: lease) == original else { throw invalid("Recovery snapshot differs from original journal.") }
        var members: [String: CaptureMediaIdentity] = [:]
        for name in names { members[name] = try memberIdentity(name, lease: lease) }
        let diagnostic = recoveredDiagnostic
        let source = CapturePublishedSource(take: takeFacts(header), marks: marks, kind: authority.kind, sourceId: header.sessionID,
            sourceDurationUs: duration, originHostUs: origin, binding: header.cameraBinding, diagnostic: diagnostic,
            journal: .init(file: journalFile, bytes: original.bytes, sha256: original.sha256,
                lastSequence: facts.lastSequence, layout: layout), members: members)
        let basis = RecoveryBasis(original: original, prefix: prefix, lastSequence: facts.lastSequence,
            finished: facts.finished, incompleteTail: facts.incompleteTail, invalidAtSequence: facts.invalidAtSequence,
            supportSHA256: try supportHash(video))
        let stored = StoredReceipt(source: source, recovery: basis)
        try await verifyStored(stored, lease: lease)
        try Task.checkCancellation()
        let encoded = try JSONEncoder().encode(stored)
        guard encoded.count <= 65536 else { throw invalid("Source authority exceeds its receipt bound.") }
        try lease.publishMember(receiptFile) { try write(encoded, to: $0, offset: 0) }
        return source
    }

    package static func verifyStaged(_ expectation: CaptureSourceAuthorityExpectation,
        lease: CaptureJournalLease, canonical: [String: String]) async throws -> CapturePublishedSource {
        guard try memberIdentity(receiptFile, lease: lease) == expectation.receipt else { throw invalid("Staged source receipt differs from its frozen identity.") }
        let stored = try read(lease: lease)
        guard try same(stored.source, expectation.source) else { throw invalid("Staged source receipt differs from expected authority.") }
        try await verifyStored(stored, lease: lease, staged: true, canonical: canonical)
        try Task.checkCancellation()
        guard try memberIdentity(receiptFile, lease: lease) == expectation.receipt else { throw invalid("Staged source receipt changed during verification.") }
        return stored.source
    }

    fileprivate static func verifyStored(_ stored: StoredReceipt, lease: CaptureJournalLease,
        staged: Bool = false, canonical: [String: String]? = nil) async throws {
        if let basis = stored.recovery {
            try await verifyRecovery(stored.source, basis: basis, lease: lease, staged: staged, canonical: canonical)
        } else {
            try verify(stored.source, lease: lease, staged: staged, canonical: canonical)
            try await verifyMedia(stored.source, lease: lease, canonical: canonical)
        }
    }

    private static func verifyRecovery(_ source: CapturePublishedSource, basis: RecoveryBasis,
        lease: CaptureJournalLease, staged: Bool, canonical: [String: String]?) async throws {
        let name = staged ? "capture.journal.jsonl" : source.journal.file
        let descriptor = try lease.openMember(name)
        defer { close(descriptor) }
        let whole = try CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(descriptor)"))
        let (facts, marks) = try summary(lease: lease, descriptor: descriptor, layout: source.journal.layout)
        let allowed: Set<String> = source.kind == .camera
            ? ["video.mov", "camera.publication.json", CameraMedia.mappingFile]
            : ["video.mov", "narration.mov", "system.mov", "narration.publication.json", "system.publication.json"]
        guard whole == basis.original, whole.bytes == source.journal.bytes, whole.sha256 == source.journal.sha256,
            source.journal.file == (source.kind == .primary ? "source.journal.jsonl" : "capture.journal.jsonl"),
            source.kind == .primary ? JournalSchema.isPacked(source.journal.layout) : JournalSchema.isCompanion(source.journal.layout),
            facts.validatedPrefix == basis.prefix, facts.lastSequence == basis.lastSequence,
            facts.lastSequence == source.journal.lastSequence, facts.finished == basis.finished,
            facts.incompleteTail == basis.incompleteTail, facts.invalidAtSequence == basis.invalidAtSequence,
            facts.completion == nil || facts.incompleteTail || facts.invalidAtSequence != nil,
            source.take == facts.header.flatMap(takeFacts),
            source.marks == marks,
            facts.header?.sessionID == source.sourceId, facts.header?.cameraBinding == source.binding,
            facts.originHostUs == source.originHostUs, source.sourceDurationUs > 0,
            source.diagnostic?.code == recoveredDiagnostic.code, source.diagnostic?.message == recoveredDiagnostic.message,
            Set(source.members.keys).isSubset(of: allowed), source.members["video.mov"] != nil,
            source.kind != .camera || Set(source.members.keys) == allowed else { throw invalid("Recovery authority differs from its journal provenance.") }
        try validateAuthority(.init(kind: source.kind, sourceId: source.sourceId, binding: source.binding), lease: lease, layout: source.journal.layout)
        for role in ["narration", "system"] {
            guard (source.members["\(role).mov"] != nil) == (source.members["\(role).publication.json"] != nil) else { throw invalid("Recovery audio proof is incomplete.") }
        }
        for (name, expected) in source.members {
            guard try memberIdentity(name, lease: lease, canonical: canonical) == expected else { throw invalid("Recovered source member changed: \(name).") }
        }
        if !staged {
            guard try CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(lease.descriptor)")) == basis.original else {
                throw invalid("Original recovery journal changed outside its trusted prefix.")
            }
        }
        try await verifyMedia(source, lease: lease, canonical: canonical)
        try Task.checkCancellation()
        let video = try await support(kind: source.kind, lease: lease, canonical: canonical)
        try Task.checkCancellation()
        guard video.last?.endUs == source.sourceDurationUs, try supportHash(video) == basis.supportSHA256 else { throw invalid("Recovered support differs from publication authority.") }
        guard try CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(descriptor)")) == whole,
            try (staged || CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(lease.descriptor)")) == basis.original) else {
            throw invalid("Recovery journal changed during support verification.")
        }
        for (name, expected) in source.members {
            guard try memberIdentity(name, lease: lease, canonical: canonical) == expected else { throw invalid("Recovered source member changed during verification: \(name).") }
        }
        try lease.check()
        try Task.checkCancellation()
    }

    private static func support(kind: CapturePublishedSource.Kind, lease: CaptureJournalLease,
        canonical: [String: String]? = nil) async throws -> [TimeSpan] {
        let url = try mediaURL("video", lease: lease, canonical: canonical)
        if kind == .camera {
            let verified = try await CameraMedia.readPublished(lease: lease, canonical: url)
            return try verified.identity.availability.intervals.map { try $0.roundedSpan() }
        }
        let inspected = await CaptureMediaInspection.inspect(role: "video", url: url, acquired: nil, requested: true)
        try Task.checkCancellation()
        if let failure = inspected.failure, failure.code == "MEDIA_UNAVAILABLE" { throw failure }
        return inspected.intervals
    }
    private static func supportHash(_ intervals: [TimeSpan]) throws -> String {
        var hash = SHA256(); let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        for interval in intervals { hash.update(data: try encoder.encode(interval)); hash.update(data: Data([10])) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private static func same<T: Encodable>(_ a: T, _ b: T) throws -> Bool {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(a) == encoder.encode(b)
    }

    /// Live publication calls this on its writer queue so lifecycle appends cannot tear the snapshot.
    /// Offline callers hold exclusive authority and use the same freeze before publishing evidence.
    package static func freezePrimaryJournal(lease: CaptureJournalLease, layout: Int) throws {
        // An existing receipt must reverify its own snapshot, never reconstruct missing authority.
        if try lease.hasMember(receiptFile) { return }
        let journalFile = "source.journal.jsonl"
        if try !lease.hasMember(journalFile) {
            let (summary, _) = try summary(lease: lease, descriptor: lease.descriptor, layout: layout)
            guard summary.finished, !summary.incompleteTail, summary.invalidAtSequence == nil,
                let prefix = summary.validatedPrefix else { throw invalid("Source completion is not durably recorded.") }
            let sourceDescriptor = lease.descriptor
            try lease.publishMember(journalFile) { output in
                var offset: Int64 = 0
                while offset < prefix.bytes {
                    try Task.checkCancellation()
                    var data = Data(count: Int(min(65536, prefix.bytes - offset)))
                    let count = data.withUnsafeMutableBytes { pread(sourceDescriptor, $0.baseAddress, $0.count, offset) }
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw invalid("Closed journal ended before its validated prefix.") }
                    data.count = count
                    try write(data, to: output, offset: offset)
                    offset += Int64(count)
                }
            }
        }
    }

    package static func publish(kind: CapturePublishedSource.Kind, durationUs: Int64,
        originHostUs: Int64?, tracks: [CapturedTrack], diagnostic: CaptureFailure?,
        lease: CaptureJournalLease, layout: Int) async throws -> CapturePublishedSource {
        try lease.synchronize()
        if try lease.hasMember(receiptFile) {
            let receipt = try read(lease: lease)
            guard receipt.source.kind == kind else { throw invalid("Source publication kind changed.") }
            try await verifyStored(receipt, lease: lease)
            try Task.checkCancellation()
            return receipt.source
        }
        let journalFile = kind == .primary ? "source.journal.jsonl" : "capture.journal.jsonl"
        if kind == .primary { try freezePrimaryJournal(lease: lease, layout: layout) }
        let descriptor = try lease.openMember(journalFile)
        defer { close(descriptor) }
        let (summary, marks) = try summary(lease: lease, descriptor: descriptor, layout: layout)
        let identity = try CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(descriptor)"))
        guard let prefix = summary.validatedPrefix, prefix.bytes == identity.bytes, prefix.sha256 == identity.sha256,
            let header = summary.header, let origin = summary.originHostUs,
            let completion = summary.completion, completion.durationUs > 0,
            completion.durationUs == durationUs, originHostUs == origin,
            !summary.incompleteTail, summary.invalidAtSequence == nil else {
            throw invalid("Source has no verified positive completion authority.")
        }
        var names = ["video.mov"]
        if kind == .camera { names += ["camera.publication.json", CameraMedia.mappingFile] }
        else {
            for role in ["narration", "system"] where tracks.contains(where: { $0.role == role && $0.file == "\(role).mov" && $0.samples > 0 }) {
                names += ["\(role).mov", "\(role).publication.json"]
            }
        }
        var members: [String: CaptureMediaIdentity] = [:]
        for name in names { members[name] = try memberIdentity(name, lease: lease) }
        let receipt = CapturePublishedSource(take: takeFacts(header), marks: marks, kind: kind, sourceId: header.sessionID,
            sourceDurationUs: completion.durationUs, originHostUs: origin, binding: header.cameraBinding,
            diagnostic: diagnostic.map { CaptureFailure(bounded: $0) },
            journal: .init(file: journalFile, bytes: identity.bytes, sha256: identity.sha256,
                lastSequence: summary.lastSequence, layout: layout), members: members)
        try verify(receipt, lease: lease)
        let data = try JSONEncoder().encode(receipt)
        try lease.publishMember(receiptFile) { try write(data, to: $0, offset: 0) }
        return receipt
    }

    fileprivate static func read(lease: CaptureJournalLease) throws -> StoredReceipt {
        let descriptor = try lease.openMember(receiptFile)
        defer { close(descriptor) }
        // At most six member proofs plus journal/binding facts (<16 KiB); 4× JSON/envelope margin.
        let identity = try CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(descriptor)"), maximumBytes: 65536)
        var data = Data(count: Int(identity.bytes))
        let count = data.withUnsafeMutableBytes { pread(descriptor, $0.baseAddress, $0.count, 0) }
        guard count == data.count, SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == identity.sha256 else {
            throw invalid("Source receipt changed during read.")
        }
        do { return try JSONDecoder().decode(StoredReceipt.self, from: data) }
        catch { throw invalid("Source receipt is malformed.") }
    }

    fileprivate static func verify(_ receipt: CapturePublishedSource, lease: CaptureJournalLease, staged: Bool = false, canonical: [String: String]? = nil) throws {
        try lease.check()
        let expectedJournal = receipt.kind == .primary ? "source.journal.jsonl" : "capture.journal.jsonl"
        let allowedMembers: Set<String> = receipt.kind == .primary
            ? ["video.mov", "narration.mov", "system.mov", "narration.publication.json", "system.publication.json"]
            : ["video.mov", "camera.publication.json", CameraMedia.mappingFile]
        guard receipt.journal.file == expectedJournal, JournalSchema.isSupported(receipt.journal.layout),
            Set(receipt.members.keys).isSubset(of: allowedMembers), receipt.members["video.mov"] != nil,
            receipt.kind != .camera || Set(receipt.members.keys) == allowedMembers else {
            throw invalid("Source receipt names invalid authority members.")
        }
        let descriptor = try lease.openMember(staged ? "capture.journal.jsonl" : expectedJournal)
        defer { close(descriptor) }
        let identity = try CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(descriptor)"))
        guard identity.bytes == receipt.journal.bytes, identity.sha256 == receipt.journal.sha256 else {
            throw invalid("Immutable source journal changed.")
        }
        let (summary, marks) = try summary(lease: lease, descriptor: descriptor, layout: receipt.journal.layout)
        try receipt.binding?.validate()
        guard !receipt.sourceId.isEmpty, receipt.sourceId.utf16.count <= 256,
            receipt.diagnostic?.code == summary.completion?.failureCode.map({ String($0.prefix(128)) }),
            receipt.diagnostic?.message == summary.completion?.failureMessage,
            summary.validatedPrefix == JournalPrefix(bytes: identity.bytes, sha256: identity.sha256),
            !summary.incompleteTail, summary.invalidAtSequence == nil,
            summary.lastSequence == receipt.journal.lastSequence,
            receipt.take == summary.header.flatMap(takeFacts),
            receipt.marks == marks,
            summary.header?.sessionID == receipt.sourceId, summary.header?.cameraBinding == receipt.binding,
            summary.originHostUs == receipt.originHostUs, receipt.sourceDurationUs > 0,
            summary.completion?.durationUs == receipt.sourceDurationUs else { throw invalid("Source receipt differs from its journal.") }
        if receipt.kind == .primary {
            _ = try CaptureJournal.readEvidence(directory: lease.directory,                 retainTiming: false, geometry: { _ in }, samples: { _ in }, displaySpace: { _ in },
                through: JournalPrefix(bytes: identity.bytes, sha256: identity.sha256),
                descriptor: lease.descriptor, layout: receipt.journal.layout)
        }
        for (name, expected) in receipt.members {
            guard try memberIdentity(name, lease: lease, canonical: canonical) == expected else { throw invalid("Published source member changed: \(name).") }
        }
        for role in ["narration", "system"] {
            guard (receipt.members["\(role).mov"] != nil) == (receipt.members["\(role).publication.json"] != nil) else {
                throw invalid("Published audio proof is incomplete.")
            }
        }
        try lease.check()
    }

    // Live callers have just run their publishers. Recovery uses the same read-only proof checks.
    fileprivate static func verifyMedia(_ receipt: CapturePublishedSource, lease: CaptureJournalLease, canonical: [String: String]? = nil) async throws {
        if receipt.kind == .camera {
            _ = try await CameraMedia.readPublished(lease: lease, canonical: try mediaURL("video", lease: lease, canonical: canonical))
        } else {
            for role in ["narration", "system"] where receipt.members["\(role).mov"] != nil {
                _ = try await CaptureAudioPublication.readPublished(lease: lease, role: role, canonical: try mediaURL(role, lease: lease, canonical: canonical))
            }
        }
        try lease.check()
    }

    private static func takeFacts(_ header: CaptureJournalHeader) -> CapturePublishedSource.Take? {
        guard JournalSchema.summarizesTake(header.schemaVersion),
            let kind = CapturePublishedSource.Take.Kind(rawValue: header.source.kind) else { return nil }
        return .init(kind: kind)
    }
    private static func summary(lease: CaptureJournalLease, descriptor: Int32, layout: Int) throws -> (CaptureJournalSummary, CapturePublishedSource.Marks?) {
        let summarizesTake = JournalSchema.summarizesTake(layout)
        var kinds = Set<String>()
        let facts = try CaptureJournal.readEvidence(directory: lease.directory,             retainTiming: false, geometry: { _ in }, samples: { _ in }, displaySpace: { _ in },
            mark: { mark in
                // An undo row says when a mark left the screen; it takes no mark away.
                if summarizesTake, mark.retracts == nil { kinds.insert(mark.kind) }
            }, retainPrefix: true, descriptor: descriptor, layout: layout)
        let marks: CapturePublishedSource.Marks? = summarizesTake
            ? .init(pins: kinds.contains("pin"), strokes: kinds.contains("stroke")) : nil
        return (facts, marks)
    }
    private static func memberIdentity(_ name: String, lease: CaptureJournalLease, canonical: [String: String]? = nil) throws -> CaptureMediaIdentity {
        if let role = ["video", "narration", "system"].first(where: { name == "\($0).mov" }), canonical != nil {
            return try CaptureMediaIdentity.read(mediaURL(role, lease: lease, canonical: canonical))
        }
        let descriptor = try lease.openMember(name)
        defer { close(descriptor) }
        return try CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(descriptor)"))
    }
    private static func mediaURL(_ role: String, lease: CaptureJournalLease, canonical: [String: String]?) throws -> URL {
        if let canonical {
            guard let path = canonical[role], path.hasPrefix("/dev/fd/"), Int32(path.dropFirst(8)) != nil else {
                throw invalid("Capture admission requires every pinned canonical descriptor.")
            }
            return URL(fileURLWithPath: path)
        }
        return URL(fileURLWithPath: lease.directory).appendingPathComponent("\(role).mov")
    }

    private static func write(_ data: Data, to descriptor: Int32, offset: Int64) throws {
        try data.withUnsafeBytes { bytes in
            var written = 0
            while written < data.count {
                let count = pwrite(descriptor, bytes.baseAddress!.advanced(by: written), data.count - written, offset + Int64(written))
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                written += count
            }
        }
    }
    private static func invalid(_ message: String) -> CaptureFailure { CaptureFailure("INVALID_JOURNAL_PREFIX", message) }
}
