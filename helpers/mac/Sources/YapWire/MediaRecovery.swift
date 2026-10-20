@preconcurrency import AVFoundation
import Darwin
import Foundation
import YapCapture
import YapMedia

package struct RecoveredCapture: Codable, Sendable {
    package let durationUs: Int64
    package let tracks: [RecoveredTrack]
    package let journal: CaptureJournalSummary?
    package let journalFailure: CaptureFailure?
    package var cleanupFailure: CaptureFailure? = nil
    package var inputsClosed: Bool? = nil
    package var sourcePublication: CaptureSourcePublicationOutcome? = nil
}

/// Bounded control result. Complete support stays in the native model and source-evidence owner.
package struct RecoveryReceipt: Encodable {
    let durationUs: Int64
    let tracks: [Track]
    let journal: Journal?
    let journalFailure: CaptureFailure?
    let cleanupFailure: CaptureFailure?
    let inputsClosed: Bool?
    let sourcePublication: CaptureSourcePublicationOutcome?
    package init(_ capture: RecoveredCapture) {
        durationUs = capture.durationUs
        tracks = capture.tracks.map(Track.init)
        journal = capture.journal.map(Journal.init)
        journalFailure = capture.journalFailure
        cleanupFailure = capture.cleanupFailure
        inputsClosed = capture.inputsClosed
        sourcePublication = capture.sourcePublication
    }
    struct Track: Encodable {
        let role: String
        let file: String
        let intervalCount: Int
        let decodedSamples: Int?
        let representedFrames: JournalInteger?
        let decodeReachedEnd: Bool
        let acquisitionVerified: Bool
        let failure: CaptureFailure?
        init(_ track: RecoveredTrack) {
            role = track.role; file = track.file; intervalCount = track.intervals.count
            decodedSamples = track.decodedSamples; representedFrames = track.representedFrames
            decodeReachedEnd = track.decodeReachedEnd; acquisitionVerified = track.acquisitionVerified
            failure = track.failure
        }
    }
    struct Journal: Encodable {
        let file: String
        let header: CaptureJournalHeader?
        let originHostUs: Int64?
        let openPauseHostUs: Int64?
        let lastSequence: Int
        let incompleteTail: Bool
        let invalidAtSequence: Int?
        let finished: Bool
        let completion: JournalCompletion?
        init(_ summary: CaptureJournalSummary) {
            file = summary.file; header = summary.header; originHostUs = summary.originHostUs
            openPauseHostUs = summary.openPauseHostUs; lastSequence = summary.lastSequence
            incompleteTail = summary.incompleteTail; invalidAtSequence = summary.invalidAtSequence
            finished = summary.finished; completion = summary.completion
        }
    }
}

package enum MediaRecovery {
    /// Packed recovery uses the same publication transaction as normal finish, under one lease.
    package static func recover(directory: String, sourceAuthority: CaptureRecoveryAuthority? = nil) async throws -> RecoveredCapture {
        guard let sourceAuthority else { return try await recoverMedia(directory: directory) }
        try Task.checkCancellation()
        guard let lease = try CaptureJournalLease.existing(directory: directory) else {
            return try recoverEmptyAllocation(directory: directory, authority: sourceAuthority)
        }
        defer { lease.release() }
        let layout: Int
        do { layout = try CaptureJournal.layout(directory: directory) }
        catch is CancellationError { throw CancellationError() }
        catch {
            let failure = CaptureFinalizationError(error)
            if failure.retryable { throw error }
            var result = await inspect(directory: directory)
            try Task.checkCancellation()
            result.inputsClosed = true
            result.sourcePublication = .unavailable(CaptureFailure(bounded: error))
            return result
        }
        do { try CaptureSourcePublication.validateAuthority(sourceAuthority, lease: lease, layout: layout) }
        catch is CancellationError { throw CancellationError() }
        catch {
            let failure = CaptureFinalizationError(error)
            if failure.retryable { throw error }
            var result = await inspect(directory: directory)
            try Task.checkCancellation()
            result.inputsClosed = true
            result.sourcePublication = .unavailable(CaptureFailure(bounded: error))
            return result
        }
        var result = try await recoverMedia(directory: directory, leased: lease)
        result.inputsClosed = true
        do {
            result.sourcePublication = .published(try await CaptureSourcePublication.recover(
                lease: lease, authority: sourceAuthority, layout: layout, tracks: result.tracks))
        } catch is CancellationError { throw CancellationError() }
        catch {
            let failure = CaptureFinalizationError(error)
            result.sourcePublication = failure.retryable ? .pending(failure) : .unavailable(CaptureFailure(bounded: error))
        }
        return result
    }

    /// Managed reconciliation has already proved native idle and fenced this finalizing allocation.
    /// This directory lease pins the empty observation; it cannot independently prove capture idle.
    private static func recoverEmptyAllocation(directory: String, authority: CaptureRecoveryAuthority) throws -> RecoveredCapture {
        try CaptureSourcePublication.validateAuthority(authority)
        try Task.checkCancellation()
        var selected = stat()
        guard lstat(directory, &selected) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard selected.st_mode & S_IFMT == S_IFDIR else {
            throw CaptureFailure("INVALID_JOURNAL", "Empty source ownership requires a directory.")
        }
        guard let canonical = realpath(directory, nil) else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { free(canonical) }
        let fd = Darwin.open(canonical, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { close(fd) }
        let identity = InodeIdentity(selected)
        try identity.check(fd)
        try ManagedFiles.lockPrivateDirectory(fd, busyCode: "CAPTURE_BUSY")
        func check() throws {
            try identity.check(fd)
            try ManagedFiles.checkDirectoryEntry(AT_FDCWD, directory, identity, failing: { _ in
                NativeFailure("JOURNAL_CHANGED", "Empty source directory was replaced.")
            })
            var journal = stat()
            if fstatat(fd, "capture.journal.jsonl", &journal, AT_SYMLINK_NOFOLLOW) == 0 {
                throw CaptureFailure("JOURNAL_CHANGED", "Capture journal appeared during empty-source recovery.")
            }
            guard errno == ENOENT else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        }
        try check()
        var members: [String] = []
        try DirectoryContents.forEachName(in: fd, failing: { action in
            NativeFailure("JOURNAL_UNAVAILABLE", "\(action): \(String(cString: strerror(errno))).")
        }) { name in members.append(String(cString: name)); return members.count < 2 }
        // A companion camera writes its journal with its first picture, so a camera that never
        // delivered one (never turned on, or lost before its first picture) leaves only its mapping.
        let unavailable: CaptureFailure
        if members.isEmpty {
            unavailable = CaptureFailure("NO_SOURCE_MEDIA", "Allocated source directory contains no retained members.")
        } else if authority.kind == .camera, members == [CameraMedia.mappingFile], try isRegularFile(fd, CameraMedia.mappingFile) {
            unavailable = CaptureFailure("NO_CAMERA", "The reserved camera recorded no picture.")
        } else {
            throw CaptureFailure("JOURNAL_UNAVAILABLE", "Source members remain without a capture journal.")
        }
        try Task.checkCancellation()
        try check()
        return RecoveredCapture(durationUs: 0, tracks: [], journal: nil,
            journalFailure: CaptureFailure("JOURNAL_MISSING", "Empty allocation has no capture journal."),
            inputsClosed: true, sourcePublication: .unavailable(unavailable))
    }

    private static func isRegularFile(_ directory: Int32, _ name: String) throws -> Bool {
        var member = stat()
        guard fstatat(directory, name, &member, AT_SYMLINK_NOFOLLOW) == 0 else {
            throw NativeFailure("JOURNAL_UNAVAILABLE", "Inspect \(name): \(String(cString: strerror(errno))).")
        }
        return member.st_mode & S_IFMT == S_IFREG
    }

    private static func recoverMedia(directory: String, leased: CaptureJournalLease? = nil) async throws -> RecoveredCapture {
        try Task.checkCancellation()
        let layout: Int?
        do { layout = try CaptureJournal.layout(directory: directory) }
        catch is CancellationError { throw CancellationError() }
        catch let failure as CaptureFailure where ["JOURNAL_MISSING", "INVALID_JOURNAL"].contains(failure.code) {
            layout = nil
        }
        let cameraReceipt = URL(fileURLWithPath: directory).appendingPathComponent("camera.publication.json")
        if layout == 1 && FileManager.default.fileExists(atPath: cameraReceipt.path) {
            return try await recoverCamera(directory: directory, leased: leased)
        }
        guard CaptureJournal.isPacked(layout) else {
            let result = await inspect(directory: directory)
            try Task.checkCancellation()
            if layout == 1 && (result.journal?.header?.source.kind == "camera" || result.journal?.header?.cameraBinding != nil) {
                return try await recoverCamera(directory: directory, leased: leased)
            }
            if let failure = result.tracks.compactMap(\.failure).first(where: { $0.code == "MEDIA_UNAVAILABLE" }) { throw failure }
            return result
        }
        let lease = try leased ?? CaptureJournalLease(directory: directory)
        var journal = try CaptureJournal.streamAcceptedPCM(lease: lease) { _ in }
        var tracks: [RecoveredTrack] = []
        var receipts: [CaptureAudioPublication.Receipt] = []
        var retryFailure: (any Error)?
        let root = URL(fileURLWithPath: directory)
        let video = await CaptureMediaInspection.inspect(role: "video", url: root.appendingPathComponent("video.mov"), acquired: nil, requested: true)
        tracks.append(video)
        if let failure = video.failure, failure.code == "MEDIA_UNAVAILABLE" { retryFailure = failure }
        try Task.checkCancellation()
        for role in ["narration", "system"] {
            try Task.checkCancellation()
            let requested = journal.header?.requested(role) == true
            do {
                guard requested else { throw CaptureFailure("NOT_REQUESTED", "This take did not request \(role) audio.") }
                let hasFiles = ["\(role).packed.mov", "\(role).mov", "\(role).publication.json"].contains {
                    FileManager.default.fileExists(atPath: root.appendingPathComponent($0).path)
                }
                guard hasFiles else { throw CaptureFailure("AUDIO_UNAVAILABLE", "Requested \(role) has no retained media.") }
                switch try await CaptureAudioPublication.publish(lease: lease, role: role) {
                case .unavailable:
                    throw CaptureFailure("AUDIO_UNAVAILABLE", "Requested \(role) has no verified playable frames.")
                case .published(let receipt):
                    let verified = try await CaptureAudioPublication.verify(receipt, lease: lease,
                        canonical: root.appendingPathComponent("\(role).mov"))
                    let support = verified.acquiredAudio.map { TimeSpan(startUs: $0.startUs, endUs: $0.endUs) }
                    journal.acquiredAudio[role] = support
                    tracks.append(RecoveredTrack(role: role, file: "\(role).mov", intervals: support,
                        decodedSamples: nil, representedFrames: JournalInteger(wrappedValue: verified.representedFrames),
                        decodeReachedEnd: true, acquisitionVerified: true,
                        failure: receipt.diagnostic.map { CaptureFailure("AUDIO_PUBLICATION_PARTIAL", $0) }))
                    receipts.append(receipt)
                }
            } catch is CancellationError { throw CancellationError() }
            catch {
                if CaptureFinalizationError(error).retryable { retryFailure = retryFailure ?? error }
                tracks.append(RecoveredTrack(role: role, file: "\(role).mov", intervals: [],
                    decodedSamples: nil, decodeReachedEnd: false, acquisitionVerified: false,
                    failure: (error as? CaptureFailure) ?? CaptureFailure("PUBLICATION_FAILED", error.localizedDescription)))
            }
        }
        try Task.checkCancellation()
        var cleanupFailure: CaptureFailure?
        for receipt in receipts {
            do { try await CaptureAudioPublication.cleanup(lease: lease, receipt: receipt) }
            catch { cleanupFailure = cleanupFailure ?? CaptureFailure("CLEANUP_PENDING", error.localizedDescription) }
        }
        try lease.check()
        if let retryFailure { throw retryFailure }
        return RecoveredCapture(durationUs: tracks.first { $0.role == "video" }?.intervals.last?.endUs ?? 0,
            tracks: tracks, journal: journal,
            journalFailure: journal.invalidAtSequence == nil ? nil : CaptureFailure("INVALID_JOURNAL", "Recovery used only the validated journal prefix."),
            cleanupFailure: cleanupFailure)
    }

    /// Camera recovery and admission consume the same canonical picture/support authority.
    private static func recoverCamera(directory: String, leased: CaptureJournalLease?) async throws -> RecoveredCapture {
        let root = URL(fileURLWithPath: directory)
        let lease = try leased ?? CaptureJournalLease(directory: directory)
        defer { if leased == nil { lease.release() } }
        let canonical = root.appendingPathComponent("video.mov")
        if !FileManager.default.fileExists(atPath: canonical.path) {
            _ = try await CameraMedia.publish(lease: lease, observationURL: root.appendingPathComponent("camera.mapping.jsonl"))
        }
        let verified = try await CameraMedia.readPublished(lease: lease, canonical: canonical)
        let journal = try CaptureJournal.readEvidence(directory: directory, maximumBytes: nil,
            retainTiming: false, geometry: { _ in }, samples: { _ in }, displaySpace: { _ in },
            descriptor: lease.descriptor, layout: 1)
        let intervals = try verified.identity.availability.intervals.map { try $0.roundedSpan() }
        let track = RecoveredTrack(role: "video", file: "video.mov", intervals: intervals,
            decodedSamples: nil, representedFrames: JournalInteger(wrappedValue: Int64(verified.identity.representedFrames)),
            decodeReachedEnd: true, acquisitionVerified: true,
            failure: verified.diagnostics.isEmpty ? nil : CaptureFailure("PARTIAL_CAMERA", verified.diagnostics.joined(separator: ", ")))
        try lease.check()
        return RecoveredCapture(durationUs: intervals[intervals.count - 1].endUs, tracks: [track], journal: journal,
            journalFailure: journal.invalidAtSequence == nil ? nil : CaptureFailure("INVALID_JOURNAL", "Recovery used only the validated journal prefix."))
    }

    package static func inspect(directory: String) async -> RecoveredCapture {
        var journal: CaptureJournalSummary?
        var journalFailure: CaptureFailure?
        do { journal = try CaptureJournal.inspect(directory: directory) } catch {
            journalFailure = CaptureFailure("JOURNAL_UNAVAILABLE", error.localizedDescription)
        }
        var tracks: [RecoveredTrack] = []
        for role in ["video", "narration", "system"] {
            tracks.append(
                await CaptureMediaInspection.inspect(
                    role: role, url: URL(fileURLWithPath: directory).appendingPathComponent("\(role).mov"),
                    acquired: journal?.header == nil
                        ? nil : journal?.acquiredAudio[role, default: []],
                    requested: journal?.header?.requested(role)))
        }
        return RecoveredCapture(
            durationUs: tracks.first { $0.role == "video" }?.intervals.last?.endUs ?? 0,
            tracks: tracks, journal: journal, journalFailure: journalFailure)
    }

}
