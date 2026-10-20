@preconcurrency import AVFoundation
import AppKit
import Foundation
import Synchronization
@preconcurrency import ScreenCaptureKit

private final class TrackWriter {
    let role: String
    let file: String
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let sampleRate: Double?
    let channelCount: UInt32?
    let pcm: CapturePCM?
    var first: Int64?
    var lastAcceptedUs: Int64?
    var end: Int64?
    var samples = 0
    var physicalFrames: Int64 = 0
    var heldTailUs: Int64 = 0

    init(
        role: String, directory: String, settings: [String: Any], format: CMFormatDescription? = nil
    ) throws {
        self.role = role
        pcm = try role == "video" ? nil : format.map { try CapturePCM(format: $0) }
        sampleRate = format.flatMap {
            CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mSampleRate
        }
        channelCount = format.flatMap {
            CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mChannelsPerFrame
        }
        file = role == "video" ? "video.mov" : "\(role).packed.mov"
        writer = try AVAssetWriter(
            outputURL: URL(fileURLWithPath: directory).appendingPathComponent(file), fileType: .mov)
        // Video endpoints use source-clock ticks; packed PCM endpoints use exact native frames.
        let timescale: Int32
        if role == "video" { timescale = 1_000_000 }
        else {
            guard let rate = sampleRate.flatMap({ Int32(exactly: $0) }), rate > 0 else {
                throw CaptureFailure("INVALID_AUDIO_FORMAT", "PCM rate cannot identify its native sample grid.")
            }
            timescale = rate
        }
        writer.movieTimeScale = timescale
        writer.movieFragmentInterval = CMTime(value: 5, timescale: 1)
        writer.initialMovieFragmentInterval = CMTime(value: 1, timescale: 1)
        input = AVAssetWriterInput(
            mediaType: role == "video" ? .video : .audio, outputSettings: settings,
            sourceFormatHint: pcm?.format ?? format)
        if role == "video" { input.mediaTimeScale = timescale }
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            throw CaptureFailure("ENCODER_UNAVAILABLE", "Cannot encode \(role).")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw writer.error ?? CaptureFailure("WRITE_FAILED", "Cannot start \(role) writer.")
        }
        writer.startSession(atSourceTime: .zero)
    }
}

/// What a live take tells the person drawing on it, in the order it happened: the stroke still
/// being drawn, each mark once it is recorded, and each mark undo takes back. It carries the
/// recognizer's decisions, so whoever draws them classifies nothing.
public enum CaptureMarkUpdate: Equatable, Sendable {
    case liveStroke([MarkPoint])
    case committed(JournalMark)
    case retracted(String)
}

// All writer and clock mutations run on this queue, including control boundaries.
package final class CaptureWriter: NSObject, SCStreamOutput, @unchecked Sendable {
    package let queue = DispatchQueue(label: "com.dzhng.yap.capture-writer")
    private let journal: CaptureJournal
    package var packedJournalLease: CaptureJournalLease? { JournalSchema.isPacked(journal.schemaVersion) ? journal.lease : nil }
    package var journalSchemaVersion: Int { journal.schemaVersion }
    package var requestedAudioRoles: [String] {
        (request.microphone ? ["narration"] : []) + (request.systemAudio ? ["system"] : [])
    }
    private let request: CaptureRequest
    private let width: Int
    private let height: Int
    private var clock = CaptureClock()
    /// A copy of the clock for readers outside this queue. Elapsed playback time is asked for while
    /// a take is being finalized, and finalization occupies the writer queue for as long as the
    /// media takes to close; a reader that waited for the queue would stall its own thread behind
    /// that work. The copy is refreshed whenever the clock's own boundaries move, which is the only
    /// thing that changes what elapsed time it reports.
    private let publishedClock = Mutex(CaptureClock())
    private var tracks: [String: TrackWriter] = [:]
    private var dropped: [String: Int] = [:]
    private var omitted: [String: Int] = [:]
    private var stopHostUs: Int64?
    private let onFailure: @Sendable (CaptureFailure) -> Void
    private var failure: CaptureFailure?
    private var finishing = false
    private var lastVideo: CMSampleBuffer?
    /// A still screen delivers no frames, and the video writer only indexes media on disk once
    /// encoded samples pass its fragment interval. While the screen is still, the last frame repeats
    /// at 10 frames a second, so an open take keeps reaching disk and a killed process loses only
    /// its last seconds. The encoder holds several frames before writing any, so a slower floor
    /// leaves a short take with no index at all. The repeated pixels are the ones already on screen.
    private static let idleRepeatUs: Int64 = 100_000
    private var idleRepeat: DispatchSourceTimer?
    /// Host time the last video frame was written, real or repeated. Stillness is time without a
    /// delivery, not a gap in timestamps: a frame can arrive stamped well before it is delivered.
    private var lastVideoWrittenHostUs: Int64?
    private let requestedSourceRect: CGRect?
    private var cursor = CursorTrack()
    private var sampler: CursorSampler?
    private var cursorFlush: DispatchSourceTimer?
    private var zeroOriginHeight: Double?
    private var markRecognizer: MarkRecognizer?
    private var markMonitorTokens: [Any] = []
    private var recordedMarks: [(id: String, kind: String, pin: Int?)] = []
    private var retractedMarkIDs = Set<String>()
    package var onMarkUpdate: (@Sendable (CaptureMarkUpdate) -> Void)?
    /// Points of the live stroke the overlay was last told about. A stroke only grows until it
    /// ends, so its length is enough to know whether there is anything new to say.
    private var publishedStrokePoints = 0

    package init(
        request: CaptureRequest, width: Int, height: Int, sessionID: String,
        requestedSourceRect: CGRect?, onFailure: @escaping @Sendable (CaptureFailure) -> Void
    ) throws {
        self.onFailure = onFailure
        self.request = request
        self.width = width
        self.height = height
        self.requestedSourceRect = requestedSourceRect
        self.markRecognizer = request.source.kind == "camera"
            ? nil : MarkRecognizer(windowUnderPoint: LiveWindowSource())
        try FileManager.default.createDirectory(
            atPath: request.outputDirectory, withIntermediateDirectories: true)
        journal = try CaptureJournal(
            directory: request.outputDirectory,
            header: CaptureJournalHeader(
                schemaVersion: JournalSchema.current, sessionID: sessionID, source: request.source, width: width,
                height: height,
                microphone: request.microphone, systemAudio: request.systemAudio,
                cursorSampling: CursorSampling(holds: true)))
        tracks["video"] = try TrackWriter(
            role: "video", directory: request.outputDirectory,
            settings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoExpectedSourceFrameRateKey: 30, AVVideoMaxKeyFrameIntervalKey: 30,
                ],
            ])
    }

    /// Pointer sampling exists only while a take is actually recording: a paused take stops the
    /// cadence instead of collecting readings its clock would then refuse.
    func startCursorSampling() {
        queue.sync {
            let sampler = CursorSampler(target: queue) { [weak self] reading in
                self?.accept(reading)
            }
            self.sampler = sampler
            sampler.start()
        }
        guard request.source.kind != "camera" else { return }
        installMarkMonitors()
    }

    package func pause() {
        queue.sync {
            sampler?.suspend()
            cursorFlush?.schedule(deadline: .distantFuture)
            let hostUs = CaptureHostTime.nowUs()
            clock.pause(at: hostUs)
            publishClock()
            markRecognizer?.updateCaptureState(
                paused: true, hasFirstFrame: clock.originUs != nil)
            _ = record { try self.journal.recordPauseBegan(hostUs: hostUs) }
        }
    }
    package func resume() {
        queue.sync {
            resumeClock(at: CaptureHostTime.nowUs())
            if !finishing { sampler?.resume() }
        }
    }
    private func resumeClock(at hostUs: Int64) {
        let paused = clock.isPaused
        let count = clock.pauses.count
        clock.resume(at: hostUs)
        publishClock()
        markRecognizer?.updateCaptureState(
            paused: clock.isPaused, hasFirstFrame: clock.originUs != nil)
        if paused {
            cursor.resume()
            scheduleCursorFlush()
            let pause = clock.pauses.count > count ? clock.pauses.last : nil
            _ = record { try self.journal.recordPauseEnded(hostUs: hostUs, pause: pause) }
        }
    }
    private func record(_ write: () throws -> Void) -> Bool {
        do {
            try write()
            return true
        } catch {
            let reason = CaptureFailure("JOURNAL_FAILED", error.localizedDescription)
            if failure == nil {
                failure = reason
                onFailure(reason)
            }
            return false
        }
    }
    /// Records one reported transition in the take's journal and returns its sequence, so the
    /// number the service stores is the number this file carries.
    func note(_ state: String, reason: String?) -> Int? {
        queue.sync {
            var sequence: Int?
            _ = record { sequence = try self.journal.recordLifecycle(state: state, reason: reason) }
            return sequence
        }
    }
    /// The playback time this take holds right now, read from the one clock its media is written
    /// in. It is nil until video establishes source zero, and stops advancing while paused. It is
    /// answered from the published copy, so asking what time a take has reached never waits behind
    /// the take's own encoding or finalization.
    func elapsedSourceUs() -> Int64? {
        publishedClock.withLock { $0.elapsedSourceUs(at: CaptureHostTime.nowUs()) }
    }

    private func publishClock() {
        let current = clock
        publishedClock.withLock { $0 = current }
    }

    package func seal() {
        removeMarkMonitors()
        queue.sync {
            sampler?.stop()
            cursorFlush?.cancel()
            idleRepeat?.cancel()
            if stopHostUs == nil {
                let endpoint = CaptureHostTime.nowUs()
                stopHostUs = endpoint
                clock.seal(at: endpoint)
                publishClock()
                finishing = true
            }
            flushCursorSamples()
        }
    }
    package func cancel() {
        removeMarkMonitors()
        queue.sync {
            sampler?.stop()
            cursorFlush?.cancel()
            idleRepeat?.cancel()
            finishing = true
            tracks.values.forEach { $0.writer.cancelWriting() }
            journal.lease.release()
        }
    }
    package func releaseJournal() { queue.sync { journal.lease.release() } }

    /// Places one pointer reading in the take's source time. A reading the clock refuses, because
    /// the take is paused or has no source zero yet, is counted and dropped: no sample is invented
    /// for time the recording does not contain.
    package func accept(_ reading: CursorReading) {
        // A canceled sampler can still have deliveries queued behind seal/cancel.
        guard !finishing else { return }
        if zeroOriginHeight != reading.zeroOriginHeight {
            zeroOriginHeight = reading.zeroOriginHeight
            _ = record {
                try self.journal.recordDisplaySpace(
                    hostUs: reading.hostUs, zeroOriginHeight: reading.zeroOriginHeight)
            }
        }
        let sourceUs = clock.sourceTime(for: reading.hostUs)
        guard failure == nil else { return }
        if let batch = cursor.accept(reading, sourceUs: sourceUs) {
            _ = record { try self.journal.recordCursorSamples(batch) }
        }
        guard let markRecognizer, sourceUs != nil else { return }
        var recognizer = markRecognizer
        recognizer.updateCaptureState(
            paused: clock.isPaused, hasFirstFrame: clock.originUs != nil)
        let events = recognizer.feed(
            sample: MarkSample(
                hostUs: reading.hostUs, shift: reading.shift, otherModifiers: reading.otherModifiers,
                point: reading.global, buttonDown: reading.buttons != 0))
        self.markRecognizer = recognizer
        append(events)
        publishActiveStroke(recognizer)
    }

    /// Appends a retracting mark for the most recent mark that has not already been undone.
    package func undoMark() throws {
        try queue.sync {
            guard !finishing, failure == nil, request.source.kind != "camera" else {
                throw CaptureFailure("INVALID_STATE", "No screen capture is recording marks.")
            }
            guard let target = recordedMarks.last(where: { !retractedMarkIDs.contains($0.id) })
            else { return }
            let hostUs = CaptureHostTime.nowUs()
            // A paused take has no source time now; its undo lands where the pause began.
            guard let sourceUs = clock.isPaused ? clock.openPauseSourceUs : clock.sourceTime(for: hostUs)
            else { return }
            let mark = JournalMark(
                hostUs: hostUs, sourceUs: sourceUs, epoch: cursor.epoch,
                id: UUID().uuidString, kind: target.kind, pin: target.pin, points: [], retracts: target.id)
            let written = record { try journal.recordMark(mark) }
            guard written else { return }
            retractedMarkIDs.insert(target.id)
            onMarkUpdate?(.retracted(target.id))
        }
    }

    private func installMarkMonitors() {
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp]
        let register = { [weak self] in
            NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
                guard let self else { return }
                let isDown = event.type == .leftMouseDown
                let shift = event.modifierFlags.contains(.shift)
                let point = GlobalPointSpace.flip(
                    appKit: NSEvent.mouseLocation, zeroOriginHeight: GlobalPointSpace.zeroOriginHeight())
                let hostUs = CaptureHostTime.nowUs()
                self.queue.async {
                    guard !self.finishing, self.failure == nil, var recognizer = self.markRecognizer else { return }
                    guard self.clock.sourceTime(for: hostUs) != nil else { return }
                    recognizer.updateCaptureState(
                        paused: self.clock.isPaused, hasFirstFrame: self.clock.originUs != nil)
                    let events: [MarkEvent]
                    if isDown {
                        events = recognizer.feed(
                            press: MarkPress(
                                hostUs: hostUs, point: point, shift: shift))
                    } else {
                        events = recognizer.feed(release: MarkRelease(hostUs: hostUs, point: point))
                    }
                    self.markRecognizer = recognizer
                    self.append(events)
                    self.publishActiveStroke(recognizer)
                }
            }
        }
        let token: Any? = Thread.isMainThread ? register() : DispatchQueue.main.sync(execute: register)
        if let token { markMonitorTokens = [token] }
    }

    private func removeMarkMonitors() {
        let tokens = markMonitorTokens
        let remove = { for token in tokens { NSEvent.removeMonitor(token) } }
        if Thread.isMainThread { remove() } else { DispatchQueue.main.sync(execute: remove) }
        markMonitorTokens.removeAll()
    }

    private func append(_ events: [MarkEvent]) {
        for event in events {
            guard let first = event.points.first else { continue }
            guard let sourceUs = clock.sourceTime(for: first.hostUs) else { continue }
            let mark = JournalMark(
                hostUs: first.hostUs, sourceUs: sourceUs, epoch: cursor.epoch,
                id: UUID().uuidString, kind: event.kind.rawValue, pin: event.pin,
                points: event.points.map { point in
                    let projection = cursor.projection(
                        forGlobalPoint: CGPoint(x: point.x, y: point.y), hostUs: point.hostUs)
                    let pixel = projection.inside ? projection.pixel : nil
                    return JournalMarkPoint(
                        globalX: point.x, globalY: point.y,
                        x: pixel.map { Double($0.x) }, y: pixel.map { Double($0.y) },
                        hostUs: point.hostUs)
                },
                window: event.window)
            let written = record { try journal.recordMark(mark) }
            guard written else { return }
            recordedMarks.append((mark.id, mark.kind, mark.pin))
            onMarkUpdate?(.committed(mark))
        }
    }

    /// Tells the overlay about the live stroke only when it changed. It follows any mark the same
    /// reading recorded, so an ended stroke is drawn as its mark before its live line goes.
    private func publishActiveStroke(_ recognizer: MarkRecognizer) {
        let stroke = recognizer.activeStroke
        guard stroke.count != publishedStrokePoints else { return }
        publishedStrokePoints = stroke.count
        onMarkUpdate?(.liveStroke(stroke))
    }

    private func scheduleCursorFlush() {
        guard !finishing, !clock.isPaused, request.source.kind != "camera",
            let sourceUs = clock.elapsedSourceUs(at: CaptureHostTime.nowUs()) else { return }
        let interval = CursorTrack.defaultFlushIntervalUs
        if cursorFlush == nil {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.setEventHandler { [weak self] in
                guard let self, !self.finishing, !self.clock.isPaused,
                    let at = self.clock.elapsedSourceUs(at: CaptureHostTime.nowUs()) else { return }
                let samples = self.cursor.flush(through: at)
                if !samples.isEmpty {
                    _ = self.record { try self.journal.recordCursorSamples(samples) }
                }
            }
            cursorFlush = timer
            timer.resume()
        }
        cursorFlush?.schedule(deadline: .now() + .microseconds(Int(interval - sourceUs % interval)),
            repeating: .microseconds(Int(interval)))
    }

    private func flushCursorSamples() {
        let remaining = cursor.seal()
        cursor.note(refusedReadings: sampler?.refusedReadings ?? 0)
        guard failure == nil, !remaining.isEmpty else { return }
        _ = record { try self.journal.recordCursorSamples(remaining) }
    }

    /// Follows the placement each delivered frame reports. Idle and blank frames still describe
    /// where the source is, so geometry follows them even though their pixels are not written; a
    /// moved or resized window keeps the same output dimensions.
    private func updateGeometry(
        from info: [SCStreamFrameInfo: Any], hostUs: Int64, durationUs: Int64, usable: Bool
    ) {
        guard
            let observed = CaptureGeometry(
                frameInfo: info, outputWidth: width, outputHeight: height,
                requestedSourceRect: requestedSourceRect)
        else { return }
        guard
            let event = cursor.observe(
                observed, hostUs: hostUs,
                sourceUs: clock.sourceTime(for: hostUs, durationUs: usable ? durationUs : 0),
                usable: usable
            )
        else { return }
        _ = record {
            try self.journal.recordGeometry(
                epoch: event.epoch, hostUs: event.hostUs, sourceUs: event.sourceUs,
                geometry: event.geometry)
        }
    }

    package func stream(
        _ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        ingest(sample, of: type)
    }

    /// Screen completeness and geometry belong to the ScreenCaptureKit adapter.
    package func ingest(_ sample: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .screen:
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                let info = attachments.first, let status = info[.status] as? Int else { return }
            let usable = status == SCFrameStatus.complete.rawValue || status == SCFrameStatus.started.rawValue
            ingest(sample, role: "video", screenInfo: info, usable: usable)
        case .audio: ingest(sample, role: "system")
        case .microphone: ingest(sample, role: "narration")
        @unknown default: return
        }
    }

    /// Usable primary pictures in host time use the same writer and source clock as screen input.
    /// The caller converts its device clock before delivery; no screen attachments are required.
    @discardableResult
    package func ingestPrimaryVideo(_ sample: CMSampleBuffer) -> IngressReceipt {
        observeIngress(role: "video") { ingest(sample, role: "video") }
    }

    private func ingest(_ sample: CMSampleBuffer, role: String,
        screenInfo: [SCStreamFrameInfo: Any]? = nil, usable: Bool = true) {
        guard !finishing, failure == nil, sample.isValid, CMSampleBufferDataIsReady(sample) else {
            return
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        guard pts.isNumeric else { return }
        let hostUs = CMTimeConvertScale(pts, timescale: 1_000_000, method: .roundHalfAwayFromZero)
            .value
        let duration = CMSampleBufferGetDuration(sample)
        let observedDurationUs =
            duration.isNumeric
            ? max(
                0,
                CMTimeConvertScale(duration, timescale: 1_000_000, method: .roundHalfAwayFromZero)
                    .value)
            : 0
        let durationUs =
            observedDurationUs > 0 ? observedDurationUs : (role == "video" ? 33_333 : 0)
        if role == "video" {
            let usable = usable && sample.imageBuffer != nil
            // The first usable primary picture establishes zero before screen geometry is placed.
            if usable, clock.start(at: hostUs, durationUs: durationUs) {
                publishClock()
                scheduleCursorFlush()
                if screenInfo != nil { startIdleRepeat() }
                guard record({
                    try self.journal.recordPCMOrigin(JournalPCMOrigin(rawPTS: pts, declaredHostUs: hostUs),
                        placedPauses: self.clock.pauses)
                }) else { return }
            }
            if let screenInfo {
                updateGeometry(from: screenInfo, hostUs: hostUs, durationUs: durationUs, usable: usable)
            }
            guard usable else { return }
        }
        guard var sourceUs = clock.sourceTime(for: hostUs, durationUs: role == "video" ? durationUs : 0) else {
            omitted[role, default: 0] += 1
            return
        }
        if role == "video", let lastUs = tracks["video"]?.lastAcceptedUs, sourceUs <= lastUs {
            // A screen change delivered after a repeat of the still frame plays right after it.
            sourceUs = lastUs + 1
        }
        do {
            if tracks[role] == nil {
                guard let format = sample.formatDescription,
                    let audio = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
                else {
                    throw CaptureFailure("INVALID_AUDIO_FORMAT", "Missing format for \(role).")
                }
                tracks[role] = try TrackWriter(
                    role: role, directory: request.outputDirectory,
                    settings: [
                        AVFormatIDKey: kAudioFormatLinearPCM,
                        AVSampleRateKey: audio.mSampleRate,
                        AVNumberOfChannelsKey: audio.mChannelsPerFrame,
                        AVLinearPCMBitDepthKey: 32,
                        AVLinearPCMIsFloatKey: true,
                        AVLinearPCMIsNonInterleaved: false,
                        AVLinearPCMIsBigEndianKey: false,
                    ], format: format)
            }
            guard let track = tracks[role] else { return }
            guard track.input.isReadyForMoreMediaData else {
                dropped[role, default: 0] += 1
                return
            }
            let sample = try track.pcm?.normalize(sample) ?? sample
            var endUs = sourceUs + durationUs
            var targetPTS = CMTime(value: sourceUs, timescale: 1_000_000)
            var prospectiveClock = clock
            var placement: CaptureClock.PCMPlacement?
            let physicalFirst = track.physicalFrames
            if role != "video" {
                guard let rate = track.sampleRate.flatMap({ Int32(exactly: $0) }), rate > 0 else {
                    throw CaptureFailure("INVALID_AUDIO_FORMAT", "PCM sample rate must identify its native sample grid.")
                }
                guard let admitted = try prospectiveClock.recordAcceptedPCM(
                    role: role, hostPTS: pts, frames: Int64(sample.numSamples), rate: rate) else {
                    omitted[role, default: 0] += 1
                    return
                }
                placement = admitted
                let timeline = try PCMContainerTime(phaseUs: admitted.anchorUs, rate: rate)
                sourceUs = CMTimeConvertScale(try timeline.time(at: admitted.firstFrame),
                    timescale: 1_000_000, method: .roundHalfAwayFromZero).value
                endUs = CMTimeConvertScale(try timeline.time(at: admitted.firstFrame + admitted.frames),
                    timescale: 1_000_000, method: .roundHalfAwayFromZero).value
                let physicalEnd = physicalFirst.addingReportingOverflow(admitted.frames)
                guard !physicalEnd.overflow else { throw CaptureFailure("INVALID_AUDIO_TIMING", "Physical PCM address overflow.") }
                targetPTS = CMTime(value: physicalFirst, timescale: rate)
            }
            var count = 0
            var status = CMSampleBufferGetSampleTimingInfoArray(
                sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
            guard status == noErr else {
                throw CaptureFailure("RETIME_FAILED", "Cannot read sample timing: \(status).")
            }
            var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
            status = CMSampleBufferGetSampleTimingInfoArray(
                sample, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)
            guard status == noErr else {
                throw CaptureFailure("RETIME_FAILED", "Cannot read sample timing: \(status).")
            }
            let offset = CMTimeSubtract(pts, targetPTS)
            for index in timing.indices {
                timing[index].presentationTimeStamp = CMTimeSubtract(
                    timing[index].presentationTimeStamp, offset)
                if timing[index].decodeTimeStamp.isNumeric {
                    timing[index].decodeTimeStamp = CMTimeSubtract(
                        timing[index].decodeTimeStamp, offset)
                }
            }
            var retimed: CMSampleBuffer?
            status = CMSampleBufferCreateCopyWithNewTiming(
                allocator: kCFAllocatorDefault, sampleBuffer: sample,
                sampleTimingEntryCount: timing.count, sampleTimingArray: &timing,
                sampleBufferOut: &retimed)
            guard status == noErr, let retimed else {
                throw CaptureFailure("RETIME_FAILED", "Cannot retime sample: \(status).")
            }
            guard track.input.append(retimed) else {
                throw track.writer.error
                    ?? CaptureFailure("WRITE_FAILED", "Cannot append \(role) sample.")
            }
            let firstAppend = track.first == nil
            // Media acceptance cannot be rolled back if the following journal write fails.
            track.first = track.first ?? sourceUs
            track.lastAcceptedUs = sourceUs
            track.end = max(track.end ?? 0, endUs)
            track.samples += 1
            if let placement {
                clock = prospectiveClock
                track.physicalFrames = physicalFirst + placement.frames
                publishClock()
                if firstAppend {
                    guard record({ try self.journal.recordPCMTrack(JournalPCMTrack(
                        role: role, rate: placement.rate, channels: track.channelCount!, phaseUs: placement.anchorUs)) }) else { return }
                }
                guard record({ try self.journal.recordPCMAppend(JournalPCMAppend(
                    role: role, physicalFirstFrame: physicalFirst, frameCount: placement.frames,
                    declaredFirstFrame: placement.firstFrame, rawPTS: pts, removedPauseUs: placement.removedPauseUs)) }) else { return }
            } else {
                lastVideo = retimed
                lastVideoWrittenHostUs = CaptureHostTime.nowUs()
                if firstAppend {
                    guard record({ try self.journal.recordTrackStarted(
                        role: role, file: track.file, firstSourceUs: sourceUs,
                        sampleRate: track.sampleRate, channelCount: track.channelCount) }) else { return }
                }
            }
        } catch {
            let reason =
                (error as? CaptureFailure)
                ?? CaptureFailure("WRITE_FAILED", error.localizedDescription)
            failure = reason
            onFailure(reason)
        }
    }

    private func startIdleRepeat() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
        timer.setEventHandler { [weak self] in self?.repeatIdleFrame() }
        idleRepeat = timer
        timer.resume()
    }

    /// Repeats the last written frame once the screen has been still for `idleRepeatUs`, that long
    /// after the previous frame's end and never past the take's clock, which excludes pauses.
    private func repeatIdleFrame() {
        let hostNowUs = CaptureHostTime.nowUs()
        guard !finishing, failure == nil, let video = tracks["video"], let last = lastVideo,
            let end = video.end, let writtenUs = lastVideoWrittenHostUs,
            hostNowUs - writtenUs >= Self.idleRepeatUs,
            let sourceNowUs = clock.sourceTime(for: hostNowUs), video.input.isReadyForMoreMediaData
        else { return }
        let endUs = min(end + hostNowUs - writtenUs, sourceNowUs)
        let ptsUs = endUs - 33_333
        guard ptsUs > video.lastAcceptedUs ?? -1 else { return }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 33_333, timescale: 1_000_000),
            presentationTimeStamp: CMTime(value: ptsUs, timescale: 1_000_000),
            decodeTimeStamp: .invalid)
        do {
            var repeated: CMSampleBuffer?
            let status = CMSampleBufferCreateCopyWithNewTiming(
                allocator: kCFAllocatorDefault, sampleBuffer: last, sampleTimingEntryCount: 1,
                sampleTimingArray: &timing, sampleBufferOut: &repeated)
            guard status == noErr, let repeated else {
                throw CaptureFailure("RETIME_FAILED", "Cannot retime an idle frame: \(status).")
            }
            guard video.input.append(repeated) else {
                throw video.writer.error
                    ?? CaptureFailure("WRITE_FAILED", "Cannot append a repeated idle frame.")
            }
            video.lastAcceptedUs = ptsUs
            video.end = endUs
            video.samples += 1
            lastVideoWrittenHostUs = hostNowUs
        } catch {
            let reason =
                (error as? CaptureFailure)
                ?? CaptureFailure("WRITE_FAILED", error.localizedDescription)
            failure = reason
            onFailure(reason)
        }
    }

    package struct IngressState {
        package let clock: CaptureClock
        package let accepting: Bool
    }
    /// Read only on queue; a clock alone does not carry the writer's sealed/failure gate.
    package var ingressState: IngressState {
        IngressState(clock: clock, accepting: !finishing && failure == nil)
    }
    package struct IngressReceipt: Codable {
        package let disposition: String
        package let sourceUs: Int64?
    }
    package func ingestObserved(_ sample: CMSampleBuffer, of type: SCStreamOutputType) -> IngressReceipt {
        let role = type == .screen ? "video" : (type == .microphone ? "narration" : "system")
        return observeIngress(role: role) { ingest(sample, of: type) }
    }
    private func observeIngress(role: String, ingest: () -> Void) -> IngressReceipt {
        let before = tracks[role]?.samples ?? 0
        let previousDropped = dropped[role, default: 0]
        let previousOmitted = omitted[role, default: 0]
        let accepting = ingressState.accepting
        ingest()
        let disposition = (tracks[role]?.samples ?? 0) > before ? "accepted"
            : !accepting ? "sealed-or-failed" : dropped[role, default: 0] > previousDropped ? "backpressure"
            : omitted[role, default: 0] > previousOmitted ? "outside-support" : "invalid-or-unusable"
        return IngressReceipt(disposition: disposition,
            sourceUs: disposition == "accepted" ? tracks[role]?.lastAcceptedUs : nil)
    }

    package func finish(failure externalFailure: CaptureFailure?) async -> CaptureResult {
        await withCheckedContinuation { continuation in
            queue.async {
                self.finishing = true
                self.sampler?.stop()
                self.idleRepeat?.cancel()
                self.cursorFlush?.cancel()
                self.flushCursorSamples()
                let endHost = self.stopHostUs ?? CaptureHostTime.nowUs()
                self.resumeClock(at: endHost)
                let duration = max(0, self.clock.sourceTime(for: endHost) ?? 0)
                self.failure = externalFailure ?? self.failure
                if self.tracks["video"]?.samples == 0 {
                    self.failure =
                        self.failure
                        ?? CaptureFailure("NO_VIDEO", "Capture produced no usable video samples.")
                }
                if self.failure != nil {
                    self.finalize(
                        sourceDurationUs: min(duration, self.tracks["video"]?.end ?? 0),
                        continuation: continuation)
                } else if let video = self.tracks["video"], let last = self.lastVideo,
                    let end = video.end, duration > end
                {
                    self.holdTail(of: video, repeating: last, from: end, through: duration) {
                        settled in
                        self.finalize(sourceDurationUs: settled, continuation: continuation)
                    }
                } else {
                    self.finalize(sourceDurationUs: duration, continuation: continuation)
                }
            }
        }
    }

    /// Stretches a healthy take to its stop boundary by repeating the last delivered frame, and
    /// reports the source duration the file actually reached. A take that cannot keep its tail
    /// is interrupted and retains only its valid prefix.
    private func holdTail(
        of video: TrackWriter, repeating last: CMSampleBuffer, from lastSampleEndUs: Int64,
        through durationUs: Int64, then settle: @escaping (Int64) -> Void
    ) {
        let timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: CMTime(value: durationUs - 33_333, timescale: 1_000_000),
            decodeTimeStamp: .invalid)
        HeldTailFrame.place(
            last, at: timing, in: video.input, of: video.writer, on: queue
        ) { reason in
            guard reason == nil else {
                self.failure = reason
                settle(lastSampleEndUs)
                return
            }
            video.heldTailUs = durationUs - lastSampleEndUs
            settle(durationUs)
        }
    }

    private func finalize(
        sourceDurationUs: Int64, continuation: CheckedContinuation<CaptureResult, Never>
    ) {
        let group = DispatchGroup()
        for track in tracks.values {
            if track.samples == 0 {
                track.writer.cancelWriting()
                continue
            }
            let end = track.role == "video"
                ? CMTime(value: sourceDurationUs, timescale: 1_000_000)
                : CMTime(value: track.physicalFrames, timescale: Int32(track.sampleRate!))
            track.writer.endSession(atSourceTime: end)
            track.input.markAsFinished()
            group.enter()
            track.writer.finishWriting { group.leave() }
        }
        group.notify(queue: queue) {
            for track in self.tracks.values
            where track.samples > 0 && track.writer.status != .completed {
                self.failure =
                    self.failure
                    ?? CaptureFailure(
                        "WRITE_FAILED",
                        track.writer.error?.localizedDescription
                            ?? "Writer did not complete \(track.role).")
            }
            if self.request.microphone && (self.tracks["narration"]?.samples ?? 0) == 0 {
                self.failure =
                    self.failure
                    ?? CaptureFailure(
                        "NO_NARRATION",
                        "Microphone was requested but delivered no usable samples.")
            }
            if self.request.systemAudio && (self.tracks["system"]?.samples ?? 0) == 0 {
                self.failure =
                    self.failure
                    ?? CaptureFailure(
                        "NO_SYSTEM_AUDIO",
                        "System audio was requested but delivered no usable samples.")
            }
            let result = CaptureResult(
                state: self.failure == nil ? "complete" : "interrupted",
                source: self.request.source,
                width: self.width, height: self.height,
                durationUs: self.tracks["video"]?.samples == 0 ? 0 : sourceDurationUs,
                hostOriginUs: self.clock.originUs, pauses: self.clock.pauses,
                tracks: self.tracks.values.sorted { $0.role < $1.role }.map { track in
                    CapturedTrack(
                        role: track.role, file: track.file, firstSampleUs: track.first,
                        lastSampleEndUs: track.end, samples: track.samples,
                        droppedSamples: self.dropped[track.role, default: 0],
                        omittedSamples: self.omitted[track.role, default: 0],
                        heldTailUs: track.heldTailUs, sampleRate: track.sampleRate,
                        channelCount: track.channelCount)
                }, failure: self.failure,
                systemAudioScope: self.request.systemAudio
                    ? "whole-system-excluding-recorder" : "disabled",
                cursor: self.cursor.stats
            )
            continuation.resume(returning: result)
        }
    }
    /// Joins the complete snapshot on the journal's existing writer queue before releasing authority.
    package func freezePublicationJournal() async throws {
        guard let lease = packedJournalLease else { return }
        try Task.checkCancellation()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            queue.async {
                do {
                    try lease.synchronize()
                    try CaptureSourcePublication.freezePrimaryJournal(lease: lease, layout: self.journalSchemaVersion)
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
        try Task.checkCancellation()
    }

    package func recordPublishedResult(_ result: CaptureResult) -> CaptureResult {
        queue.sync { recordFinished(result) }
    }

    private func recordFinished(_ result: CaptureResult) -> CaptureResult {
        guard !record({ try journal.recordFinished(result) }) else { return result }
        return CaptureResult(state: "interrupted", source: result.source, width: result.width,
            height: result.height, durationUs: result.durationUs, hostOriginUs: result.hostOriginUs,
            pauses: result.pauses, tracks: result.tracks, failure: failure,
            systemAudioScope: result.systemAudioScope, cursor: result.cursor,
            cleanupFailure: result.cleanupFailure, camera: result.camera)
    }

}
