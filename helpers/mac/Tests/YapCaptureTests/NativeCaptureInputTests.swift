@preconcurrency import AVFoundation
import Foundation
import CryptoKit
import ScreenCaptureKit
import YapCapture
import YapMedia
import YapWire

@MainActor
func runNativeCaptureInputTests() async throws {
    let root = RecoveryFixture.directory("native-prerecorded-input")
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: source,
        timesUs: [0, 100_000, 200_000], endUs: 300_000)
    let failed = PrerecordedCaptureInput(source: source, refusesAfterDelivery: true)
    failed.probeDirectory = root.appendingPathComponent("failed")
    let healthy = PrerecordedCaptureInput(source: source)
    var inputs = [failed, healthy]
    let capture = NativeCapture(prepareInput: { _, _ in inputs.removeFirst() })
    func request(_ name: String) -> CaptureRequest {
        CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: root.appendingPathComponent(name).path, microphone: false, systemAudio: false)
    }
    do { try await capture.start(request("failed")); preconditionFailure("Partial input must refuse") }
    catch let error as CaptureFailure { precondition(error.code == "INPUT_START_FAILED") }
    precondition(capture.publication == nil, "Failed startup cannot leave a live-input publication observation")
    precondition(failed.stops == 1 && failed.discards == 1 && failed.finalizations == 0 && capture.deviceState == "idle")
    try await capture.start(request("healthy"))
    failed.onFailure?(CaptureFailure("STALE_DEVICE_LOSS", "Old input callback"))
    await Task.yield()
    precondition(capture.deviceState == "recording")
    try capture.pause()
    let result = try await capture.stop()
    precondition(result.state == "complete" && result.failure == nil && healthy.stops == 1)
    precondition(healthy.finalizations == 1 && healthy.discards == 0 && healthy.finalClock?.isPaused == false)
    precondition(result.cursor.sampled == 0, "Prerecorded input cannot acquire the live cursor")
    let recovered = try await MediaRecovery.recover(directory: root.appendingPathComponent("healthy").path)
    precondition(recovered.journalFailure == nil)
    precondition(recovered.durationUs == result.durationUs && result.durationUs >= 300_000)
    precondition(capture.deviceState == "idle")
    let discarded = PrerecordedCaptureInput(source: source)
    discarded.probeDirectory = root.appendingPathComponent("discarded")
    let discardedCapture = NativeCapture(prepareInput: { _, _ in discarded })
    try await discardedCapture.start(request("discarded"))
    await discardedCapture.discard()
    precondition(discarded.stops == 1 && discarded.discards == 1 && discarded.finalizations == 0)
    try await verifyNoCompanionCamera(root: root, source: source)
    print("PASS actual NativeCapture closes prerecorded writer, tears down partial input, ignores stale generation, and acquires no live cursor")
}

/// Only a screen take with a reserved companion camera has a camera switch: a screen-only take
/// and a camera-only take refuse the toggle and report no companion camera.
@MainActor
private func verifyNoCompanionCamera(root: URL, source: URL) async throws {
    let screen = PrerecordedCaptureInput(source: source)
    let screenOnly = NativeCapture(prepareInput: { _, _ in screen })
    try await screenOnly.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
        outputDirectory: root.appendingPathComponent("screen-only").path, microphone: false, systemAudio: false))
    let device = FixtureCameraDevice("primary-camera", session: FixtureCameraSession(source: source, origin: { CaptureHostTime.nowUs() }))
    var preparation = CaptureInputPreparation()
    preparation.cameraAuthorized = { true }
    preparation.cameras = { [device] }
    let cameraOnly = NativeCapture(prepareInput: { [preparation] request, check in
        try await preparation.prepare(request, checkInterruption: check)
    })
    try await cameraOnly.start(CaptureRequest(source: CaptureSource(kind: "camera", deviceID: "primary-camera"),
        outputDirectory: root.appendingPathComponent("camera-only").path, microphone: false, systemAudio: false))
    for capture in [screenOnly, cameraOnly] {
        precondition(capture.deviceState == "recording" && capture.companionCamera == nil)
        do { try await capture.setCamera(on: false); preconditionFailure("A take without a companion camera cannot toggle one") }
        catch let error as CaptureFailure { precondition(error.code == "CAMERA_NOT_RESERVED") }
        await capture.discard()
    }
    print("PASS screen-only and camera-only takes have no companion camera switch")
}


@MainActor
func runNativeCapturePublicationProbe(output: String, corpus: String) async throws {
    let root = URL(fileURLWithPath: output)
    let child = ProcessInfo.processInfo.environment["YAP_NATIVE_PUBLICATION_CHILD"] == "1"
    let video = root.appendingPathComponent("input.mov")
    if !child {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try await RecoveryFixture.writeVariableDurationVideo(to: video,
            timesUs: [0, 500000, 1500000, 2300000], endUs: 2500000)
    }
    var supportHashes: [String] = []
    var normalPCMHash: String?
    for mode in child ? ["interrupted-before-publication"] : ["normal", "pause", "retry-before-publication", "interrupted-before-publication", "publication-conflict", "unreadable-packed", "requested-missing"] {
        let folder = root.appendingPathComponent(mode)
        let input = PrerecordedCaptureInput(source: video)
        if mode != "requested-missing" {
            input.audio = URL(fileURLWithPath: corpus).appendingPathComponent("a-audio.wav")
            input.omittedAudioBuffer = mode == "pause" ? nil : 4
            if mode == "pause" { input.pauseJournal = folder.appendingPathComponent("capture.journal.jsonl") }
            input.audioRoles = [.microphone, .audio]
        }
        input.holdStop = ["interrupted-before-publication", "retry-before-publication", "unreadable-packed"].contains(mode)
        let crashedChild = mode == "interrupted-before-publication" && !child
        if crashedChild {
            let process = Process()
            process.executableURL = Bundle.main.executableURL
            var environment = ProcessInfo.processInfo.environment
            environment["YAP_NATIVE_PUBLICATION_CHILD"] = "1"
            process.environment = environment
            try process.run()
            process.waitUntilExit()
            precondition(process.terminationStatus == 0, "Interrupted writer child must close before recovery")
        } else {
            var capture: NativeCapture? = NativeCapture(prepareInput: { _, _ in input })
            try await capture!.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
                outputDirectory: folder.path, sourceId: mode, microphone: true, systemAudio: true))
            if input.holdStop {
                let stopping = Task { [active = capture!] in try await active.stop() }
                await input.stopEntered.wait()
                capture!.cancelPublication()
                input.releaseStop.release()
                do { _ = try await stopping.value; preconditionFailure("Publication should observe cancellation after encoder closure") }
                catch is CancellationError {}
                do { _ = try await MediaRecovery.recover(directory: folder.path); preconditionFailure("Failed publication retains retry authority") }
                catch let error as CaptureFailure { precondition(error.code == "CAPTURE_BUSY") }
                if child {
                    // Exiting this owned process, rather than dropping an ARC reference, models abandoned ownership.
                    return
                }
                if mode == "unreadable-packed" {
                    try Data("corrupted immutable packed media".utf8).write(to: folder.appendingPathComponent("narration.packed.mov"))
                }
                let retried: CaptureResult
                do { retried = try await capture!.stop() }
                catch {
                    let native = error as NSError
                    try JSONSerialization.data(withJSONObject: ["domain": native.domain, "code": native.code,
                        "description": native.localizedDescription, "underlying": String(describing: native.userInfo[NSUnderlyingErrorKey])], options: [.prettyPrinted])
                        .write(to: folder.appendingPathComponent("publication-error.json"))
                    throw error
                }
                precondition(input.finalizations == 1 && input.discards == 0, "Publication retry must not refinalize companion media")
                precondition(retried.state == (mode == "unreadable-packed" ? "interrupted" : "complete"))
                try JSONEncoder().encode(retried).write(to: folder.appendingPathComponent("capture-result.json"))
                capture = nil
            } else {
                if mode == "publication-conflict" {
                    try Data("occupied canonical name".utf8).write(to: folder.appendingPathComponent("narration.mov"))
                }
                let result = try await capture!.stop()
                try JSONEncoder().encode(result).write(to: folder.appendingPathComponent("capture-result.json"))
                precondition(result.state == (["requested-missing", "publication-conflict"].contains(mode) ? "interrupted" : "complete"))
                if mode == "publication-conflict" { precondition(result.failure?.code == "PUBLICATION_CONFLICT") }
                if mode == "requested-missing" { precondition(result.failure?.code == "NO_NARRATION") }
                else {
                    for track in result.tracks where track.role != "video" {
                        precondition(track.samples == input.offeredAudioBuffers - input.rejectedAudioBuffers && track.droppedSamples == 0 && track.omittedSamples == input.rejectedAudioBuffers)
                    }
                }
                precondition(result.cursor.sampled == 0)
                capture = nil
            }
        }
        let publishedNames = mode == "pause" ? ["narration.mov", "system.mov", "narration.publication.json", "system.publication.json"] : []
        let normalPublication = try publishedNames.map { try Data(contentsOf: folder.appendingPathComponent($0)) }
        let recovered = try await MediaRecovery.recover(directory: folder.path)
        let recoveredPublication = try publishedNames.map { try Data(contentsOf: folder.appendingPathComponent($0)) }
        precondition(normalPublication == recoveredPublication, "Recovery must retain normal pause publications byte-for-byte")
        try JSONEncoder().encode(recovered).write(to: folder.appendingPathComponent("recovery.json"))
        precondition(recovered.durationUs >= 2500000 - (input.pauseBounds.map { $0.end - $0.start } ?? 0) || mode == "requested-missing")
        if mode == "requested-missing" {
            precondition(recovered.tracks.filter { $0.role != "video" }.allSatisfy { $0.failure?.code == "AUDIO_UNAVAILABLE" && $0.intervals.isEmpty })
            continue
        }
        var expected = SHA256()
        expected.update(data: Data("yap.capture-pcm.v1\0".utf8))
        for value in [input.expectedRate, input.expectedChannels] {
            var little = value.littleEndian
            expected.update(data: withUnsafeBytes(of: &little) { Data($0) })
        }
        expected.update(data: input.expectedPCM)
        let offeredHash = expected.finalize().map { String(format: "%02x", $0) }.joined()
        if mode == "normal" { normalPCMHash = offeredHash }
        let expectedHash = crashedChild ? normalPCMHash! : offeredHash
        if ["publication-conflict", "unreadable-packed"].contains(mode) {
            precondition(recovered.tracks.first { $0.role == "narration" }!.failure?.code == (mode == "publication-conflict" ? "PUBLICATION_CONFLICT" : "PACKED_MEDIA_INVALID"))
            precondition(recovered.tracks.first { $0.role == "video" }!.intervals.isEmpty == false)
            let retainedConflict = try Data(contentsOf: folder.appendingPathComponent(mode == "publication-conflict" ? "narration.mov" : "narration.packed.mov"))
            precondition(retainedConflict == Data((mode == "publication-conflict" ? "occupied canonical name" : "corrupted immutable packed media").utf8))
        }
        for role in ["publication-conflict", "unreadable-packed"].contains(mode) ? ["system"] : ["narration", "system"] {
            let receipt = try JSONDecoder().decode(CaptureAudioPublication.Receipt.self,
                from: Data(contentsOf: folder.appendingPathComponent("\(role).publication.json")))
            precondition(receipt.pcmSHA256 == expectedHash, "Canonical PCM must equal independently decoded offered samples excluding the known omission")
            precondition(receipt.acceptedFrames == receipt.representedFrames)
            if mode == "pause" {
                precondition(input.rejectedAudioBuffers > 0, "The pause must exclude offered audio")
                let journal = try CaptureJournal.readEvidence(directory: folder.path, retainTiming: true, geometry: { _ in }, samples: { _ in }, displaySpace: { _ in }, layout: 3)
                precondition(journal.pauses.count == 1 && journal.pauses[0].atSourceUs == 800000
                    && journal.pauses[0].elapsedPauseUs == input.pauseBounds!.end - input.pauseBounds!.start)
                var support = SHA256()
                support.update(data: Data("yap.capture-support.v1\0".utf8))
                func integer(_ value: Int64) { var little = value.littleEndian; support.update(data: withUnsafeBytes(of: &little) { Data($0) }) }
                integer(input.expectedRate); integer(input.expectedChannels); integer(100001)
                var runs: [(physical: Int64, first: Int64, count: Int64, removed: Int64)] = []
                var physical: Int64 = 0
                for span in input.expectedPlacements {
                    if let last = runs.last, last.first + last.count == span.first, last.removed == span.removedUs {
                        runs[runs.count - 1].count += span.frames
                    } else { runs.append((physical, span.first, span.frames, span.removedUs)) }
                    physical += span.frames
                }
                precondition(runs.count == 2, "Both sides of the pause must survive")
                for run in runs { integer(run.physical); integer(run.first); integer(run.count) }
                let expectedSupport = support.finalize().map { String(format: "%02x", $0) }.joined()
                precondition(receipt.supportSHA256 == expectedSupport, "Canonical source placement must remove exactly the observed pause")
                try JSONSerialization.data(withJSONObject: ["pcmSHA256": expectedHash, "supportSHA256": expectedSupport,
                    "pauseStartHostUs": input.pauseBounds!.start, "pauseEndHostUs": input.pauseBounds!.end,
                    "acceptedFrames": physical, "excludedBuffers": input.rejectedAudioBuffers,
                    "runs": runs.map { ["physical": $0.physical, "first": $0.first, "count": $0.count, "removedPauseUs": $0.removed] }],
                    options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent("\(role)-oracle.json"))
                precondition(recovered.tracks.first { $0.role == role }!.intervals.count == runs.count)
            } else { supportHashes.append(receipt.supportSHA256) }
            precondition(recovered.tracks.first { $0.role == role }!.intervals.count == 2)
        }
    }
    precondition(Set(supportHashes).count == 1, "Normal and interrupted recovery preserve the same admitted source support")
    if !child { try await verifyPublishedTerminalBoundaries(root: root) }
    print("PASS actual NativeCapture normal/interrupted publication preserves independent PCM, both roles, exact shared support and requested-missing refusal")
}

/// Reconstruct the durable boundary after canonical publication, before its terminal journal append.
private func verifyPublishedTerminalBoundaries(root: URL) async throws {
    let donor = root.appendingPathComponent("normal")
    let journal = try Data(contentsOf: donor.appendingPathComponent("capture.journal.jsonl"))
    let lines = journal.split(separator: 10)
    let terminal = try lines.firstIndex { line in
        let record = try JSONSerialization.jsonObject(with: Data(line)) as! [String: Any]
        return record["event"] as? String == "finished"
    }!
    let prefix = lines.prefix(terminal).reduce(into: Data()) { $0.append(contentsOf: $1); $0.append(10) }
    let names = ["capture.journal.jsonl", "video.mov", "narration.mov", "system.mov", "narration.publication.json", "system.publication.json"]
    for boundary in ["absent-terminal", "torn-terminal"] {
        let folder = root.appendingPathComponent(boundary)
        try FileManager.default.copyItem(at: donor, to: folder)
        var bytes = prefix
        if boundary == "torn-terminal" { bytes.append(contentsOf: lines[terminal].prefix(lines[terminal].count / 2)) }
        try bytes.write(to: folder.appendingPathComponent("capture.journal.jsonl"))
        let before = try names.map { try Data(contentsOf: folder.appendingPathComponent($0)) }
        for _ in 0..<2 {
            let recovered = try await MediaRecovery.recover(directory: folder.path)
            precondition(recovered.journal?.finished == false && recovered.journal?.completion == nil)
            precondition(recovered.journal?.incompleteTail == (boundary == "torn-terminal"))
            precondition(recovered.journal?.invalidAtSequence == nil && recovered.journalFailure == nil)
            precondition(recovered.durationUs > 0 && recovered.tracks.allSatisfy { $0.failure == nil })
            for role in ["narration", "system"] {
                let retained = try JSONDecoder().decode(CaptureAudioPublication.Receipt.self,
                    from: Data(contentsOf: folder.appendingPathComponent("\(role).publication.json")))
                precondition(recovered.tracks.first { $0.role == role }?.representedFrames?.wrappedValue == retained.representedFrames)
            }
            let after = try names.map { try Data(contentsOf: folder.appendingPathComponent($0)) }
            precondition(after == before, "Recovery must not invent a terminal record or change durable publication")
            try JSONEncoder().encode(recovered).write(to: folder.appendingPathComponent("recovery.json"))
        }
    }
    let unchanged = try Data(contentsOf: donor.appendingPathComponent("capture.journal.jsonl"))
    precondition(unchanged == journal)
    print("PASS published canonical audio survives absent/torn terminal journal records with truthful completion and unchanged source bytes")
}
