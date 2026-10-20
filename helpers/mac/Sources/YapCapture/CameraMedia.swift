@preconcurrency import AVFoundation
import CryptoKit
import Darwin
import Foundation
import YapMedia
import Synchronization

package struct CameraFrameMapping: Codable {
    let ordinal: Int
    let start: CaptureRationalTime
    let nominalEnd: CaptureRationalTime
    /// Frames between one turn-on and the next turn-off. Written only when nonzero, so the rows
    /// of a camera never turned off carry no `run`.
    let run: Int
    private enum CodingKeys: String, CodingKey { case ordinal, start, run; case nominalEnd = "end" }
    init(ordinal: Int, start: CaptureRationalTime, nominalEnd: CaptureRationalTime, run: Int = 0) {
        self.ordinal = ordinal; self.start = start; self.nominalEnd = nominalEnd; self.run = run
    }
    package init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ordinal = try values.decode(Int.self, forKey: .ordinal)
        start = try values.decode(CaptureRationalTime.self, forKey: .start)
        nominalEnd = try values.decode(CaptureRationalTime.self, forKey: .nominalEnd)
        guard let run = try values.decodeIfPresent(Int.self, forKey: .run) else { run = 0; return }
        // Zero is written by omission only, so one take has one mapping form.
        guard run > 0 else { throw CameraMedia.invalid("Camera run must be omitted when zero.") }
        self.run = run
    }
    package func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(ordinal, forKey: .ordinal)
        try values.encode(start, forKey: .start)
        try values.encode(nominalEnd, forKey: .nominalEnd)
        if run != 0 { try values.encode(run, forKey: .run) }
    }
    // Callback duration supplies provenance and the final endpoint, not inter-picture availability.
    func acquisitionRange(scale: Int32) throws -> CMTimeRange {
        guard start.timescale > 0, nominalEnd.timescale > 0, start.epoch == 0, nominalEnd.epoch == 0,
            start.value >= 0, nominalEnd.time > start.time else { throw CameraMedia.invalid("Invalid rational camera interval.") }
        let first = CMTimeConvertScale(start.time, timescale: scale, method: .roundHalfAwayFromZero)
        let last = CMTimeConvertScale(nominalEnd.time, timescale: scale, method: .roundHalfAwayFromZero)
        guard last > first else { throw CameraMedia.invalid("Camera interval cannot fit its writer timescale.") }
        return CMTimeRange(start: first, end: last)
    }
}

/// The source time a companion camera actually recorded: one interval per run of frames between
/// a turn-on and the next turn-off, merged where no source time separates two runs. `support` is
/// the outer span and `gaps` the off time strictly inside it, so a camera never turned off has
/// no gaps. The only owner of camera interval arithmetic.
package struct CameraAvailability: Sendable, Equatable {
    /// A take turns its camera on at most 500 times, counting a turn-on at its start; the 501st is
    /// refused (`CAMERA_TOGGLE_LIMIT`). Each turn-on starts at most one run, so at most 499 gaps;
    /// that keeps the receipt inside its 64 KiB read bound and the normalized receipt's 32 KiB.
    package static let maximumGaps = 499
    package let support: ExactRange
    package let gaps: [ExactRange]

    package init(intervals: [ExactRange]) throws {
        var merged: [ExactRange] = []
        for interval in intervals {
            guard try interval.endUs.compare(interval.startUs) == .orderedDescending else {
                throw CameraMedia.invalid("Camera interval is empty.")
            }
            if let last = merged.last {
                let order = try last.endUs.compare(interval.startUs)
                guard order != .orderedDescending else { throw CameraMedia.invalid("Camera intervals overlap or are out of order.") }
                if order == .orderedSame {
                    merged[merged.count - 1] = ExactRange(startUs: last.startUs, endUs: interval.endUs)
                    continue
                }
            }
            merged.append(interval)
        }
        guard let first = merged.first, let last = merged.last, merged.count - 1 <= Self.maximumGaps else {
            throw CameraMedia.invalid("Camera availability requires 1...\(Self.maximumGaps + 1) intervals.")
        }
        support = ExactRange(startUs: first.startUs, endUs: last.endUs)
        gaps = zip(merged, merged.dropFirst()).map { ExactRange(startUs: $0.endUs, endUs: $1.startUs) }
    }
    init(_ ranges: [CMTimeRange]) throws {
        try self.init(intervals: ranges.map { try ExactRange(startUs: ExactTime($0.start), endUs: ExactTime($0.end)) })
    }
    /// Stated gaps must be exactly the ones their intervals imply: sorted, disjoint, non-adjacent
    /// and strictly inside support.
    package init(support: ExactRange, gaps: [ExactRange]) throws {
        try self.init(intervals: support.subtracting(gaps))
        guard self.support == support, self.gaps == gaps else { throw CameraMedia.invalid("Camera gaps are malformed.") }
    }
    package var intervals: [ExactRange] {
        zip([support.startUs] + gaps.map(\.endUs), gaps.map(\.startUs) + [support.endUs]).map {
            ExactRange(startUs: $0, endUs: $1)
        }
    }
}

/// Canonical camera publication/replay owner. Raw files and observations stay retained.
package enum CameraMedia {
    package static let mappingFile = "camera.mapping.jsonl"
    package enum Presentation: String, Codable { case nativeBounded = "native-bounded" }
    package struct Receipt: Codable {
        package let presentation: Presentation
        package let raw: CaptureMediaIdentity
        package let observations: CaptureMediaIdentity
        package let closed: CaptureMediaIdentity?
        package let canonical: CaptureMediaIdentity
        package let candidate: String
        package let representedFrames: Int
        package let firstUs: Int64
        package let endUs: Int64
        package let pictureSHA256: String
        package let diagnostics: [String]
        /// The outer span; `gaps` is the off time inside it, omitted when the camera was never off.
        package let support: ExactRange?
        package let gaps: [ExactRange]?
        package let pictureTimeScale: Int32?
        package let binding: CameraCaptureBinding?
        package let originHostUs: Int64?
        package let journal: JournalPrefix?

        /// Nil only for historical unbound receipts, which predate support and hold one interval.
        func availability() throws -> CameraAvailability? {
            guard let support else {
                guard gaps == nil else { throw invalid("Camera gaps require support.") }
                return nil
            }
            guard gaps.map({ !$0.isEmpty }) ?? true else { throw invalid("Empty camera gaps must be omitted.") }
            return try CameraAvailability(support: support, gaps: gaps ?? [])
        }
    }
    private struct Row: Decodable {
        let role: CaptureIngressRole
        let disposition: String
        let cameraFrame: CameraFrameMapping?
    }
    package static func invalid(_ message: String) -> CaptureFailure { CaptureFailure("INVALID_CAMERA_MAPPING", message) }
    private static func save<T: Encodable>(_ value: T, to url: URL) throws {
        let file = try NewFile(at: url.path, assembledAs: "receipt.json")
        defer { file.discard() }
        try file.write(JSONEncoder().encode(value)); _ = try file.publish()
    }
    package static func recordClosed(raw: URL, marker: URL) throws {
        try save(CaptureMediaIdentity.read(raw), to: marker)
    }
    package final class Mapping {
        package struct Position: Sendable {
            let bytes: Int64
            let lines: Int
            let frames: Int
            let run: Int?
            let sha256: String
        }
        private let input: FileHandle
        private var pending = Data()
        private var eof = false
        private var lines = 0
        private let openedBytes: Int64
        private var readBytes: Int64 = 0
        private var consumedBytes: Int64 = 0
        private var prefixHash = SHA256()
        private(set) var frames = 0
        /// The run of the last accepted frame.
        private(set) var run: Int?
        private(set) var torn = false
        package init(_ url: URL, resuming position: Position? = nil) throws {
            let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard descriptor >= 0 else {
                throw CaptureFailure([ENOENT, ENOTDIR, ELOOP].contains(errno) ? "INVALID_CAMERA_MAPPING" : "MEDIA_UNAVAILABLE", "Cannot open camera mapping.")
            }
            var info = stat()
            guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
                info.st_size >= 0, info.st_size <= 268_435_456 else {
                Darwin.close(descriptor)
                throw invalid("Camera mapping exceeds its regular-file read budget.")
            }
            input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            openedBytes = info.st_size
            if let position {
                guard position.bytes <= openedBytes else { throw invalid("Camera mapping prefix disappeared.") }
                while readBytes < position.bytes {
                    let data = try input.read(upToCount: Int(min(65536, position.bytes - readBytes))) ?? Data()
                    guard !data.isEmpty else { throw invalid("Camera mapping prefix ended early.") }
                    prefixHash.update(data: data); readBytes += Int64(data.count)
                }
                guard hex(prefixHash.finalize()) == position.sha256 else { throw invalid("Camera mapping prefix changed.") }
                consumedBytes = position.bytes; lines = position.lines; frames = position.frames; run = position.run
            }
        }
        var position: Position { Position(bytes: consumedBytes, lines: lines, frames: frames, run: run, sha256: hex(prefixHash.finalize())) }
        deinit { try? input.close() }
        package func next() throws -> CameraFrameMapping? {
            while true {
                try Task.checkCancellation()
                if let end = pending.firstIndex(of: 10) {
                    let data = Data(pending[..<end]); pending.removeSubrange(...end)
                    lines += 1
                    guard lines <= 5_000_000, data.count <= 65536 else { throw invalid("Observation bounds exceeded.") }
                    let row: Row
                    do { row = try JSONDecoder().decode(Row.self, from: data) }
                    catch { throw invalid("Malformed camera observation row.") }
                    prefixHash.update(data: data); prefixHash.update(data: Data([10]))
                    consumedBytes += Int64(data.count + 1)
                    if row.role == .camera && row.disposition == "accepted" {
                        guard let frame = row.cameraFrame, frame.ordinal == frames else {
                            throw invalid("Accepted camera mapping is missing or out of ordinal order.")
                        }
                        // A run advances by one, and only after a run that accepted a frame.
                        guard frame.run == (run ?? 0) || run.map({ frame.run == $0 + 1 }) == true else {
                            throw invalid("Camera mapping runs are out of order.")
                        }
                        frames += 1; run = frame.run
                        return frame
                    } else if row.cameraFrame != nil { throw invalid("Unaccepted picture has a camera mapping.") }
                } else {
                    guard pending.count <= 65536 else { throw invalid("Observation line exceeds bounded size.") }
                    if eof { torn = !pending.isEmpty; return nil }
                    let remaining = openedBytes - readBytes
                    if remaining == 0 {
                        guard (try input.read(upToCount: 1) ?? Data()).isEmpty else { throw invalid("Camera mapping grew beyond its opened byte boundary.") }
                        eof = true
                    } else {
                        let chunk = try input.read(upToCount: Int(min(65536, remaining))) ?? Data()
                        guard !chunk.isEmpty else { throw invalid("Camera mapping shrank before its opened byte boundary.") }
                        readBytes += Int64(chunk.count); pending.append(chunk)
                    }
                }
            }
        }
    }
    fileprivate struct Source: Sendable {
        let input: MediaInput
        let track: AVAssetTrack
        let segments: [SourceSegment]
        let scale: Int32
        var asset: AVURLAsset { input.asset }
        init(url: URL) async throws {
            input = try MediaInput(url: url, purpose: .streaming)
            let asset = input.asset
            let videos = try await asset.loadTracks(withMediaType: .video)
            guard videos.count == 1, try await asset.loadTracks(withMediaType: .audio).isEmpty,
                let track = videos.first else { throw invalid("Camera requires one video track and no audio.") }
            self.track = track
            scale = try await track.load(.naturalTimeScale)
            guard scale > 0 else { throw invalid("Camera has no positive native timescale.") }
            segments = SourceSegment.occupied(of: try await track.load(.segments))
        }
    }
    private final class Pictures {
        let source: Source
        var track: AVAssetTrack { source.track }
        var segments: [SourceSegment] { source.segments }
        var scale: Int32 { source.scale }
        let reader: AVAssetReader
        let output: AVAssetReaderTrackOutput
        private(set) var lastEnd = CMTime.invalid
        convenience init(url: URL) async throws { try self.init(source: await Source(url: url)) }
        init(source: Source, range: CMTimeRange? = nil) throws {
            self.source = source
            reader = try AVAssetReader(asset: source.asset)
            output = AVAssetReaderTrackOutput(track: source.track,
                outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            reader.add(output)
            if let range { reader.timeRange = range }
            guard reader.startReading() else { throw reader.error ?? invalid("Cannot decode camera payload.") }
        }
        func next() throws -> CMSampleBuffer? {
            while let sample = output.copyNextSampleBuffer() {
                try Task.checkCancellation()
                if let end = assetEnd(ofSamplePresentedAt: sample.presentationTimeStamp, in: segments, of: track) {
                    lastEnd = end
                    return sample
                }
            }
            guard reader.status == .completed else { throw reader.error ?? invalid("Camera decoder ended incompletely.") }
            return nil
        }
        deinit { reader.cancelReading() }
    }
    private static func digest(_ sample: CMSampleBuffer, into hash: inout SHA256, scale: Int32) throws {
        guard let pixel = sample.imageBuffer else { throw invalid("Camera picture has no decoded pixels.") }
        CVPixelBufferLockBaseAddress(pixel, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixel, .readOnly) }
        for number in [CMTimeConvertScale(sample.presentationTimeStamp, timescale: scale, method: .roundHalfAwayFromZero).value,
            Int64(CVPixelBufferGetWidth(pixel)), Int64(CVPixelBufferGetHeight(pixel))] {
            var little = number.littleEndian
            withUnsafeBytes(of: &little) { hash.update(bufferPointer: $0) }
        }
        let base = CVPixelBufferGetBaseAddress(pixel)!
        let visibleRowBytes = CVPixelBufferGetWidth(pixel) * 4
        let stride = CVPixelBufferGetBytesPerRow(pixel)
        let height = CVPixelBufferGetHeight(pixel)
        // Padding is not picture data; tightly packed rows can share one hash update.
        if stride == visibleRowBytes {
            hash.update(bufferPointer: UnsafeRawBufferPointer(start: base, count: visibleRowBytes * height))
        } else {
            for row in 0..<height {
                hash.update(bufferPointer: UnsafeRawBufferPointer(start: base.advanced(by: row * stride), count: visibleRowBytes))
            }
        }
    }
    private static func hex(_ value: SHA256.Digest) -> String { value.map { String(format: "%02x", $0) }.joined() }

    /// The original closed observation bytes become a local immutable publication dependency.
    package static func retainMapping(observations: URL, directory: URL, identity: CaptureMediaIdentity? = nil) throws -> URL {
        let expected = try identity ?? CaptureMediaIdentity.read(observations, maximumBytes: 268_435_456)
        guard expected.bytes > 0, expected.bytes <= 268_435_456 else { throw invalid("Camera mapping exceeds its read budget.") }
        let target = directory.appendingPathComponent(mappingFile)
        if FileManager.default.fileExists(atPath: target.path) {
            guard try CaptureMediaIdentity.read(target, maximumBytes: 268_435_456) == expected else { throw invalid("Retained camera mapping differs from closed observations.") }
            return target
        }
        let descriptor = Darwin.open(observations.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else { throw CaptureFailure("MEDIA_UNAVAILABLE", "Cannot retain camera mapping input.") }
        let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? input.close() }
        let file = try NewFile(at: target.path, assembledAs: "mapping.jsonl")
        defer { file.discard() }
        let staged = Darwin.open(file.url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard staged >= 0 else { throw CaptureFailure("MEDIA_UNAVAILABLE", "Cannot create retained camera mapping.") }
        let output = FileHandle(fileDescriptor: staged, closeOnDealloc: true)
        defer { try? output.close() }
        var bytes: Int64 = 0
        while let data = try input.read(upToCount: 65536), !data.isEmpty {
            try Task.checkCancellation()
            bytes += Int64(data.count)
            guard bytes <= expected.bytes else { throw invalid("Closed camera mapping changed length.") }
            try output.write(contentsOf: data)
        }
        guard try CaptureMediaIdentity.read(file.url, maximumBytes: 268_435_456) == expected,
            try CaptureMediaIdentity.read(observations, maximumBytes: 268_435_456) == expected else { throw invalid("Closed camera mapping changed during retention.") }
        _ = try file.publish()
        return target
    }

    private static func facts(_ lease: CaptureJournalLease, through prefix: JournalPrefix? = nil) throws -> CaptureJournalSummary {
        try lease.check()
        return try CaptureJournal.readEvidence(directory: lease.directory, maximumBytes: 268_435_456, retainTiming: true,
            geometry: { _ in }, samples: { _ in }, displaySpace: { _ in }, retainPrefix: true,
            through: prefix, descriptor: lease.descriptor)
    }

    private static func validateJournal(_ receipt: Receipt, lease: CaptureJournalLease) throws {
        let pinned = try facts(lease, through: receipt.journal)
        guard let header = pinned.header, JournalSchema.isCompanion(header.schemaVersion) else { throw invalid("Camera requires its source journal.") }
        let production = header.source.kind == "camera" || header.cameraBinding != nil || receipt.binding != nil
        if production {
            guard let binding = receipt.binding, header.source.kind == "camera", header.cameraBinding == binding,
                header.sessionID == binding.sourceId, !header.microphone, !header.systemAudio,
                receipt.journal != nil, receipt.originHostUs != nil, receipt.support != nil,
                let scale = receipt.pictureTimeScale, scale > 0 else { throw invalid("Production camera requires bound exact publication proof.") }
            try binding.validate()
        }
        if receipt.journal != nil {
            let current = try facts(lease)
            guard receipt.binding == header.cameraBinding, receipt.originHostUs == pinned.originHostUs,
                current.originHostUs == pinned.originHostUs, current.pauses == pinned.pauses,
                current.openPauseHostUs == pinned.openPauseHostUs else { throw invalid("Camera binding or shared clock differs from its publication prefix.") }
        }
        try lease.check()
    }

    fileprivate struct CanonicalScan: Sendable {
        let availability: CameraAvailability
        let pictureHash: String
        let remainingMapping: Result<Void, any Error>
        func verified(against expectedHash: String) throws -> CameraAvailability {
            guard pictureHash == expectedHash else { throw invalid("Canonical camera pixels or terminal support changed.") }
            try remainingMapping.get()
            return availability
        }
    }
    /// A run's first frame starts a new interval unless no source time separates it from the
    /// previous run's last acquisition. Raw and canonical scans share this one rule.
    private static func startsInterval(_ run: Int, at start: CMTime, after last: (range: CMTimeRange, run: Int)) -> Bool {
        run != last.run && last.range.end < start
    }
    /// Run boundaries are the only place an interval may end; every other frame stays inside the
    /// current interval. Each interval ends inside its last frame's acquisition. The intervals are
    /// `CameraAvailability`'s, read from the movie's occupied segments.
    private struct CanonicalScanState {
        private var hash = SHA256()
        private var previous: CMTime?
        private var last: (range: CMTimeRange, run: Int)?
        private var interval = 0
        private(set) var represented = 0

        private static func ends(_ interval: ExactRange, at last: CMTimeRange) throws -> Bool {
            try interval.endUs.compare(ExactTime(last.start)) == .orderedDescending
                && interval.endUs.compare(ExactTime(last.end)) != .orderedDescending
        }
        private static func starts(_ interval: ExactRange?, at start: CMTime) throws -> Bool {
            try interval.map { try $0.startUs.compare(ExactTime(start)) == .orderedSame } ?? false
        }
        mutating func append(_ frame: CameraFrameMapping, scale: Int32, intervals: [ExactRange],
            nextPicture: () throws -> CMSampleBuffer?) throws {
            let range = try frame.acquisitionRange(scale: scale)
            guard previous.map({ $0 < frame.start.time }) ?? true else {
                throw invalid("Canonical camera picture order or exact timestamp changed.")
            }
            if let last {
                if startsInterval(frame.run, at: range.start, after: last) {
                    guard interval + 1 < intervals.count, try Self.ends(intervals[interval], at: last.range),
                        try Self.starts(intervals[interval + 1], at: range.start) else { throw invalid("Canonical camera gaps differ from mapped runs.") }
                    interval += 1
                } else if try ExactTime(range.start).compare(intervals[interval].endUs) != .orderedAscending {
                    throw invalid("Canonical camera gaps differ from mapped runs.")
                }
            } else if try !Self.starts(intervals.first, at: range.start) { throw invalid("Canonical camera picture order or exact timestamp changed.") }
            guard let sample = try nextPicture(), sample.presentationTimeStamp == range.start else {
                throw invalid("Canonical camera picture order or exact timestamp changed.")
            }
            previous = frame.start.time; last = (range, frame.run)
            try digest(sample, into: &hash, scale: scale)
            represented += 1
        }
        func finish(intervals: [ExactRange], nextPicture: () throws -> CMSampleBuffer?) throws -> String {
            guard let last, interval == intervals.count - 1, try Self.ends(intervals[interval], at: last.range),
                try nextPicture() == nil else { throw invalid("Canonical camera pixels or terminal support changed.") }
            return hex(hash.finalize())
        }
        mutating func validateRemaining(_ frame: CameraFrameMapping, scale: Int32) throws {
            _ = try frame.acquisitionRange(scale: scale)
            guard previous.map({ $0 < frame.start.time }) ?? true else {
                throw invalid("Camera acquisition timestamps are not strictly increasing.")
            }
            previous = frame.start.time
        }
    }
    /// One ordered-picture, exact-PTS, native-support and visible-BGRA verifier for publication/admission.
    /// `expected` is nil only for historical unbound receipts, which always held one interval.
    private static func verifyCanonical(_ url: URL, mappingURL: URL, represented: Int, scale: Int32,
        pictureHash: String, expected: CameraAvailability?) async throws -> CameraAvailability {
        let scanned = try await scanCanonical(url, mappingURL: mappingURL, represented: represented,
            scale: scale, expected: expected)
        return try scanned.verified(against: pictureHash)
    }
    private static func scanCanonical(_ url: URL, mappingURL: URL, represented: Int, scale: Int32,
        expected: CameraAvailability?) async throws -> CanonicalScan {
        guard represented > 0, represented <= 5_000_000, scale > 0 else { throw invalid("Invalid represented camera picture count or timescale.") }
        let candidate = try await Pictures(url: url)
        // Occupied segments are the canonical movie's only statement of availability.
        let availability: CameraAvailability
        do { availability = try CameraAvailability(candidate.segments.map(\.asset)) }
        catch {
            if expected == nil { throw invalid("Camera has no single bounded native support interval.") }
            throw error
        }
        guard expected != nil || availability.gaps.isEmpty else { throw invalid("Camera has no single bounded native support interval.") }
        guard expected.map({ $0 == availability }) ?? true else { throw invalid("Canonical camera support differs from publication.") }
        let intervals = availability.intervals
        let mapping = try Mapping(mappingURL)
        var state = CanonicalScanState()
        for _ in 0..<represented {
            guard let frame = try mapping.next() else { throw invalid("Camera mapping ended before represented pictures.") }
            try state.append(frame, scale: scale, intervals: intervals, nextPicture: candidate.next)
        }
        let pictureHash = try state.finish(intervals: intervals, nextPicture: candidate.next)
        // Hash disagreement precedes malformed trailing mapping rows, as in sequential verification.
        let remaining: Result<Void, any Error>
        do {
            while let frame = try mapping.next() {
                try state.validateRemaining(frame, scale: scale)
            }
            remaining = .success(())
        } catch { remaining = .failure(error) }
        return CanonicalScan(availability: availability, pictureHash: pictureHash, remainingMapping: remaining)
    }

    private static func readReceipt(_ url: URL) throws -> (Receipt, CaptureMediaIdentity) {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else { throw CaptureFailure([ENOENT, ENOTDIR, ELOOP].contains(errno) ? "INVALID_CAMERA_MAPPING" : "MEDIA_UNAVAILABLE", "Cannot read camera publication receipt.") }
        let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? input.close() }
        let identity = try CaptureMediaIdentity.read(URL(fileURLWithPath: "/dev/fd/\(descriptor)"), maximumBytes: receiptLimit)
        let data = try input.read(upToCount: Int(receiptLimit) + 1) ?? Data()
        guard Int64(data.count) == identity.bytes, hex(SHA256.hash(data: data)) == identity.sha256 else { throw invalid("Camera publication receipt changed during read.") }
        do { return (try JSONDecoder().decode(Receipt.self, from: data), identity) }
        catch { throw invalid("Malformed retained camera publication.") }
    }

    /// Encodes the receipt's form: outer `support`, and `gaps` only when the camera was off.
    package struct VerifiedSource: Encodable, Sendable {
        package let canonical: CaptureMediaIdentity
        package let receipt: CaptureMediaIdentity
        package let mapping: CaptureMediaIdentity
        package let availability: CameraAvailability
        package let representedFrames: Int
        private enum CodingKeys: String, CodingKey { case canonical, receipt, mapping, support, gaps, representedFrames }
        package func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(canonical, forKey: .canonical)
            try values.encode(receipt, forKey: .receipt)
            try values.encode(mapping, forKey: .mapping)
            try values.encode(availability.support, forKey: .support)
            if !availability.gaps.isEmpty { try values.encode(availability.gaps, forKey: .gaps) }
            try values.encode(representedFrames, forKey: .representedFrames)
        }
    }

    /// Read-only admission verifies the supplied immutable canonical descriptor; it never republishes.
    package static func readPublished(lease: CaptureJournalLease, canonical: URL) async throws -> (identity: VerifiedSource, diagnostics: [String]) {
        let root = URL(fileURLWithPath: lease.directory)
        let receiptURL = root.appendingPathComponent("camera.publication.json")
        let (receipt, receiptIdentity) = try readReceipt(receiptURL)
        try validateJournal(receipt, lease: lease)
        let mappingURL = root.appendingPathComponent(mappingFile)
        let mapping = try CaptureMediaIdentity.read(mappingURL, maximumBytes: 268_435_456)
        guard mapping == receipt.observations, try CaptureMediaIdentity.read(canonical) == receipt.canonical else { throw invalid("Canonical camera or mapping differs from publication.") }
        let scale: Int32
        if let retained = receipt.pictureTimeScale { scale = retained }
        else {
            // Historical unbound receipts did not retain the digest's native scale. Only their actual raw authority can supply it.
            let raw = root.appendingPathComponent("camera.raw.mov")
            let descriptor = Darwin.open(raw.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard descriptor >= 0 else { throw CaptureFailure([ENOENT, ENOTDIR, ELOOP].contains(errno) ? "INVALID_CAMERA_MAPPING" : "MEDIA_UNAVAILABLE", "Historical camera proof requires original raw timescale authority.") }
            defer { Darwin.close(descriptor) }
            let original = URL(fileURLWithPath: "/dev/fd/\(descriptor)")
            guard try CaptureMediaIdentity.read(original) == receipt.raw else { throw invalid("Historical raw camera identity differs from publication.") }
            let pictures = try await Pictures(url: original)
            scale = pictures.scale
            guard try CaptureMediaIdentity.read(original) == receipt.raw else { throw invalid("Historical raw camera changed during native scale verification.") }
        }
        // The scan proves the receipt's gaps against the canonical edits and the mapping's runs.
        let availability = try await verifyCanonical(canonical, mappingURL: mappingURL, represented: receipt.representedFrames,
            scale: scale, pictureHash: receipt.pictureSHA256, expected: receipt.availability())
        guard try availability.support.startUs.sample(1_000_000, nearest: true) == receipt.firstUs,
            try availability.support.endUs.sample(1_000_000, nearest: true) == receipt.endUs,
            try CaptureMediaIdentity.read(canonical) == receipt.canonical,
            try CaptureMediaIdentity.read(mappingURL, maximumBytes: 268_435_456) == mapping,
            try CaptureMediaIdentity.read(receiptURL, maximumBytes: receiptLimit) == receiptIdentity else { throw invalid("Camera publication changed during canonical verification.") }
        try validateJournal(receipt, lease: lease)
        return (VerifiedSource(canonical: receipt.canonical, receipt: receiptIdentity, mapping: mapping,
            availability: availability, representedFrames: receipt.representedFrames), receipt.diagnostics)
    }
    /// Room for the most gaps a receipt may state, each with fractional endpoints.
    private static let receiptLimit = Int64(65536)

    fileprivate struct IntendedSupport: Sendable {
        let source: Source
        let support: CMTimeRange
        let represented: Int
    }
    /// Metadata qualifies scheduling only; both complete pixel scans still own acceptance. Only a
    /// single run qualifies: more runs publish through the sequential scan.
    private static func intendedSupport(rawURL: URL, mappingURL: URL) async throws -> IntendedSupport? {
        do {
            let source = try await Source(url: rawURL)
            guard source.segments.count == 1 else { return nil }
            let mapping = try Mapping(mappingURL)
            var first: CMTime?
            var previous: CMTime?
            var support: CMTimeRange?
            try visitPresentedSamples(track: source.track, segments: source.segments) { native in
                guard let frame = try mapping.next() else { throw invalid("Native inventory exceeds mapping.") }
                let range = try frame.acquisitionRange(scale: source.scale)
                guard previous.map({ $0 < frame.start.time }) ?? true, frame.run == 0,
                    range.start == native.start else { throw invalid("Mapping differs from native inventory.") }
                previous = frame.start.time
                first = first ?? range.start
                support = CMTimeRange(start: first!, end: CMTimeMinimum(range.end, native.end))
            }
            guard let support, support.end > support.start, try mapping.next() == nil, !mapping.torn,
                source.segments[0].asset.start <= support.start,
                source.segments[0].asset.end >= support.end else { return nil }
            return IntendedSupport(source: source, support: support, represented: mapping.frames)
        } catch is CancellationError { throw CancellationError() }
        catch { return nil }
    }
    /// Selects acceptance only after both actual scan results settle; failed speculation cannot defeat a raw prefix.
    package static func acceptScans<Raw: Sendable, Canonical: Sendable>(
        raw: Result<Raw, any Error>, canonical: Result<Canonical, any Error>,
        complete: (Raw) -> Bool, verify: (Raw, Canonical) throws -> CameraAvailability
    ) throws -> (raw: Raw, availability: CameraAvailability?) {
        let scanned = try raw.get()
        guard complete(scanned) else { return (scanned, nil) }
        return (scanned, try verify(scanned, canonical.get()))
    }
    private static func outcome<T: Sendable>(_ work: @Sendable () async throws -> T) async -> Result<T, any Error> {
        do { return .success(try await work()) }
        catch { return .failure(error) }
    }
    fileprivate struct RawScan: Sendable {
        let source: Source
        let intervals: [CMTimeRange]
        let represented: Int
        let pictureHash: String
        let diagnostics: [String]
        var support: CMTimeRange { CMTimeRange(start: intervals[0].start, end: intervals[intervals.count - 1].end) }
    }
    /// The raw movie is continuous; mapped runs say where its acquired intervals begin and end.
    private struct RawScanState {
        private var hash = SHA256()
        private var previousMappedStart: CMTime?
        private var last: (range: CMTimeRange, run: Int)?
        private(set) var intervals: [CMTimeRange] = []
        private(set) var represented = 0
        var diagnostics: [String]
        var pictureHash: String { hex(hash.finalize()) }

        init(sealed: Bool) { diagnostics = sealed ? [] : ["unsealedRaw"] }
        mutating func mapping(_ frame: CameraFrameMapping, scale: Int32) throws -> CMTimeRange {
            let range = try frame.acquisitionRange(scale: scale)
            guard previousMappedStart.map({ $0 < frame.start.time }) ?? true else {
                throw invalid("Camera acquisition timestamps are not strictly increasing.")
            }
            previousMappedStart = frame.start.time
            return range
        }
        mutating func append(_ sample: CMSampleBuffer, range: CMTimeRange, run: Int, nativeEnd: CMTime,
            scale: Int32) throws {
            guard sample.presentationTimeStamp == range.start else {
                throw invalid("Raw picture does not match its exact mapped ordinal.")
            }
            try digest(sample, into: &hash, scale: scale)
            represented += 1
            // Native holds each picture until the next; only the physical tail bounds the endpoint.
            let end = CMTimeMinimum(range.end, nativeEnd)
            if let last, !startsInterval(run, at: range.start, after: last) {
                intervals[intervals.count - 1] = CMTimeRange(start: intervals[intervals.count - 1].start, end: end)
            } else {
                intervals.append(CMTimeRange(start: range.start, end: end))
            }
            last = (range, run)
        }
    }
    /// One coalesced worker owns private media and both ordered scans until closure or discard.
    package final class Verification: @unchecked Sendable {
        package struct Checkpoint: Sendable { let observations: URL; let bytes: Int64; let frames: Int }
        private struct Control: Sendable {
            var pending: Checkpoint?
            var task: Task<Void, Never>?
            var closed = false
            var lastWritten: Checkpoint?
        }
        private let control = Mutex(Control())
        private let directory: URL
        private var rawState = RawScanState(sealed: true)
        private var canonicalState = CanonicalScanState()
        private var rawPosition: Mapping.Position?
        private var canonicalPosition: Mapping.Position?
        private var rawFence: CMTime?
        private var canonicalFence: CMTime?
        private var format: CMFormatDescription?
        private var transform: CGAffineTransform?
        private var scale: Int32?
        private var origin: (CMTime, CMTime, CMTime)?
        private var encodedCount = 0
        private var encodedHash: String?
        private var canonicalEncodedHash: String?
        private var canonicalOrigin: (CMTime, CMTime, CMTime)?
        private var writer: AVAssetWriter?
        private var input: AVAssetWriterInput?
        private var file: NewFile?
        private var failure: (any Error)?
        private var fallbackReported = false
        private var completed: (RawScan, CanonicalScan, CaptureMediaIdentity)?
        private var previousVersion: (off_t, timespec, Int?)?
        private var rawInode: (dev_t, ino_t)?
        private var canonicalVersion: (off_t, timespec)?
        private var watches: [DispatchSourceFileSystemObject] = []
        private let watchJoin = DispatchGroup()

        package init(directory: URL) {
            self.directory = directory
            watch(self.directory.appendingPathComponent("camera.raw.mov"))
        }
        private func watch(_ url: URL) {
            let fd = Darwin.open(url.path, O_EVTONLY | O_NOFOLLOW_ANY | O_CLOEXEC)
            guard fd >= 0 else { return }
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend], queue: .global(qos: .utility))
            source.setEventHandler { [self] in
                guard let request = control.withLock({ $0.lastWritten }) else { return }
                self.request(observations: request.observations, bytes: request.bytes, frames: request.frames)
            }
            watchJoin.enter()
            source.setCancelHandler { [watchJoin] in Darwin.close(fd); watchJoin.leave() }
            watches.append(source); source.resume()
        }
        private func joinNotifications() async {
            let owned = watches; watches.removeAll()
            for source in owned { source.cancel() }
            await withCheckedContinuation { continuation in
                watchJoin.notify(queue: .global()) { continuation.resume() }
            }
        }
        package static func newest(_ previous: Checkpoint?, _ offered: Checkpoint) -> Checkpoint {
            if let previous, previous.bytes >= offered.bytes { return previous }
            return offered
        }
        package func request(observations: URL, bytes: Int64, frames: Int) {
            control.withLock { state in
                guard !state.closed else { return }
                let request = Checkpoint(observations: observations, bytes: bytes, frames: frames)
                state.lastWritten = Self.newest(state.lastWritten, request); state.pending = state.lastWritten
                if state.task == nil { state.task = Task { await self.run() } }
            }
        }
        private func run() async {
            while let request = control.withLock({ state -> Checkpoint? in
                let next = state.pending; state.pending = nil
                if next == nil { state.task = nil }
                return next
            }) {
                do { try await advance(request) }
                catch {
                    failure = error
                    control.withLock { state in state.closed = true; state.pending = nil; state.task = nil }
                    return
                }
            }
        }
        /// Accepts no further checkpoints. Work already proved stays usable by `finish`.
        package func abandon() {
            control.withLock { state in state.closed = true; state.pending = nil }
        }
        package func close() async {
            let task = control.withLock { state in state.closed = true; return state.task }
            await task?.value
            await joinNotifications()
        }
        package func discard() async {
            let task = control.withLock { state in
                state.closed = true; state.pending = nil; state.task?.cancel(); return state.task
            }
            await task?.value
            await joinNotifications()
            if writer?.status == .writing { writer?.cancelWriting() }
            file?.discard(); file = nil
        }
        package func discardUnfinished() async {
            await close()
            if completed == nil { await discard() }
        }
        private func copy(_ source: URL, to destination: URL) throws {
            let fd = Darwin.open(source.path, O_RDONLY | O_NOFOLLOW_ANY | O_CLOEXEC | O_NONBLOCK)
            guard fd >= 0 else { throw invalid("Cannot snapshot camera media.") }
            defer { Darwin.close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
                info.st_uid == getuid() else { throw invalid("Camera snapshot requires an owned regular file.") }
            if source.lastPathComponent == "camera.raw.mov" {
                let identity = (info.st_dev, info.st_ino)
                guard rawInode.map({ $0 == identity }) ?? true else { throw invalid("Active raw camera changed inode.") }
                rawInode = identity
            }
            let parent = Darwin.open(destination.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
            guard parent >= 0 else { throw invalid("Cannot open camera snapshot directory.") }
            defer { Darwin.close(parent) }
            guard fclonefileat(fd, parent, destination.lastPathComponent, 0) == 0 else {
                throw invalid("Camera filesystem cannot isolate a private media snapshot.")
            }
        }
        private func copyMapping(_ request: Checkpoint, to url: URL) throws {
            guard let parent = realpath(request.observations.deletingLastPathComponent().path, nil) else {
                throw invalid("Cannot resolve camera observation directory.")
            }
            let sourceURL = URL(fileURLWithPath: String(cString: parent))
                .appendingPathComponent(request.observations.lastPathComponent)
            free(parent)
            try copy(sourceURL, to: url)
            let fd = Darwin.open(url.path, O_RDWR | O_NOFOLLOW_ANY | O_CLOEXEC | O_NONBLOCK)
            guard fd >= 0 else { throw invalid("Cannot truncate camera observation snapshot.") }
            defer { Darwin.close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
                request.bytes > 0, request.bytes <= info.st_size, request.bytes <= 268_435_456,
                ftruncate(fd, request.bytes) == 0 else {
                throw invalid("Camera observation snapshot exceeds its written prefix.")
            }
        }

        private struct Inventory {
            let source: Source
            let count: Int
            let fence: Int?
            let fenceTime: CMTime?
            let format: CMFormatDescription
            let transform: CGAffineTransform
            let projection: CMTime
            let waitingForMapping: Bool
        }
        private func inventory(_ url: URL, mappingURL: URL, maximum: Int, canonical: Bool = false,
            complete: Bool = false) async throws -> Inventory {
            var fileInfo = stat()
            guard lstat(url.path, &fileInfo) == 0, fileInfo.st_mode & S_IFMT == S_IFREG else { throw invalid("Camera snapshot is unavailable.") }
            let source = try await Source(url: url)
            guard source.segments.count == 1, let segment = source.segments.first else {
                throw invalid("Active camera has no single occupied native segment.")
            }
            let descriptions = try await source.track.load(.formatDescriptions)
            let currentTransform = try await source.track.load(.preferredTransform)
            guard descriptions.count == 1, let description = descriptions.first,
                format.map({ CMFormatDescriptionEqual($0, otherFormatDescription: description) }) ?? true,
                transform.map({ $0 == currentTransform }) ?? true,
                scale.map({ $0 == source.scale }) ?? true else { throw invalid("Active camera format or clock changed.") }
            let projection = segment.assetDuration(ofMedia: CMTime(value: 1, timescale: source.scale))
            if let origin = canonical ? canonicalOrigin : origin {
                guard origin.0 == segment.media.start, origin.1 == segment.asset.start, origin.2 == projection else {
                    throw invalid("Active camera media mapping changed.")
                }
            }
            let mapping = try Mapping(mappingURL)
            var count = 0, fence: Int?, fenceTime: CMTime?, previous: CMTime?
            var largestPriorDTS: CMTime?, fenceDTS: CMTime?
            var mappedPrefix = true
            var waitingForMapping = false
            try visitPresentedSamples(track: source.track, segments: source.segments) { native in
                guard let cursor = source.track.makeSampleCursor(presentationTimeStamp: segment.mediaTime(ofAsset: native.start)),
                    cursor.presentationTimeStamp == segment.mediaTime(ofAsset: native.start) else {
                    throw invalid("Active native camera sample differs from its mapped ordinal.")
                }
                let storage = cursor.currentSampleStorageRange
                if mappedPrefix {
                    let frame = count < maximum ? try mapping.next() : nil
                    if let frame {
                        let range = try frame.acquisitionRange(scale: source.scale)
                        mappedPrefix = range.start == native.start && (previous.map { $0 < frame.start.time } ?? true)
                            && storage.offset >= 0 && storage.length > 0 && storage.offset <= fileInfo.st_size - storage.length
                        previous = frame.start.time
                    } else { mappedPrefix = false; waitingForMapping = true }
                }
                if complete && !mappedPrefix { throw invalid("Closed native camera inventory differs from its complete mapping.") }
                let dts = cursor.decodeTimeStamp
                guard dts.isNumeric else { throw invalid("Camera sample has no finite decode clock.") }
                // Cursor reordering queries may be unknown; actual DTS/PTS partition owns the fence.
                if let boundary = fenceDTS, dts <= boundary { fence = nil; fenceTime = nil; fenceDTS = nil }
                if mappedPrefix, count > 0, cursor.currentSampleSyncInfo.sampleIsFullSync.boolValue,
                    largestPriorDTS.map({ $0 < dts }) ?? true {
                    fence = count; fenceTime = native.start; fenceDTS = dts
                }
                largestPriorDTS = largestPriorDTS.map { CMTimeMaximum($0, dts) } ?? dts
                count += 1
            }
            return Inventory(source: source, count: count, fence: fence, fenceTime: fenceTime, format: description,
                transform: currentTransform, projection: projection, waitingForMapping: waitingForMapping)
        }
        private func compressedPrefix(_ source: Source, through count: Int, verifyCount: Int, expectedHash: String?,
            appendFrom: Int? = nil) async throws -> String {
            let generator = AVSampleBufferGenerator(asset: source.asset, timebase: nil)
            guard let cursor = source.track.makeSampleCursorAtFirstSampleInDecodeOrder() else { throw invalid("Camera has no compressed sample cursor.") }
            var hash = SHA256(), previousDTS: CMTime?
            let deadline = ContinuousClock.now.advanced(by: .seconds(30))
            for ordinal in 0..<count {
                try Task.checkCancellation()
                guard previousDTS.map({ $0 < cursor.decodeTimeStamp }) ?? true,
                    cursor.decodeTimeStamp.isNumeric else { throw invalid("Camera compressed decode order changed.") }
                previousDTS = cursor.decodeTimeStamp
                let request = AVSampleBufferRequest(start: cursor); request.direction = .none; request.mode = .immediate
                let sample = try generator.makeSampleBuffer(for: request)
                guard sample.isValid, CMSampleBufferDataIsReady(sample), sample.numSamples == 1,
                    let block = sample.dataBuffer, let description = sample.formatDescription,
                    CMFormatDescriptionEqual(description, otherFormatDescription: format!),
                    sample.presentationTimeStamp == cursor.presentationTimeStamp,
                    sample.decodeTimeStamp == cursor.decodeTimeStamp,
                    sample.duration == cursor.currentSampleDuration else { throw invalid("Camera compressed sample lost its native identity.") }
                for time in [sample.presentationTimeStamp, sample.decodeTimeStamp, sample.duration,
                    CMSampleBufferGetOutputPresentationTimeStamp(sample), CMSampleBufferGetOutputDecodeTimeStamp(sample), CMSampleBufferGetOutputDuration(sample)] {
                    for number in [time.value, Int64(time.timescale), Int64(time.flags.rawValue), time.epoch] {
                        var little = number.littleEndian
                        withUnsafeBytes(of: &little) { hash.update(bufferPointer: $0) }
                    }
                }
                let length = CMBlockBufferGetDataLength(block)
                var encodedLength = Int64(length).littleEndian
                withUnsafeBytes(of: &encodedLength) { hash.update(bufferPointer: $0) }
                var offset = 0
                while offset < length {
                    let n = min(65536, length - offset)
                    var bytes = Data(count: n)
                    let status = bytes.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: offset, dataLength: n, destination: $0.baseAddress!) }
                    guard status == noErr else { throw invalid("Camera compressed bytes cannot be read.") }
                    hash.update(data: bytes); offset += n
                }
                if ordinal + 1 == verifyCount {
                    guard hex(hash.finalize()) == expectedHash else {
                        throw invalid("Committed \(source.input.url.lastPathComponent) compressed prefix of \(verifyCount) pictures changed.")
                    }
                }
                if let appendFrom, ordinal >= appendFrom {
                    if writer == nil {
                        let file = try NewFile(at: directory.appendingPathComponent("video.mov").path, assembledAs: "camera.mov")
                        self.file = file
                        let writer = try AVAssetWriter(outputURL: file.url, fileType: .mov)
                        writer.movieTimeScale = source.scale
                        writer.initialMovieFragmentInterval = CMTime(value: 1, timescale: 4)
                        writer.movieFragmentInterval = CMTime(value: 1, timescale: 1)
                        let input = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: format)
                        input.mediaTimeScale = source.scale; input.transform = transform!
                        guard writer.canAdd(input) else { throw invalid("Cannot admit private canonical camera input.") }
                        writer.add(input); guard writer.startWriting() else { throw writer.error ?? invalid("Cannot start private canonical camera.") }
                        writer.startSession(atSourceTime: .zero); self.writer = writer; self.input = input
                        watch(file.url)
                    }
                    while !input!.isReadyForMoreMediaData {
                        try Task.checkCancellation()
                        guard writer!.status == .writing else { throw writer!.error ?? invalid("Private camera writer stopped accepting media.") }
                        guard ContinuousClock.now < deadline else {
                            FileHandle.standardError.write(Data("camera verification: backpressure deadline=30s; outcome=full-scan-fallback\n".utf8))
                            throw invalid("Private camera writer backpressure deadline expired.")
                        }
                        try await Task.sleep(for: .milliseconds(1))
                    }
                    guard let segment = source.segments.first(where: { $0.media.containsTime(sample.presentationTimeStamp) }),
                        segment.assetDuration(ofMedia: CMTime(value: 1, timescale: source.scale)) == CMTime(value: 1, timescale: source.scale) else {
                        throw invalid("Camera transfer requires its unscaled media-to-asset mapping.")
                    }
                    let assetPTS = segment.assetTime(ofMedia: sample.presentationTimeStamp)
                    let forwarded = assetPTS == sample.presentationTimeStamp ? sample
                        : try CaptureClockIngress.retime(sample, to: assetPTS)
                    guard CMSampleBufferGetOutputPresentationTimeStamp(forwarded) == assetPTS,
                        CMSampleBufferGetOutputDecodeTimeStamp(forwarded) == segment.assetTime(ofMedia: sample.decodeTimeStamp) else {
                        throw invalid("Camera transfer cannot preserve its absolute asset clocks.")
                    }
                    guard input!.append(forwarded) else { throw writer!.error ?? invalid("Private camera passthrough append failed.") }
                }
                if ordinal + 1 < count, cursor.stepInDecodeOrder(byCount: 1) != 1 { throw invalid("Camera compressed inventory ended early.") }
            }
            guard count >= verifyCount else { throw invalid("Camera compressed prefix shrank.") }
            return hex(hash.finalize())
        }
        private func transfer(_ source: Source, through count: Int) async throws {
            encodedHash = try await compressedPrefix(source, through: count, verifyCount: encodedCount,
                expectedHash: encodedHash, appendFrom: encodedCount)
            encodedCount = count
        }
        private func scanRawPrefix(_ inventory: Inventory, mappingURL: URL) throws {
            guard let fence = inventory.fence, let end = inventory.fenceTime, fence > rawState.represented else { return }
            let source = inventory.source
            let pictures = try Pictures(source: source, range: CMTimeRange(start: rawFence ?? source.segments[0].asset.start,
                end: source.segments[0].asset.end))
            let mapping = try Mapping(mappingURL, resuming: rawPosition)
            var trial = rawState
            while trial.represented < fence {
                guard let frame = try mapping.next(), let sample = try pictures.next() else { throw invalid("Active camera physical prefix ended early.") }
                let range = try trial.mapping(frame, scale: source.scale)
                guard pictures.lastEnd <= end else { throw invalid("Camera picture crosses the proposed IDR fence.") }
                try trial.append(sample, range: range, run: frame.run, nativeEnd: pictures.lastEnd, scale: source.scale)
            }
            let position = mapping.position
            // Decode the closing IDR itself; range EOF/flush is not evidence of decoder drainage.
            guard let closing = try pictures.next(), closing.presentationTimeStamp == end else {
                throw invalid("Camera closing IDR was not physically decoded.")
            }
            rawState = trial; rawPosition = position; rawFence = end
        }
        private func scanCanonicalPrefix(_ inventory: Inventory, mappingURL: URL) async throws {
            guard let fence = inventory.fence, let end = inventory.fenceTime, fence > canonicalState.represented else { return }
            let source = inventory.source
            let encoded = try await compressedPrefix(source, through: fence,
                verifyCount: canonicalState.represented, expectedHash: canonicalEncodedHash)
            let pictures = try Pictures(source: source, range: CMTimeRange(start: canonicalFence ?? source.segments[0].asset.start,
                end: source.segments[0].asset.end))
            let mapping = try Mapping(mappingURL, resuming: canonicalPosition)
            let intervals = try CameraAvailability([source.segments[0].asset]).intervals
            var trial = canonicalState
            while trial.represented < fence {
                guard let frame = try mapping.next() else { throw invalid("Active canonical mapping ended early.") }
                try trial.append(frame, scale: source.scale, intervals: intervals, nextPicture: pictures.next)
                guard pictures.lastEnd <= end else { throw invalid("Canonical picture crosses the proposed IDR fence.") }
            }
            let position = mapping.position
            guard let closing = try pictures.next(), closing.presentationTimeStamp == end else {
                throw invalid("Canonical closing IDR was not physically decoded.")
            }
            canonicalEncodedHash = encoded
            canonicalState = trial; canonicalPosition = position; canonicalFence = end
            canonicalOrigin = (source.segments[0].media.start, source.segments[0].asset.start, inventory.projection)
        }
        private func advance(_ request: Checkpoint) async throws {
            let raw = directory.appendingPathComponent("camera.raw.mov")
            var version = stat()
            let rawChanged = lstat(raw.path, &version) == 0 && (previousVersion.map {
                $0.0 != version.st_size || $0.1.tv_sec != version.st_mtimespec.tv_sec
                    || $0.1.tv_nsec != version.st_mtimespec.tv_nsec || ($0.2.map { request.frames > $0 } ?? false)
            } ?? true)
            var candidateAtEntry = stat()
            let canonicalChanged: Bool
            if let file, canonicalState.represented < rawState.represented,
                lstat(file.url.path, &candidateAtEntry) == 0 {
                canonicalChanged = canonicalVersion.map {
                    $0.0 != candidateAtEntry.st_size || $0.1.tv_sec != candidateAtEntry.st_mtimespec.tv_sec
                        || $0.1.tv_nsec != candidateAtEntry.st_mtimespec.tv_nsec
                } ?? true
            } else { canonicalChanged = false }
            guard rawChanged || canonicalChanged else { return }
            let scratch = directory.appendingPathComponent(".camera-snapshot-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: scratch) }
            let mapping = scratch.appendingPathComponent("mapping.jsonl")
            try copyMapping(request, to: mapping)
            if rawChanged {
                let rawCopy = scratch.appendingPathComponent("camera.raw.mov")
                try copy(raw, to: rawCopy)
                let rawInventory: Inventory?
                do { rawInventory = try await inventory(rawCopy, mappingURL: mapping, maximum: request.frames) }
                catch is CancellationError { throw CancellationError() }
                catch { rawInventory = nil }
                if let rawInventory {
                    previousVersion = (version.st_size, version.st_mtimespec, rawInventory.waitingForMapping ? request.frames : nil)
                    if rawInventory.fence.map({ $0 > rawState.represented }) ?? false {
                        try scanRawPrefix(rawInventory, mappingURL: mapping)
                        format = rawInventory.format; transform = rawInventory.transform; scale = rawInventory.source.scale
                        let segment = rawInventory.source.segments[0]
                        origin = (segment.media.start, segment.asset.start, rawInventory.projection)
                        try await transfer(rawInventory.source, through: rawInventory.fence!)
                    }
                }
            }
            guard let file, canonicalState.represented < rawState.represented else { return }
            var candidateVersion = stat()
            guard lstat(file.url.path, &candidateVersion) == 0 else { return }
            if let canonicalVersion, canonicalVersion.0 == candidateVersion.st_size,
                canonicalVersion.1.tv_sec == candidateVersion.st_mtimespec.tv_sec,
                canonicalVersion.1.tv_nsec == candidateVersion.st_mtimespec.tv_nsec { return }
            let canonicalCopy = scratch.appendingPathComponent("camera.mov")
            try copy(file.url, to: canonicalCopy)
            let canonicalInventory: Inventory?
            do { canonicalInventory = try await inventory(canonicalCopy, mappingURL: mapping, maximum: encodedCount, canonical: true) }
            catch is CancellationError { throw CancellationError() }
            catch { canonicalInventory = nil }
            if let canonicalInventory {
                canonicalVersion = (candidateVersion.st_size, candidateVersion.st_mtimespec)
                try await scanCanonicalPrefix(canonicalInventory, mappingURL: mapping)
            }
        }
        private func finishRaw(_ source: Source, mappingURL: URL, represented: Int) throws -> RawScan {
            let pictures = try Pictures(source: source, range: CMTimeRange(start: rawFence ?? source.segments[0].asset.start, end: source.segments[0].asset.end))
            let mapping = try Mapping(mappingURL, resuming: rawPosition)
            var trial = rawState
            while trial.represented < represented {
                guard let frame = try mapping.next(), let sample = try pictures.next() else { throw invalid("Closed camera no longer contains its mapped prefix.") }
                let range = try trial.mapping(frame, scale: source.scale)
                try trial.append(sample, range: range, run: frame.run, nativeEnd: pictures.lastEnd, scale: source.scale)
            }
            guard try pictures.next() == nil, !trial.intervals.isEmpty, try mapping.next() == nil, !mapping.torn else {
                throw invalid("Closed camera differs from its complete mapped inventory.")
            }
            return RawScan(source: source, intervals: trial.intervals, represented: trial.represented,
                pictureHash: trial.pictureHash, diagnostics: [])
        }
        private func finishCanonical(_ source: Source, mappingURL: URL, represented: Int, expected: CameraAvailability) throws -> CanonicalScan {
            guard let availability = try? CameraAvailability(source.segments.map(\.asset)), availability.gaps.isEmpty,
                availability == expected, let first = source.segments.first, let last = source.segments.last else {
                throw invalid("Canonical camera support differs from publication.")
            }
            let intervals = availability.intervals
            let pictures = try Pictures(source: source, range: CMTimeRange(start: canonicalFence ?? first.asset.start, end: last.asset.end))
            let mapping = try Mapping(mappingURL, resuming: canonicalPosition)
            var trial = canonicalState
            while trial.represented < represented {
                guard let frame = try mapping.next() else { throw invalid("Camera mapping ended before represented pictures.") }
                try trial.append(frame, scale: source.scale, intervals: intervals, nextPicture: pictures.next)
            }
            let hash = try trial.finish(intervals: intervals, nextPicture: pictures.next)
            let remaining: Result<Void, any Error>
            do {
                while let frame = try mapping.next() { try trial.validateRemaining(frame, scale: source.scale) }
                remaining = .success(())
            } catch { remaining = .failure(error) }
            return CanonicalScan(availability: expected, pictureHash: hash, remainingMapping: remaining)
        }
        fileprivate func reportFallback(_ reason: String) {
            guard !fallbackReported else { return }
            fallbackReported = true
            FileHandle.standardError.write(Data("camera verification: outcome=full-scan-fallback; reason=\(reason)\n".utf8))
        }
        fileprivate func finish(rawURL: URL, mappingURL: URL, intended: IntendedSupport) async throws -> (RawScan, NewFile, CanonicalScan)? {
            await close()
            guard file != nil, rawState.represented > 0, failure == nil else {
                reportFallback(failure.map { String(describing: $0) } ?? "no usable active checkpoint")
                await discard()
                return nil
            }
            if let completed, let file {
                guard try CaptureMediaIdentity.read(file.url) == completed.2 else {
                    throw invalid("Completed private canonical camera changed before publication retry.")
                }
                return (completed.0, file, completed.1)
            }
            let rawInventory = try await inventory(rawURL, mappingURL: mappingURL, maximum: intended.represented, complete: true)
            guard rawInventory.count == intended.represented else { throw invalid("Closed camera inventory changed count.") }
            try await transfer(rawInventory.source, through: rawInventory.count)
            if writer!.status == .writing {
                writer!.endSession(atSourceTime: intended.support.end); input!.markAsFinished(); await writer!.finishWriting()
            }
            guard writer!.status == .completed else { throw writer!.error ?? invalid("Private canonical camera closure failed.") }
            let candidateInventory = try await inventory(file!.url, mappingURL: mappingURL, maximum: intended.represented, canonical: true, complete: true)
            let candidate = candidateInventory.source
            if let canonicalEncodedHash {
                _ = try await compressedPrefix(candidate, through: canonicalState.represented,
                    verifyCount: canonicalState.represented, expectedHash: canonicalEncodedHash)
            }
            async let raw = outcome { try self.finishRaw(rawInventory.source, mappingURL: mappingURL, represented: intended.represented) }
            async let canonical = outcome { try self.finishCanonical(candidate, mappingURL: mappingURL, represented: intended.represented,
                expected: CameraAvailability([intended.support])) }
            let rawResult = await raw, canonicalResult = await canonical
            let result = try acceptScans(raw: rawResult, canonical: canonicalResult, complete: { _ in true },
                verify: { try $1.verified(against: $0.pictureHash) })
            try Task.checkCancellation()
            completed = (result.raw, try canonicalResult.get(), try CaptureMediaIdentity.read(file!.url))
            return (result.raw, file!, completed!.1)
        }
    }
    private static func scanRaw(_ rawURL: URL, mappingURL: URL, sealed: Bool) async throws -> RawScan {
        let mapping = try Mapping(mappingURL)
        let raw = try await Pictures(url: rawURL)
        var state = RawScanState(sealed: sealed)
        while let frame = try mapping.next() {
            let range = try state.mapping(frame, scale: raw.scale)
            let sample: CMSampleBuffer?
            do { sample = try raw.next() }
            catch is CancellationError { throw CancellationError() }
            catch { state.diagnostics.append("rawDecodeInterrupted"); break }
            guard let sample else { state.diagnostics.append("acceptedBeyondPhysicalEOF"); break }
            // A crashed encoder can leave a reordered picture without the earlier ones it never
            // flushed; the physical prefix ends at the first mapped picture it lacks.
            if !sealed && sample.presentationTimeStamp > range.start { state.diagnostics.append("acceptedBeyondPhysicalEOF"); break }
            try state.append(sample, range: range, run: frame.run, nativeEnd: raw.lastEnd, scale: raw.scale)
        }
        guard let first = state.intervals.first, let last = state.intervals.last else { throw invalid("No physically verified camera prefix.") }
        if state.represented == mapping.frames {
            do { if try raw.next() != nil { state.diagnostics.append("unmappedRawTail") } }
            catch is CancellationError { throw CancellationError() }
            catch { state.diagnostics.append("rawDecodeInterrupted") }
        }
        // Validate the remaining journal even when the physical payload ended early.
        while let frame = try mapping.next() {
            _ = try state.mapping(frame, scale: raw.scale)
        }
        if mapping.torn { state.diagnostics.append("tornMappingTail") }
        let (start, end) = (try ExactTime(first.start), try ExactTime(last.end))
        guard let covered = try? CameraAvailability(raw.segments.map(\.asset)), try covered.intervals.contains(where: {
            try $0.startUs.compare(start) != .orderedDescending && $0.endUs.compare(end) != .orderedAscending
        }) else {
            throw invalid("Raw camera presentation does not cover its bounded acquired prefix.")
        }
        return RawScan(source: raw.source, intervals: state.intervals, represented: state.represented,
            pictureHash: state.pictureHash, diagnostics: state.diagnostics)
    }
    /// The continuous raw movie becomes one passthrough edit per interval, with explicit empty
    /// edits before the first and between intervals, so off time never holds a picture.
    private static func exportCandidate(rawURL: URL, canonicalURL: URL,
        source: Source, intervals: [CMTimeRange]) async throws -> NewFile {
        let file: NewFile
        do { file = try NewFile(at: canonicalURL.path, assembledAs: "camera.mov") }
        catch {
            if FileManager.default.fileExists(atPath: canonicalURL.path) {
                throw CaptureFailure("PUBLICATION_CONFLICT", "Camera output already exists without a matching receipt; no replacement performed.")
            }
            throw error
        }
        // Keep failed candidates for diagnosis/recovery; raw media and mapping are never removed.
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw invalid("Cannot construct canonical camera track.") }
        track.naturalTimeScale = source.scale
        track.preferredTransform = try await source.track.load(.preferredTransform)
        var pieces: [AVCompositionTrackSegment] = []
        var through = CMTime.zero
        for interval in intervals {
            if interval.start > through {
                pieces.append(AVCompositionTrackSegment(timeRange: CMTimeRange(start: through, end: interval.start)))
            }
            pieces.append(AVCompositionTrackSegment(url: rawURL, trackID: source.track.trackID,
                sourceTimeRange: interval, targetTimeRange: interval))
            through = interval.end
        }
        try track.validateSegments(pieces); track.segments = pieces
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else { throw invalid("Cannot export camera edit list.") }
        try await export.export(to: file.url, as: .mov)
        try Task.checkCancellation()
        return file
    }
    package static func publish(lease: CaptureJournalLease, observationURL: URL,
        verification: Verification? = nil) async throws -> Receipt {
        try Task.checkCancellation(); try lease.check()
        let root = URL(fileURLWithPath: lease.directory)
        let rawURL = root.appendingPathComponent("camera.raw.mov")
        let markerURL = root.appendingPathComponent("camera.closed.json")
        let receiptURL = root.appendingPathComponent("camera.publication.json")
        let canonicalURL = root.appendingPathComponent("video.mov")
        let rawIdentity = try CaptureMediaIdentity.read(rawURL)
        let observationIdentity = try CaptureMediaIdentity.read(observationURL, maximumBytes: 268_435_456)
        let mappingURL = try retainMapping(observations: observationURL, directory: root, identity: observationIdentity)
        let provenance = try facts(lease)
        guard let header = provenance.header, let prefix = provenance.validatedPrefix else { throw invalid("Camera publication requires source journal provenance.") }
        if let binding = header.cameraBinding {
            try binding.validate()
            guard header.source.kind == "camera", header.sessionID == binding.sourceId,
                provenance.originHostUs != nil, !header.microphone, !header.systemAudio else { throw invalid("Camera journal differs from supplied binding or shared origin.") }
        } else if header.source.kind == "camera" { throw invalid("Production camera has no supplied binding.") }
        let closed = FileManager.default.fileExists(atPath: markerURL.path) ? try CaptureMediaIdentity.read(markerURL) : nil
        if closed != nil {
            let markerBytes = try Data(contentsOf: markerURL)
            let pinned: CaptureMediaIdentity
            do { pinned = try JSONDecoder().decode(CaptureMediaIdentity.self, from: markerBytes) }
            catch { throw invalid("Malformed closed camera marker.") }
            guard pinned == rawIdentity else { throw invalid("Closed camera payload changed.") }
        }
        func unchanged() throws {
            try lease.check(); try Task.checkCancellation()
            guard try CaptureMediaIdentity.read(rawURL) == rawIdentity,
                try CaptureMediaIdentity.read(observationURL, maximumBytes: 268_435_456) == observationIdentity,
                try CaptureMediaIdentity.read(mappingURL, maximumBytes: 268_435_456) == observationIdentity,
                (FileManager.default.fileExists(atPath: markerURL.path) ? try CaptureMediaIdentity.read(markerURL) : nil) == closed else { throw invalid("Camera input changed during publication.") }
        }
        if FileManager.default.fileExists(atPath: receiptURL.path) {
            let (receipt, retainedIdentity) = try readReceipt(receiptURL)
            try validateJournal(receipt, lease: lease)
            guard receipt.raw == rawIdentity, receipt.observations == observationIdentity, receipt.closed == closed else {
                throw invalid("Retained camera publication belongs to other input bytes.")
            }
            let parts = receipt.candidate.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0].hasPrefix(".yap-output-"), parts[1] == "camera.mov" else {
                throw invalid("Invalid private camera candidate locator.")
            }
            if !FileManager.default.fileExists(atPath: canonicalURL.path) {
                let candidate = root.appendingPathComponent(receipt.candidate)
                guard try CaptureMediaIdentity.read(candidate) == receipt.canonical else { throw invalid("Prepared camera candidate changed.") }
                let verified = try await readPublished(lease: lease, canonical: candidate)
                guard verified.identity.receipt == retainedIdentity else { throw invalid("Retained camera receipt changed during retry.") }
                try unchanged(); _ = try NewFile.publish(staged: candidate, at: canonicalURL.path)
            }
            guard try CaptureMediaIdentity.read(canonicalURL) == receipt.canonical else {
                throw invalid("Published camera identity conflicts; no replacement performed.")
            }
            let verified = try await readPublished(lease: lease, canonical: canonicalURL)
            guard verified.identity.receipt == retainedIdentity else { throw invalid("Retained camera receipt changed during retry.") }
            try unchanged()
            return receipt
        }
        let intended = closed == nil ? nil : try await intendedSupport(rawURL: rawURL, mappingURL: mappingURL)
        let raw: RawScan
        var verifiedCandidate: (file: NewFile, availability: CameraAvailability)?
        let continued: (RawScan, NewFile, CanonicalScan)?
        if let intended {
            do { continued = try await verification?.finish(rawURL: rawURL, mappingURL: mappingURL, intended: intended) }
            catch is CancellationError { throw CancellationError() }
            catch { verification?.reportFallback(String(describing: error)); await verification?.discard(); continued = nil }
        } else { await verification?.discard(); continued = nil }
        if let completed = continued {
            raw = completed.0
            verifiedCandidate = (completed.1, try completed.2.verified(against: raw.pictureHash))
        } else if let intended {
            let exported = await outcome {
                try await exportCandidate(rawURL: rawURL, canonicalURL: canonicalURL,
                    source: intended.source, intervals: [intended.support])
            }
            async let rawResult = outcome { try await scanRaw(rawURL, mappingURL: mappingURL, sealed: true) }
            async let canonicalResult = outcome { () async throws -> CanonicalScan in
                let candidate = try exported.get()
                return try await scanCanonical(candidate.url, mappingURL: mappingURL,
                    represented: intended.represented, scale: intended.source.scale,
                    expected: CameraAvailability([intended.support]))
            }
            // Join both readers even on cancellation/failure; raw validation selects the public error first.
            let rawOutcome = await rawResult
            let canonicalOutcome = await canonicalResult
            let accepted = try acceptScans(raw: rawOutcome, canonical: canonicalOutcome,
                complete: { $0.represented == intended.represented && $0.intervals == [intended.support]
                    && $0.source.scale == intended.source.scale && $0.diagnostics.isEmpty },
                verify: { try $1.verified(against: $0.pictureHash) })
            raw = accepted.raw
            try Task.checkCancellation()
            if let availability = accepted.availability {
                verifiedCandidate = (try exported.get(), availability)
            } else if case .success(let candidate) = exported {
                candidate.discard()
            }
        } else {
            raw = try await scanRaw(rawURL, mappingURL: mappingURL, sealed: closed != nil)
        }
        let file: NewFile
        let availability: CameraAvailability
        if let verifiedCandidate {
            file = verifiedCandidate.file
            availability = verifiedCandidate.availability
        } else {
            file = try await exportCandidate(rawURL: rawURL, canonicalURL: canonicalURL,
                source: raw.source, intervals: raw.intervals)
            availability = try await verifyCanonical(file.url, mappingURL: mappingURL,
                represented: raw.represented, scale: raw.source.scale, pictureHash: raw.pictureHash,
                expected: CameraAvailability(raw.intervals))
        }
        let support = raw.support, represented = raw.represented, pictureHash = raw.pictureHash
        let diagnostics = raw.diagnostics
        try unchanged()
        let receipt = Receipt(presentation: .nativeBounded, raw: rawIdentity, observations: observationIdentity, closed: closed,
            canonical: try CaptureMediaIdentity.read(file.url),
            candidate: file.url.deletingLastPathComponent().lastPathComponent + "/" + file.url.lastPathComponent,
            representedFrames: represented, firstUs: CMTimeConvertScale(support.start, timescale: 1000000, method: .roundHalfAwayFromZero).value,
            endUs: CMTimeConvertScale(support.end, timescale: 1000000, method: .roundHalfAwayFromZero).value,
            pictureSHA256: pictureHash, diagnostics: diagnostics, support: availability.support,
            gaps: availability.gaps.isEmpty ? nil : availability.gaps, pictureTimeScale: raw.source.scale,
            binding: header.cameraBinding, originHostUs: provenance.originHostUs, journal: prefix)
        try validateJournal(receipt, lease: lease)
        try lease.synchronize()
        try save(receipt, to: receiptURL)
        try unchanged()
        do { _ = try file.publish() }
        catch {
            if FileManager.default.fileExists(atPath: canonicalURL.path) {
                throw CaptureFailure("PUBLICATION_CONFLICT", "Camera output changed before publication; no replacement performed.")
            }
            throw error
        }
        return receipt
    }
}
