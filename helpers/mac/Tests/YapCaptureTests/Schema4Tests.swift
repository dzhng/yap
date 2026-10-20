import CoreMedia
import Foundation
import YapCapture
import YapMedia

func runSchema4HeaderTests() throws {
    let root = RecoveryFixture.directory("schema4-header")
    defer { try? FileManager.default.removeItem(at: root) }
    let writer = try CaptureWriter(request: CaptureRequest(source: CaptureSource(kind: "display"),
        outputDirectory: root.path, microphone: false, systemAudio: false),
        width: 32, height: 32, sessionID: "schema4", requestedSourceRect: nil, onFailure: { _ in })
    defer { writer.cancel() }
    let data = try Data(contentsOf: root.appendingPathComponent("capture.journal.jsonl"))
    let record = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let header = record["data"] as! [String: Any]
    precondition(header["schemaVersion"] as? Int == 4, "New takes must write schema 4")
    let sampling = header["cursorSampling"] as? [String: Any]
    precondition(sampling?["intervalUs"] as? Int == 16_667 && sampling?["holds"] as? Bool == true,
        "New takes must declare the sampler cadence and held samples")
    let decoded = try CaptureJournal.streamEvidence(directory: root.path)
    precondition(JournalSchema.cursorSampling(decoded.header!) == CursorSampling(holds: true))
    for version in 1...3 {
        let historical = CaptureJournalHeader(schemaVersion: version, sessionID: "old", source: CaptureSource(kind: "display"),
            width: 32, height: 32, microphone: false, systemAudio: false, cursorSampling: CursorSampling(holds: true))
        precondition(!JournalSchema.cursorSampling(historical).holds,
            "Historical schema flags cannot enable held cursor semantics")
    }
    // Future-version refusal is malformed-input coverage; the fixture starts with a production header.
    let future = root.appendingPathComponent("future")
    try FileManager.default.createDirectory(at: future, withIntermediateDirectories: false)
    var unknown = record
    var futureHeader = header
    futureHeader["schemaVersion"] = 5
    unknown["data"] = futureHeader
    try (JSONSerialization.data(withJSONObject: unknown) + Data([10]))
        .write(to: future.appendingPathComponent("capture.journal.jsonl"))
    for read in [CaptureJournal.inspect, { try CaptureJournal.streamEvidence(directory: $0) }] {
        do { _ = try read(future.path); preconditionFailure("Future journals must refuse") }
        catch let failure as CaptureFailure {
            precondition(failure.code == "INVALID_JOURNAL" && failure.message.contains("schema 5")
                && failure.message.contains("through 4"), "Future-version refusal must explain the supported range")
        }
    }
    print("PASS schema4 header declares held cursor sampling")
}

@MainActor
func runSchema4StrokeTests() async throws {
    let root = RecoveryFixture.directory("schema4-stroke")
    defer { try? FileManager.default.removeItem(at: root) }
    let video = root.appendingPathComponent("input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: video,
        timesUs: [0, 100_000], endUs: 200_000)
    let input = PrerecordedCaptureInput(source: video)
    // Six minutes of hardware samples, delivered without waiting six wall-clock minutes.
    input.markSamples = (0...21_600).map { i in
        MarkSample(hostUs: Int64(i) * 1_000_000 / 60, shift: true, otherModifiers: false,
            point: CGPoint(x: Double(i % 100) / 7, y: Double(i % 71) / 11), buttonDown: false)
    }
    input.markSamples.append(MarkSample(hostUs: 360_016_667, shift: false, otherModifiers: false,
        point: .zero, buttonDown: false))
    let take = root.appendingPathComponent("take")
    let capture = NativeCapture(prepareInput: { _, _ in input })
    try await capture.start(CaptureRequest(source: CaptureSource(kind: "display"),
        outputDirectory: take.path, microphone: false, systemAudio: false))
    var marks: [JournalMark] = []
    let summary = try CaptureJournal.streamEvidence(directory: take.path, mark: { marks.append($0) })
    precondition(summary.invalidAtSequence == nil && marks.count == 2,
        "Six minutes held must commit two readable strokes, got \(marks.count)")
    precondition(marks.allSatisfy { $0.kind == "stroke" && $0.points.last!.hostUs - $0.hostUs <= Requirements.maximumStrokeUs })
    precondition(marks[0].points.last!.hostUs - marks[0].hostUs == Requirements.maximumStrokeUs,
        "The first stroke must commit at the product stroke limit")
    let actual = marks.flatMap(\.points).map(\.hostUs)
    let expected = input.markSamples.dropLast().map { input.fixtureOrigin! + $0.hostUs }
    precondition(actual == expected, "Splitting must retain every hardware observation in order")
    let lines = try Data(contentsOf: take.appendingPathComponent("capture.journal.jsonl")).split(separator: 10)
    precondition(lines.allSatisfy { $0.count <= CaptureJournal.maximumRecordBytes })
    precondition(lines.contains { $0.count > 1_048_576 }, "The unthinned stroke must exercise the schema4 record allowance")
    await capture.discard()
    print("PASS six-minute held stroke: two records, 21601 points; largest line \(lines.map(\.count).max()!) / \(CaptureJournal.maximumRecordBytes) bytes")
}

func runSchema4SummaryTests() async throws {
    for (version, undo) in [(4, false), (4, true), (3, false)] {
        try await verifyTakeSummary(version: version, undo: undo)
    }
    try await verifyTakeSummary(version: 4, undo: false, sourceKind: "region")
}

private func verifyTakeSummary(version: Int, undo: Bool, sourceKind: String = "display") async throws {
    let root = RecoveryFixture.directory("schema4-summary")
    defer { try? FileManager.default.removeItem(at: root) }
    let source = CaptureSource(kind: sourceKind, displayID: 1)
    try await RecoveryFixture.writeVariableDurationVideo(to: root.appendingPathComponent("video.mov"),
        timesUs: [0, 100_000], endUs: 200_000)
    let journal = try CaptureJournal(directory: root.path, header: CaptureJournalHeader(
        schemaVersion: version, sessionID: "schema4-marks", source: source, width: 160, height: 120,
        microphone: false, systemAudio: false, cursorSampling: version == 4 ? CursorSampling() : nil))
    try journal.recordPCMOrigin(JournalPCMOrigin(rawPTS: time(microseconds: 1000), declaredHostUs: 1000))
    try journal.recordMark(JournalMark(hostUs: 1100, sourceUs: 100, epoch: 1, id: "pin", kind: "pin", pin: 1,
        points: [JournalMarkPoint(globalX: 10, globalY: 20, x: 10, y: 20, hostUs: 1100)]))
    try journal.recordMark(JournalMark(hostUs: 1200, sourceUs: 200, epoch: 1, id: "stroke", kind: "stroke",
        points: [JournalMarkPoint(globalX: 10, globalY: 20, x: 10, y: 20, hostUs: 1200),
            JournalMarkPoint(globalX: 20, globalY: 20, x: 20, y: 20, hostUs: 1300)]))
    if undo {
        for (id, kind, pin) in [("pin", "pin", 1 as Int?), ("stroke", "stroke", nil)] {
            try journal.recordMark(JournalMark(hostUs: 1400, sourceUs: 400, epoch: 1,
                id: "undo-" + id, kind: kind, pin: pin, points: [], retracts: id))
        }
        // Ordinary clicks never turn the pin/stroke facts on.
        try journal.recordMark(JournalMark(hostUs: 1500, sourceUs: 500, epoch: 1, id: "click", kind: "click",
            points: [JournalMarkPoint(globalX: 1, globalY: 2, x: 1, y: 2, hostUs: 1500)]))
    }
    try journal.recordFinished(CaptureResult(state: "complete", source: source, width: 160,
        height: 120, durationUs: 200_000, hostOriginUs: 1000, pauses: [], tracks: [],
        failure: nil, systemAudioScope: "disabled"))
    _ = try await CaptureSourcePublication.publish(kind: .primary, durationUs: 200_000,
        originHostUs: 1000, tracks: [], diagnostic: nil, lease: journal.lease, layout: version)
    let url = root.appendingPathComponent("source.publication.json")
    let bytes = try Data(contentsOf: url)
    let receipt = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
    if version == 4 {
        precondition((receipt["take"] as? [String: String])?["kind"] == (sourceKind == "region" ? "area" : sourceKind),
            "Publication must retain the take kind separately from source authority")
        precondition(receipt["marks"] as? [String: Bool] == ["pins": !undo, "strokes": !undo],
            "Publication must report only live pins and strokes")
    } else {
        precondition(receipt["take"] == nil && receipt["marks"] == nil,
            "Old source summaries must omit optional take facts")
    }
    _ = try await CaptureSourcePublication.publish(kind: .primary, durationUs: 200_000,
        originHostUs: 1000, tracks: [], diagnostic: nil, lease: journal.lease, layout: version)
    let republished = try Data(contentsOf: url)
    precondition(republished == bytes, "An already-published receipt must never be rewritten")
    if let output = ProcessInfo.processInfo.environment["YAP_SCHEMA4_FIXTURE_DIRECTORY"], version == 4, sourceKind == "display" {
        let destination = URL(fileURLWithPath: output)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: root.appendingPathComponent("capture.journal.jsonl"),
            to: destination.appendingPathComponent(undo ? "schema4-undone.jsonl" : "schema4-marks.jsonl"))
        if !undo { try bytes.write(to: destination.appendingPathComponent("schema4-summary.json")) }
    }
    if version == 4 {
        var stripped = receipt
        stripped.removeValue(forKey: "take"); stripped.removeValue(forKey: "marks")
        try JSONSerialization.data(withJSONObject: stripped).write(to: url)
        do {
            _ = try await CaptureSourcePublication.publish(kind: .primary, durationUs: 200_000,
                originHostUs: 1000, tracks: [], diagnostic: nil, lease: journal.lease, layout: version)
            preconditionFailure("Stripped schema4 summary must refuse republish")
        } catch is CaptureFailure {}
        try bytes.write(to: url)
    }
    journal.lease.release()
    let recovered = try await CapturePublishedSource.recover(directory: root.path)
    precondition(recovered.sourceId == "schema4-marks" && recovered.marks?.pins == (version == 4 ? !undo : nil))
    let recoveredBytes = try Data(contentsOf: url)
    precondition(recoveredBytes == bytes, "Read-only recovery must retain publication bytes")
    if version == 4 {
        var stripped = receipt
        stripped.removeValue(forKey: "take"); stripped.removeValue(forKey: "marks")
        try JSONSerialization.data(withJSONObject: stripped).write(to: url)
        do {
            _ = try await CapturePublishedSource.recover(directory: root.path)
            preconditionFailure("Stripped schema4 summary must refuse recovery")
        } catch is CaptureFailure {}
        try bytes.write(to: url)
    }
    print("PASS schema\(version) summary live marks=\(!undo), optional facts and immutable republish")
}
