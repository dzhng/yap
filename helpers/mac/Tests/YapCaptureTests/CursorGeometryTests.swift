import CoreGraphics
import CoreMedia
import CoreVideo
import Dispatch
import Foundation
@preconcurrency import ScreenCaptureKit
import YapCapture
import Synchronization

/// The same retina window at a chosen onscreen x, so a take can be given as much geometry churn as
/// a test needs without inventing a new shape for each step.
private func window(atX x: Double) -> CaptureGeometry {
    CaptureGeometry(
        outputWidth: 1600, outputHeight: 1000,
        contentRect: GeometryRect(x: 0, y: 0, width: 800, height: 500), contentScale: 1,
        scaleFactor: 2, screenRect: GeometryRect(x: x, y: 80, width: 800, height: 500),
        boundingRect: nil, requestedSourceRect: nil)
}

/// A retina window filling its surface: 800x500 points at 100,80 onscreen, 1600x1000 output pixels.
private let placed = window(atX: 100)

/// The same take after the window grew to 1000x600 points. The output keeps its dimensions, so the
/// content is scaled to 0.8 and letterboxed by ten points at the top and bottom.
private let letterboxed = CaptureGeometry(
    outputWidth: 1600, outputHeight: 1000,
    contentRect: GeometryRect(x: 0, y: 10, width: 800, height: 480), contentScale: 0.8,
    scaleFactor: 2, screenRect: GeometryRect(x: 100, y: 80, width: 1000, height: 600),
    boundingRect: nil, requestedSourceRect: nil)

/// A window on a display mounted above the origin display, where global points are negative.
private let aboveOrigin = CaptureGeometry(
    outputWidth: 1280, outputHeight: 800,
    contentRect: GeometryRect(x: 0, y: 0, width: 640, height: 400), contentScale: 1,
    scaleFactor: 2, screenRect: GeometryRect(x: -300, y: -1440, width: 640, height: 400),
    boundingRect: nil, requestedSourceRect: nil)

private func pixel(
    _ geometry: CaptureGeometry, _ x: Double, _ y: Double, line: UInt = #line
) -> CGPoint {
    guard let point = geometry.outputPixel(forGlobalPoint: CGPoint(x: x, y: y)) else {
        preconditionFailure("Geometry with a source rect must place a finite point", line: line)
    }
    return point
}

private func reading(hostUs: Int64, x: Double, y: Double, buttons: Int = 0, skipped: Int = 0)
    -> CursorReading
{
    CursorReading(
        hostUs: hostUs, global: CGPoint(x: x, y: y), buttons: buttons, zeroOriginHeight: 982,
        skippedTicks: skipped)
}

func runCursorGeometryTests() throws {
    try runChangeOnlyCursorTests()
    // Corners and an asymmetric interior target, so a transposed transform cannot pass.
    precondition(pixel(placed, 100, 80) == CGPoint(x: 0, y: 0), "The content origin is pixel zero")
    precondition(
        pixel(placed, 300, 455) == CGPoint(x: 400, y: 750),
        "An asymmetric target keeps its axes, got \(pixel(placed, 300, 455))")
    precondition(
        pixel(placed, 900, 580) == CGPoint(x: 1600, y: 1000),
        "The far corner lands on the surface bound")
    precondition(
        !placed.contains(outputPixel: pixel(placed, 900, 580)),
        "The far corner is one pixel past the last drawn pixel")
    precondition(
        placed.contains(outputPixel: pixel(placed, 899.9, 579.9)),
        "The last drawn pixel is inside the capture")
    print("PASS a filled retina window maps corners and an asymmetric interior point")

    // Fixed output dimensions do not imply fixed source geometry.
    precondition(
        letterboxed.outputWidth == placed.outputWidth
            && letterboxed.outputHeight == placed.outputHeight,
        "A resized window keeps the take's output dimensions")
    precondition(
        pixel(letterboxed, 100, 80) == CGPoint(x: 0, y: 20),
        "Padding offsets the content origin, got \(pixel(letterboxed, 100, 80))")
    precondition(
        pixel(letterboxed, 600, 380) == CGPoint(x: 800, y: 500),
        "A scaled interior point follows content scale, got \(pixel(letterboxed, 600, 380))")
    precondition(
        pixel(letterboxed, 1100, 680) == CGPoint(x: 1600, y: 980),
        "The scaled far corner keeps its letterbox, got \(pixel(letterboxed, 1100, 680))")
    precondition(
        letterboxed.contains(outputPixel: CGPoint(x: 10, y: 21))
            && !letterboxed.contains(outputPixel: CGPoint(x: 10, y: 19)),
        "Letterbox padding is outside the captured content")
    print("PASS a resized window letterboxes inside unchanged output dimensions")

    // A display mounted above the origin display has negative global points throughout.
    precondition(
        pixel(aboveOrigin, -300, -1440) == CGPoint(x: 0, y: 0),
        "A negative display origin is still the content origin")
    precondition(
        pixel(aboveOrigin, -60, -1140) == CGPoint(x: 480, y: 600),
        "Negative origins keep interior placement, got \(pixel(aboveOrigin, -60, -1140))")
    let onOtherDisplay = pixel(aboveOrigin, 100, 100)
    precondition(
        onOtherDisplay == CGPoint(x: 800, y: 3080),
        "A point on another display is projected, not clamped, got \(onOtherDisplay)")
    precondition(
        !aboveOrigin.contains(outputPixel: onOtherDisplay), "That point is outside the capture")
    let before = pixel(placed, 0, 0)
    precondition(
        before == CGPoint(x: -200, y: -160) && !placed.contains(outputPixel: before),
        "A point left of the capture keeps negative coordinates, got \(before)")
    print("PASS out-of-capture points stay projected and outside, never clamped to an edge")

    // Region capture has no per-frame screen rect; the request's global rect explains it.
    let region = CaptureGeometry(
        outputWidth: 800, outputHeight: 600,
        contentRect: GeometryRect(x: 0, y: 0, width: 400, height: 300), contentScale: 1,
        scaleFactor: 2, screenRect: nil, boundingRect: nil,
        requestedSourceRect: GeometryRect(x: 1228, y: -1440, width: 400, height: 300))
    precondition(
        pixel(region, 1428, -1290) == CGPoint(x: 400, y: 300),
        "A display-local region offsets into its display, got \(pixel(region, 1428, -1290))")
    let unexplained = CaptureGeometry(
        outputWidth: 800, outputHeight: 600,
        contentRect: GeometryRect(x: 0, y: 0, width: 400, height: 300), contentScale: 1,
        scaleFactor: 2, screenRect: nil, boundingRect: nil, requestedSourceRect: nil)
    precondition(
        unexplained.outputPixel(forGlobalPoint: CGPoint(x: 0, y: 0)) == nil,
        "Geometry no frame has explained cannot place a point")
    var unlocated = CursorTrack(flushIntervalUs: 0)
    _ = unlocated.observe(unexplained, hostUs: 0, sourceUs: nil, usable: true)
    let unlocatedSample = unlocated.accept(
        reading(hostUs: 1_000, x: 300, y: 455), sourceUs: 1_000)?.first
    precondition(
        unlocatedSample?.eligibility == "unknownGeometry" && unlocatedSample?.geometryEpoch == 0,
        "A frame with no source placement cannot claim a projected epoch, got \(String(describing: unlocatedSample))"
    )
    print("PASS a region uses its requested global rect and unexplained geometry places nothing")

    // AppKit reports the pointer in a bottom-left space anchored to the zero-origin display.
    precondition(
        GlobalPointSpace.flip(appKit: CGPoint(x: 2341, y: 1688), zeroOriginHeight: 982)
            == CGPoint(x: 2341, y: -706),
        "A pointer above the origin display converts to a negative global y")
    precondition(
        GlobalPointSpace.flip(appKit: CGPoint(x: 10, y: 10), zeroOriginHeight: 982)
            == CGPoint(x: 10, y: 972), "A pointer near the origin display's bottom stays positive")
    print("PASS AppKit pointer readings convert through the zero-origin display height")

    try runCursorTrackTests()
}

private func runCursorTrackTests() throws {
    var track = CursorTrack(flushIntervalUs: 32_000)
    precondition(
        track.epoch == 0
            && track.observe(placed, hostUs: 0, sourceUs: nil, usable: true)?.epoch == 1,
        "A first observation opens epoch 1")
    precondition(
        track.observe(placed, hostUs: 16_000, sourceUs: nil, usable: true) == nil,
        "An unchanged geometry keeps its epoch")
    precondition(
        track.accept(reading(hostUs: 1_000, x: 300, y: 455), sourceUs: 0) == nil,
        "Readings are retained until the take-time flush")
    precondition(
        track.accept(reading(hostUs: 17_000, x: 0, y: 0), sourceUs: 16_000) == nil,
        "Readings are retained until the take-time flush")
    guard
        let batch = track.accept(
            reading(hostUs: 33_000, x: 300, y: 455, buttons: 1), sourceUs: 32_000)
    else { preconditionFailure("The take-time deadline flushes pending readings") }
    precondition(
        batch.map(\.sourceUs) == [0, 16_000, 32_000], "A batch keeps sample order, got \(batch)")
    precondition(
        batch[0].x == 400 && batch[0].y == 750 && batch[0].visible,
        "An inside sample carries its output pixel, got \(batch[0])")
    precondition(
        batch[1].eligibility == "outside" && batch[1].x == -200,
        "An outside sample keeps its projection, got \(batch[1])")
    precondition(
        batch[2].buttons == 1 && batch[0].buttons == 0, "Button state is recorded as observed")
    precondition(
        batch.allSatisfy { $0.geometryEpoch == 1 }, "Samples carry the epoch they were taken under")
    precondition(
        batch[0].globalX == 300 && batch[0].globalY == 455,
        "The raw global point is retained beside the transform")
    precondition(
        track.accept(reading(hostUs: 49_000, x: 300, y: 455), sourceUs: 48_000) == nil,
        "A written batch leaves nothing pending")

    // A window that moves opens a new epoch under unchanged output dimensions.
    let moved = window(atX: 140)
    precondition(
        track.observe(moved, hostUs: 60_000, sourceUs: nil, usable: true)?.epoch == 2,
        "A moved window opens the next epoch")
    let sealed = (track.accept(reading(hostUs: 65_000, x: 300, y: 455), sourceUs: 64_000) ?? []) + track.seal()
    precondition(
        sealed.map(\.geometryEpoch) == [1, 2],
        "A seal writes what is pending, under the epoch each sample was taken, got \(sealed)")
    precondition(
        sealed.last.map { $0.x == 320 && $0.y == 750 } == true,
        "A sample after the move follows the new geometry, got \(sealed.last as CursorSample?)")
    precondition(
        track.stats.sampled == 5 && track.stats.geometryEpochs == 2,
        "Sealed takes report what they recorded, got \(track.stats)")
    print("PASS a track flushes by take time and follows geometry epochs")

    // A frame reports its placement milliseconds after the moment it describes. Readings taken
    // after a window moved must not be projected onto the position it had just left.
    var late = CursorTrack(flushIntervalUs: 100_000_000)
    _ = late.observe(placed, hostUs: 0, sourceUs: nil, usable: true)
    _ = late.accept(reading(hostUs: 40_000, x: 300, y: 455), sourceUs: 40_000)
    _ = late.accept(reading(hostUs: 60_000, x: 300, y: 455), sourceUs: 60_000)
    precondition(
        late.observe(moved, hostUs: 50_000, sourceUs: nil, usable: true)?.epoch == 2,
        "A geometry delivered after the readings it explains still opens its epoch")
    let projected = late.seal()
    precondition(
        projected.map(\.geometryEpoch) == [1, 2],
        "Each reading uses the geometry in effect when it was taken, got \(projected)")
    precondition(
        projected[0].x == 400 && projected[1].x == 320,
        "A reading after the move is projected through the moved window, got \(projected)")
    print("PASS readings are projected through the geometry contemporaneous with them")

    // The sampler and frame producer enqueue independently. A reading taken before a move
    // may reach the capture queue just after the new geometry, even with no pending batch.
    var delayedReading = CursorTrack(flushIntervalUs: 0)
    _ = delayedReading.observe(placed, hostUs: 0, sourceUs: nil, usable: true)
    _ = delayedReading.accept(reading(hostUs: 10_000, x: 300, y: 455), sourceUs: 10_000)
    _ = delayedReading.observe(moved, hostUs: 50_000, sourceUs: nil, usable: true)
    let delayedBatch = delayedReading.accept(
        reading(hostUs: 40_000, x: 300, y: 455), sourceUs: 40_000)
    precondition(
        delayedBatch?.isEmpty == true,
        "An unchanged delayed reading must deduplicate under its known pre-move geometry, got \(String(describing: delayedBatch))"
    )
    print("PASS a delayed reading retains geometry across an empty batch")

    // A reading no observed geometry covers cannot claim an epoch it was never projected through.
    var unexplained = CursorTrack(flushIntervalUs: 0)
    _ = unexplained.observe(placed, hostUs: 50_000, sourceUs: nil, usable: true)
    guard
        let orphan = unexplained.accept(
            reading(hostUs: 10_000, x: 300, y: 455), sourceUs: 10_000)?.first
    else { preconditionFailure("A zero-interval test flushes on arrival") }
    precondition(
        orphan.eligibility == "unknownGeometry" && orphan.geometryEpoch == 0 && orphan.x == nil
            && orphan.globalX == 300,
        "An unplaced reading cites no epoch and keeps its raw global point, got \(orphan)")
    print("PASS a reading no geometry explains cites epoch 0 and keeps its global point")

    // Frames keep reporting geometry through a pause while the cadence is suspended, so the
    // delivered-reading watermark stops advancing. Retention is bounded by a count as well, and
    // the placements a resumed take needs are the newest ones.
    var churn = CursorTrack(flushIntervalUs: 0, placementLimit: 3)
    precondition(
        churn.accept(reading(hostUs: 0, x: 300, y: 455), sourceUs: nil) == nil,
        "A reading the paused clock refuses records no sample")
    for step in 1...6 {
        _ = churn.observe(
            window(atX: Double(100 + step * 10)), hostUs: Int64(step) * 10_000, sourceUs: nil,
            usable: true)
    }
    precondition(
        churn.stats.forgottenPlacements == 3 && churn.stats.geometryEpochs == 6,
        "Unclaimed geometry past the bound is forgotten and reported, got \(churn.stats)")
    guard
        let beforeBound = churn.accept(reading(hostUs: 15_000, x: 300, y: 455), sourceUs: 15_000)?
            .first,
        let withinBound = churn.accept(reading(hostUs: 55_000, x: 300, y: 455), sourceUs: 55_000)?
            .first
    else { preconditionFailure("A zero-interval test flushes on arrival") }
    precondition(
        beforeBound.eligibility == "unknownGeometry" && beforeBound.geometryEpoch == 0,
        "A reading older than every retained placement is unplaced, got \(beforeBound)")
    precondition(
        withinBound.geometryEpoch == 5 && withinBound.x == 300,
        "A reading inside the bound still follows the geometry it was taken under, got \(withinBound)"
    )
    print("PASS geometry retained across a suspended cadence is bounded from the old end")

    // Pauses: the take's own clock refuses readings, and nothing is invented for that time.
    var clock = CaptureClock()
    clock.start(at: 100_000_000)
    var paused = CursorTrack(flushIntervalUs: 100_000_000)
    _ = paused.observe(placed, hostUs: 100_000_000, sourceUs: nil, usable: true)
    let hosts: [Int64] = [
        100_000_000, 101_000_000, 102_500_000, 103_000_000, 104_000_000, 105_500_000, 106_000_000,
    ]
    for (index, hostUs) in hosts.enumerated() {
        if hostUs == 102_500_000 { clock.pause(at: 102_000_000) }
        if hostUs == 105_500_000 { clock.resume(at: 105_000_000) }
        _ = paused.accept(
            reading(hostUs: hostUs, x: 300 + Double(index), y: 455),
            sourceUs: clock.sourceTime(for: hostUs))
    }
    let recorded = paused.seal()
    precondition(
        recorded.map(\.sourceUs) == [0, 1_000_000, 2_500_000, 3_000_000],
        "Paused readings are omitted and resumed time removes the pause, got \(recorded)")
    precondition(
        paused.stats.omittedPaused == 3 && paused.stats.sampled == 4,
        "Omitted paused readings are counted, not backfilled, got \(paused.stats)")
    precondition(
        recorded.map(\.globalX) == [300, 301, 305, 306],
        "The gap keeps the movement that was observed, with nothing interpolated across it")
    print("PASS a paused take records no samples and reports the readings it dropped")

    // Missed cadence ticks are reported rather than reconstructed.
    precondition(
        CursorSampler.skippedTicks(elapsedUs: 16_667, intervalUs: 16_667) == 0
            && CursorSampler.skippedTicks(elapsedUs: 20_000, intervalUs: 16_667) == 0,
        "An on-time or slightly late tick owes nothing")
    precondition(
        CursorSampler.skippedTicks(elapsedUs: 33_334, intervalUs: 16_667) == 1
            && CursorSampler.skippedTicks(elapsedUs: 100_000, intervalUs: 16_667) == 5,
        "A late tick reports the readings the cadence owed")
    var gapped = CursorTrack(flushIntervalUs: 100_000_000)
    _ = gapped.observe(placed, hostUs: 0, sourceUs: nil, usable: true)
    _ = gapped.accept(reading(hostUs: 1_000, x: 300, y: 455, skipped: 4), sourceUs: 0)
    gapped.note(refusedReadings: 7)
    precondition(
        gapped.stats.skippedTicks == 4 && gapped.stats.droppedReadings == 7
            && gapped.seal().count == 1,
        "A gap is reported as skipped and refused readings, got \(gapped.stats)")
    print("PASS missed and refused readings are reported instead of filled in")

    try runGeometryPlacementTests()
    runCursorSamplerTests()
    try runCursorJournalTests()
    try runLiveMarkJournalTests()
}

private func runLiveMarkJournalTests() throws {
    let directory = RecoveryFixture.directory("live-marks")
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try CaptureWriter(
        request: CaptureRequest(
            source: CaptureSource(kind: "window", windowID: 1),
            outputDirectory: directory.path, microphone: false, systemAudio: false),
        width: 32, height: 32, sessionID: "live-marks", requestedSourceRect: nil,
        onFailure: { _ in })
    defer { writer.cancel() }
    let updates = MarkUpdates()
    writer.onMarkUpdate = { updates.list.append($0) }
    let origin = CaptureHostTime.nowUs()
    let geometry = CaptureGeometry(
        outputWidth: 32, outputHeight: 32,
        contentRect: GeometryRect(x: 0, y: 0, width: 16, height: 16), contentScale: 1,
        scaleFactor: 1, screenRect: GeometryRect(x: 100, y: 100, width: 16, height: 16),
        boundingRect: nil, requestedSourceRect: nil)
    writer.queue.sync { writer.ingest(liveMarkFrame(atHostUs: origin, geometry: geometry), of: .screen) }
    var expectedTrack = CursorTrack(flushIntervalUs: 0)
    _ = expectedTrack.observe(geometry, hostUs: origin, sourceUs: 0, usable: true)
    let expectedInside = expectedTrack.accept(
        CursorReading(hostUs: origin + 10, global: CGPoint(x: 105, y: 105), buttons: 0,
            zeroOriginHeight: 800), sourceUs: 10)?.first
    let expectedOutside = expectedTrack.accept(
        CursorReading(hostUs: origin + 20, global: CGPoint(x: 120, y: 105), buttons: 0,
            zeroOriginHeight: 800), sourceUs: 20)?.first
    writer.queue.sync {
        writer.accept(CursorReading(
            hostUs: origin - 1, global: CGPoint(x: 10, y: 10), buttons: 0,
            zeroOriginHeight: 800, shift: true, otherModifiers: false))
        writer.accept(CursorReading(
            hostUs: origin + 10, global: CGPoint(x: 105, y: 105), buttons: 0,
            zeroOriginHeight: 800, shift: true, otherModifiers: false))
        writer.accept(CursorReading(
            hostUs: origin + 20, global: CGPoint(x: 120, y: 105), buttons: 0,
            zeroOriginHeight: 800, shift: true, otherModifiers: false))
        writer.accept(CursorReading(
            hostUs: origin + 30, global: CGPoint(x: 120, y: 105), buttons: 0,
            zeroOriginHeight: 800, shift: false, otherModifiers: false))
    }
    var marks: [JournalMark] = []
    _ = try CaptureJournal.streamEvidence(directory: directory.path, mark: { marks.append($0) })
    precondition(marks.count == 1, "A replayed stroke is appended once, got \(marks.count)")
    precondition(
        marks[0].kind == "stroke" && marks[0].sourceUs == 10
            && marks[0].points.map(\.hostUs) == [origin + 10, origin + 20]
            && marks[0].points[0].x == expectedInside?.x
            && marks[0].points[0].y == expectedInside?.y
            && marks[0].points[1].x == nil && marks[0].points[1].y == nil
            && expectedOutside?.eligibility == "outside",
        "A live mark keeps source time and points, got \(marks)")
    // The overlay draws the stroke while ⇧ is held, then the recorded mark, and nothing else: a
    // reading that leaves the stroke as it was says nothing new.
    let first = MarkPoint(x: 105, y: 105, hostUs: origin + 10)
    let second = MarkPoint(x: 120, y: 105, hostUs: origin + 20)
    precondition(
        updates.list == [.liveStroke([first]), .liveStroke([first, second]), .committed(marks[0]), .liveStroke([])],
        "The overlay sees the live stroke grow, then the recorded mark, got \(updates.list)")
    try writer.undoMark()
    marks.removeAll()
    _ = try CaptureJournal.streamEvidence(directory: directory.path, mark: { marks.append($0) })
    precondition(
        marks.count == 2 && marks[1].retracts == marks[0].id && marks[1].points.isEmpty,
        "Undo appends a retracting mark without rewriting the original")
    precondition(updates.list.last == .retracted(marks[0].id), "The overlay hears which mark was undone")
    // Another stroke, then a pause: the paused take still takes the undo.
    writer.queue.sync {
        for (offset, x, shift) in [(40, 105, true), (50, 120, true), (60, 120, false)] as [(Int64, Double, Bool)] {
            writer.accept(CursorReading(
                hostUs: origin + offset, global: CGPoint(x: x, y: 105),
                buttons: 0, zeroOriginHeight: 800, shift: shift, otherModifiers: false))
        }
    }
    writer.pause()
    try writer.undoMark()
    marks.removeAll()
    _ = try CaptureJournal.streamEvidence(directory: directory.path, mark: { marks.append($0) })
    let live = marks.filter { $0.retracts == nil }
    precondition(
        marks.filter { $0.retracts != nil }.map(\.retracts) == [marks[0].id, live.last?.id]
            && live.count == 2,
        "Undo while paused retracts the latest mark, got \(marks)")
    print("PASS replayed cursor readings produce a source-timed journal mark and the overlay's stream")
}

/// What the writer told the overlay, in order. The writer calls it on its own queue, which the
/// test drives synchronously.
private final class MarkUpdates: @unchecked Sendable {
    var list: [CaptureMarkUpdate] = []
}

private func liveMarkFrame(atHostUs hostUs: Int64, geometry: CaptureGeometry) -> CMSampleBuffer {
    var pixel: CVPixelBuffer?
    CVPixelBufferCreate(nil, 32, 32, kCVPixelFormatType_32BGRA, nil, &pixel)
    var description: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: nil, imageBuffer: pixel!, formatDescriptionOut: &description)
    var timing = CMSampleTimingInfo(
        duration: CMTime(value: 33_333, timescale: 1_000_000),
        presentationTimeStamp: CMTime(value: hostUs, timescale: 1_000_000), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(
        allocator: nil, imageBuffer: pixel!, formatDescription: description!, sampleTiming: &timing,
        sampleBufferOut: &sample)
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample!, createIfNecessary: true)! as NSArray
    let info = attachments[0] as! NSMutableDictionary
    info[SCStreamFrameInfo.status.rawValue] = SCFrameStatus.complete.rawValue
    info[SCStreamFrameInfo.contentRect.rawValue] = geometry.contentRect.cgRect.dictionaryRepresentation
    info[SCStreamFrameInfo.scaleFactor.rawValue] = geometry.scaleFactor
    info[SCStreamFrameInfo.contentScale.rawValue] = geometry.contentScale
    info[SCStreamFrameInfo.screenRect.rawValue] = geometry.screenRect?.cgRect.dictionaryRepresentation
    return sample!
}

/// Polls a condition the cadence reaches on its own schedule, so a test waits for the behaviour
/// instead of pinning how many milliseconds this machine took to get there.
private func reached(within milliseconds: Int, _ ready: () -> Bool) -> Bool {
    var waited = 0
    while waited < milliseconds {
        if ready() { return true }
        Thread.sleep(forTimeInterval: 0.005)
        waited += 5
    }
    return ready()
}

/// A real `CursorSampler`, driving its own cadence. The sampler reads the pointer's position and
/// button state and nothing else: no input is synthesized, no window is opened and no screen
/// content is captured, so these observe only what a take already observes about the cursor.
private func runCursorSamplerTests() {
    let target = DispatchQueue(label: "com.dzhng.yap.cursor-sampler-lifecycle-test")
    let readings = Atomic<Int>(0)
    // Deliveries land on `target`; settling past one cadence interval and then draining that queue
    // leaves no reading in flight to arrive after a count is taken.
    func settled() -> Int {
        Thread.sleep(forTimeInterval: 0.05)
        target.sync {}
        return readings.load(ordering: .sequentiallyConsistent)
    }
    do {
        let sampler = CursorSampler(intervalUs: 20_000, pendingLimit: 240, target: target) { _ in
            readings.wrappingAdd(1, ordering: .sequentiallyConsistent)
        }
        sampler.start()
        precondition(
            reached(within: 2_000) { readings.load(ordering: .sequentiallyConsistent) >= 2 },
            "A started cadence delivers readings, got \(readings.load(ordering: .sequentiallyConsistent))"
        )
        sampler.suspend()
        let atSuspend = settled()
        Thread.sleep(forTimeInterval: 0.2)
        precondition(
            settled() == atSuspend,
            "A suspended cadence delivers nothing for ten intervals, got \(settled()) after \(atSuspend)"
        )
        sampler.resume()
        precondition(
            reached(within: 2_000) {
                readings.load(ordering: .sequentiallyConsistent) > atSuspend
            }, "A resumed cadence delivers again")
        sampler.stop()
        let atStop = settled()
        Thread.sleep(forTimeInterval: 0.2)
        precondition(
            settled() == atStop, "A stopped cadence delivers nothing more, got \(settled())")
        // A take seals and may then cancel, so stopping twice must not over-resume the source.
        sampler.stop()
    }
    // Leaving the scope releases a sampler that was suspended and then stopped. An unbalanced
    // suspend traps in libdispatch on dealloc, so reaching the next line is the balance proof.
    print("PASS a sampler's cadence starts, suspends, resumes and stops without leaking a suspend")

    // The bounded handoff, driven by the sampler rather than a hand-fed count: a capture queue
    // that stops draining holds exactly the bound and every further reading is refused.
    let blocked = DispatchQueue(label: "com.dzhng.yap.cursor-sampler-bound-test")
    let release = DispatchSemaphore(value: 0)
    let arrived = Atomic<Int>(0)
    let bounded = CursorSampler(intervalUs: 1_000, pendingLimit: 4, target: blocked) { _ in
        arrived.wrappingAdd(1, ordering: .sequentiallyConsistent)
    }
    blocked.async { release.wait() }
    bounded.start()
    precondition(
        reached(within: 2_000) { bounded.refusedReadings >= 8 },
        "A blocked capture queue refuses readings repeatedly, got \(bounded.refusedReadings)")
    precondition(
        arrived.load(ordering: .sequentiallyConsistent) == 0,
        "A blocked capture queue receives nothing while it is blocked")
    // Stop the cadence before unblocking, so what drains is exactly what was in flight.
    bounded.stop()
    release.signal()
    blocked.sync {}
    precondition(
        arrived.load(ordering: .sequentiallyConsistent) == 4,
        "Only the bound was ever in flight, got \(arrived.load(ordering: .sequentiallyConsistent))")
    print("PASS a blocked capture queue holds only the bound and refuses the rest")
}

private func runCursorJournalTests() throws {
    let directory = RecoveryFixture.directory("cursor-journal")
    defer { try? FileManager.default.removeItem(at: directory) }
    let journal = try CaptureJournal(
        directory: directory.path,
        header: CaptureJournalHeader(
            schemaVersion: 1, sessionID: "cursor",
            source: CaptureSource(kind: "window", windowID: 3),
            width: 1600, height: 1000, microphone: false, systemAudio: false))
    try journal.recordOrigin(hostUs: 1_000_000)
    try journal.recordDisplaySpace(hostUs: 1_000_000, zeroOriginHeight: 982)
    try journal.recordGeometry(epoch: 1, hostUs: 1_000_000, sourceUs: 0, geometry: placed)
    var track = CursorTrack(flushIntervalUs: 16_000)
    _ = track.observe(placed, hostUs: 1_000_000, sourceUs: nil, usable: true)
    _ = track.accept(reading(hostUs: 1_000_000, x: 300, y: 455), sourceUs: 0)
    guard let batch = track.accept(reading(hostUs: 1_016_000, x: 0, y: 0), sourceUs: 16_000) else {
        preconditionFailure("The take-time deadline flushes pending readings")
    }
    try journal.recordCursorSamples(batch)
    try journal.recordGeometry(epoch: 2, hostUs: 1_100_000, sourceUs: nil, geometry: letterboxed)

    let summary = try CaptureJournal.inspect(directory: directory.path)
    precondition(
        summary.cursorSamples == 2 && summary.firstCursorSourceUs == 0
            && summary.lastCursorSourceUs == 16_000,
        "A summary reports the cursor range without retaining samples, got \(summary)")
    precondition(
        summary.geometryEpochs == 2 && summary.lastGeometry == letterboxed,
        "A summary keeps the take's last geometry and epoch count")
    precondition(
        summary.invalidAtSequence == nil && !summary.incompleteTail
            && summary.originHostUs == 1_000_000,
        "Cursor records must not disturb the acquisition boundaries around them")
    precondition(
        summary.zeroOriginHeight == 982,
        "A summary reports the height the take converted readings through, got \(summary.zeroOriginHeight as Double?)"
    )

    var events: [JournalGeometry] = []
    var streamed: [CursorSample] = []
    var spaces: [JournalDisplaySpace] = []
    let streamedSummary = try CaptureJournal.streamEvidence(
        directory: directory.path, geometry: { events.append($0) },
        samples: { streamed.append(contentsOf: $0) }, displaySpace: { spaces.append($0) })
    precondition(
        spaces.map(\.zeroOriginHeight) == [982] && spaces.map(\.hostUs) == [1_000_000],
        "The height a reading was flipped through reads back through the stream, got \(spaces)")
    precondition(
        streamedSummary.invalidAtSequence == nil && !streamedSummary.incompleteTail
            && streamedSummary.cursorSamples == 2,
        "One pass reports the evidence and that the journal was believable to its end")
    precondition(
        events.map(\.epoch) == [1, 2] && events.map(\.sourceUs) == [0, nil],
        "Streamed geometry keeps its epochs and the source time each was seen at")
    precondition(
        events[0].geometry == placed && events[1].geometry.contentScale == 0.8,
        "Streamed geometry carries the raw evidence the transform came from")
    precondition(
        streamed == batch, "Streamed samples read back exactly as written, got \(streamed)")

    // Evidence after a record that will not decode is not believed by either reader.
    let url = directory.appendingPathComponent("capture.journal.jsonl")
    var lines = try String(contentsOf: url, encoding: .utf8).split(
        separator: "\n", omittingEmptySubsequences: false
    ).map(String.init)
    precondition(lines[4].contains("\"event\":\"cursorSamples\""), "Fixture holds the batch record")
    lines[4] = lines[4].replacingOccurrences(of: "\"sourceUs\":0", with: "\"sourceUs\":\"0\"")
    try lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    var afterBadRecord: [CursorSample] = []
    var geometryAfterBadRecord: [JournalGeometry] = []
    // The same pass that streams the evidence names where it stopped, so a caller never has to
    // re-read the file to tell a stream that stopped early from a short take.
    let corrupted = try CaptureJournal.streamEvidence(
        directory: directory.path, geometry: { geometryAfterBadRecord.append($0) },
        samples: { afterBadRecord.append(contentsOf: $0) })
    precondition(
        corrupted.invalidAtSequence == 5 && !corrupted.incompleteTail,
        "The corrupted fixture names its bad record, got \(corrupted.invalidAtSequence as Int?)")
    precondition(
        afterBadRecord.isEmpty && geometryAfterBadRecord.map(\.epoch) == [1],
        "A stream stops where the summary stops believing the journal, got \(afterBadRecord.count) samples"
    )
    print("PASS geometry and cursor evidence round-trip through the journal")
}

private func runGeometryPlacementTests() throws {
    var clock = CaptureClock()
    var track = CursorTrack(flushIntervalUs: 100_000_000)
    let directory = RecoveryFixture.directory("geometry-placement")
    defer { try? FileManager.default.removeItem(at: directory) }
    let journal = try CaptureJournal(
        directory: directory.path,
        header: CaptureJournalHeader(
            schemaVersion: 1, sessionID: "placement",
            source: CaptureSource(kind: "window", windowID: 3),
            width: 1600, height: 1000, microphone: false, systemAudio: false))
    func observe(_ geometry: CaptureGeometry, at hostUs: Int64, usable: Bool) throws
        -> JournalGeometry?
    {
        let event = track.observe(
            geometry, hostUs: hostUs, sourceUs: clock.sourceTime(for: hostUs), usable: usable)
        if let event {
            try journal.recordGeometry(
                epoch: event.epoch, hostUs: event.hostUs, sourceUs: event.sourceUs,
                geometry: event.geometry
            )
        }
        return event
    }
    let prologue = try observe(placed, at: 10, usable: false)
    precondition(prologue?.epoch == 1 && prologue?.sourceUs == nil)
    let unchanged1 = try observe(placed, at: 20, usable: false)
    precondition(unchanged1 == nil)
    clock.start(at: 100)
    try journal.recordOrigin(hostUs: 100)
    let first = try observe(placed, at: 100, usable: true)
    precondition(
        first?.epoch == 1 && first?.sourceUs == 0,
        "An unchanged first usable frame must place its prologue epoch at source zero")
    let unchanged2 = try observe(placed, at: 150, usable: true)
    precondition(
        unchanged2 == nil,
        "An already placed epoch does not repeat for every frame")
    _ = track.accept(reading(hostUs: 150, x: 300, y: 455), sourceUs: clock.sourceTime(for: 150))
    clock.pause(at: 200)
    try journal.recordPauseBegan(hostUs: 200)
    let resize = try observe(letterboxed, at: 250, usable: false)
    let moved = try observe(aboveOrigin, at: 260, usable: false)
    precondition(
        resize?.epoch == 2 && resize?.sourceUs == nil && moved?.epoch == 3 && moved?.sourceUs == nil
    )
    let unchanged3 = try observe(aboveOrigin, at: 270, usable: true)
    precondition(
        unchanged3 == nil,
        "Usable pixels during a pause cannot place a pending geometry epoch")
    clock.resume(at: 400)
    try journal.recordPauseEnded(hostUs: 400, pause: clock.pauses.last)
    let unchanged4 = try observe(aboveOrigin, at: 410, usable: false)
    precondition(
        unchanged4 == nil,
        "An unchanged idle frame after resume is not the first usable placement")
    let resumed = try observe(aboveOrigin, at: 420, usable: true)
    precondition(
        resumed?.epoch == 3 && resumed?.sourceUs == 120,
        "The resumed usable frame places only the current epoch, using pause-adjusted source time")
    _ = track.accept(reading(hostUs: 425, x: -250, y: -1400), sourceUs: clock.sourceTime(for: 425))
    let activeIdle = try observe(letterboxed, at: 430, usable: false)
    precondition(
        activeIdle?.epoch == 4 && activeIdle?.sourceUs == 130,
        "New geometry observed on active idle frames retains its known source coordinate")
    let unchanged5 = try observe(letterboxed, at: 440, usable: true)
    precondition(unchanged5 == nil)
    let samples = track.seal()
    precondition(
        samples.map(\.geometryEpoch) == [1, 3] && samples.map(\.sourceUs) == [50, 125],
        "Delayed cursor batches retain the actual observed epoch, not the latest journal entry")
    try journal.recordCursorSamples(samples)
    precondition(
        track.stats.geometryEpochs == 4,
        "Timed placement of the same epoch is not a geometry change")
    var events: [JournalGeometry] = []
    var readSamples: [CursorSample] = []
    let summary = try CaptureJournal.streamEvidence(
        directory: directory.path,
        geometry: { events.append($0) }, samples: { readSamples.append(contentsOf: $0) })
    precondition(events.map(\.epoch) == [1, 1, 2, 3, 3, 4])
    precondition(events.map(\.sourceUs) == [nil, 0, nil, nil, 120, 130])
    precondition(events.map(\.hostUs) == [10, 100, 250, 260, 420, 430])
    precondition(
        summary.invalidAtSequence == nil && summary.geometryEpochs == 4 && readSamples == samples)
    print(
        "PASS unplaced geometry epochs gain one native timed placement without rewriting raw evidence"
    )
}


func runChangeOnlyCursorTests() throws {
    var track = CursorTrack()
    _ = track.observe(placed, hostUs: 0, sourceUs: 0, usable: true)
    var samples: [CursorSample] = []
    for i in 0..<600 {
        let at = Int64(i) * 1_000_000 / 60
        if let batch = track.accept(reading(hostUs: at, x: 300, y: 455), sourceUs: at) {
            samples += batch
        }
    }
    samples += track.seal()
    precondition(samples.count == 1 && samples[0].sourceUs == 0 && samples[0].x == 400 && samples[0].y == 750,
        "Ten still seconds write exactly the first projected sample; got \(samples.count)")
    precondition(track.stats.sampled == 600)
    var changes = CursorTrack()
    _ = changes.accept(reading(hostUs: 0, x: 1, y: 2), sourceUs: 0)
    _ = changes.accept(reading(hostUs: 100, x: 9, y: 8), sourceUs: 100)
    _ = changes.observe(placed, hostUs: 200, sourceUs: 200, usable: true)
    _ = changes.accept(reading(hostUs: 200, x: 300, y: 455), sourceUs: 200)
    _ = changes.accept(reading(hostUs: 300, x: 301, y: 455), sourceUs: 300)
    _ = changes.accept(reading(hostUs: 400, x: 301, y: 455, buttons: 1), sourceUs: 400)
    _ = changes.accept(reading(hostUs: 500, x: 301, y: 455, buttons: 1), sourceUs: 500)
    _ = changes.observe(window(atX: 140), hostUs: 600, sourceUs: 600, usable: true)
    _ = changes.accept(reading(hostUs: 600, x: 341, y: 455, buttons: 1), sourceUs: 600)
    _ = changes.accept(reading(hostUs: 700, x: 0, y: 455, buttons: 1), sourceUs: 700)
    let transitions = changes.flush(through: 500_000)
    precondition(transitions.map(\.sourceUs) == [0, 200, 300, 400, 600, 700])
    precondition(transitions.map(\.x) == [nil, 400, 402, 402, 402, -280])
    precondition(transitions.map(\.eligibility) == ["unknownGeometry", "inside", "inside", "inside", "inside", "outside"])
    precondition(transitions.map(\.geometryEpoch) == [0, 1, 1, 1, 2, 2])
    precondition(transitions.map(\.buttons) == [0, 0, 0, 1, 1, 1])
    _ = changes.accept(reading(hostUs: 500_100, x: 0, y: 455, buttons: 1), sourceUs: 500_100)
    precondition(changes.flush(through: 999_999).isEmpty)
    precondition(changes.flush(through: 1_000_000).isEmpty,
        "Deduplication must retain the last written state across flushes")
    changes.resume()
    _ = changes.accept(reading(hostUs: 1_000_100, x: 0, y: 455, buttons: 1), sourceUs: 1_000_100)
    precondition(changes.seal().map(\.sourceUs) == [1_000_100], "Resume must force its first reading")
    print("PASS projected changes, cross-flush holds and forced resume retain exact observations")
    precondition(track.stats.written == 1)
    print("PASS ten still seconds: 600 readings, one written sample")

    let directory = RecoveryFixture.directory("cursor-flush-clock")
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try CaptureWriter(request: CaptureRequest(source: CaptureSource(kind: "window", windowID: 1),
        outputDirectory: directory.path, microphone: false, systemAudio: false), width: 32, height: 32,
        sessionID: "cursor-flush", requestedSourceRect: nil, onFailure: { _ in })
    defer { writer.cancel() }
    let origin = CaptureHostTime.nowUs()
    let geometry = CaptureGeometry(outputWidth: 32, outputHeight: 32,
        contentRect: GeometryRect(x: 0, y: 0, width: 32, height: 32), contentScale: 1,
        scaleFactor: 1, screenRect: GeometryRect(x: 0, y: 0, width: 32, height: 32),
        boundingRect: nil, requestedSourceRect: nil)
    writer.queue.sync {
        writer.ingest(liveMarkFrame(atHostUs: origin, geometry: geometry), of: .screen)
        writer.accept(CursorReading(hostUs: origin + 1, global: CGPoint(x: 10, y: 20), buttons: 0,
            zeroOriginHeight: 800))
    }
    // No sampler and no additional hardware readings: take time alone must publish the sample.
    Thread.sleep(forTimeInterval: 0.6)
    writer.queue.sync {}
    var written: [CursorSample] = []
    _ = try CaptureJournal.streamEvidence(directory: directory.path, samples: { written += $0 })
    precondition(written.count == 1 && written[0].x == 10 && written[0].sourceUs == 1,
        "The 500 ms take-time flush must not wait for another reading; got \(written)")
    print("PASS a 500 ms flush publishes without another hardware reading")
    writer.pause()
    Thread.sleep(forTimeInterval: 0.1)
    writer.resume()
    writer.queue.sync {
        writer.accept(CursorReading(hostUs: CaptureHostTime.nowUs(), global: CGPoint(x: 10, y: 20),
            buttons: 0, zeroOriginHeight: 800))
    }
    Thread.sleep(forTimeInterval: 0.5)
    writer.seal()
    written = []
    let summary = try CaptureJournal.streamEvidence(directory: directory.path, samples: { written += $0 })
    precondition(written.count == 2 && written.allSatisfy { $0.x == 10 && $0.y == 20 },
        "The production resume must preserve a still pointer's first reading")
    precondition(summary.header?.cursorSampling?.holds == true)
    print("PASS the production writer forces a resumed still pointer and declares holds")
}
