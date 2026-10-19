@preconcurrency import AVFoundation
import Foundation
import ScreenCaptureKit
import YapCapture
import YapMedia
import YapWire

func runCaptureWriterTests() async throws {
    for canceled in [false, true] {
        let directory = RecoveryFixture.directory("quiet-writer")
        defer { try? FileManager.default.removeItem(at: directory) }
        let writer = try CaptureWriter(
            request: CaptureRequest(
                source: CaptureSource(kind: "window", windowID: 1),
                outputDirectory: directory.path, microphone: false, systemAudio: false),
            width: 32, height: 32, sessionID: "quiet-writer",
            requestedSourceRect: nil, onFailure: { _ in })
        defer { writer.cancel() }
        let journal = directory.appendingPathComponent("capture.journal.jsonl")
        let header = try Data(contentsOf: journal)
        writer.queue.sync {
            writer.accept(CursorReading(
                hostUs: 1, global: .zero, buttons: 0, zeroOriginHeight: 800))
        }
        let written = try Data(contentsOf: journal)
        precondition(written.count > header.count, "A live writer journals display-space changes")
        if canceled { writer.cancel() } else { writer.seal() }
        let sealed = try Data(contentsOf: journal)
        // Keep the real writer alive, as queued stream callbacks can during native shutdown.
        writer.queue.sync {
            writer.accept(CursorReading(
                hostUs: 2, global: .zero, buttons: 0, zeroOriginHeight: 900))
        }
        let delivered = try Data(contentsOf: journal)
        precondition(delivered == sealed, "A late cursor delivery must not append after seal/cancel")
    }
    print("PASS late cursor deliveries cannot append after writer seal or cancel")
}


func runCaptureDurationTests() async throws {
    for (elapsedUs, interrupted) in [(Int64(4_316_788), false), (7_000_121, false), (1_000_000, true)] {
        let directory = RecoveryFixture.directory("writer-duration")
        defer { try? FileManager.default.removeItem(at: directory) }
        let writer = try CaptureWriter(
            request: CaptureRequest(source: CaptureSource(kind: "window", windowID: 1),
                outputDirectory: directory.path, microphone: false, systemAudio: false),
            width: 32, height: 32, sessionID: "writer-duration",
            requestedSourceRect: nil, onFailure: { _ in })
        let sample = completeScreenFrame(atHostUs: CaptureHostTime.nowUs() - elapsedUs)
        writer.queue.sync { writer.ingest(sample, of: .screen) }
        writer.seal()
        let closed = await writer.finish(failure: interrupted
            ? CaptureFailure("INTERRUPTED", "Generated interruption") : nil)
        let result = writer.recordPublishedResult(closed)
        writer.releaseJournal()
        precondition(result.state == (interrupted ? "interrupted" : "complete"))
        if interrupted { precondition(result.durationUs == 33_333) }
        let evidenceFile = directory.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".jsonl")
        defer { try? FileManager.default.removeItem(at: evidenceFile) }
        let evidence = try await SourceEvidenceExport.write(directory: directory.path, output: evidenceFile.path)
        precondition(evidence.completion?.durationUs == result.durationUs
            && evidence.completion?.state == result.state
            && evidence.completion?.failureCode == result.failure?.code
            && evidence.completion?.sequence == evidence.lastSequence,
            "Actual writer completion must survive normalized evidence export")
        let asset = AVURLAsset(url: directory.appendingPathComponent("video.mov"),
            options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let duration = try await asset.load(.duration)
        precondition(time(microseconds: result.durationUs) == duration,
            "Finalized revision duration \(result.durationUs) must equal actual asset \(duration.value)/\(duration.timescale)")
        let recovered = try await MediaRecovery.recover(directory: directory.path)
        precondition(recovered.durationUs == result.durationUs, "Recovery and finalized capture must agree")
        print("PASS generated capture exact finalized duration \(result.durationUs)")
    }
}

/// One complete 32x32 screen frame presented at `hostUs`, as ScreenCaptureKit delivers it.
private func completeScreenFrame(atHostUs hostUs: Int64, grey: Int32 = 127) -> CMSampleBuffer {
    var pixel: CVPixelBuffer?
    CVPixelBufferCreate(nil, 32, 32, kCVPixelFormatType_32BGRA, nil, &pixel)
    CVPixelBufferLockBaseAddress(pixel!, [])
    memset(CVPixelBufferGetBaseAddress(pixel!)!, grey, CVPixelBufferGetDataSize(pixel!))
    CVPixelBufferUnlockBaseAddress(pixel!, [])
    var description: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixel!, formatDescriptionOut: &description)
    var timing = CMSampleTimingInfo(duration: time(microseconds: 33_333),
        presentationTimeStamp: time(microseconds: hostUs), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixel!,
        formatDescription: description!, sampleTiming: &timing, sampleBufferOut: &sample)
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample!, createIfNecessary: true)! as NSArray
    (attachments[0] as! NSMutableDictionary)[SCStreamFrameInfo.status.rawValue] = SCFrameStatus.complete.rawValue
    return sample!
}

/// A screen that stops changing stops sending frames. The take must still reach disk as it records,
/// so a process killed mid-take leaves media up to its last few seconds, not a file with no index.
func runIdleScreenFragmentTest() async throws {
    let directory = RecoveryFixture.directory("idle-screen")
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try CaptureWriter(
        request: CaptureRequest(source: CaptureSource(kind: "window", windowID: 1),
            outputDirectory: directory.path, microphone: false, systemAudio: false),
        width: 32, height: 32, sessionID: "idle-screen",
        requestedSourceRect: nil, onFailure: { _ in })
    defer { writer.cancel() }
    // One frame, then a still screen; the writer stays open, as it is when the process dies. How
    // many frames the encoder holds before writing depends on the machine, so this waits for the
    // index rather than timing it; the app's kill test owns the deadline.
    writer.queue.sync { writer.ingest(completeScreenFrame(atHostUs: CaptureHostTime.nowUs()), of: .screen) }
    var durationUs: Int64 = 0
    for _ in 0..<40 where durationUs < 1_000_000 {
        try await Task.sleep(for: .milliseconds(250))
        let snapshot = directory.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".mov")
        defer { try? FileManager.default.removeItem(at: snapshot) }
        try FileManager.default.copyItem(at: directory.appendingPathComponent("video.mov"), to: snapshot)
        let asset = AVURLAsset(url: snapshot, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let tracks = try? await asset.loadTracks(withMediaType: .video), !tracks.isEmpty,
            let duration = try? await asset.load(.duration) else { continue }
        durationUs = CMTimeConvertScale(duration, timescale: 1_000_000, method: .roundTowardZero).value
    }
    precondition(durationUs >= 1_000_000,
        "A still screen's open take must reach disk with an index, got \(durationUs)us after 10s")
    print("PASS a still screen's open take keeps writing media (\(durationUs)us on disk)")
}

/// A screen change that arrives late, after the still screen's last frame has already been
/// repeated past its timestamp, is still recorded and the take still finishes.
func runLateScreenFrameTest() async throws {
    let directory = RecoveryFixture.directory("late-screen-frame")
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try CaptureWriter(
        request: CaptureRequest(source: CaptureSource(kind: "window", windowID: 1),
            outputDirectory: directory.path, microphone: false, systemAudio: false),
        width: 32, height: 32, sessionID: "late-screen-frame",
        requestedSourceRect: nil, onFailure: { _ in })
    let originUs = CaptureHostTime.nowUs()
    writer.queue.sync { writer.ingest(completeScreenFrame(atHostUs: originUs), of: .screen) }
    try await Task.sleep(for: .milliseconds(400))
    let late = writer.queue.sync {
        writer.ingestObserved(completeScreenFrame(atHostUs: originUs + 150_000, grey: 255), of: .screen)
    }
    precondition(late.disposition == "accepted",
        "A late screen change must be recorded, got \(late.disposition)")
    writer.seal()
    let result = writer.recordPublishedResult(await writer.finish(failure: nil))
    writer.releaseJournal()
    precondition(result.state == "complete", "A late frame must not fail the take: \(result.failure as Any)")
    print("PASS a late screen change after a repeated still frame is recorded")
}

func runFractionalRecoveryDurationTest() async throws {
    let directory = RecoveryFixture.directory("fractional-duration")
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = directory.appendingPathComponent("video.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: source,
        timesUs: [0, 4_280_000], endUs: 4_316_788)
    let duration = try await AVURLAsset(url: source).load(.duration)
    let recovered = await MediaRecovery.inspect(directory: directory.path)
    precondition(time(microseconds: recovered.durationUs) <= duration,
        "Recovery cannot round video support beyond the actual asset duration")
    precondition(recovered.durationUs == CMTimeConvertScale(duration, timescale: 1_000_000,
        method: .roundTowardNegativeInfinity).value)
    print("PASS fractional container endpoint recovers only supported source-clock ticks")
}
