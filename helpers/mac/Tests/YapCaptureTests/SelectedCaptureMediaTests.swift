@preconcurrency import AVFoundation
import CryptoKit
import Foundation
import YapCapture
import YapMedia
import YapFrames
import YapWire
import ScreenCaptureKit

@MainActor
func runSelectedCaptureMediaTests(output: String, corpus: String) async throws {
    let delayed = ProbeStartDelay()
    let waiting = Task { try await delayed.wait(seconds: 3600) }
    try await Task.sleep(for: .milliseconds(10))
    let cancelStart = ContinuousClock.now
    delayed.cancel()
    do { try await waiting.value; preconditionFailure("Canceled startup delay resumed normally") }
    catch is CancellationError {}
    precondition(cancelStart.duration(to: .now) < .seconds(1))
    let root = URL(fileURLWithPath: output)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let video = root.appendingPathComponent("input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: video,
        timesUs: [0, 100000, 500000, 1500000, 2300000], endUs: 2500000)
    let folder = root.appendingPathComponent("take")
    let input = PrerecordedCaptureInput(source: video)
    input.audio = URL(fileURLWithPath: corpus).appendingPathComponent("a-audio.wav")
    input.probeDirectory = folder
    input.cameraBeforePrimary = false
    input.pauseJournal = folder.appendingPathComponent("capture.journal.jsonl")
    let capture = NativeCapture(prepareInput: { _, _ in input })
    try await capture.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
        outputDirectory: folder.path, microphone: true))
    try capture.pause()
    let result = try await capture.stop()
    precondition(result.failure == nil, "Probe publication failed: \(String(describing: result.failure))")
    precondition(result.tracks.allSatisfy { ["video", "narration"].contains($0.role) })
    precondition(input.finalizations == 1 && input.finalClock?.isPaused == false)
    let camera = try JSONDecoder().decode(CaptureResult.self,
        from: Data(contentsOf: folder.appendingPathComponent("camera/capture-result.json")))
    precondition(camera.hostOriginUs == result.hostOriginUs && camera.pauses == result.pauses)
    precondition(camera.tracks[0].firstSampleUs == 200000 && camera.tracks[0].heldTailUs == 0)
    precondition(camera.tracks[0].samples > 0 && camera.durationUs == camera.tracks[0].lastSampleEndUs)
    let recovered = await MediaRecovery.inspect(directory: folder.appendingPathComponent("camera").path)
    let recoveredVideo = recovered.tracks.first { $0.role == "video" }!
    precondition(recoveredVideo.failure == nil && recoveredVideo.decodeReachedEnd
        && (recoveredVideo.decodedSamples ?? 0) > 0)
    precondition(recoveredVideo.intervals.first?.startUs == 200000)
    precondition(recoveredVideo.intervals.count == 1, "Sparse camera callbacks must retain native presentation holds")
    try JSONEncoder().encode(recovered).write(to: root.appendingPathComponent("camera-recovery.json"))
    _ = try await assertProbePresentation(directory: folder.appendingPathComponent("camera"),
        observations: folder.appendingPathComponent("timestamps.jsonl"))
    let receipt = try JSONDecoder().decode(CaptureAudioPublication.Receipt.self,
        from: Data(contentsOf: folder.appendingPathComponent("narration.publication.json")))
    var hash = SHA256(); hash.update(data: Data("yap.capture-pcm.v1\0".utf8))
    for number in [input.expectedRate,input.expectedChannels] {
        var little = number.littleEndian
        hash.update(data: withUnsafeBytes(of: &little) { Data($0) })
    }
    hash.update(data: input.expectedPCM)
    precondition(receipt.pcmSHA256 == hash.finalize().map { String(format: "%02x", $0) }.joined())
    precondition(receipt.acceptedFrames == receipt.representedFrames && input.rejectedAudioBuffers > 0)
    let rows = try String(contentsOf: folder.appendingPathComponent("timestamps.jsonl"), encoding: .utf8)
        .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    precondition(!rows.isEmpty && rows.allSatisfy { $0["role"] as? String == "camera" },
        "The camera's mapping logs camera callbacks only, not the screen or microphone")
    // The primary's callbacks inside the pause are counted by its own result, not the mapping.
    precondition(result.tracks.contains { $0.omittedSamples > 0 },
        "The primary reports the paused callbacks it omitted: \(result.tracks.map { "\($0.role)=\($0.omittedSamples)" })")
    precondition(rows.contains { $0["disposition"] as? String == "sealed-or-failed" })
    let earlier = CaptureFailure("EARLIER", "earlier failure")
    let later = CaptureFailure("CAMERA", "camera failure")
    let failed = result.withFailure(earlier).withFailure(later)
    precondition(failed.failure?.code == "EARLIER")
    func stable(_ r: CaptureResult) throws -> [String: Any] {
        var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(r)) as! [String: Any]
        value.removeValue(forKey: "failure"); value.removeValue(forKey: "state"); return value
    }
    let originalFields = try stable(result); let failedFields = try stable(failed)
    precondition(NSDictionary(dictionary: originalFields).isEqual(to: failedFields))
    try JSONEncoder().encode(result).write(to: root.appendingPathComponent("result.json"))
    let retryInput = PrerecordedCaptureInput(source: video)
    retryInput.audio = input.audio
    retryInput.holdStop = true
    retryInput.companionFailure = CaptureFailure("CAMERA_CLOSURE", "offline companion closure failure")
    let retry = NativeCapture(prepareInput: { _, _ in retryInput })
    let retryFolder = root.appendingPathComponent("retry")
    try await retry.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
        outputDirectory: retryFolder.path, microphone: true))
    let stopping = Task { try await retry.stop() }
    await retryInput.stopEntered.wait()
    retry.cancelPublication(); retryInput.releaseStop.release()
    do { _ = try await stopping.value; preconditionFailure("Expected canceled publication") }
    catch is CancellationError {}
    precondition(retryInput.finalizations == 1)
    retryInput.companionFailure = CaptureFailure("WRONG_RETRY", "Must not replace cached closure")
    let retried = try await retry.stop()
    precondition(retryInput.finalizations == 1 && retried.failure?.code == "CAMERA_CLOSURE")
    precondition(retried.hostOriginUs == retryInput.finalClock?.originUs && retried.pauses == retryInput.finalClock?.pauses)
    precondition(retried.tracks.map(\.role) == ["narration", "video"] && retried.cleanupFailure == nil)
    try JSONEncoder().encode(retried).write(to: root.appendingPathComponent("retry-result.json"))
    print("PASS shared ingress camera offset/pause, separate results, exact canonical microphone PCM, final pause closure and earlier failure precedence")
}

@MainActor
func runProbeFrameBoundary(output: String, sourcePath: String? = nil) async throws {
    let root = URL(fileURLWithPath: output)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let source = root.appendingPathComponent(sourcePath == nil ? "input.mov" : "input.mp4")
    if let sourcePath { try FileManager.default.copyItem(atPath: sourcePath, toPath: source.path) }
    else { try await RecoveryFixture.writeVariableDurationVideo(to: source,
        timesUs: (0..<24).map { Int64($0) * 100000 }, endUs: 2400000) }
    let asset = AVURLAsset(url: source)
    let track = try await asset.loadTracks(withMediaType: .video).first!
    let reader = try AVAssetReader(asset: asset)
    let decoded = AVAssetReaderTrackOutput(track: track,
        outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(decoded); precondition(reader.startReading())
    var images: [CMSampleBuffer] = []
    while images.count < (sourcePath == nil ? 24 : 1), let image = decoded.copyNextSampleBuffer() { images.append(image) }
    let image = images[0]
    reader.cancelReading()
    // Convert every timestamp and endpoint, including multiple timing entries, at a non-unit rate.
    var clock: CMTimebase?
    precondition(CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault,
        sourceClock: CMClockGetHostTimeClock(), timebaseOut: &clock) == noErr)
    let anchor = CMTime(value: 7000000, timescale: 1000000)
    let hostAnchor = CMTime(value: CaptureHostTime.nowUs(), timescale: 1000000)
    precondition(CMTimebaseSetRateAndAnchorTime(clock!, rate: 2, anchorTime: anchor,
        immediateSourceTime: hostAnchor) == noErr)
    var timing = [CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 20),
        presentationTimeStamp: anchor, decodeTimeStamp: CMTimeSubtract(anchor, CMTime(value: 1, timescale: 20))),
        CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 20),
        presentationTimeStamp: CMTimeAdd(anchor, CMTime(value: 1, timescale: 20)), decodeTimeStamp: .invalid)]
    var multi: CMSampleBuffer?
    precondition(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
        makeDataReadyCallback: nil, refcon: nil, formatDescription: image.formatDescription,
        sampleCount: 2, sampleTimingEntryCount: 2, sampleTimingArray: &timing,
        sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &multi) == noErr)
    let converted = try CaptureClockIngress.convert(multi!, from: clock!)
    var actual = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: 2)
    var count = 0
    precondition(CMSampleBufferGetSampleTimingInfoArray(converted, entryCount: 2,
        arrayToFill: &actual, entriesNeededOut: &count) == noErr && count == 2)
    precondition(actual[0].presentationTimeStamp == hostAnchor)
    precondition(actual[1].presentationTimeStamp == CMTimeAdd(hostAnchor, CMTime(value: 1, timescale: 40)))
    precondition(actual.allSatisfy { $0.duration == CMTime(value: 1, timescale: 40) })
    precondition(actual[0].decodeTimeStamp == CMTimeSubtract(hostAnchor, CMTime(value: 1, timescale: 40)))
    precondition(!actual[1].decodeTimeStamp.isNumeric)
    let writer = try CaptureWriter(request: CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
        outputDirectory: root.appendingPathComponent("screen").path),
        width: CVPixelBufferGetWidth(image.imageBuffer!), height: CVPixelBufferGetHeight(image.imageBuffer!),
        sessionID: "rational-frame-boundary", requestedSourceRect: nil, onFailure: { _ in })
    let origin = CMTime(value: CaptureHostTime.nowUs() - 1000000, timescale: 1000000)
    let screen = try captureFixtureRetimed(image, at: origin, duration: CMTime(value: 1, timescale: 60))
    let attachments = CMSampleBufferGetSampleAttachmentsArray(screen, createIfNecessary: true)! as NSArray
    (attachments[0] as! NSMutableDictionary)[SCStreamFrameInfo.status.rawValue] = SCFrameStatus.complete.rawValue
    writer.queue.sync { writer.ingest(screen, of: .screen) }
    let camera = try CameraWriter(directory: root.appendingPathComponent("camera"), framesPerSecond: 60)
    let ingress = try CaptureClockIngress(writer: writer, destination: .companion(camera), observations: root.appendingPathComponent("observations.jsonl"), failure: { _ in preconditionFailure("Unexpected probe failure") })
    var receipts: [CaptureWriter.IngressReceipt] = []
    let duration = sourcePath == nil ? CMTime(value: 3334, timescale: 100000) : CMTime(value: 1, timescale: 60)
    var cadence = (sourcePath == nil ? [0,3333,6667,6667,6666,10000] : [0,1,3,3])
        .map { CMTime(value: Int64($0), timescale: sourcePath == nil ? 100000 : 60) }
    // Each magnitude observed in the real take is exercised against this writer's
    // evolving accepted PTS. Historical dropped-frame counts are not an oracle.
    if sourcePath == nil {
        let overlaps = [16670,10,32170,16280,400,20,330,190,780,30,40,370,560,540]
            .map { CMTime(value: Int64($0), timescale: 1000000) }
            + [CMTime(value: 10, timescale: 3000000)]
        for overlap in overlaps { cadence.append(CMTimeSubtract(CMTimeAdd(cadence.last!, duration), overlap)) }
    }
    let expectedDispositions = sourcePath == nil
        ? ["accepted","accepted","accepted","duplicate-or-reordered","duplicate-or-reordered","accepted"]
            + Array(repeating: "accepted", count: cadence.count - 6)
        : ["accepted","accepted","accepted","duplicate-or-reordered"]
    for (index, time) in cadence.enumerated() {
        let picture = sourcePath == nil ? images[index] : image
        let sample = try captureFixtureRetimed(picture, at: CMTimeAdd(origin, time), duration: duration)
        receipts.append(writer.queue.sync { ingress.accept(sample, role: .camera, from: CMClockGetHostTimeClock())! })
        try await Task.sleep(for: .milliseconds(10))
    }
    try JSONEncoder().encode(receipts).write(to: root.appendingPathComponent("receipts.json"))
    precondition(receipts.map(\.disposition) == expectedDispositions,
        "Ordered acquired PTS must survive nominal duration overlap: \(receipts)")
    for (index, receipt) in receipts.enumerated() where receipt.disposition == "accepted" {
        precondition(receipt.sourceUs == CMTimeConvertScale(cadence[index], timescale: 1000000,
            method: .roundHalfAwayFromZero).value)
    }
    // A later dropped callback must not append behind a torn row after ingress has failed.
    let stoppedURL = root.appendingPathComponent("stopped-observations.jsonl")
    let stoppedIngress = try CaptureClockIngress(writer: writer, destination: .companion(camera),
        observations: stoppedURL, failure: { failure in precondition(failure.code == "CLOCK_UNAVAILABLE") })
    writer.queue.sync { precondition(stoppedIngress.accept(image, role: .camera, from: nil) == nil) }
    let torn = Data("{\"role\":".utf8)
    let tail = try FileHandle(forWritingTo: stoppedURL)
    try tail.write(contentsOf: torn); try tail.close()
    let videoOutput = AVCaptureVideoDataOutput()
    let connection = AVCaptureConnection(inputPorts: [], output: videoOutput)
    writer.queue.sync { stoppedIngress.captureOutput(videoOutput, didDrop: image, from: connection) }
    try stoppedIngress.close()
    let retainedTail = try Data(contentsOf: stoppedURL)
    precondition(retainedTail == torn, "Dropped callback appended behind failed evidence")
    writer.seal(); let closed = await writer.finish(failure: nil)
    try ingress.close()
    let snapshot = await camera.close(clock: writer.queue.sync { writer.ingressState.clock }, failure: closed.failure, observations: ingress.observationURL!)
    let cameraResult = try await CameraMedia.publish(snapshot)
    snapshot.releaseJournal()
    writer.releaseJournal()
    precondition(cameraResult.failure == nil)
    let result = try JSONDecoder().decode(CaptureResult.self,
        from: Data(contentsOf: root.appendingPathComponent("camera/capture-result.json")))
    let expectedEnd = try await assertProbePresentation(directory: root.appendingPathComponent("camera"),
        observations: root.appendingPathComponent("observations.jsonl"))
    precondition(result.tracks[0].samples == expectedDispositions.filter { $0 == "accepted" }.count
        && result.tracks[0].omittedSamples == (sourcePath == nil ? 2 : 1)
        && result.durationUs == expectedEnd)
    print("PASS multi-entry 2x clock endpoints; exact ordered acquired pictures, observed nominal overlaps and duplicate/backward refusal; endpoint \(result.durationUs)us")
}


/// Exercise the same retained-picture selector as ordinary movie rendering, independently
/// of the publication verifier. Native display support holds a picture between acquired PTS.
func assertProbePresentation(directory: URL, observations: URL) async throws -> Int64 {
    struct Timestamp: Decodable { let value: Int64; let timescale: Int32 }
    struct Frame: Decodable { let start: Timestamp; let end: Timestamp }
    let rows = try String(contentsOf: observations, encoding: .utf8).split(separator: "\n")
    let frames = try rows.compactMap { line -> Frame? in
        let row = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        guard let frame = row["cameraFrame"] else { return nil }
        return try JSONDecoder().decode(Frame.self, from: JSONSerialization.data(withJSONObject: frame))
    }
    let ranges = frames.map { frame in
        CMTimeRange(start: CMTimeConvertScale(CMTime(value: frame.start.value, timescale: frame.start.timescale),
            timescale: 1000000, method: .roundHalfAwayFromZero),
            end: CMTimeConvertScale(CMTime(value: frame.end.value, timescale: frame.end.timescale),
                timescale: 1000000, method: .roundHalfAwayFromZero))
    }
    let first = ranges.first!.start
    let rawAsset = AVURLAsset(url: directory.appendingPathComponent("camera.raw.mov"))
    let rawTrack = try await rawAsset.loadTracks(withMediaType: .video).first!
    let occupied = SourceSegment.occupied(of: try await rawTrack.load(.segments))
    let physicalEnd = assetEnd(ofSamplePresentedAt: ranges.last!.start, in: occupied, of: rawTrack)!
    let terminal = CMTimeMinimum(ranges.last!.end, physicalEnd)
    let raw = try await PresentationSource(source: directory.appendingPathComponent("camera.raw.mov"),
        streamId: nil, startUs: nil)
    let canonical = try await PresentationSource(source: directory.appendingPathComponent("video.mov"),
        streamId: nil, startUs: nil)
    var points = ranges.map { $0.start.value }
    for pair in zip(ranges, ranges.dropFirst()) {
        points.append((pair.0.start.value + pair.1.start.value) / 2)
        points.append(pair.1.start.value - 1)
    }
    if first.value > 0 { points.append(first.value - 1) }
    points += [terminal.value - 1, terminal.value, terminal.value + 1]
    func pixels(_ buffer: CVPixelBuffer) -> Data {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        var bytes = Data()
        for row in 0..<CVPixelBufferGetHeight(buffer) {
            bytes.append(Data(bytes: CVPixelBufferGetBaseAddress(buffer)!.advanced(by: row * CVPixelBufferGetBytesPerRow(buffer)),
                count: CVPixelBufferGetWidth(buffer) * 4))
        }
        return bytes
    }
    for point in Set(points).sorted() {
        let at = CMTime(value: point, timescale: 1000000)
        guard at >= first && at < terminal else {
            do {
                let outside = try canonical.selection(at: at, end: CMTimeAdd(terminal, CMTime(value: 1, timescale: 1)))
                precondition(outside.buffer == nil && outside.sampleTime == nil, "Camera appeared outside bounded presentation")
            } catch let failure as NativeFailure { precondition(failure.code == "UNAVAILABLE") }
            continue
        }
        let selected: PresentationSource.Selection
        do { selected = try canonical.selection(at: at, end: terminal) }
        catch { throw CaptureFailure("PRESENTATION_TEST", "Canonical point \(point): \(error)") }
        let expected = ranges.last { $0.start <= at }!.start
        let original: PresentationSource.Selection
        do { original = try raw.selection(at: at, end: terminal) }
        catch { throw CaptureFailure("PRESENTATION_TEST", "Raw point \(point): \(error)") }
        precondition(selected.sampleTime == expected && original.sampleTime == expected,
            "Native presentation did not retain the preceding acquired picture")
        precondition(pixels(selected.buffer!) == pixels(original.buffer!), "Held camera picture changed pixels")
    }
    return CMTimeConvertScale(terminal, timescale: 1000000, method: .roundHalfAwayFromZero).value
}
