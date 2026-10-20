@preconcurrency import AVFoundation
import Foundation
import ScreenCaptureKit
import YapCapture
import YapMedia

/// Only the physical input boundary is substituted. NativeCapture creates and closes the real writer.
@MainActor
final class PrerecordedCaptureInput: CaptureInputSession {
    let width: Int
    let height: Int
    var paceVideo = false
    var videoDeliveryInterval: Duration?
    var offeredVideoFrames = 0
    let requestedSourceRect: CGRect? = nil
    var previewFrame: (@Sendable (NativeCapture.CameraPreviewFrame) -> Void)?
    let source: URL
    let refusesAfterDelivery: Bool
    var stops = 0
    var finalizations = 0
    var discards = 0
    var finalClock: CaptureClock?
    var companionFailure: CaptureFailure?
    var probeDirectory: URL?
    var cameraBinding: CameraCaptureBinding?
    var probe: CaptureClockIngress?
    var sharedIngress: CaptureClockIngress?
    var fixtureOrigin: Int64?
    var cursorSamplingStarts = 0
    var cursorFixture = false
    var cameraFramesEnabled = true
    var primaryFramesEnabled = true
    var primaryVideoIngress = false
    var cameraBeforePrimary = true
    var cameraPrologueEnabled = true
    var beforeCameraClose: (() throws -> Void)?
    var afterCameraClose: (() throws -> Void)?
    var finalCameraSample: CMSampleBuffer?
    var onFailure: (@Sendable (CaptureFailure) -> Void)?
    var audio: URL?
    var omittedAudioBuffer: Int?
    var pauseJournal: URL?
    var pauseBounds: (start: Int64, end: Int64)?
    var rejectedAudioBuffers = 0
    var expectedPlacements: [(first: Int64, frames: Int64, removedUs: Int64)] = []
    var audioRoles: [SCStreamOutputType] = [.microphone]
    var expectedPCM = Data()
    var expectedRate: Int64 = 0
    var expectedChannels: Int64 = 0
    var offeredAudioBuffers = 0
    var holdStop = false
    let stopEntered = InputGate()
    let releaseStop = InputGate()

    init(source: URL, refusesAfterDelivery: Bool = false, size: CGSize? = nil) {
        width = size.map { Int($0.width) } ?? RecoveryFixture.width
        height = size.map { Int($0.height) } ?? RecoveryFixture.height
        self.source = source
        self.refusesAfterDelivery = refusesAfterDelivery
    }

    func start(writer: CaptureWriter, output captureOutput: any SCStreamOutput, framesPerSecond: Int?, onFailure: @escaping @Sendable (CaptureFailure) -> Void,
        checkInterruption: @escaping @MainActor () throws -> Void) async throws {
        self.onFailure = onFailure
        sharedIngress = captureOutput as? CaptureClockIngress
        if let probeDirectory {
            let camera = try CameraWriter(directory: probeDirectory.appendingPathComponent("camera"), framesPerSecond: 30, binding: cameraBinding)
            probe = try CaptureClockIngress(writer: writer, destination: .companion(camera),
                observations: probeDirectory.appendingPathComponent("timestamps.jsonl"), failure: onFailure)
        }
        let asset = AVURLAsset(url: source)
        let track = try await asset.loadTracks(withMediaType: .video).first!
        let occupied = SourceSegment.occupied(of: try await track.load(.segments))
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        precondition(reader.startReading())
        // An inert SCStream only supplies the existing callback's identity. Never start it.
        let stream = SCStream(filter: SCContentFilter(), configuration: SCStreamConfiguration(), delegate: nil)
        // Native-rate replay starts now; backdating it would deliver the initial prefix as a burst.
        var origin = CaptureHostTime.nowUs() - (audio == nil ? (paceVideo ? 0 : 400_000) : 3_000_000)
        if let pauseJournal {
            writer.pause()
            try await Task.sleep(for: .milliseconds(20))
            writer.resume()
            let events = try String(contentsOf: pauseJournal, encoding: .utf8).split(separator: "\n").map {
                try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any]
            }
            let began = events.first { $0["event"] as? String == "pauseBegan" }!["data"] as! [String: Any]
            let ended = events.first { $0["event"] as? String == "pauseEnded" }!["data"] as! [String: Any]
            pauseBounds = (began["hostUs"] as! Int64, ended["hostUs"] as! Int64)
            origin = pauseBounds!.start - 800_000
        }
        var sourceClock: CMClockOrTimebase = CMClockGetHostTimeClock()
        if probe != nil || sharedIngress != nil {
            var base: CMTimebase?
            precondition(CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault,
                sourceClock: CMClockGetHostTimeClock(), timebaseOut: &base) == noErr)
            precondition(CMTimebaseSetRateAndAnchorTime(base!, rate: 1.0002,
                anchorTime: time(microseconds: 7000000), immediateSourceTime: time(microseconds: origin)) == noErr)
            sourceClock = base!
        }
        fixtureOrigin = origin
        func rawProbeSample(_ host: CMSampleBuffer) throws -> CMSampleBuffer {
            try captureFixtureRetimed(host, at: CMSyncConvertTime(host.presentationTimeStamp,
                from: CMClockGetHostTimeClock(), to: sourceClock))
        }
        while let sample = output.copyNextSampleBuffer() {
            // AVAssetReader may emit a picture for a leading empty edit; it was never acquired.
            guard assetEnd(ofSamplePresentedAt: sample.presentationTimeStamp, in: occupied, of: track) != nil else { continue }
            if paceVideo {
                let waitUs = origin + microseconds(sample.presentationTimeStamp) - CaptureHostTime.nowUs()
                if waitUs > 0 { try await Task.sleep(for: .microseconds(waitUs)) }
            }
            offeredVideoFrames += 1
            let timed = try captureFixtureRetimed(sample,
                at: CMTimeAdd(time(microseconds: origin), sample.presentationTimeStamp))
            if !primaryVideoIngress {
                let attachments = CMSampleBufferGetSampleAttachmentsArray(timed, createIfNecessary: true)! as NSArray
                (attachments[0] as! NSMutableDictionary)[SCStreamFrameInfo.status.rawValue] = SCFrameStatus.complete.rawValue
            }
            finalCameraSample = timed
            writer.queue.sync {
                if let probe {
                    let prologue = writer.ingressState.clock.originUs == nil
                    if cameraFramesEnabled && prologue && cameraPrologueEnabled && cameraBeforePrimary {
                        probe.accept(try! rawProbeSample(timed), role: .camera, from: sourceClock)
                    }
                    if primaryFramesEnabled { probe.accept(try! rawProbeSample(timed), role: .screen, from: sourceClock) }
                    let delayed = try! captureFixtureRetimed(timed, at: CMTimeAdd(timed.presentationTimeStamp, time(microseconds: 200000)))
                    if cameraFramesEnabled { probe.accept(try! rawProbeSample(delayed), role: .camera, from: sourceClock) }
                    // Retain the prologue callback in the primary-first control, delivered out of order.
                    if cameraFramesEnabled && prologue && cameraPrologueEnabled && !cameraBeforePrimary {
                        probe.accept(try! rawProbeSample(timed), role: .camera, from: sourceClock)
                    }
                } else if primaryFramesEnabled {
                    if primaryVideoIngress { writer.ingestPrimaryVideo(timed) }
                    else if let sharedIngress { sharedIngress.acceptStream(try! rawProbeSample(timed), of: .screen, from: sourceClock) }
                    else { captureOutput.stream!(stream, didOutputSampleBuffer: timed, of: .screen) }
                }
            }
            try checkInterruption()
            if refusesAfterDelivery { throw CaptureFailure("INPUT_START_FAILED", "Prerecorded partial start") }
            if let videoDeliveryInterval { try await Task.sleep(for: videoDeliveryInterval) }
        }
        precondition(reader.status == .completed)
        if let audio {
            for role in audioRoles {
                let asset = AVURLAsset(url: audio)
                let track = try await asset.loadTracks(withMediaType: .audio).first!
                let reader = try AVAssetReader(asset: asset)
                let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
                    AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32,
                    AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
                    AVLinearPCMIsBigEndianKey: false])
                reader.add(output)
                precondition(reader.startReading())
                var index = 0
                while let sample = output.copyNextSampleBuffer() {
                    if index != omittedAudioBuffer {
                        let raw = try captureFixtureRetimed(sample,
                            at: CMTimeAdd(time(microseconds: origin + 100001), sample.presentationTimeStamp))
                        writer.queue.sync {
                            if let probe { probe.accept(try! rawProbeSample(raw), role: .microphone, from: sourceClock) }
                            else if let sharedIngress { sharedIngress.acceptStream(try! rawProbeSample(raw), of: role, from: sourceClock) }
                            else { captureOutput.stream!(stream, didOutputSampleBuffer: raw, of: role) }
                        }
                        if role == audioRoles.first {
                            let format = CMAudioFormatDescriptionGetStreamBasicDescription(sample.formatDescription!)!.pointee
                            expectedRate = Int64(format.mSampleRate)
                            expectedChannels = Int64(format.mChannelsPerFrame)
                            let block = sample.dataBuffer!
                            var bytes = Data(count: CMBlockBufferGetDataLength(block))
                            let status = bytes.withUnsafeMutableBytes {
                                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!)
                            }
                            precondition(status == noErr)
                            offeredAudioBuffers += 1
                            let host = microseconds(raw.presentationTimeStamp)
                            let end = host + Int64((Double(sample.numSamples) * 1_000_000 / format.mSampleRate).rounded())
                            let excluded = pauseBounds.map { host < $0.end && end > $0.start } ?? false
                            if excluded { rejectedAudioBuffers += 1 }
                            else {
                                expectedPCM.append(bytes)
                                let removed = pauseBounds.map { host >= $0.end ? $0.end - $0.start : 0 } ?? 0
                                let relative = CMTimeSubtract(sample.presentationTimeStamp, time(microseconds: removed))
                                let first = CMTimeConvertScale(relative, timescale: Int32(expectedRate), method: .roundHalfAwayFromZero).value
                                expectedPlacements.append((first, Int64(sample.numSamples), removed))
                            }
                        }
                    }
                    index += 1
                    // Pace prerecorded delivery so the real-time writer's backpressure is not the oracle variable.
                    try await Task.sleep(for: .milliseconds(5))
                }
                precondition(reader.status == .completed)
            }
        }
        if pauseBounds != nil {
            let waitUs = origin + 2_500_000 - CaptureHostTime.nowUs()
            if waitUs > 0 { try await Task.sleep(for: .microseconds(waitUs)) }
        }
    }
    func closeMedia(clock: CaptureClock, failure: CaptureFailure?) async -> CaptureInputClosure {
        finalizations += 1; finalClock = clock
        if let probe {
            try? probe.close()
            do { try beforeCameraClose?() } catch { preconditionFailure("Fixture setup failed: \(error)") }
            let closed = await probe.companion!.close(clock: clock, failure: failure ?? companionFailure, observations: probe.observationURL!)
            do { try afterCameraClose?() } catch { preconditionFailure("Fixture setup failed: \(error)") }
            return CaptureInputClosure(camera: .closed(closed))
        }
        return CaptureInputClosure(failure: companionFailure)
    }
    func discardMedia() async {
        discards += 1
        await probe?.companion?.discard()
        try? probe?.close()
    }
    func startCursorSampling(writer: CaptureWriter) {
        cursorSamplingStarts += 1
        if cursorFixture, let fixtureOrigin {
            writer.queue.sync { writer.accept(CursorReading(hostUs: fixtureOrigin + 150000,
                global: CGPoint(x: 50, y: 40), buttons: 0, zeroOriginHeight: 120)) }
        }
    }
    func observeDeviceLoss(onFailure: @escaping @Sendable (CaptureFailure) -> Void) {}
    func stop() async -> CaptureFailure? {
        stops += 1
        if let probe, let finalCameraSample {
            probe.writer.queue.sync { _ = probe.accept(finalCameraSample, role: .camera, from: CMClockGetHostTimeClock()) }
        }
        stopEntered.release()
        if holdStop { await releaseStop.wait() }
        return nil
    }
}

@MainActor
final class InputGate {
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async { if !open { await withCheckedContinuation { waiters.append($0) } } }
    func release() { open = true; let pending = waiters; waiters.removeAll(); for waiter in pending { waiter.resume() } }
}

func captureFixtureRetimed(_ sample: CMSampleBuffer, at pts: CMTime, duration: CMTime? = nil) throws
  -> CMSampleBuffer
{
  var count = 0
  var status = CMSampleBufferGetSampleTimingInfoArray(
    sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
  precondition(status == noErr)
  var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
  status = CMSampleBufferGetSampleTimingInfoArray(
    sample, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)
  precondition(status == noErr)
  let shift = CMTimeSubtract(pts, sample.presentationTimeStamp)
  for n in timing.indices {
    timing[n].presentationTimeStamp = CMTimeAdd(timing[n].presentationTimeStamp, shift)
    if timing[n].decodeTimeStamp.isNumeric {
      timing[n].decodeTimeStamp = CMTimeAdd(timing[n].decodeTimeStamp, shift)
    }
    if let duration { timing[n].duration = duration }
  }
  var copy: CMSampleBuffer?
  status = CMSampleBufferCreateCopyWithNewTiming(
    allocator: kCFAllocatorDefault, sampleBuffer: sample, sampleTimingEntryCount: count,
    sampleTimingArray: &timing, sampleBufferOut: &copy)
  precondition(status == noErr)
  return copy!
}
