@preconcurrency import AVFoundation
import Foundation
import YapCapture

/// Declared SDR pixels exercise composition without changing the historical publication corpus.
@MainActor
func runCameraProjectFixture(output: String) async throws {
    let root = URL(fileURLWithPath: output)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let source = root.appendingPathComponent("input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: source,
        timesUs: [0, 100000, 200000, 500000, 700000], endUs: 800000,
        colorProperties: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2])
    let audio = try captureMaterializerFixture(in: root, name: "audio-input", accepted: 96000)
    let folder = root.appendingPathComponent("capture")
    let input = PrerecordedCaptureInput(source: source)
    input.probeDirectory = folder
    input.cameraBeforePrimary = false
    input.audio = audio.appendingPathComponent("narration.packed.mov")
    // Real-time writer backpressure is not the variable under this source-to-project check.
    input.videoDeliveryInterval = .milliseconds(10)
    let capture = NativeCapture(prepareInput: { _, _ in input })
    try await capture.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
        outputDirectory: folder.path, microphone: true))
    try capture.pause()
    try await Task.sleep(for: .milliseconds(10))
    let result = try await capture.stop()
    precondition(result.failure == nil && result.camera?.failure == nil)
    precondition(result.tracks.first { $0.role == "video" }?.samples == 5)
    precondition(result.camera?.tracks.first?.samples == 5)
    precondition(result.camera?.hostOriginUs == result.hostOriginUs && result.camera?.pauses == result.pauses)
    try JSONEncoder().encode(result).write(to: folder.appendingPathComponent("native-result.json"))
    print("PASS declared Rec.709 prerecorded primary/camera/PCM publication with a shared clock")
}

@MainActor
func runCameraSourcePublicationTests(output: String? = nil) async throws {
    let root = output.map { URL(fileURLWithPath: $0) } ?? RecoveryFixture.directory("camera-source-publication")
    if output != nil { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false) }
    defer { if output == nil { try? FileManager.default.removeItem(at: root) } }
    let source = root.appendingPathComponent("input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: source,
        timesUs: [0, 100000, 200000, 500000, 700000], endUs: 800000)
    let audioFolder = try captureMaterializerFixture(in: root, name: "audio-input", accepted: 96000)
    for mode in ["normal", "concurrent", "publication-failure", "result-write-failure", "cancel-retry", "cancel-discard", "changed-after-cancel", "conflict", "partial", "no-camera", "audio-retry", "audio-retry-canonical", "audio-retry-receipt", "audio-retry-raw", "audio-retry-observations", "audio-retry-marker", "audio-retry-conflict-stays-terminal", "camera-error-audio-progress", "journal-replaced", "journal-replaced-before-close"] {
        let folder = root.appendingPathComponent(mode)
        let input = PrerecordedCaptureInput(source: source)
        input.probeDirectory = folder
        input.cameraBeforePrimary = false
        input.cameraFramesEnabled = mode != "no-camera"
        let hasAudio = mode.hasPrefix("audio-retry") || mode == "camera-error-audio-progress"
        if hasAudio { input.audio = audioFolder.appendingPathComponent("narration.packed.mov") }
        input.holdStop = ["concurrent", "cancel-retry", "cancel-discard", "changed-after-cancel"].contains(mode)
        func replaceCameraJournal() throws {
            let original = folder.appendingPathComponent("camera/closed-original.journal.jsonl")
            let journal = folder.appendingPathComponent("camera/capture.journal.jsonl")
            try FileManager.default.moveItem(at: journal, to: original)
            try FileManager.default.copyItem(at: original, to: journal)
        }
        if mode == "journal-replaced-before-close" { input.beforeCameraClose = { try replaceCameraJournal() } }
        input.afterCameraClose = {
            if mode == "journal-replaced" { try replaceCameraJournal() }
            if mode.hasPrefix("audio-retry") {
                try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: folder.appendingPathComponent("narration.packed.mov").path)
            }
            if mode == "publication-failure" || mode == "camera-error-audio-progress" {
                try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder.appendingPathComponent("camera").path)
            }
            if mode == "result-write-failure" {
                try FileManager.default.createDirectory(at: folder.appendingPathComponent("camera/capture-result.json"), withIntermediateDirectories: false)
            }
        }
        if mode == "partial" {
            input.beforeCameraClose = {
                let path = folder.appendingPathComponent("timestamps.jsonl")
                var rows = try String(contentsOf: path, encoding: .utf8).split(separator: "\n").map(String.init)
                let last = try rows.lastIndex {
                    let row = try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any]
                    return row["role"] as? String == "camera" && row["disposition"] as? String == "accepted"
                }!
                rows.remove(at: last)
                try Data((rows.joined(separator: "\n") + "\n").utf8).write(to: path)
            }
        }
        let capture = NativeCapture(prepareInput: { _, _ in input })
        try await capture.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"), outputDirectory: folder.path, microphone: hasAudio))
        try capture.pause()
        if mode == "conflict" || mode == "audio-retry-conflict-stays-terminal" { try Data("other camera output".utf8).write(to: folder.appendingPathComponent("camera/video.mov")) }
        let first = Task { try await capture.stop() }
        var result: CaptureResult
        if input.holdStop {
            await input.stopEntered.wait()
            if mode == "concurrent" {
                let second = Task { try await capture.stop() }
                let discarding = Task { await capture.discard() }
                await Task.yield()
                input.releaseStop.release()
                result = try await first.value
                let joined = try await second.value
                await discarding.value
                let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
                let firstBytes = try encoder.encode(result); let joinedBytes = try encoder.encode(joined)
                precondition(firstBytes == joinedBytes)
            } else {
                capture.cancelPublication()
                input.releaseStop.release()
                do { _ = try await first.value; preconditionFailure("Cancellation must retain unpublished closure") }
                catch is CancellationError {}
                precondition(input.stops == 1 && input.finalizations == 1 && capture.deviceState == "finalizing")
                try assertCameraLeaseBusy(folder)
                let rawBefore = try CaptureMediaIdentity.read(folder.appendingPathComponent("camera/camera.raw.mov"))
                if mode == "cancel-discard" {
                    await capture.discard()
                    precondition(input.stops == 1 && input.finalizations == 1 && input.discards == 0 && capture.deviceState == "idle")
                    let lease = try CaptureJournalLease(directory: folder.appendingPathComponent("camera").path)
                    lease.release()
                    let rawAfter = try CaptureMediaIdentity.read(folder.appendingPathComponent("camera/camera.raw.mov"))
                    precondition(rawBefore == rawAfter)
                    precondition(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("camera/video.mov").path))
                    try JSONSerialization.data(withJSONObject: ["physicalInputStops": input.stops,
                        "cameraClosureBoundaryCalls": input.finalizations, "inputDiscards": input.discards,
                        "finalDeviceState": capture.deviceState], options: [.sortedKeys])
                        .write(to: folder.appendingPathComponent("closure-counts.json"))
                    continue
                }
                if mode == "changed-after-cancel" {
                    let handle = try FileHandle(forWritingTo: folder.appendingPathComponent("timestamps.jsonl"))
                    try handle.seekToEnd(); try handle.write(contentsOf: Data([10])); try handle.close()
                }
                result = try await capture.stop()
                let rawAfter = try CaptureMediaIdentity.read(folder.appendingPathComponent("camera/camera.raw.mov"))
                precondition(rawBefore == rawAfter, "Retry changed closed encoder bytes")
            }
        } else if ["publication-failure", "result-write-failure", "camera-error-audio-progress"].contains(mode) || mode.hasPrefix("audio-retry") {
            do { _ = try await first.value; preconditionFailure("Filesystem publication failure must be retryable") }
            catch { precondition(CaptureFinalizationError(error).retryable, "Operational failure must retain publication authority: \(error)") }
            precondition(input.stops == 1 && input.finalizations == 1 && capture.deviceState == "finalizing")
            try assertCameraLeaseBusy(folder)
            let rawBefore = try CaptureMediaIdentity.read(folder.appendingPathComponent("camera/camera.raw.mov"))
            if mode == "camera-error-audio-progress" {
                precondition(FileManager.default.fileExists(atPath: folder.appendingPathComponent("narration.mov").path)
                    && FileManager.default.fileExists(atPath: folder.appendingPathComponent("narration.publication.json").path),
                    "Camera's operational failure must not starve primary audio publication")
            }
            if mode.hasPrefix("audio-retry") {
                precondition(FileManager.default.fileExists(atPath: folder.appendingPathComponent("camera/capture-result.json").path), "Camera must already have crossed publication before primary audio fails")
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: folder.appendingPathComponent("narration.packed.mov").path)
                if mode == "audio-retry-conflict-stays-terminal" {
                    try FileManager.default.removeItem(at: folder.appendingPathComponent("camera/video.mov"))
                }
                let member = ["audio-retry-canonical": "camera/video.mov", "audio-retry-receipt": "camera/camera.publication.json",
                    "audio-retry-raw": "camera/camera.raw.mov", "audio-retry-observations": "timestamps.jsonl", "audio-retry-marker": "camera/camera.closed.json"][mode]
                if let member {
                    let handle = try FileHandle(forWritingTo: folder.appendingPathComponent(member))
                    try handle.seekToEnd(); try handle.write(contentsOf: Data(member.hasSuffix("camera.publication.json") ? [123] : [10])); try handle.close()
                }
            } else if mode == "publication-failure" || mode == "camera-error-audio-progress" {
                try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.appendingPathComponent("camera").path)
            } else { try FileManager.default.removeItem(at: folder.appendingPathComponent("camera/capture-result.json")) }
            result = try await capture.stop()
            let rawAfter = try CaptureMediaIdentity.read(folder.appendingPathComponent("camera/camera.raw.mov"))
            if mode != "audio-retry-raw" { precondition(rawBefore == rawAfter) }
        } else { result = try await first.value }
        precondition(input.stops == 1 && input.finalizations == 1 && input.discards == 0)
        precondition(capture.deviceState == "idle" && result.cursor.sampled == 0)
        let camera = result.camera!
        precondition(camera.directory == folder.appendingPathComponent("camera").path && camera.source.kind == "probe-camera")
        precondition(camera.hostOriginUs == result.hostOriginUs && camera.pauses == result.pauses && input.finalClock?.isPaused == false)
        precondition(result.tracks.allSatisfy { $0.role == "video" || (hasAudio && $0.role == "narration") }, "Camera must not masquerade as a screen/audio track")
        let expectedFailure = mode == "audio-retry-conflict-stays-terminal" ? "PUBLICATION_CONFLICT" : mode.hasPrefix("audio-retry-") ? "INVALID_CAMERA_MAPPING" : ["conflict": "PUBLICATION_CONFLICT", "partial": "PARTIAL_CAMERA", "no-camera": "NO_CAMERA", "changed-after-cancel": "INVALID_CAMERA_MAPPING", "journal-replaced": "JOURNAL_CHANGED", "journal-replaced-before-close": "JOURNAL_CHANGED"][mode]
        precondition(result.failure?.code == expectedFailure && camera.failure?.code == expectedFailure,
            "Unexpected camera result for \(mode): \(String(describing: camera.failure))")
        if expectedFailure == nil || mode == "partial" {
            let receipt = try JSONDecoder().decode(CameraMedia.Receipt.self,
                from: Data(contentsOf: folder.appendingPathComponent("camera/camera.publication.json")))
            let currentRaw = try CaptureMediaIdentity.read(folder.appendingPathComponent("camera/camera.raw.mov"))
            let currentObservations = try CaptureMediaIdentity.read(folder.appendingPathComponent("timestamps.jsonl"))
            precondition(receipt.raw == currentRaw && receipt.observations == currentObservations)
            precondition(camera.tracks[0].samples == receipt.representedFrames && camera.tracks[0].firstSampleUs == 200000
                && camera.tracks[0].lastSampleEndUs == receipt.endUs && camera.tracks[0].heldTailUs == 0)
            if mode == "partial" {
                let rawPictures = await RecoveryFixture.decodedPresentationMicroseconds(of: folder.appendingPathComponent("camera/camera.raw.mov"))
                precondition(receipt.diagnostics == ["unmappedRawTail"] && receipt.representedFrames == rawPictures.filter { $0 >= receipt.firstUs }.count - 1)
            }
            if mode != "partial" { _ = try await assertProbePresentation(directory: folder.appendingPathComponent("camera"), observations: folder.appendingPathComponent("timestamps.jsonl")) }
            let lease = try CaptureJournalLease(directory: folder.appendingPathComponent("camera").path)
            let replay = try await CameraMedia.publish(lease: lease, observationURL: folder.appendingPathComponent("timestamps.jsonl"))
            lease.release()
            precondition(replay.canonical == receipt.canonical && replay.pictureSHA256 == receipt.pictureSHA256)
        } else { precondition(camera.tracks.isEmpty && camera.durationUs == 0) }
        if mode == "conflict" {
            let bytes = try Data(contentsOf: folder.appendingPathComponent("camera/video.mov"))
            precondition(bytes == Data("other camera output".utf8))
        }
        if mode != "no-camera" {
            let journal = try CaptureJournal.readEvidence(directory: camera.directory,
                retainTiming: true, geometry: { _ in }, samples: { _ in }, displaySpace: { _ in })
            if mode.hasPrefix("journal-replaced") {
                let rawPictures = await RecoveryFixture.decodedPresentationMicroseconds(of: folder.appendingPathComponent("camera/camera.raw.mov"))
                precondition(rawPictures.filter { $0 >= 200000 }.first == 200000, "Journal failure must not skip physical encoder closure")
                precondition(!journal.finished && journal.completion == nil)
                let moved = try Data(contentsOf: folder.appendingPathComponent("camera/closed-original.journal.jsonl"))
                let current = try Data(contentsOf: folder.appendingPathComponent("camera/capture.journal.jsonl"))
                precondition(moved == current, "Journal refusal must not append terminal evidence to either inode")
            } else {
                precondition(journal.finished && journal.completion?.state == (mode.hasPrefix("audio-retry-") && mode != "audio-retry-conflict-stays-terminal" ? "complete" : camera.state))
            }
            let rows = try String(contentsOf: folder.appendingPathComponent("camera/capture.journal.jsonl"), encoding: .utf8).split(separator: "\n")
            let finished = try rows.filter { (try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any])["event"] as? String == "finished" }
            precondition(finished.count == (mode.hasPrefix("journal-replaced") ? 0 : 1), "Retry repeated camera terminal publication")
        }
        try JSONEncoder().encode(result).write(to: folder.appendingPathComponent("native-result.json"))
        try JSONSerialization.data(withJSONObject: ["physicalInputStops": input.stops,
            "cameraClosureBoundaryCalls": input.finalizations, "inputDiscards": input.discards,
            "offeredScreenFrames": input.offeredVideoFrames, "finalDeviceState": capture.deviceState],
            options: [.sortedKeys]).write(to: folder.appendingPathComponent("closure-counts.json"))
        do { _ = try await capture.stop(); preconditionFailure("Settled capture must reject another stop") }
        catch let error as CaptureFailure { precondition(error.code == "INVALID_STATE") }
        precondition(input.stops == 1 && input.finalizations == 1)
    }
    print("PASS camera source outcomes through actual NativeCapture: single closure, concurrent stop/discard, cancellation/retry/discard, operational retry, pinned input refusal, positive start, partial prefix, conflict, missing frames and terminal pause")
}

private func assertCameraLeaseBusy(_ folder: URL) throws {
    do { _ = try CaptureJournalLease(directory: folder.appendingPathComponent("camera").path); preconditionFailure("Pending publication released camera lease") }
    catch let failure as CaptureFailure { precondition(failure.code == "CAPTURE_BUSY") }
}
