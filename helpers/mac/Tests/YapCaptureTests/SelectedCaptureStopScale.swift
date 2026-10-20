@preconcurrency import AVFoundation
import Foundation
import Darwin
import YapCapture
import YapMedia

/// Opt-in native-rate replay; timing is evidence, never a machine-dependent pass threshold.
@MainActor
func runSelectedCaptureStopScale(output: String, sourcePath: String) async throws {
    let root = URL(fileURLWithPath: output)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let source = URL(fileURLWithPath: sourcePath)
    let asset = AVURLAsset(url: source)
    let track = try await asset.loadTracks(withMediaType: .video).first!
    let size = try await track.load(.naturalSize)
    let duration = try await asset.load(.duration)
    precondition(duration.seconds > 0 && duration.seconds < 600, "Replay is bounded to ten minutes")
    let folder = root.appendingPathComponent("take")
    let cameraDirectory = folder.appendingPathComponent("camera")
    let diagnosticDirectory = root.appendingPathComponent("unverified-reader-views")
    let readers = try CameraReaderStarts(directory: cameraDirectory,
        logURL: root.appendingPathComponent("reader-starts.jsonl"), diagnosticDirectory: diagnosticDirectory)
    defer { readers.restore() }
    let input = PrerecordedCaptureInput(source: source, size: size)
    input.paceVideo = true
    input.probeDirectory = folder
    input.cameraBeforePrimary = false
    let capture = NativeCapture(prepareInput: { _, _ in input })
    let probe = SelectedCaptureProbe()
    let request = try JSONDecoder().decode(SelectedCaptureRequest.self,
        from: JSONSerialization.data(withJSONObject: [
            "source": ["kind": "display", "displayID": 7], "cameraID": "unused-offline",
            "microphone": ["enabled": false], "outputDirectory": root.path,
            "framesPerSecond": 30, "durationSeconds": 3600, "cameraDelaySeconds": 0,
        ]))
    let began = ContinuousClock.now
    let task = Task { try await probe.record(capture, request: request,
        screenRequest: CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: folder.path)) }
    while capture.deviceState != "recording" {
        precondition(began.duration(to: .now) < .seconds(duration.seconds + 60), "Replay did not finish startup")
        try await Task.sleep(for: .milliseconds(20))
    }
    let beforeStop = readers.observed
    let candidates = try FileManager.default.contentsOfDirectory(atPath: cameraDirectory.path)
        .filter { $0.hasPrefix(".yap-output-") }
        .map { cameraDirectory.appendingPathComponent($0).appendingPathComponent("camera.mov").path }
        .filter { FileManager.default.fileExists(atPath: $0) }
    let candidateIdentities = try candidates.map { path -> [String: Any] in
        var info = stat()
        guard lstat(path, &info) == 0 else { throw CaptureFailure("OBSERVATION_FAILED", "Cannot observe private camera candidate.") }
        return ["path": path, "device": Int64(info.st_dev), "inode": UInt64(info.st_ino), "bytes": Int64(info.st_size)]
    }
    try JSONSerialization.data(withJSONObject: ["readerStarts": beforeStop,
        "privateCandidates": candidates, "candidateIdentities": candidateIdentities], options: [.prettyPrinted, .sortedKeys])
        .write(to: root.appendingPathComponent("before-stop.json"), options: .atomic)
    let retentionBegan = ContinuousClock.now
    try readers.retainActive([cameraDirectory.appendingPathComponent("camera.raw.mov")]
        + candidates.map { URL(fileURLWithPath: $0) }, in: diagnosticDirectory)
    let retentionElapsed = retentionBegan.duration(to: .now).components
    let activeRetentionSeconds = Double(retentionElapsed.seconds) + Double(retentionElapsed.attoseconds) / 1e18
    readers.markStop()
    let stopAt = ContinuousClock.now
    probe.requestStop()
    let result = try await task.value
    let stoppedAt = ContinuousClock.now
    try readers.checkLog()
    try JSONEncoder().encode(readers.readings).write(to: root.appendingPathComponent("reader-starts.json"), options: .atomic)
    let persisted = try Data(contentsOf: root.appendingPathComponent("screen-result.json"))
    precondition(persisted == result, "Stop returned before durable screen result")
    let screen = try JSONDecoder().decode(CaptureResult.self, from: result)
    let camera = try JSONDecoder().decode(CaptureResult.self,
        from: Data(contentsOf: folder.appendingPathComponent("camera/capture-result.json")))
    let publication = try JSONDecoder().decode(CameraMedia.Receipt.self,
        from: Data(contentsOf: folder.appendingPathComponent("camera/camera.publication.json")))
    precondition(screen.failure == nil && camera.failure == nil, "Closure must succeed")
    precondition(publication.diagnostics.isEmpty && publication.representedFrames == input.offeredVideoFrames,
        "Every offered camera picture must survive admission and exact PTS/BGRA publication verification")
    precondition(camera.tracks[0].samples == publication.representedFrames
        && camera.tracks[0].droppedSamples == 0 && camera.tracks[0].omittedSamples == 1)
    let rows = try String(contentsOf: folder.appendingPathComponent("timestamps.jsonl"), encoding: .utf8)
        .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    let dispositions = rows.filter { $0["role"] as? String == "camera" }.map { $0["disposition"] as! String }
    precondition(dispositions == ["accepted", "duplicate-or-reordered"] + Array(repeating: "accepted", count: input.offeredVideoFrames - 1)
        + ["sealed-or-failed"], "Only reordered prologue and post-seal boundary probes may be omitted")
    precondition(camera.hostOriginUs == screen.hostOriginUs && camera.tracks[0].firstSampleUs == 200000)
    func seconds(_ elapsed: Duration) -> Double {
        Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
    }
    let report: [String: Any] = [
        "source": source.path, "width": input.width, "height": input.height,
        "sourceDurationSeconds": duration.seconds, "offeredPictures": input.offeredVideoFrames,
        "acquisitionWallSeconds": seconds(began.duration(to: stopAt)),
        "stopToDurableResultSeconds": seconds(stopAt.duration(to: stoppedAt)),
        "cameraPictureSHA256": publication.pictureSHA256,
        "representedPictures": publication.representedFrames,
        "cameraOmittedSamples": camera.tracks[0].omittedSamples,
        "cameraFirstUs": publication.firstUs, "cameraEndUs": publication.endUs,
        "activeDiagnosticSnapshotSeconds": activeRetentionSeconds,
        "readerViewRetentionSeconds": readers.readings.reduce(0.0) { $0 + $1.retentionSeconds },
        "preStopRawReaderStarts": beforeStop["raw", default: 0],
        "preStopCanonicalReaderStarts": beforeStop["canonical", default: 0],
        "publishedActiveCandidate": candidates.contains(cameraDirectory.appendingPathComponent(publication.candidate).path),
        "scope": "Native-rate prerecorded screen/camera replay; microphone disabled; no AppKit quit timer or physical devices",
    ]
    try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        .write(to: root.appendingPathComponent("measurement.json"), options: .atomic)
    print("PASS selected probe full stop: \(publication.representedFrames) pictures, \(seconds(stopAt.duration(to: stoppedAt)))s to durable result")
}

/// Measures final camera proof on closed immutable operands; it does not exercise hardware drain.
func runRetainedCameraPublicationCost(output: String, donorPath: String) async throws {
    let root = URL(fileURLWithPath: output)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let donor = URL(fileURLWithPath: donorPath)
    let began = ContinuousClock.now
    func seconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
    }
    func progress(_ phase: String) throws {
        try JSONSerialization.data(withJSONObject: ["phase": phase,
            "elapsedSeconds": seconds(began.duration(to: .now))], options: [.sortedKeys])
            .write(to: root.appendingPathComponent("progress.json"), options: .atomic)
    }
    try progress("checking-donor")
    let receiptURL = donor.appendingPathComponent("camera.publication.json")
    let original = try JSONDecoder().decode(CameraMedia.Receipt.self, from: Data(contentsOf: receiptURL))
    try JSONEncoder().encode(original).write(to: root.appendingPathComponent("original-receipt.json"))
    let names = ["camera.raw.mov", CameraMedia.mappingFile, "camera.closed.json", "capture.journal.jsonl", "camera.publication.json"]
    var originalIdentities: [String: CaptureMediaIdentity] = [:]
    for name in names { originalIdentities[name] = try CaptureMediaIdentity.read(donor.appendingPathComponent(name)) }
    try JSONEncoder().encode(originalIdentities).write(to: root.appendingPathComponent("donor-before.json"))
    let marker = try JSONDecoder().decode(CaptureMediaIdentity.self,
        from: Data(contentsOf: donor.appendingPathComponent("camera.closed.json")))
    guard originalIdentities["camera.raw.mov"] == original.raw,
        originalIdentities[CameraMedia.mappingFile] == original.observations,
        originalIdentities["camera.closed.json"] == original.closed, marker == original.raw,
        original.representedFrames == 6145, original.pictureTimeScale == 1000000,
        original.pictureSHA256 == "4e923cdd76e318daf9f131c7a1b79ee8d2b1afadc48d98bdec274c2754c517d0",
        original.firstUs == 712680, original.endUs == 205714400,
        original.support == ExactRange(startUs: 712680, endUs: 205714400),
        original.journal != nil, original.binding != nil,
        original.diagnostics.isEmpty else {
        throw CaptureFailure("INELIGIBLE_RETAINED_CAMERA", "Donor must retain the original exact bound camera authority.")
    }
    let donorLease = try CaptureJournalLease(directory: donor.path)
    defer { donorLease.release() }
    func facts(_ lease: CaptureJournalLease, prefix: JournalPrefix? = nil) throws -> CaptureJournalSummary {
        try CaptureJournal.readEvidence(directory: lease.directory,
            retainTiming: true, geometry: { _ in }, samples: { _ in }, displaySpace: { _ in },
            retainPrefix: true, through: prefix, descriptor: lease.descriptor)
    }
    let pinned = try facts(donorLease, prefix: original.journal)
    let current = try facts(donorLease)
    try JSONEncoder().encode(pinned).write(to: root.appendingPathComponent("donor-prefix.json"))
    try JSONEncoder().encode(current).write(to: root.appendingPathComponent("donor-journal.json"))
    guard let header = pinned.header, header.schemaVersion == 1,
        header.source.kind == "camera", header.cameraBinding == original.binding,
        header.sessionID == original.binding?.sourceId, !header.microphone, !header.systemAudio,
        original.originHostUs == pinned.originHostUs, current.originHostUs == pinned.originHostUs,
        current.pauses == pinned.pauses, current.openPauseHostUs == pinned.openPauseHostUs,
        !current.incompleteTail, current.invalidAtSequence == nil else {
        throw CaptureFailure("INELIGIBLE_RETAINED_CAMERA", "Donor journal must preserve the publication's binding and shared clock.")
    }
    try original.binding?.validate()
    let camera = root.appendingPathComponent("camera")
    try FileManager.default.createDirectory(at: camera, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    let cloneAt = ContinuousClock.now
    for name in names where name != "camera.publication.json" {
        guard clonefile(donor.appendingPathComponent(name).path, camera.appendingPathComponent(name).path, 0) == 0 else {
            throw CaptureFailure("RETAINED_CLONE_FAILED", "Cannot isolate camera operand: \(name).")
        }
    }
    let cloneSeconds = seconds(cloneAt.duration(to: .now))
    let lease = try CaptureJournalLease(directory: camera.path)
    defer { lease.release() }
    let readers = try CameraReaderStarts(directory: camera, logURL: root.appendingPathComponent("reader-starts.jsonl"))
    defer { readers.restore() }
    let verification = CameraMedia.Verification(directory: camera)
    do {
        try progress("priming-verification")
        let primeAt = ContinuousClock.now
        verification.request(observations: camera.appendingPathComponent(CameraMedia.mappingFile),
            bytes: original.observations.bytes, frames: original.representedFrames)
        await verification.close()
        let primeSeconds = seconds(primeAt.duration(to: .now))
        let primedReadings = readers.readings
        try JSONEncoder().encode(primedReadings).write(to: root.appendingPathComponent("primed-readers.json"))
        let candidates = try FileManager.default.contentsOfDirectory(atPath: camera.path)
            .filter { $0.hasPrefix(".yap-output-") }
            .map { camera.appendingPathComponent($0).appendingPathComponent("camera.mov") }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        let primeOperands = root.appendingPathComponent("unverified-prime")
        try FileManager.default.createDirectory(at: primeOperands, withIntermediateDirectories: false)
        try readers.retainActive([camera.appendingPathComponent("camera.raw.mov")] + candidates, in: primeOperands)
        let primedBoth = ["raw", "canonical"].allSatisfy { role in primedReadings.contains { $0.role == role && $0.started } }
        try JSONSerialization.data(withJSONObject: ["primingSeconds": primeSeconds,
            "bothReadersStarted": primedBoth, "privateCandidates": candidates.map(\.path)],
            options: [.sortedKeys, .prettyPrinted]).write(to: root.appendingPathComponent("priming.json"))
        guard primedBoth else {
            throw CaptureFailure("INSUFFICIENT_CAMERA_PRIMING", "Both actual readers must prime before final publication begins.")
        }
        try progress("publishing-camera")
        readers.markStop()
        let publicationAt = ContinuousClock.now
        let result = try await CameraMedia.publish(lease: lease,
            observationURL: camera.appendingPathComponent(CameraMedia.mappingFile), verification: verification)
        let publicationSeconds = seconds(publicationAt.duration(to: .now))
        try JSONEncoder().encode(result).write(to: root.appendingPathComponent("new-receipt.json"))
        let closedFacts = try facts(lease)
        try JSONEncoder().encode(closedFacts).write(to: root.appendingPathComponent("new-journal.json"))
        try JSONEncoder().encode(readers.readings).write(to: root.appendingPathComponent("reader-starts.json"))
        var after: [String: CaptureMediaIdentity] = [:]
        for name in names { after[name] = try CaptureMediaIdentity.read(donor.appendingPathComponent(name)) }
        try JSONEncoder().encode(after).write(to: root.appendingPathComponent("donor-after.json"))
        let tails = readers.readings.filter { $0.phase == "stop" && $0.started }
        let boundedTails = ["raw", "canonical"].allSatisfy { role in
            tails.contains { $0.role == role } && tails.filter { $0.role == role }.allSatisfy {
                CMTime(value: $0.rangeStart.value, timescale: $0.rangeStart.timescale) > CMTime(value: original.firstUs, timescale: 1000000)
            }
        }
        let matches = result.pictureSHA256 == original.pictureSHA256 && result.representedFrames == original.representedFrames
            && result.firstUs == original.firstUs && result.endUs == original.endUs && result.support == original.support
            && result.pictureTimeScale == original.pictureTimeScale && result.binding == original.binding
            && result.originHostUs == original.originHostUs && result.diagnostics == original.diagnostics
            && result.raw == original.raw && result.observations == original.observations && result.closed == original.closed
            && closedFacts.pauses == current.pauses && closedFacts.originHostUs == current.originHostUs
        try JSONSerialization.data(withJSONObject: ["cloneSeconds": cloneSeconds,
            "primingSeconds": primeSeconds, "publicationSeconds": publicationSeconds,
            "elapsedSeconds": seconds(began.duration(to: .now)), "primedBothReaders": primedBoth,
            "bothFinalReadersResumeBeyondOrigin": boundedTails, "exactPictureSupportAndClockMatch": matches,
            "donorUnchanged": after == originalIdentities,
            "canonicalContainerBytesEqual": result.canonical == original.canonical,
            "scope": "Fresh closed-source priming then one camera publication; no SDK input drain, primary source, app quit or physical Stop guarantee."],
            options: [.sortedKeys, .prettyPrinted]).write(to: root.appendingPathComponent("measurement.json"))
        guard after == originalIdentities && matches else {
            throw CaptureFailure("RETAINED_CAMERA_CHANGED", "Exact source picture/support/clock evidence or donor authority differs.")
        }
        guard primedBoth && boundedTails else {
            throw CaptureFailure("INSUFFICIENT_CAMERA_PRIMING", "Both actual readers must prime and resume final proof beyond the initial support.")
        }
        try readers.checkLog()
        try progress("complete")
        print("PASS retained camera exact proof: priming \(primeSeconds)s, publication \(publicationSeconds)s; this is not a physical Stop verdict")
    } catch {
        await verification.close()
        try JSONEncoder().encode(readers.readings).write(to: root.appendingPathComponent("reader-starts.json"))
        try Data(String(describing: error).utf8).write(to: root.appendingPathComponent("failure.txt"))
        try progress("failed")
        // Owned unfinished candidates remain diagnostic operands; no cleanup destroys them here.
        throw error
    }
}
