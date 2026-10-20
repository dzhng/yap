@preconcurrency import AVFoundation
import CryptoKit
import Foundation
@testable import YapCapture
import YapFrames
import YapMedia
import YapWire

/// A companion camera turned off and on during a take publishes real gaps: the canonical movie
/// shows nothing across off time, and a single-run take keeps today's receipt and mapping shape.
@MainActor
func runCameraAvailabilityTests(output: String? = nil) async throws {
    let root = output.map { URL(fileURLWithPath: $0) } ?? RecoveryFixture.directory("camera-availability")
    if output != nil { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false) }
    defer { if output == nil { try? FileManager.default.removeItem(at: root) } }
    let source = root.appendingPathComponent("input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: source,
        timesUs: [0, 50000, 100000, 150000], endUs: 200000)
    let pictures = try await availabilityPictures(source)
    try runLimit()
    try await singleRunKeepsRelease0133Shape(root: root, pictures: pictures)
    try await startsOffThenOn(root: root, pictures: pictures)
    try await onOffOn(root: root, pictures: pictures)
    try await offAndPause(root: root, pictures: pictures)
    try await lateCallbackAfterOff(root: root, pictures: pictures)
    try await staleBufferAfterOn(root: root, pictures: pictures)
    try await emptyRun(root: root, pictures: pictures)
    try await malformedGapsRefused(root.appendingPathComponent("on-off-on"))
    try await crashRecoveryWithGaps(root: root, pictures: pictures)
    try await manyGaps(root: root, pictures: pictures, output: output.map { URL(fileURLWithPath: $0) })
}

// MARK: Cases

/// Toggle count has no relationship to recorded duration; retain every disjoint interval.
private func runLimit() throws {
    let runs = (0..<1001).map { ExactRange(startUs: Int64($0) * 10, endUs: Int64($0) * 10 + 5) }
    let availability = try CameraAvailability(intervals: runs)
    precondition(availability.gaps.count == 1000 && availability.support.endUs == runs.last!.endUs)
}

/// Receipt and mapping key sets of a camera take published by release 0.1.33, before cameras
/// could be turned off: the receipt and mapping in corpus A
/// (specs/done/camera-toggle/assets/pre-toggle-corpus/a.tar.gz) and those `YAP_CAMERA_CLOCK_OUTPUT`
/// wrote at commit 63f9f25c. A camera never turned off must still publish exactly these.
private let release0133ReceiptKeys: Set<String> = ["binding", "candidate", "canonical", "closed", "diagnostics",
    "endUs", "firstUs", "journal", "observations", "originHostUs", "pictureSHA256", "pictureTimeScale",
    "presentation", "raw", "representedFrames", "support"]
private let release0133NestedKeys: [String: Set<String>] = ["binding": ["deviceId", "recordingId", "sourceId"],
    "canonical": ["bytes", "sha256"], "closed": ["bytes", "sha256"], "journal": ["bytes", "sha256"],
    "observations": ["bytes", "sha256"], "raw": ["bytes", "sha256"], "support": ["endUs", "startUs"]]
private let release0133CameraFrameKeys: Set<String> = ["end", "ordinal", "start"]

@MainActor
private func singleRunKeepsRelease0133Shape(root: URL, pictures: [CMSampleBuffer]) async throws {
    let take = try GatedCameraTake(root: root, name: "single-run", pictures: pictures)
    for index in 0..<4 { take.expect("accepted", try await take.offer(1_000_000 + Int64(index) * 50000)) }
    let published = try await take.publish()
    let receipt = try take.receiptJSON()
    precondition(Set(receipt.keys) == release0133ReceiptKeys, "Single-run receipt keys changed: \(receipt.keys.sorted())")
    for (key, nested) in release0133NestedKeys {
        precondition(Set((receipt[key] as! [String: Any]).keys) == nested, "Single-run receipt \(key) shape changed")
    }
    for frame in try take.mappingFrames() {
        precondition(Set(frame.keys) == release0133CameraFrameKeys, "Single-run mapping row gained a key: \(frame.keys.sorted())")
    }
    precondition(published.receipt.support == ExactRange(startUs: 0, endUs: 200000))
    print("PASS single-run take keeps the 0.1.33 receipt and mapping shape")
}

@MainActor
private func startsOffThenOn(root: URL, pictures: [CMSampleBuffer]) async throws {
    var clock = CaptureClock()
    precondition(clock.start(at: 1_000_000))
    let take = try GatedCameraTake(root: root, name: "starts-off", pictures: pictures, clock: clock)
    take.setCamera(false, at: 1_000_000)
    take.expect("camera-off", try await take.offer(1_100_000))
    take.setCamera(true, at: 1_500_000)
    for index in 0..<3 { take.expect("accepted", try await take.offer(1_500_000 + Int64(index) * 50000)) }
    let published = try await take.publish()
    precondition(published.receipt.support == ExactRange(startUs: 500000, endUs: 650000) && published.receipt.gaps == nil)
    let receiptJSON = try take.receiptJSON(), frames = try take.mappingFrames()
    precondition(receiptJSON["gaps"] == nil && frames.allSatisfy { $0["run"] == nil })
    let segments = try await canonicalSegments(take.canonical)
    precondition(segments == [.empty(0, 500000), .occupied(500000, 650000)], "Unexpected canonical segments \(segments)")
    print("PASS a take that starts with the camera off publishes one run after a leading empty edit")
}

@MainActor
private func onOffOn(root: URL, pictures: [CMSampleBuffer]) async throws {
    var clock = CaptureClock()
    precondition(clock.start(at: 1_000_000))
    let take = try GatedCameraTake(root: root, name: "on-off-on", pictures: pictures, clock: clock)
    for index in 0..<3 { take.expect("accepted", try await take.offer(1_100_000 + Int64(index) * 50000)) }
    take.setCamera(false, at: 1_250_000)
    take.expect("camera-off", try await take.offer(1_300_000))
    take.setCamera(true, at: 1_600_000)
    for index in 0..<2 { take.expect("accepted", try await take.offer(1_600_000 + Int64(index) * 50000)) }
    let published = try await take.publish()
    precondition(published.receipt.support == ExactRange(startUs: 100000, endUs: 700000)
        && published.receipt.gaps == [ExactRange(startUs: 250000, endUs: 600000)], "Unexpected receipt \(published.receipt)")
    let runs = try take.mappingFrames().map { $0["run"] as? Int }
    precondition(runs == [nil, nil, nil, 1, 1], "Unexpected runs \(runs)")
    let segments = try await canonicalSegments(take.canonical)
    precondition(segments == [.empty(0, 100000), .occupied(100000, 250000), .empty(250000, 600000), .occupied(600000, 700000)],
        "Unexpected canonical segments \(segments)")
    let keyFrames = try await keyFrameStartsUs(take.raw)
    precondition(keyFrames.isSuperset(of: [100000, 600000]), "Every run must start on a key frame: \(keyFrames.sorted())")
    try await assertPresentation(take, pictureStartsUs: [100000, 150000, 200000, 600000, 650000],
        gaps: [0..<100000, 250000..<600000], endUs: 700000)
    print("PASS on-off-on publishes two intervals with an explicit empty edit and no picture in the gap")
}

/// Off time inside a pause is not source time: gaps are measured with paused time removed, and
/// a turn-off and turn-on within one pause leave no gap at all.
@MainActor
private func offAndPause(root: URL, pictures: [CMSampleBuffer]) async throws {
    enum Step { case off(Int64), on(Int64), pause(Int64), resume(Int64) }
    // The second run's source start is its host time minus the paused time before it.
    let cases: [(name: String, steps: [Step], secondRunHostUs: Int64, secondRunUs: Int64, gaps: [Range<Int64>])] = [
        ("off-during-pause", [.pause(1_100_000), .off(1_200_000), .resume(1_300_000), .on(1_400_000)],
            1_400_000, 200000, [100000..<200000]),
        ("pause-during-off", [.off(1_100_000), .pause(1_200_000), .resume(1_300_000), .on(1_500_000)],
            1_500_000, 400000, [100000..<400000]),
        ("off-and-on-within-pause", [.pause(1_100_000), .off(1_150_000), .on(1_250_000), .resume(1_300_000)],
            1_300_000, 100000, []),
    ]
    for test in cases {
        var clock = CaptureClock()
        precondition(clock.start(at: 1_000_000))
        let take = try GatedCameraTake(root: root, name: test.name, pictures: pictures, clock: clock)
        for index in 0..<2 { take.expect("accepted", try await take.offer(1_000_000 + Int64(index) * 50000)) }
        for step in test.steps {
            switch step {
            case .off(let at): take.setCamera(false, at: at)
            case .on(let at): take.setCamera(true, at: at)
            case .pause(let at): take.clock.pause(at: at)
            case .resume(let at): take.clock.resume(at: at)
            }
        }
        for index in 0..<2 { take.expect("accepted", try await take.offer(test.secondRunHostUs + Int64(index) * 50000)) }
        let published = try await take.publish()
        let endUs = test.secondRunUs + 100000
        let gaps = test.gaps.map { ExactRange(startUs: $0.lowerBound, endUs: $0.upperBound) }
        precondition(published.receipt.support == ExactRange(startUs: 0, endUs: endUs)
            && published.receipt.gaps == (gaps.isEmpty ? nil : gaps), "\(test.name): unexpected receipt \(published.receipt)")
        try await assertPresentation(take, pictureStartsUs: [0, 50000, test.secondRunUs, test.secondRunUs + 50000],
            gaps: test.gaps, endUs: endUs)
    }
    print("PASS gaps are measured in pause-removed source time; off and on within one pause merge")
}

@MainActor
private func lateCallbackAfterOff(root: URL, pictures: [CMSampleBuffer]) async throws {
    var clock = CaptureClock()
    precondition(clock.start(at: 1_000_000))
    let take = try GatedCameraTake(root: root, name: "late-callback", pictures: pictures, clock: clock)
    for index in 0..<2 { take.expect("accepted", try await take.offer(1_000_000 + Int64(index) * 50000)) }
    take.setCamera(false, at: 1_120_000)
    take.expect("camera-off", try await take.offer(1_100_000))
    take.expect("accepted", try await take.offer(1_100_000, durationUs: 20000))
    take.setCamera(true, at: 1_300_000)
    take.expect("accepted", try await take.offer(1_300_000))
    let published = try await take.publish()
    precondition(published.receipt.gaps == [ExactRange(startUs: 120000, endUs: 300000)], "Unexpected receipt \(published.receipt)")
    print("PASS a callback still showing at the turn-off is refused; one acquired before it is kept")
}

@MainActor
private func staleBufferAfterOn(root: URL, pictures: [CMSampleBuffer]) async throws {
    var clock = CaptureClock()
    precondition(clock.start(at: 1_000_000))
    let take = try GatedCameraTake(root: root, name: "stale-buffer", pictures: pictures, clock: clock)
    take.expect("accepted", try await take.offer(1_000_000))
    take.setCamera(false, at: 1_050_000)
    take.setCamera(true, at: 1_300_000)
    take.expect("camera-off", try await take.offer(1_250_000))
    take.expect("accepted", try await take.offer(1_300_000))
    let published = try await take.publish()
    precondition(published.receipt.gaps == [ExactRange(startUs: 50000, endUs: 300000)], "Unexpected receipt \(published.receipt)")
    print("PASS a buffer acquired before the turn-on is refused")
}

@MainActor
private func emptyRun(root: URL, pictures: [CMSampleBuffer]) async throws {
    var clock = CaptureClock()
    precondition(clock.start(at: 1_000_000))
    let take = try GatedCameraTake(root: root, name: "empty-run", pictures: pictures, clock: clock)
    for index in 0..<2 { take.expect("accepted", try await take.offer(1_000_000 + Int64(index) * 50000)) }
    take.setCamera(false, at: 1_100_000)
    take.setCamera(true, at: 1_200_000)
    take.setCamera(false, at: 1_300_000)
    take.setCamera(true, at: 1_400_000)
    for index in 0..<2 { take.expect("accepted", try await take.offer(1_400_000 + Int64(index) * 50000)) }
    let published = try await take.publish()
    let runs = try take.mappingFrames().map { $0["run"] as? Int }
    precondition(runs == [nil, nil, 1, 1], "An empty run must not advance the run: \(runs)")
    precondition(published.receipt.gaps == [ExactRange(startUs: 100000, endUs: 400000)], "Unexpected receipt \(published.receipt)")
    print("PASS a turn-on and turn-off with no frames adds no interval and no run")
}

/// A receipt states gaps only in their one canonical form, and only where the canonical edits and
/// the mapping's runs both put them.
private func malformedGapsRefused(_ directory: URL) async throws {
    let receiptURL = directory.appendingPathComponent("camera.publication.json")
    let mappingURL = directory.appendingPathComponent(CameraMedia.mappingFile)
    let original = try Data(contentsOf: receiptURL), originalMapping = try Data(contentsOf: mappingURL)
    func gaps(_ ranges: [[Int64]]) -> [[String: Int64]] { ranges.map { ["startUs": $0[0], "endUs": $0[1]] } }
    // The same take with every run boundary erased from its mapping.
    let unjustified = Data(try String(decoding: originalMapping, as: UTF8.self).split(separator: "\n").map { line -> String in
        var row = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        if var frame = row["cameraFrame"] as? [String: Any] { frame["run"] = nil; row["cameraFrame"] = frame }
        return String(decoding: try JSONSerialization.data(withJSONObject: row), as: UTF8.self)
    }.joined(separator: "\n").appending("\n").utf8)
    let unjustifiedIdentity = try JSONSerialization.jsonObject(with: JSONEncoder().encode(CaptureMediaIdentity(
        bytes: Int64(unjustified.count), sha256: SHA256.hash(data: unjustified).map { String(format: "%02x", $0) }.joined())))
    let mutations: [(name: String, reason: String, mapping: Data?, edit: (inout [String: Any]) -> Void)] = [
        ("overlapping", "malformed", nil, { $0["gaps"] = gaps([[250000, 600000], [500000, 650000]]) }),
        ("out-of-span", "malformed", nil, { $0["gaps"] = gaps([[250000, 600000], [650000, 800000]]) }),
        ("adjacent", "malformed", nil, { $0["gaps"] = gaps([[250000, 400000], [400000, 600000]]) }),
        ("empty", "omitted", nil, { $0["gaps"] = [[String: Int64]]() }),
        ("stripped", "differs from publication", nil, { $0["gaps"] = nil }),
        ("unjustified-by-runs", "mapped runs", unjustified, { $0["observations"] = unjustifiedIdentity }),
    ]
    for mutation in mutations {
        var receipt = try JSONSerialization.jsonObject(with: original) as! [String: Any]
        mutation.edit(&receipt)
        try JSONSerialization.data(withJSONObject: receipt).write(to: receiptURL)
        if let mapping = mutation.mapping { try mapping.write(to: mappingURL) }
        let lease = try CaptureJournalLease(directory: directory.path)
        defer { lease.release() }
        do {
            _ = try await CameraMedia.readPublished(lease: lease, canonical: directory.appendingPathComponent("video.mov"))
            preconditionFailure("\(mutation.name) gaps were admitted")
        } catch let failure as CaptureFailure {
            precondition(failure.code == "INVALID_CAMERA_MAPPING" && failure.message.contains(mutation.reason),
                "\(mutation.name) refused for another reason: \(failure.code) \(failure.message)")
        }
        try original.write(to: receiptURL); try originalMapping.write(to: mappingURL)
    }
    let lease = try CaptureJournalLease(directory: directory.path)
    defer { lease.release() }
    _ = try await CameraMedia.readPublished(lease: lease, canonical: directory.appendingPathComponent("video.mov"))
    print("PASS overlapping, out-of-span, adjacent, empty, stripped and run-unjustified gaps are refused")
}

/// A process crash leaves the raw movie's fragmented prefix. Recovery republishes it with the gaps
/// the mapping's runs place inside that prefix; the last run's unfragmented tail is lost.
@MainActor
private func crashRecoveryWithGaps(root: URL, pictures: [CMSampleBuffer]) async throws {
    var clock = CaptureClock()
    precondition(clock.start(at: 1_000_000))
    let take = try GatedCameraTake(root: root, name: "crash-live", pictures: pictures, clock: clock)
    func run(from startUs: Int64, frames: Int) async throws {
        for index in 0..<frames { take.expect("accepted", try await take.offer(startUs + Int64(index) * 100_000, durationUs: 100_000)) }
    }
    try await run(from: 1_000_000, frames: 5)
    take.setCamera(false, at: 1_500_000); take.setCamera(true, at: 2_000_000)
    try await run(from: 2_000_000, frames: 10)
    take.setCamera(false, at: 3_000_000); take.setCamera(true, at: 3_500_000)
    // The writer cuts fragments on its own schedule, and only while pictures keep arriving. Keep
    // the third run going and copy the take the way a crashed process leaves it once a fragment
    // holds third-run pictures; the pictures after that fragment are the lost tail.
    let crashed = root.appendingPathComponent("crash-recovered")
    let members = ["camera.raw.mov", "capture.journal.jsonl", CameraMedia.mappingFile]
    var offeredEndUs: Int64 = 3_500_000
    var reachedThirdRun = false
    while !reachedThirdRun && offeredEndUs < 60_000_000 {
        try await run(from: offeredEndUs, frames: 10)
        offeredEndUs += 1_000_000
        try? FileManager.default.removeItem(at: crashed)
        try FileManager.default.createDirectory(at: crashed, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        for member in members {
            try FileManager.default.copyItem(at: take.directory.appendingPathComponent(member), to: crashed.appendingPathComponent(member))
        }
        reachedThirdRun = await RecoveryFixture.decodedPresentationMicroseconds(of: crashed.appendingPathComponent("camera.raw.mov"))
            .contains { $0 >= 2_600_000 }
    }
    precondition(reachedThirdRun, "No raw fragment reached the third run")
    await take.closeUnpublished()
    let authority = CaptureRecoveryAuthority(kind: .camera, sourceId: take.binding.sourceId, binding: take.binding)
    let recovered = try await MediaRecovery.recover(directory: crashed.path, sourceAuthority: authority)
    let video = recovered.tracks.first { $0.role == "video" }!
    let bounds = RecoveryFixture.bounds(video.intervals)
    precondition(bounds.count == 3 && bounds[0] == [0, 500000] && bounds[1] == [1_000_000, 2_000_000]
        && bounds[2][0] == 2_500_000 && bounds[2][1] > 2_600_000 && bounds[2][1] < offeredEndUs - 1_000_000, "Unexpected recovered intervals \(bounds)")
    precondition(video.failure?.code == "PARTIAL_CAMERA" && recovered.durationUs == bounds[2][1])
    guard case .published(let source) = recovered.sourcePublication else { preconditionFailure("Recovered camera source was not published") }
    precondition(source.sourceDurationUs == bounds[2][1])
    let again = try await MediaRecovery.recover(directory: crashed.path, sourceAuthority: authority)
    guard case .published(let stored) = again.sourcePublication else { preconditionFailure("Stored source authority was refused") }
    precondition(RecoveryFixture.bounds(again.tracks.first { $0.role == "video" }!.intervals) == bounds
        && stored.sourceDurationUs == source.sourceDurationUs, "Multi-interval source authority must round-trip")
    print("PASS crash recovery republishes \(bounds) with its gaps; the last run's unfragmented tail is lost")
}

/// Stop latency is the camera's share of Stop: closing the encoder and publishing a verified
/// canonical movie with one empty edit per gap. The runs begin 1,000 s into the take, so every
/// receipt time has the ten digits of a long take and the receipt is as large as a real one.
@MainActor
private func manyGaps(root: URL, pictures: [CMSampleBuffer], output: URL?) async throws {
    var clock = CaptureClock()
    precondition(clock.start(at: 1_000_000))
    let take = try GatedCameraTake(root: root, name: "many-gaps", pictures: pictures, clock: clock)
    let runs = 502, firstUs: Int64 = 1_000_000_000
    for run in 0..<runs {
        let at = 1_000_000 + firstUs + Int64(run) * 200_000
        if run > 0 { take.setCamera(true, at: at) }
        take.expect("accepted", try await take.offer(at, durationUs: 33_333))
        take.expect("accepted", try await take.offer(at + 33_333, durationUs: 33_333))
        take.setCamera(false, at: at + 100_000)
    }
    let started = ContinuousClock.now
    let published = try await take.publish()
    let elapsed = ContinuousClock.now - started
    precondition(published.receipt.gaps?.count == runs - 1 && published.receipt.representedFrames == runs * 2)
    precondition(published.receipt.support == ExactRange(startUs: firstUs, endUs: firstUs + Int64(runs - 1) * 200_000 + 66_666))
    let segments = try await canonicalSegments(take.canonical)
    precondition(segments.first == .empty(0, firstUs), "A camera first seen late starts with an empty edit")
    precondition(segments.dropFirst().filter { if case .empty = $0 { true } else { false } }.count == runs - 1)
    let milliseconds = elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000
    if let output {
        try JSONSerialization.data(withJSONObject: ["runs": runs, "frames": runs * 2, "stopLatencyMs": milliseconds],
            options: [.sortedKeys]).write(to: output.appendingPathComponent("many-gaps-stop-latency.json"))
    }
    print("PASS \(runs) runs publish \(runs - 1) gaps; camera Stop latency \(milliseconds) ms")
}

/// Walks the canonical movie through the production presentation reader: no picture in a gap,
/// and every presented picture is the raw picture acquired at that time, pixel for pixel.
private func assertPresentation(_ take: GatedCameraTake, pictureStartsUs: [Int64], gaps: [Range<Int64>], endUs: Int64) async throws {
    let raw = try await decodedPixels(take.raw)
    let presentation = try await PresentationSource(source: take.canonical, streamId: nil, startUs: 0)
    var shown: Set<Int64> = []
    for at in stride(from: Int64(0), to: endUs, by: 5000) {
        let selection = try presentation.selection(at: time(microseconds: at), end: .positiveInfinity)
        if gaps.contains(where: { $0.contains(at) }) {
            precondition(selection.buffer == nil && selection.sampleTime == nil, "A picture was presented at \(at)us inside a gap")
            continue
        }
        guard let sampleTime = selection.sampleTime, let buffer = selection.buffer else { preconditionFailure("No picture at \(at)us") }
        let start = microseconds(sampleTime)
        precondition(start == pictureStartsUs.last { $0 <= at }, "Picture at \(at)us starts at \(start)us")
        precondition(pixels(buffer) == raw[start], "Canonical pixels at \(start)us differ from raw")
        shown.insert(start)
    }
    precondition(shown == Set(pictureStartsUs), "Presented pictures \(shown.sorted()) differ from accepted pictures")
}

private func keyFrameStartsUs(_ url: URL) async throws -> Set<Int64> {
    let track = await RecoveryFixture.videoTrack(of: url)
    let segments = SourceSegment.occupied(of: try await track.load(.segments))
    guard let cursor = track.makeSampleCursorAtFirstSampleInDecodeOrder() else { return [] }
    var starts: Set<Int64> = []
    repeat {
        let media = cursor.presentationTimeStamp
        if cursor.currentSampleSyncInfo.sampleIsFullSync.boolValue, let segment = segments.first(where: { $0.media.containsTime(media) }) {
            starts.insert(microseconds(segment.assetTime(ofMedia: media)))
        }
    } while cursor.stepInDecodeOrder(byCount: 1) == 1
    return starts
}

private func decodedPixels(_ url: URL) async throws -> [Int64: Data] {
    let asset = AVURLAsset(url: url)
    let track = try await asset.loadTracks(withMediaType: .video).first!
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track,
        outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    precondition(reader.startReading())
    var result: [Int64: Data] = [:]
    while let sample = output.copyNextSampleBuffer() {
        if let image = sample.imageBuffer { result[microseconds(sample.presentationTimeStamp)] = pixels(image) }
    }
    return result
}

private func pixels(_ buffer: CVPixelBuffer) -> Data {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    var bytes = Data()
    for row in 0..<CVPixelBufferGetHeight(buffer) {
        bytes.append(Data(bytes: CVPixelBufferGetBaseAddress(buffer)!.advanced(by: row * CVPixelBufferGetBytesPerRow(buffer)),
            count: CVPixelBufferGetWidth(buffer) * 4))
    }
    return bytes
}

// MARK: Harness

/// Drives the real companion writer with explicit host times, recording each callback the way
/// CaptureClockIngress does: one mapping row per offer, and a verification checkpoint per frame.
@MainActor
private final class GatedCameraTake {
    let directory: URL
    let binding: CameraCaptureBinding
    let camera: CameraWriter
    let observations: URL
    var clock: CaptureClock
    private let output: FileHandle
    private let pictures: [CMSampleBuffer]
    private var offered = 0
    private var written: Int64 = 0
    private var accepted = 0
    var raw: URL { directory.appendingPathComponent("camera.raw.mov") }
    var canonical: URL { directory.appendingPathComponent("video.mov") }

    init(root: URL, name: String, pictures: [CMSampleBuffer], clock: CaptureClock = CaptureClock()) throws {
        directory = root.appendingPathComponent(name)
        binding = CameraCaptureBinding(recordingId: name, sourceId: "\(name)-camera", deviceId: "fixture-camera")
        camera = try CameraWriter(directory: directory, framesPerSecond: 30, binding: binding)
        observations = directory.appendingPathComponent(CameraMedia.mappingFile)
        precondition(FileManager.default.createFile(atPath: observations.path, contents: nil))
        output = try FileHandle(forWritingTo: observations)
        self.pictures = pictures
        self.clock = clock
    }
    func setCamera(_ on: Bool, at hostUs: Int64) {
        if on { camera.startAcquiring(atHostUs: hostUs) } else { camera.stopAcquiring(atHostUs: hostUs) }
    }
    /// Offers the next fixture picture at `hostUs`; the real-time encoder needs a moment between pictures.
    func offer(_ hostUs: Int64, durationUs: Int64 = 50000) async throws -> String {
        try await Task.sleep(for: .milliseconds(4))
        let sample = try captureFixtureRetimed(pictures[offered % pictures.count],
            at: time(microseconds: hostUs), duration: time(microseconds: durationUs))
        offered += 1
        let result = try camera.append(sample, state: .init(clock: clock, accepting: true))
        struct Row: Encodable {
            let role = "camera"
            let disposition: String
            let convertedHostPTS: CaptureRationalTime
            let sourceUs: Int64?
            let cameraFrame: CameraFrameMapping?
        }
        let row = try JSONEncoder().encode(Row(disposition: result.receipt.disposition,
            convertedHostPTS: CaptureRationalTime(sample.presentationTimeStamp),
            sourceUs: result.receipt.sourceUs, cameraFrame: result.frame)) + Data([10])
        try output.write(contentsOf: row)
        written += Int64(row.count)
        if result.frame != nil {
            accepted += 1
            camera.recorded(observations: observations, bytes: written, frames: accepted)
        }
        return result.receipt.disposition
    }
    func expect(_ disposition: String, _ actual: String) {
        precondition(actual == disposition, "Expected \(disposition), got \(actual) in \(directory.lastPathComponent)")
    }
    func publish() async throws -> (result: CapturedCameraSource, receipt: CameraMedia.Receipt) {
        try output.synchronize()
        try output.close()
        let closed = await camera.close(clock: clock, failure: nil, observations: observations)
        defer { closed.releaseJournal() }
        let result = try await CameraMedia.publish(closed)
        precondition(result.failure == nil, "Publication failed: \(String(describing: result.failure))")
        let receipt = try JSONDecoder().decode(CameraMedia.Receipt.self,
            from: Data(contentsOf: directory.appendingPathComponent("camera.publication.json")))
        // Admission reads the same publication back through its own verifier.
        closed.releaseJournal()
        let lease = try CaptureJournalLease(directory: directory.path)
        defer { lease.release() }
        let verified = try await CameraMedia.readPublished(lease: lease, canonical: canonical)
        precondition(verified.identity.availability.support == receipt.support
            && verified.identity.availability.gaps == receipt.gaps ?? [])
        return (result, receipt)
    }
    /// Stops the live take without publishing it, releasing its encoder and journal.
    func closeUnpublished() async {
        try? output.close()
        await camera.close(clock: clock, failure: nil, observations: observations).discard()
    }
    func receiptJSON() throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("camera.publication.json"))) as! [String: Any]
    }
    func mappingFrames() throws -> [[String: Any]] {
        try String(contentsOf: observations, encoding: .utf8).split(separator: "\n").compactMap {
            (try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any])["cameraFrame"] as? [String: Any]
        }
    }
}

private enum Segment: Equatable, CustomStringConvertible {
    case empty(Int64, Int64)
    case occupied(Int64, Int64)
    var description: String {
        switch self {
        case .empty(let a, let b): "empty[\(a),\(b))"
        case .occupied(let a, let b): "occupied[\(a),\(b))"
        }
    }
}

private func canonicalSegments(_ url: URL) async throws -> [Segment] {
    let track = await RecoveryFixture.videoTrack(of: url)
    return try await track.load(.segments).map {
        let target = $0.timeMapping.target
        let start = microseconds(target.start), end = microseconds(CMTimeRangeGetEnd(target))
        return $0.isEmpty ? .empty(start, end) : .occupied(start, end)
    }
}

private func availabilityPictures(_ source: URL) async throws -> [CMSampleBuffer] {
    let asset = AVURLAsset(url: source)
    let track = try await asset.loadTracks(withMediaType: .video).first!
    let occupied = SourceSegment.occupied(of: try await track.load(.segments))
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track,
        outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    precondition(reader.startReading())
    var samples: [CMSampleBuffer] = []
    while let sample = output.copyNextSampleBuffer() {
        if assetEnd(ofSamplePresentedAt: sample.presentationTimeStamp, in: occupied, of: track) != nil { samples.append(sample) }
    }
    return samples
}
