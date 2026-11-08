import Foundation
import YapCapture

func runCameraJournalProvenanceTests() throws {
    let directory = RecoveryFixture.directory("camera-journal-provenance")
    defer { try? FileManager.default.removeItem(at: directory) }
    let binding = CameraCaptureBinding(recordingId: "supplied-take", sourceId: "independent-camera", deviceId: "selected-device")
    try binding.validate()
    let journal = try CaptureJournal(directory: directory.path, header: CaptureJournalHeader(schemaVersion: 1,
        sessionID: binding.sourceId, source: CaptureSource(kind: "camera"), width: 32, height: 16,
        microphone: false, systemAudio: false, cameraBinding: binding))
    defer { journal.lease.release() }
    try journal.recordOrigin(hostUs: 1_000_000)
    func read(retain: Bool = false, through prefix: JournalPrefix? = nil) throws -> CaptureJournalSummary {
        try CaptureJournal.readEvidence(directory: directory.path, retainTiming: false,
            geometry: { _ in }, samples: { _ in }, displaySpace: { _ in }, retainPrefix: retain,
            through: prefix, descriptor: journal.lease.descriptor)
    }
    let ordinary = try read()
    precondition(ordinary.validatedPrefix == nil && ordinary.header?.cameraBinding == binding)
    let pinned = try read(retain: true)
    let prefix = pinned.validatedPrefix!
    precondition(prefix.bytes > 0 && pinned.originHostUs == 1_000_000)
    // A through-prefix itself requests verification, with no audio callback or extra parser.
    let replay = try read(through: prefix)
    precondition(replay.validatedPrefix == prefix && replay.header?.cameraBinding == binding)
    try journal.recordFinished(CaptureResult(state: "complete", source: CaptureSource(kind: "camera"), width: 32, height: 16,
        durationUs: 100_000, hostOriginUs: 1_000_000, pauses: [], tracks: [], failure: nil,
        systemAudioScope: "disabled", cameraBinding: binding))
    let terminal = try read(retain: true)
    precondition(terminal.finished && terminal.validatedPrefix != prefix)
    let preTerminal = try read(through: prefix)
    precondition(!preTerminal.finished && preTerminal.validatedPrefix == prefix)
    let url = directory.appendingPathComponent("capture.journal.jsonl")
    let original = try Data(contentsOf: url)
    let changed = String(decoding: original, as: UTF8.self).replacingOccurrences(of: "1000000", with: "1000001")
    // In-place mutation preserves the owned descriptor while violating the byte token.
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: 0); try handle.write(contentsOf: Data(changed.utf8)); try handle.synchronize()
    do { _ = try read(through: prefix); preconditionFailure("Changed shared origin must fail pinned prefix verification") }
    catch let failure as CaptureFailure { precondition(failure.code == "INVALID_JOURNAL_PREFIX") }
    try handle.truncate(atOffset: 0); try handle.seek(toOffset: 0); try handle.write(contentsOf: original + Data([123])); try handle.close()
    let torn = try read(retain: true)
    precondition(torn.incompleteTail && torn.validatedPrefix == terminal.validatedPrefix)
    let beforeTorn = try read(through: terminal.validatedPrefix)
    precondition(beforeTorn.finished && !beforeTorn.incompleteTail)
    do { try CameraCaptureBinding(recordingId: "", sourceId: "camera", deviceId: "device").validate(); preconditionFailure("Empty supplied take identity must refuse") }
    catch let failure as CaptureFailure { precondition(failure.code == "INVALID_REQUEST") }
    print("PASS layout1 journal prefix retention, supplied camera binding, allowed terminal append, changed origin and torn-tail boundary")
}
