@preconcurrency import AVFoundation
import Foundation
import Darwin

/// What decoding and passthrough export depend on in a camera picture's format. A camera opened
/// again mid-take may describe the same format with a description that is not byte-equal, so a
/// take accepts any picture whose format is compatible with its first: same dimensions, pixel
/// format and colour tags.
struct CameraFormat: Equatable {
    let width: Int32
    let height: Int32
    let pixelFormat: FourCharCode
    let colour: [String?]

    init(_ description: CMFormatDescription) {
        let size = CMVideoFormatDescriptionGetDimensions(description)
        width = size.width; height = size.height
        pixelFormat = CMFormatDescriptionGetMediaSubType(description)
        colour = [kCMFormatDescriptionExtension_ColorPrimaries, kCMFormatDescriptionExtension_TransferFunction,
            kCMFormatDescriptionExtension_YCbCrMatrix].map {
            CMFormatDescriptionGetExtension(description, extensionKey: $0) as? String
        }
    }
}

/// Video-only companion to CaptureWriter; never writes or publishes audio.
package final class CameraWriter {
    private let directory: URL
    private let framesPerSecond: Int
    private let binding: CameraCaptureBinding?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var journal: CaptureJournal?
    private var first: Int64?
    private var end: Int64 = 0
    private var lastAcceptedTime: CMTime?
    private var frames = 0
    private var dropped = 0
    private var omitted = 0
    private var width = 0
    private var height = 0
    private var format: CameraFormat?
    private var recordedPauseCount = 0
    private var journalOpenPauseHostUs: Int64?
    private var origin: Int64?
    private var verification: CameraMedia.Verification?
    // Acquisition window: a picture is recorded only if its whole host interval lies inside it.
    // An open start means the camera has been on since the take began.
    private var onAt: CMTime?
    private var offAt: CMTime?
    private var run = 0
    private var runFrames = 0
    /// Counts acquisition windows, so a picture can be traced to the turn-on that opened its window.
    private var window = 0
    /// The window whose picture established the take's format.
    private var formatWindow = 0
    /// Called on the writer queue when a picture incompatible with the take's format arrives in a
    /// window opened by a later turn-on. The writer has already closed the window and refused the
    /// picture; the camera's owner turns the camera off.
    package var runEnded: (@Sendable (CaptureFailure) -> Void)?

    package init(directory: URL, framesPerSecond: Int, binding: CameraCaptureBinding? = nil) throws {
        try binding?.validate()
        self.directory = directory; self.framesPerSecond = framesPerSecond; self.binding = binding
        var allocated = stat()
        if binding != nil, lstat(directory.path, &allocated) == 0 {
            guard allocated.st_mode & S_IFMT == S_IFDIR, allocated.st_uid == getuid(),
                allocated.st_mode & 0o077 == 0,
                try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty else {
                throw CaptureFailure("OUTPUT_EXISTS", "Camera destination must be an empty owned private directory.")
            }
        } else {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        }
    }
    // The acquisition window has two mutators and no other: call them on the capture writer queue.

    /// Opens acquisition at a host instant. Turning on after a run that recorded a frame starts the
    /// next run.
    package func startAcquiring(atHostUs hostUs: Int64) {
        guard offAt != nil else { return }
        if runFrames > 0 {
            run += 1; runFrames = 0
            // The live continuation proves one contiguous run; later runs publish by full scan.
            verification?.abandon()
        }
        window += 1
        onAt = CMTime(value: hostUs, timescale: 1_000_000); offAt = nil
    }
    /// Closes acquisition at a host instant.
    package func stopAcquiring(atHostUs hostUs: Int64) {
        if offAt == nil { offAt = CMTime(value: hostUs, timescale: 1_000_000) }
    }
    /// No picture has been accepted, so nothing has been written.
    package var isEmpty: Bool { writer == nil }
    /// Whether the acquisition window is open.
    package var isAcquiring: Bool { offAt == nil }
    /// Whether a camera producing pictures of this size can continue this take.
    package func admits(width: Int, height: Int) -> Bool {
        format.map { Int($0.width) == width && Int($0.height) == height } ?? true
    }
    package func append(_ sample: CMSampleBuffer, state: CaptureWriter.IngressState) throws -> (receipt: CaptureWriter.IngressReceipt, frame: CameraFrameMapping?) {
        guard state.accepting else { return (.init(disposition: "sealed-or-failed", sourceUs: nil), nil) }
        let host = CMTimeConvertScale(sample.presentationTimeStamp, timescale: 1_000_000, method: .roundHalfAwayFromZero).value
        let duration = sample.duration.isNumeric && sample.duration > .zero
            ? sample.duration : CMTime(value: 1, timescale: Int32(framesPerSecond))
        // The take clock's overlap rule: a stale picture from before the turn-on, or one still
        // showing at the turn-off, was not acquired while the camera was on.
        if let onAt, sample.presentationTimeStamp < onAt { return (.init(disposition: "camera-off", sourceUs: nil), nil) }
        if let offAt, CMTimeAdd(sample.presentationTimeStamp, duration) > offAt {
            return (.init(disposition: "camera-off", sourceUs: nil), nil)
        }
        let durationUs = CMTimeConvertScale(duration, timescale: 1_000_000, method: .roundHalfAwayFromZero).value
        // A new independent origin rounds downward so exact fractional PTS never precedes it.
        let candidateOrigin = origin ?? state.clock.originUs ?? CMTimeConvertScale(
            sample.presentationTimeStamp, timescale: 1_000_000, method: .roundTowardNegativeInfinity).value
        let clock = state.clock.projected(originUs: candidateOrigin)
        guard let source = clock.sourceTime(for: host, durationUs: durationUs) else {
            omitted += 1; return (.init(disposition: "outside-support", sourceUs: nil), nil)
        }
        guard sample.isValid, CMSampleBufferDataIsReady(sample), sample.imageBuffer != nil,
            let description = sample.formatDescription else {
            throw CaptureFailure("INVALID_CAMERA_FRAME", "Camera callback lacks usable video.")
        }
        if let format, format != CameraFormat(description) {
            // Mixed colour tags in one track would play with the wrong colour, so the picture is
            // never recorded. A session opened by a later turn-on ends its own run; the session
            // that established the format changing mid-run still fails the take.
            guard window != formatWindow else {
                throw CaptureFailure("CAMERA_FORMAT_CHANGED", "Selected camera format changed during the take.")
            }
            stopAcquiring(atHostUs: host)
            runEnded?(CaptureFailure("CAMERA_FORMAT_CHANGED",
                "The camera turned on again delivers a picture format incompatible with earlier in this take."))
            return (.init(disposition: "camera-off", sourceUs: nil), nil)
        }
        if writer == nil {
            format = CameraFormat(description)
            formatWindow = window
            let size = CMVideoFormatDescriptionGetDimensions(description)
            width = Int(size.width); height = Int(size.height)
            let journal = try CaptureJournal(directory: directory.path,
                header: CaptureJournalHeader(schemaVersion: JournalSchema.companion, sessionID: binding?.sourceId ?? UUID().uuidString,
                    source: CaptureSource(kind: binding == nil ? "probe-camera" : "camera"), width: width, height: height,
                    microphone: false, systemAudio: false, cameraBinding: binding))
            self.journal = journal
            let writer = try AVAssetWriter(outputURL: directory.appendingPathComponent("camera.raw.mov"), fileType: .mov)
            self.writer = writer
            writer.movieTimeScale = 1_000_000
            writer.movieFragmentInterval = CMTime(value: 5, timescale: 1)
            writer.initialMovieFragmentInterval = CMTime(value: 1, timescale: 1)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [AVVideoExpectedSourceFrameRateKey: framesPerSecond,
                    AVVideoMaxKeyFrameIntervalKey: framesPerSecond]], sourceFormatHint: description)
            self.input = input
            input.mediaTimeScale = 1_000_000; input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw CaptureFailure("ENCODER_UNAVAILABLE", "Cannot encode camera video.") }
            writer.add(input)
            guard writer.startWriting() else { throw writer.error ?? CaptureFailure("WRITE_FAILED", "Camera writer failed.") }
            writer.startSession(atSourceTime: .zero)
            verification = CameraMedia.Verification(directory: URL(fileURLWithPath: journal.lease.directory))
        }
        if origin != nil { try synchronizePauses(clock) }
        guard let input, input.isReadyForMoreMediaData else {
            dropped += 1; return (.init(disposition: "backpressure", sourceUs: nil), nil)
        }
        // Acquisition order uses exact PTS; callback duration does not bound native frame presentation.
        let sourceTime = CMTimeSubtract(sample.presentationTimeStamp, CMTime(value: host - source, timescale: 1_000_000))
        guard sourceTime >= .zero, lastAcceptedTime == nil || sourceTime > lastAcceptedTime! else {
            omitted += 1; return (.init(disposition: "duplicate-or-reordered", sourceUs: nil), nil)
        }
        let retimed = try CaptureClockIngress.retime(sample, to: sourceTime, duration: duration)
        if runFrames == 0 {
            // Each run decodes on its own, so a passthrough edit of it copies nothing from before a gap.
            CMSetAttachment(retimed, key: kCMSampleBufferAttachmentKey_ForceKeyFrame, value: kCFBooleanTrue,
                attachmentMode: kCMAttachmentMode_ShouldNotPropagate)
        }
        guard input.append(retimed) else { throw writer?.error ?? CaptureFailure("WRITE_FAILED", "Camera append failed.") }
        if origin == nil {
            origin = candidateOrigin
            try journal?.recordOrigin(hostUs: candidateOrigin)
            try synchronizePauses(clock)
        }
        if first == nil {
            first = source
            try journal?.recordTrackStarted(role: "video", file: "video.mov", firstSourceUs: source,
                sampleRate: nil, channelCount: nil)
        }
        let frame = CameraFrameMapping(ordinal: frames, start: CaptureRationalTime(sourceTime),
            nominalEnd: CaptureRationalTime(CMTimeAdd(sourceTime, duration)), run: run)
        runFrames += 1
        lastAcceptedTime = sourceTime
        end = CMTimeConvertScale(frame.nominalEnd.time, timescale: 1_000_000, method: .roundHalfAwayFromZero).value
        frames += 1
        return (.init(disposition: "accepted", sourceUs: source), frame)
    }
    package func recorded(observations: URL, bytes: Int64, frames: Int) {
        verification?.request(observations: observations, bytes: bytes, frames: frames)
    }
    private func synchronizePauses(_ clock: CaptureClock) throws {
        guard let origin else { return }
        let controls = clock.pauseProjection(originUs: origin)
        while recordedPauseCount < controls.count {
            let control = controls[recordedPauseCount]
            if journalOpenPauseHostUs != control.startHostUs {
                try journal?.recordPauseBegan(hostUs: control.startHostUs)
            }
            try journal?.recordPauseEnded(hostUs: control.endHostUs, pause: control.pause)
            journalOpenPauseHostUs = nil
            recordedPauseCount += 1
        }
        if let opened = clock.openPauseHostUs, journalOpenPauseHostUs != opened {
            try journal?.recordPauseBegan(hostUs: opened)
            journalOpenPauseHostUs = opened
        }
    }
    @MainActor
    package func close(clock: CaptureClock, failure: CaptureFailure?, observations: URL) async -> ClosedCameraSource {
        var reason = failure
        var sealed = false
        do { try synchronizePauses(clock) }
        catch { reason = reason ?? (error as? CaptureFailure) ?? CaptureFailure("JOURNAL_FAILED", error.localizedDescription) }
        do {
            if let writer, let input, frames > 0 {
                writer.endSession(atSourceTime: CMTime(value: end, timescale: 1_000_000))
                input.markAsFinished()
                await writer.finishWriting()
                guard writer.status == .completed else { throw writer.error ?? CaptureFailure("WRITE_FAILED", "Camera closure failed.") }
                sealed = true
            } else {
                writer?.cancelWriting()
                throw CaptureFailure("NO_CAMERA", "Selected camera delivered no accepted frames.")
            }
        } catch { reason = reason ?? (error as? CaptureFailure) ?? CaptureFailure("WRITE_FAILED", error.localizedDescription) }
        let sourceClock = origin.map { clock.projected(originUs: $0) } ?? clock
        let closed = ClosedCameraSource(directory: directory, journal: journal, observations: observations,
            clock: sourceClock, width: width, height: height, frames: frames, dropped: dropped,
            omitted: omitted, sealed: sealed, failure: reason, binding: binding, verification: verification)
        if frames > 0 {
            do { try closed.pinIdentities() } catch { closed.identityFailure = error }
        }
        return closed
    }
    package func discard() async {
        writer?.cancelWriting()
        await verification?.discard()
        journal?.lease.release()
    }
}
