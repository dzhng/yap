@preconcurrency import AVFoundation
import Foundation
import Darwin
@testable import YapCapture
import YapMedia

func runCameraCheckpointSchedulingTest() {
    let url = URL(fileURLWithPath: "/unused-camera-observations")
    let earlier = CameraMedia.Verification.Checkpoint(observations: url, bytes: 10, frames: 1)
    let later = CameraMedia.Verification.Checkpoint(observations: url, bytes: 20, frames: 2)
    let selected = CameraMedia.Verification.newest(later, earlier)
    precondition(selected.bytes == 20 && selected.frames == 2 && selected.observations == url,
        "A stale filesystem wakeup cannot replace the newest written checkpoint.")
    print("PASS latest camera checkpoint survives a stale wakeup")
}

func runCameraReaderAuthorityTest() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("yap-camera-reader-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: root) }
    let camera = root.appendingPathComponent("camera")
    try FileManager.default.createDirectory(at: camera, withIntermediateDirectories: false)
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("fixtures/camera-visible32.mov")
    let readers = try CameraReaderStarts(directory: camera)
    defer { readers.restore() }
    for url in [root.appendingPathComponent("camera.raw.mov"), camera.appendingPathComponent("camera.raw.mov"), camera.appendingPathComponent("camera.mov")] {
        try FileManager.default.copyItem(at: fixture, to: url)
        let source = try MediaInput(url: url, purpose: .streaming)
        let track = try await source.asset.loadTracks(withMediaType: .video).first!
        let reader = try AVAssetReader(asset: source.asset)
        let output = AVAssetReaderTrackOutput(track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        guard reader.startReading(), output.copyNextSampleBuffer() != nil else {
            throw CaptureFailure("READER_AUTHORITY_MISSING", "Held source must decode an actual camera picture.")
        }
        reader.cancelReading()
    }
    try readers.checkLog()
    let observedSources = readers.readings.map {
        [$0.role, URL(fileURLWithPath: $0.url).resolvingSymlinksInPath().path]
    }
    guard readers.observed["raw"] == 1, readers.observed["canonical"] == 1,
        observedSources == [
            ["raw", camera.appendingPathComponent("camera.raw.mov").resolvingSymlinksInPath().path],
            ["canonical", camera.appendingPathComponent("camera.mov").resolvingSymlinksInPath().path],
        ] else {
        throw CaptureFailure("READER_AUTHORITY_MISSING", "Reader observation must retain exact held-source scope and role.")
    }
    print("PASS camera reader observation follows held authority and excludes another source")
}

/// The device boundary is offline; NativeCapture owns real encoding, closure and publication.
@MainActor
func runCameraLivePublicationTests(output: String? = nil) async throws {
    runCameraCheckpointSchedulingTest()
    try await runCameraReaderAuthorityTest()
    let root = output.map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        .appendingPathComponent("yap-camera-live-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    defer { if output == nil { try? FileManager.default.removeItem(at: root) } }
    try await runCameraLivePublicationTest(output: root.appendingPathComponent("identity").path)
    try await runCameraLivePublicationTest(output: root.appendingPathComponent("delayed").path, firstCameraAfterPrimary: true)
    try await runCameraLivePublicationTest(output: root.appendingPathComponent("retry").path, changedCandidateRetry: true)
    try await runCameraLivePublicationTest(output: root.appendingPathComponent("discard").path, discardBeforeStop: true)
    try await runCameraLivePublicationTest(output: root.appendingPathComponent("terminal").path, invalidClosedMarker: true)
    try await runCameraStableMediaTest(output: root.appendingPathComponent("stable").path)
}

/// Waits until `done` holds or active camera verification stops progressing.
///
/// Verification decodes every picture, so its duration follows machine load, not
/// the authored take. Progress is what the worker observably does: a snapshot
/// scratch in flight, a reader start, or a changed raw or candidate file. Only an
/// idle window with none of these ends the wait unsatisfied; `hangLimit` only
/// stops a hung worker and is not a latency contract.
@MainActor
private func awaitCameraVerification(camera: URL, readers: CameraReaderStarts,
    until done: () throws -> Bool = { false }) async throws {
    let idleWindow = Duration.seconds(2), hangLimit = Duration.seconds(120)
    func signature() throws -> [String] {
        let names = try FileManager.default.contentsOfDirectory(atPath: camera.path)
        var media: [String] = []
        for name in names.sorted() where name == "camera.raw.mov" || name.hasPrefix(".yap-output-") {
            let path = name == "camera.raw.mov" ? camera.appendingPathComponent(name).path
                : camera.appendingPathComponent(name).appendingPathComponent("camera.mov").path
            var info = stat()
            if lstat(path, &info) == 0 {
                media.append("\(name):\(info.st_size):\(info.st_mtimespec.tv_sec):\(info.st_mtimespec.tv_nsec)")
            }
        }
        return names.filter { $0.hasPrefix(".camera-snapshot-") }.sorted() + media
            + readers.observed.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
    }
    let started = ContinuousClock.now
    var last = try signature(), idleSince = ContinuousClock.now
    while try !done() {
        let current = try signature()
        let working = current.contains { $0.hasPrefix(".camera-snapshot-") }
        if working || current != last { last = current; idleSince = .now }
        else if idleSince.duration(to: .now) >= idleWindow { return }
        guard started.duration(to: .now) < hangLimit else {
            throw CaptureFailure("LIVE_VERIFICATION_HUNG", "Camera verification kept working without settling.")
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}

@MainActor
func runCameraStableMediaTest(output: String) async throws {
    try await runCameraLivePublicationTest(output: output, stableMediaCallbacks: true)
}

@MainActor
private func runCameraLivePublicationTest(output: String, firstCameraAfterPrimary: Bool = false,
    changedCandidateRetry: Bool = false, discardBeforeStop: Bool = false,
    invalidClosedMarker: Bool = false, stableMediaCallbacks: Bool = false) async throws {
    let root = URL(fileURLWithPath: output)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("fixtures/camera-visible32.mov")
    let input = PrerecordedCaptureInput(source: fixture, size: CGSize(width: 32, height: 16))
    input.cameraPrologueEnabled = !firstCameraAfterPrimary
    input.probeDirectory = root
    let capture = NativeCapture(prepareInput: { _, _ in input })
    let camera = root.appendingPathComponent("camera")
    let readers = try CameraReaderStarts(directory: camera, blockPublication: changedCandidateRetry)
    defer { _ = chmod(camera.path, 0o700); readers.restore() }
    do {
        try await capture.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: root.appendingPathComponent("screen").path))
        let sample = input.finalCameraSample!
        let ingress = input.probe!
        // Preserve the source image; only explicit callback clocks extend the authored take.
        for at in stride(from: Int64(300_000), through: 7_300_000, by: 33_333) {
            let next = try captureFixtureRetimed(sample,
                at: time(microseconds: input.fixtureOrigin! + at))
            ingress.writer.queue.sync { _ = ingress.accept(next, role: .camera, from: CMClockGetHostTimeClock()) }
            try await Task.sleep(for: .milliseconds(5))
        }
        input.finalCameraSample = nil
        func candidates() throws -> [String] {
            try FileManager.default.contentsOfDirectory(atPath: camera.path)
                .filter { $0.hasPrefix(".yap-output-") }
                .map { camera.appendingPathComponent($0).appendingPathComponent("camera.mov").path }
                .filter { FileManager.default.fileExists(atPath: $0) }
        }
        try await awaitCameraVerification(camera: camera, readers: readers) {
            try !candidates().isEmpty && readers.observed["canonical", default: 0] > 0
        }
        let activeCandidates = try candidates()
        let proof: [String: Any] = ["deviceState": capture.deviceState,
            "privateCandidates": activeCandidates, "readerStarts": readers.observed,
            "publicCanonicalExists": FileManager.default.fileExists(atPath: camera.appendingPathComponent("video.mov").path)]
        try JSONSerialization.data(withJSONObject: proof, options: [.sortedKeys, .prettyPrinted])
            .write(to: root.appendingPathComponent("before-stop.json"))
        var before = stat()
        if let candidate = activeCandidates.first, lstat(candidate, &before) == 0,
            before.st_size <= 2_097_152 {
            try FileManager.default.copyItem(atPath: candidate,
                toPath: root.appendingPathComponent("unverified-before-stop.mov").path)
        }
        for source in [camera.appendingPathComponent("camera.raw.mov"), root.appendingPathComponent("timestamps.jsonl")] {
            if FileManager.default.fileExists(atPath: source.path),
                let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 2_097_152 {
                try FileManager.default.copyItem(at: source, to: root.appendingPathComponent("before-stop-" + source.lastPathComponent))
            }
        }
        try readers.checkLog()
        guard capture.deviceState == "recording", activeCandidates.count == 1,
            readers.observed["raw", default: 0] > 0, readers.observed["canonical", default: 0] > 0,
            !FileManager.default.fileExists(atPath: camera.appendingPathComponent("video.mov").path) else {
            throw CaptureFailure("LIVE_VERIFICATION_MISSING", "Camera has no distinct private canonical work before stop.")
        }
        if stableMediaCallbacks {
            func version(_ path: String) throws -> [Int64] {
                var info = stat()
                guard lstat(path, &info) == 0 else { throw CaptureFailure("MISSING_MEDIA", "Cannot observe camera version.") }
                return [Int64(info.st_size), Int64(info.st_mtimespec.tv_sec), Int64(info.st_mtimespec.tv_nsec)]
            }
            let raw = camera.appendingPathComponent("camera.raw.mov").path
            let versions = try [version(raw), version(activeCandidates[0])]
            let observations = root.appendingPathComponent("timestamps.jsonl")
            let mapping = try CameraMedia.Mapping(observations)
            while try mapping.next() != nil {}
            let bytes = Int64(try observations.resourceValues(forKeys: [.fileSizeKey]).fileSize!)
            func wake() {
                ingress.writer.queue.sync {
                    ingress.companion!.recorded(observations: observations, bytes: bytes, frames: mapping.frames)
                }
            }
            // Catch up the latest written mapping once; subsequent identical wakeups have no new operands.
            wake()
            try await awaitCameraVerification(camera: camera, readers: readers)
            let settled = try [version(raw), version(activeCandidates[0])]
            let snapshots = readers.observed["snapshots", default: 0]
            for _ in 0..<3 { wake(); try await Task.sleep(for: .milliseconds(20)) }
            try await awaitCameraVerification(camera: camera, readers: readers)
            let after = try [version(raw), version(activeCandidates[0])]
            let created = readers.observed["snapshots", default: 0] - snapshots
            try JSONSerialization.data(withJSONObject: ["before": versions, "settled": settled,
                "after": after, "mappingBytes": bytes, "mappingFrames": mapping.frames,
                "snapshotCreations": created], options: [.prettyPrinted, .sortedKeys])
                .write(to: root.appendingPathComponent("stable-media.json"))
            guard settled == after else { throw CaptureFailure("MEDIA_NOT_STABLE", "No-op window requires unchanged media operands.") }
            guard created == 0 else { throw CaptureFailure("REPEATED_CAMERA_SNAPSHOT", "Same written checkpoint caused \(created) unnecessary snapshots.") }

        }
        if discardBeforeStop {
            await capture.discard()
            guard capture.deviceState == "idle", try candidates().isEmpty,
                !FileManager.default.fileExists(atPath: camera.appendingPathComponent("video.mov").path) else {
                throw CaptureFailure("LIVE_DISCARD_FAILED", "Discard must join active work and remove its private candidate.")
            }
            let released = try CaptureJournalLease(directory: camera.path)
            released.release()
            print("PASS live camera discard removes candidate before journal lease release")
            return
        }
        if changedCandidateRetry {
            do { _ = try await capture.stop(); throw CaptureFailure("RETRY_FAULT_MISSING", "Receipt publication unexpectedly succeeded.") }
            catch {
                _ = chmod(camera.path, 0o700)
                guard readers.observed["blocked"] == 1, CaptureFinalizationError(error).retryable,
                    !FileManager.default.fileExists(atPath: camera.appendingPathComponent("camera.publication.json").path) else { throw error }
                try Data(String(describing: error).utf8).write(to: root.appendingPathComponent("first-stop-error.txt"))
            }
            let file = try FileHandle(forWritingTo: URL(fileURLWithPath: activeCandidates[0]))
            try file.seekToEnd(); try file.write(contentsOf: Data([0])); try file.close()
        }
        if invalidClosedMarker {
            try Data("invalid closed marker".utf8).write(to: camera.appendingPathComponent("camera.closed.json"))
        }
        let result = try await capture.stop()
        try JSONEncoder().encode(result).write(to: root.appendingPathComponent("stop-result.json"))
        if invalidClosedMarker {
            guard result.camera?.failure?.code == "INVALID_CAMERA_MAPPING", try candidates().isEmpty,
                !FileManager.default.fileExists(atPath: camera.appendingPathComponent("video.mov").path) else {
                throw CaptureFailure("LIVE_TERMINAL_CLEANUP_FAILED", "Terminal marker refusal must remove unfinished work.")
            }
            let released = try CaptureJournalLease(directory: camera.path)
            released.release()
            print("PASS terminal camera refusal removes unused work before journal lease release")
            return
        }
        let observations = try Data(contentsOf: root.appendingPathComponent("timestamps.jsonl"))
        let retained = try Data(contentsOf: camera.appendingPathComponent(CameraMedia.mappingFile))
        precondition(observations.count > 65536 && retained == observations,
            "Publication must retain every byte across observation read chunks.")
        var published = stat()
        guard lstat(camera.appendingPathComponent("video.mov").path, &published) == 0 else {
            throw CaptureFailure("LIVE_PUBLICATION_MISSING", "Canonical publication is missing.")
        }
        let sameCandidate = before.st_dev == published.st_dev && before.st_ino == published.st_ino
        guard sameCandidate != changedCandidateRetry else {
            throw CaptureFailure("LIVE_PUBLICATION_IDENTITY", changedCandidateRetry
                ? "A changed candidate cannot reuse cached verification."
                : "Publication must finish the same actively verified private candidate.")
        }
        guard let cameraResult = result.camera, cameraResult.state == "complete",
            cameraResult.tracks.count == 1, cameraResult.tracks[0].samples > 200 else {
            throw CaptureFailure("LIVE_PUBLICATION_FAILED", "Camera did not publish the complete authored take.")
        }
        let receiptURL = camera.appendingPathComponent("camera.publication.json")
        let receipt = try JSONDecoder().decode(CameraMedia.Receipt.self, from: Data(contentsOf: receiptURL))
        precondition(receipt.representedFrames == cameraResult.tracks[0].samples && receipt.diagnostics.isEmpty)
        precondition(receipt.firstUs == (firstCameraAfterPrimary ? 200000 : 0),
            "A delayed camera must retain its absolute source clock and initial empty support.")
        let lease = try CaptureJournalLease(directory: camera.path)
        defer { lease.release() }
        let verified = try await CameraMedia.readPublished(lease: lease, canonical: camera.appendingPathComponent("video.mov"))
        precondition(verified.identity.availability.support == receipt.support
            && verified.identity.representedFrames == receipt.representedFrames && verified.diagnostics.isEmpty)
        print("PASS active private camera work and exact final publication through NativeCapture")
    } catch {
        await capture.discard()
        throw error
    }
}
