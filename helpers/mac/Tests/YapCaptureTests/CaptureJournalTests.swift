import Foundation
import YapCapture

private let header = CaptureJournalHeader(
    schemaVersion: 1, sessionID: "journal-roundtrip",
    source: CaptureSource(kind: "window", windowID: 7), width: 160, height: 120, microphone: true,
    systemAudio: false)

/// The pause a take's own clock produces across a 500ms interruption.
private let pause: PauseEvent = {
    var clock = CaptureClock()
    clock.start(at: 1_000_000)
    clock.pause(at: 1_700_000)
    clock.resume(at: 2_200_000)
    precondition(clock.pauses.count == 1, "A paused and resumed clock records one pause")
    return clock.pauses[0]
}()

/// Writes the records a take writes, in the order a take writes them.
private func writeTake(in directory: URL, finished: Bool) throws {
    let journal = try CaptureJournal(directory: directory.path, header: header)
    try journal.recordOrigin(hostUs: 1_000_000)
    try journal.recordTrackStarted(
        role: "narration", file: "narration.mov", firstSourceUs: 250_000, sampleRate: 48000,
        channelCount: 1)
    try journal.recordAudioSamples(role: "narration", startUs: 250_000, endUs: 300_000)
    try journal.recordAudioSamples(role: "narration", startUs: 300_001, endUs: 400_000)
    try journal.recordAudioSamples(role: "narration", startUs: 500_000, endUs: 700_000)
    try journal.recordPauseBegan(hostUs: 1_700_000)
    try journal.recordPauseEnded(hostUs: 2_200_000, pause: pause)
    if finished {
        try journal.recordFinished(
            CaptureResult(
                state: "complete", source: header.source, width: header.width,
                height: header.height, durationUs: 700_000, hostOriginUs: 1_000_000, pauses: [],
                tracks: [], failure: nil, systemAudioScope: "disabled"))
    }
}

private func lines(of directory: URL) throws -> [String] {
    try String(
        contentsOf: directory.appendingPathComponent("capture.journal.jsonl"), encoding: .utf8
    )
    .split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
}

private func write(_ lines: [String], to directory: URL) throws {
    try lines.joined(separator: "\n")
        .write(
            to: directory.appendingPathComponent("capture.journal.jsonl"), atomically: true,
            encoding: .utf8)
}

func runCaptureJournalTests() async throws {
    let whole = RecoveryFixture.directory("journal-roundtrip")
    defer { try? FileManager.default.removeItem(at: whole) }
    try writeTake(in: whole, finished: true)
    let read = try CaptureJournal.inspect(directory: whole.path)
    precondition(read.header?.sessionID == "journal-roundtrip", "The written header must read back")
    precondition(read.header?.source.windowID == 7, "The written source must read back")
    precondition(
        read.originHostUs == 1_000_000,
        "The written origin must read back, got \(read.originHostUs as Int64?)")
    precondition(
        read.pauses == [pause] && pause.atSourceUs == 700_000 && pause.elapsedPauseUs == 500_000,
        "The written pause must read back, got \(read.pauses)")
    precondition(read.openPauseHostUs == nil, "A pause the writer ended must not read back as open")
    precondition(
        RecoveryFixture.bounds(read.acquiredAudio["narration"] ?? [])
            == [[250_000, 400_000], [500_000, 700_000]],
        "Written audio ranges must coalesce across rounding only, got \(read.acquiredAudio)")
    precondition(read.finished && read.lastSequence == 9, "A finished take must read back finished")
    precondition(read.completion?.state == "complete" && read.completion?.sequence == 9
        && read.completion?.durationUs == 700_000 && read.completion?.failureCode == nil,
        "Completion must retain the writer's recorded capture endpoint")
    precondition(
        !read.incompleteTail && read.invalidAtSequence == nil,
        "A whole journal has neither a torn tail nor a bad record")
    print("PASS a written take's journal reads back through the reader")
    var streamedPauses: [PauseEvent] = []
    var streamedAudio: [[Int64]] = []
    let streamed = try CaptureJournal.streamEvidence(
        directory: whole.path,
        pause: { streamedPauses.append($0) },
        audioAcquired: { streamedAudio.append([$0.startUs, $0.endUs]) })
    precondition(
        streamedPauses == read.pauses, "Stream and recovery must agree on completed pauses")
    precondition(
        streamedAudio == RecoveryFixture.bounds(read.acquiredAudio["narration"] ?? []),
        "Stream and recovery share audio merging")
    precondition(
        streamed.pauses.isEmpty && streamed.acquiredAudio.isEmpty,
        "Streaming must not retain timing arrays")
    print("PASS streaming and recovery share timing without retaining streaming arrays")

    // A host timestamp that will not decode used to leave the boundary silently nil.
    let malformed = RecoveryFixture.directory("journal-malformed")
    defer { try? FileManager.default.removeItem(at: malformed) }
    try writeTake(in: malformed, finished: true)
    var corrupted = try lines(of: malformed)
    precondition(
        corrupted[6].contains("\"hostUs\":1700000"),
        "Fixture must hold the pauseBegan record, got \(corrupted[6])")
    corrupted[6] = corrupted[6].replacingOccurrences(
        of: "\"hostUs\":1700000", with: "\"hostUs\":\"1700000\"")
    try write(corrupted, to: malformed)
    let rejected = try CaptureJournal.inspect(directory: malformed.path)
    precondition(
        rejected.invalidAtSequence == 7,
        "A record that will not decode must be named, got \(rejected.invalidAtSequence as Int?)")
    precondition(
        !rejected.incompleteTail, "A corrupt mid-file record is not a torn crash boundary")
    precondition(
        rejected.originHostUs == 1_000_000 && rejected.lastSequence == 6,
        "Proof written before the bad record must stand, got sequence \(rejected.lastSequence)")
    precondition(
        rejected.acquiredAudio["narration"]?.count == 2,
        "Audio proven before the bad record must stand, got \(rejected.acquiredAudio)")
    precondition(
        !rejected.finished && rejected.openPauseHostUs == nil,
        "Nothing after the bad record may be believed")
    print("PASS a malformed host timestamp rejects its record and keeps the proof before it")

    // A crash cuts the last line short; that is a boundary, not corruption.
    let torn = RecoveryFixture.directory("journal-torn")
    defer { try? FileManager.default.removeItem(at: torn) }
    try writeTake(in: torn, finished: false)
    let cut = try lines(of: torn)
    precondition(cut.last == "" && cut.count == 9, "A whole take writes eight terminated records")
    try write(Array(cut[0..<7]) + [String(cut[7].prefix(20))], to: torn)
    let boundary = try CaptureJournal.inspect(directory: torn.path)
    precondition(
        boundary.incompleteTail && boundary.invalidAtSequence == nil,
        "An unterminated last line is a torn tail, not a bad record: \(boundary.invalidAtSequence as Int?)"
    )
    precondition(
        boundary.openPauseHostUs == 1_700_000 && boundary.lastSequence == 7,
        "A torn journal keeps its whole prefix, got sequence \(boundary.lastSequence)")
    print("PASS a torn last line reads as a crash boundary distinct from a bad record")

    // Bytes past the record bound with no terminator, followed by more records, are corruption
    // inside the file, not a crash that cut its last line short.
    let oversized = RecoveryFixture.directory("journal-oversized")
    defer { try? FileManager.default.removeItem(at: oversized) }
    try writeTake(in: oversized, finished: true)
    var bloated = try lines(of: oversized)
    bloated[7] = String(repeating: "x", count: 1_100_000) + bloated[7]
    try write(bloated, to: oversized)
    let overrun = try CaptureJournal.inspect(directory: oversized.path)
    precondition(
        overrun.invalidAtSequence == 8 && !overrun.incompleteTail,
        "An oversized run inside the file is a bad record, got invalid \(overrun.invalidAtSequence as Int?) torn \(overrun.incompleteTail)"
    )
    precondition(
        overrun.lastSequence == 7 && !overrun.finished,
        "Records before the oversized run stand and nothing after it is believed")
    print("PASS an oversized unterminated run inside the journal reads as a bad record")

    // A record that could not be written must not use up a sequence number: the next record the
    // take writes, and the sequence reported for it, must still be believed by the reader.
    let refused = RecoveryFixture.directory("journal-refused")
    defer { try? FileManager.default.removeItem(at: refused) }
    let journal = try CaptureJournal(directory: refused.path, header: header)
    do {
        try journal.recordDisplaySpace(hostUs: 1, zeroOriginHeight: .nan)
        preconditionFailure("A non-finite height cannot be journaled")
    } catch {}
    let reported = try journal.recordLifecycle(state: "recording", reason: nil)
    let afterRefusal = try CaptureJournal.inspect(directory: refused.path)
    precondition(
        reported == 2 && afterRefusal.lastSequence == 2
            && afterRefusal.invalidAtSequence == nil
            && afterRefusal.lastLifecycle?.state == "recording",
        "A refused record must leave the sequence the next record reports readable, reported \(reported) read \(afterRefusal.lastSequence) invalid \(afterRefusal.invalidAtSequence as Int?)"
    )
    print("PASS a record the journal could not write leaves the sequence unbroken")

    let schema2 = RecoveryFixture.directory("schema2-mark-refused")
    defer { try? FileManager.default.removeItem(at: schema2) }
    let oldJournal = try CaptureJournal(directory: schema2.path, header: CaptureJournalHeader(
        schemaVersion: 2, sessionID: "schema2", source: CaptureSource(kind: "display"),
        width: 120, height: 80, microphone: false, systemAudio: false))
    do {
        try oldJournal.recordMark(JournalMark(
            hostUs: 1, sourceUs: 0, epoch: 1, id: "old", kind: "click",
            points: [JournalMarkPoint(x: 1, y: 2, hostUs: 1)]))
        preconditionFailure("Schema2 journals must refuse marks")
    } catch let failure as CaptureFailure {
        precondition(failure.code == "INVALID_JOURNAL")
    }
    let schema3 = RecoveryFixture.directory("schema3-mark-writer")
    defer { try? FileManager.default.removeItem(at: schema3) }
    let newJournal = try CaptureJournal(directory: schema3.path, header: CaptureJournalHeader(
        schemaVersion: 3, sessionID: "schema3", source: CaptureSource(kind: "display"),
        width: 120, height: 80, microphone: false, systemAudio: false))
    let points = (0..<50_000).map { JournalMarkPoint(x: Double($0), y: 2, hostUs: Int64($0)) }
    try newJournal.recordMark(JournalMark(
        hostUs: 1, sourceUs: 0, epoch: 1, id: "long", kind: "stroke", points: points))
    var written: [JournalMark] = []
    let bounded = try CaptureJournal.streamEvidence(
        directory: schema3.path, geometry: { _ in }, samples: { _ in },
        displaySpace: { _ in }, mark: { written.append($0) })
    precondition(bounded.invalidAtSequence == nil && written.count == 1 && written[0].points.count < points.count,
        "Long strokes must stay under the one-megabyte record cap")
    print("PASS schema3 writer round trip, schema2 refusal and bounded marks")
}
