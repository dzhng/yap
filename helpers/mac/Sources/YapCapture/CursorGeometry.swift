import AppKit
import CoreGraphics
import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit
import Synchronization

/// Journaled rectangle evidence. Values are points unless the owning field names pixels.
public struct GeometryRect: Codable, Sendable, Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
    public init(_ rect: CGRect) {
        self.init(
            x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height)
    }
    public var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

/// Where captured content sat inside one output surface while a frame was delivered.
///
/// The fields mirror the contemporaneous `SCStreamFrameInfo` attachments of that frame, so a
/// consumer can re-derive the transform from raw evidence instead of trusting this type's
/// arithmetic. `contentRect` places the content inside the surface in points; multiplying by
/// `scaleFactor` gives output pixels. `contentScale` is the source-point to surface-point ratio,
/// so a window that grows past the surface is letterboxed rather than rescaling the output.
/// Fixed output dimensions therefore do not imply fixed source geometry.
public struct CaptureGeometry: Codable, Sendable, Equatable {
    public init(
        outputWidth: Int, outputHeight: Int, contentRect: GeometryRect, contentScale: Double,
        scaleFactor: Double, screenRect: GeometryRect?, boundingRect: GeometryRect?,
        requestedSourceRect: GeometryRect?
    ) {
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
        self.contentRect = contentRect
        self.contentScale = contentScale
        self.scaleFactor = scaleFactor
        self.screenRect = screenRect
        self.boundingRect = boundingRect
        self.requestedSourceRect = requestedSourceRect
    }

    /// Reads a delivered frame's own placement metadata. Idle and blank frames carry it too, so a
    /// take keeps learning where its source is even while nothing is being written.
    public init?(
        frameInfo: [SCStreamFrameInfo: Any], outputWidth: Int, outputHeight: Int,
        requestedSourceRect: CGRect?
    ) {
        guard
            let contentRect = (frameInfo[.contentRect] as? NSDictionary).flatMap({
                CGRect(dictionaryRepresentation: $0)
            })
        else { return nil }
        self.init(
            outputWidth: outputWidth, outputHeight: outputHeight,
            contentRect: GeometryRect(contentRect),
            contentScale: (frameInfo[.contentScale] as? NSNumber)?.doubleValue ?? 1,
            scaleFactor: (frameInfo[.scaleFactor] as? NSNumber)?.doubleValue ?? 1,
            screenRect: (frameInfo[.screenRect] as? NSDictionary).flatMap {
                CGRect(dictionaryRepresentation: $0)
            }.map(GeometryRect.init),
            boundingRect: (frameInfo[.boundingRect] as? NSDictionary).flatMap {
                CGRect(dictionaryRepresentation: $0)
            }.map(GeometryRect.init), requestedSourceRect: requestedSourceRect.map(GeometryRect.init)
        )
    }

    public let outputWidth: Int
    public let outputHeight: Int
    public let contentRect: GeometryRect
    public let contentScale: Double
    public let scaleFactor: Double
    /// Onscreen location of the captured content for this frame. A window reports where it moved.
    public let screenRect: GeometryRect?
    public let boundingRect: GeometryRect?
    /// The onscreen rect the request fixed before streaming: display bounds, or a display-local
    /// region offset into them. A window capture has none, because only the stream knows where the
    /// window is now.
    public let requestedSourceRect: GeometryRect?

    /// The onscreen rect this frame's content came from, preferring the frame's own report.
    public var sourceRect: GeometryRect? { screenRect ?? requestedSourceRect }

    /// The content area inside the output surface, in output pixels.
    public var contentPixels: GeometryRect {
        GeometryRect(
            x: contentRect.x * scaleFactor, y: contentRect.y * scaleFactor,
            width: contentRect.width * scaleFactor, height: contentRect.height * scaleFactor)
    }

    /// Where a global display point lands in output pixels, or nil when no frame has explained
    /// this surface yet. Never clamped: a point outside the capture keeps coordinates outside
    /// `contentPixels`, so a consumer sees that the pointer left rather than finding it parked on
    /// an edge it never touched.
    public func outputPixel(forGlobalPoint point: CGPoint) -> CGPoint? {
        guard let source = sourceRect, contentScale > 0, scaleFactor > 0,
            point.x.isFinite, point.y.isFinite
        else { return nil }
        return CGPoint(
            x: ((point.x - source.x) * contentScale + contentRect.x) * scaleFactor,
            y: ((point.y - source.y) * contentScale + contentRect.y) * scaleFactor)
    }

    /// Whether an output pixel is inside both the drawn content and the surface. This is capture
    /// eligibility, not an OS report that the pointer is being drawn: macOS has not supported a
    /// reliable global cursor-visibility read since 10.9, and this take renders no cursor at all.
    public func contains(outputPixel pixel: CGPoint) -> Bool {
        let content = contentPixels
        return pixel.x >= content.x && pixel.x < content.x + content.width && pixel.y >= content.y
            && pixel.y < content.y + content.height && pixel.x >= 0 && pixel.y >= 0
            && pixel.x < Double(outputWidth) && pixel.y < Double(outputHeight)
    }
}

/// One pointer reading, before it is placed in a take's source time.
/// Modifier state and clicks only, never keys.
public struct CursorReading: Sendable, Equatable {
    public init(
        hostUs: Int64, global: CGPoint, buttons: Int, zeroOriginHeight: Double,
        skippedTicks: Int = 0, shift: Bool = false, otherModifiers: Bool = false
    ) {
        self.hostUs = hostUs
        self.global = global
        self.buttons = buttons
        self.zeroOriginHeight = zeroOriginHeight
        self.skippedTicks = skippedTicks
        self.shift = shift
        self.otherModifiers = otherModifiers
    }

    public let hostUs: Int64
    /// Global display points with a top-left origin, converted from AppKit's bottom-left space.
    public let global: CGPoint
    /// `NSEvent.pressedMouseButtons` bitmask.
    public let buttons: Int
    public let shift: Bool
    public let otherModifiers: Bool
    /// Height of the zero-origin display used for that conversion, retained as raw evidence.
    public let zeroOriginHeight: Double
    /// Cadence ticks missed before this reading. Missed ticks stay missing, never interpolated.
    public let skippedTicks: Int
}

/// A journaled pointer sample in one take's coordinates.
public struct CursorSample: Codable, Sendable, Equatable {
    public init(
        sourceUs: Int64, x: Double?, y: Double?, globalX: Double, globalY: Double, buttons: Int,
        eligibility: String, geometryEpoch: Int
    ) {
        self.sourceUs = sourceUs
        self.x = x
        self.y = y
        self.globalX = globalX
        self.globalY = globalY
        self.buttons = buttons
        self.eligibility = eligibility
        self.geometryEpoch = geometryEpoch
    }

    public let sourceUs: Int64
    /// Output pixels, unclamped. Absent only when no frame has explained the surface yet.
    public let x: Double?
    public let y: Double?
    /// The raw global display point this sample was derived from, so a later reader can check the
    /// transform instead of inheriting it.
    public let globalX: Double
    public let globalY: Double
    public let buttons: Int
    /// `inside`, `outside`, or `unknownGeometry`. See `CaptureGeometry.contains(outputPixel:)`.
    public let eligibility: String
    /// The epoch whose geometry projected this sample, or 0 when none covered the reading. An
    /// `unknownGeometry` sample never cites a real epoch it was not projected through.
    public let geometryEpoch: Int

    public var visible: Bool { eligibility == "inside" }
}

public struct CursorStats: Codable, Sendable, Equatable {
    public init() {}
    /// Readings placed in source time, including unchanged readings.
    public var sampled = 0
    /// Projected changes handed to the journal.
    public var written = 0
    /// Readings that landed in a pause or before source zero: omitted, never backfilled.
    public var omittedPaused = 0
    /// Cadence ticks the sampler queue missed.
    public var skippedTicks = 0
    /// Readings the bounded handoff refused because the capture queue was behind.
    public var droppedReadings = 0
    /// Geometry placements the counted retention bound discarded before any reading claimed them.
    /// A reading older than every placement left cites epoch 0 rather than a placement that does
    /// not cover it.
    public var forgottenPlacements = 0
    public var geometryEpochs = 0
}

/// Places pointer readings in one take's source time and batches them for the journal.
///
/// It owns geometry epochs for the take: an observation that differs from the current one starts a
/// new epoch. A reading is projected when its batch is written rather than when it arrives, because
/// a frame reports its placement some milliseconds after the moment it describes; projecting on
/// arrival would credit readings taken after a window moved to the position it just left. It never
/// invents a reading for a tick that did not happen, and a paused take records nothing.
public struct CursorTrack: Sendable {
    public static let defaultFlushIntervalUs: Int64 = 500_000
    public init(flushIntervalUs: Int64 = Self.defaultFlushIntervalUs, placementLimit: Int = 240) {
        self.flushIntervalUs = flushIntervalUs
        self.nextFlushUs = flushIntervalUs
        self.placementLimit = max(1, placementLimit)
    }

    private struct Placed {
        let hostUs: Int64
        let epoch: Int
        let geometry: CaptureGeometry
    }
    private struct Pending {
        let reading: CursorReading
        let sourceUs: Int64
        let force: Bool
    }

    private let flushIntervalUs: Int64
    private var nextFlushUs: Int64
    private var forceNext = true
    private var lastWritten: CursorSample?
    // Live working set only; forgotten placements remain explicit in the statistics.
    private let placementLimit: Int
    private var placements: [Placed] = []
    private var pending: [Pending] = []
    /// The newest reading the track has actually been handed, in host time.
    private var lastReadingHostUs: Int64?
    public private(set) var stats = CursorStats()
    public private(set) var epoch = 0
    public private(set) var geometry: CaptureGeometry?

    private var geometryHasSourcePlacement = false

    package struct Projection: Sendable {
        package let pixel: CGPoint?
        package let inside: Bool
        package let epoch: Int
    }

    /// Projects a global point through the same geometry placement used for cursor samples.
    package func projection(forGlobalPoint point: CGPoint, hostUs: Int64) -> Projection {
        let placed = placements.last { $0.hostUs <= hostUs }
        let pixel = placed?.geometry.outputPixel(forGlobalPoint: point)
        guard let pixel, let placed else {
            return Projection(pixel: nil, inside: false, epoch: 0)
        }
        return Projection(
            pixel: pixel, inside: placed.geometry.contains(outputPixel: pixel), epoch: placed.epoch)
    }

    /// Records geometry changes even before source zero or during a pause. An epoch first seen
    /// without source time gains one additional observation on a usable, clock-accepted frame.
    /// That placement confirms the same epoch; it does not rewrite its raw host-time observation.
    public mutating func observe(
        _ observed: CaptureGeometry, hostUs: Int64, sourceUs: Int64?, usable: Bool
    ) -> JournalGeometry? {
        if observed != geometry {
            geometry = observed
            epoch += 1
            stats.geometryEpochs = epoch
            placements.append(Placed(hostUs: hostUs, epoch: epoch, geometry: observed))
            forgetSupersededPlacements()
            geometryHasSourcePlacement = sourceUs != nil
        } else {
            guard !geometryHasSourcePlacement, usable, sourceUs != nil else { return nil }
            geometryHasSourcePlacement = true
        }
        return JournalGeometry(epoch: epoch, hostUs: hostUs, sourceUs: sourceUs, geometry: observed)
    }

    /// Accepts every reading; elapsed take time, rather than changes, drives flushing.
    /// `sourceUs` is nil when the take's clock refuses the reading's host time.
    public mutating func accept(_ reading: CursorReading, sourceUs: Int64?) -> [CursorSample]? {
        lastReadingHostUs = reading.hostUs
        stats.skippedTicks += reading.skippedTicks
        guard let sourceUs else {
            forceNext = true
            stats.omittedPaused += 1
            return nil
        }
        pending.append(Pending(reading: reading, sourceUs: sourceUs, force: forceNext))
        forceNext = false
        stats.sampled += 1
        guard sourceUs >= nextFlushUs else { return nil }
        return flush(through: sourceUs)
    }

    /// The capture clock calls this even when no further readings arrive.
    public mutating func flush(through sourceUs: Int64) -> [CursorSample] {
        guard sourceUs >= nextFlushUs else { return [] }
        nextFlushUs = flushIntervalUs > 0
            ? (sourceUs / flushIntervalUs + 1) * flushIntervalUs : sourceUs
        return writePending()
    }

    /// Resume has its own first observation, even when its projected state is unchanged.
    public mutating func resume() { forceNext = true }

    /// Records how many readings the sampler's bounded handoff refused, so one type reports the
    /// take's cursor evidence.
    public mutating func note(refusedReadings: Int) { stats.droppedReadings = refusedReadings }

    /// Returns whatever has not been written yet. The capture writer stops handing readings and
    /// frames to a track once its take is finishing, and a restarted take uses a new track.
    public mutating func seal() -> [CursorSample] { writePending() }

    private mutating func writePending() -> [CursorSample] {
        defer {
            pending = []
            forgetSupersededPlacements()
        }
        var samples: [CursorSample] = []
        for item in pending {
            let sample = project(item)
            if !item.force, let last = lastWritten,
                sample.x == last.x, sample.y == last.y, sample.buttons == last.buttons,
                sample.eligibility == last.eligibility, sample.geometryEpoch == last.geometryEpoch {
                continue
            }
            samples.append(sample)
            lastWritten = sample
        }
        stats.written += samples.count
        return samples
    }

    private func project(_ item: Pending) -> CursorSample {
        let projection = projection(
            forGlobalPoint: item.reading.global, hostUs: item.reading.hostUs)
        let eligibility = projection.pixel == nil
            ? "unknownGeometry" : (projection.inside ? "inside" : "outside")
        return CursorSample(
            sourceUs: item.sourceUs, x: projection.pixel.map { Double($0.x) },
            y: projection.pixel.map { Double($0.y) },
            globalX: item.reading.global.x, globalY: item.reading.global.y,
            buttons: item.reading.buttons, eligibility: eligibility,
            geometryEpoch: projection.epoch)
    }

    /// Sampler readings arrive in their own timestamp order, independently of frames. An empty
    /// batch does not mean an older reading is not still in flight; only a reading the track has
    /// actually been handed advances the point before which geometry can be forgotten.
    ///
    /// That watermark stops advancing while the cadence is suspended, and frames keep reporting
    /// geometry through a pause, so retention is bounded by a count as well: past `placementLimit`
    /// the oldest placements are forgotten and reported. The newest placements are the ones a
    /// resumed take needs, so the bound drops from the old end.
    private mutating func forgetSupersededPlacements() {
        if let oldest = pending.first?.reading.hostUs ?? lastReadingHostUs {
            var superseded = 0
            for (index, placed) in placements.enumerated() where placed.hostUs <= oldest {
                superseded = index
            }
            if superseded > 0 { placements.removeFirst(superseded) }
        }
        if placements.count > placementLimit {
            let excess = placements.count - placementLimit
            placements.removeFirst(excess)
            stats.forgottenPlacements += excess
        }
    }
}

/// Global point conversion. AppKit reports the pointer in a bottom-left space anchored to the
/// display at the global origin, which is not necessarily `NSScreen.main`: that one follows the
/// key window and would silently flip against the wrong height.
public enum GlobalPointSpace {
    public static func flip(appKit point: CGPoint, zeroOriginHeight: Double) -> CGPoint {
        CGPoint(x: point.x, y: zeroOriginHeight - point.y)
    }

    /// Height of the display whose global origin is zero, measured in points.
    public static func zeroOriginHeight() -> Double {
        var displays = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        if CGGetActiveDisplayList(UInt32(displays.count), &displays, &count) == .success {
            for display in displays.prefix(Int(count)) {
                let bounds = CGDisplayBounds(display)
                if bounds.origin == .zero { return bounds.height }
            }
        }
        return CGDisplayBounds(CGMainDisplayID()).height
    }
}

/// Reads the pointer at a fixed cadence while a take is recording.
///
/// Readings come from `NSEvent`'s current pointer state: modifier state and clicks only, never keys;
/// no Accessibility authorization. Sampling runs on its own queue so a busy capture queue delays
/// the write, not the reading, and the handoff is bounded: once the capture queue is that far
/// behind, further readings are refused and counted instead of queueing without limit.
///
/// `NSEvent.mouseLocation`, `NSEvent.pressedMouseButtons` and modifier state are read off the main
/// thread. All are current-state class reads rather than main-actor UI state, and AppKit does not document them as
/// main-thread-only; the lab measured the cadence working from this queue, which is evidence that
/// it works on this host rather than a guarantee from the platform.
public final class CursorSampler: Sendable {
    public init(
        intervalUs: Int64 = CursorSampling.defaultIntervalUs, pendingLimit: Int = 240, target: DispatchQueue,
        deliver: @escaping @Sendable (CursorReading) -> Void
    ) {
        self.intervalUs = intervalUs
        self.pendingLimit = pendingLimit
        self.target = target
        self.deliver = deliver
        timer = DispatchSource.makeTimerSource(queue: queue)
        timer.setEventHandler { [weak self] in self?.tick() }
    }

    private let queue = DispatchQueue(label: "com.dzhng.yap.cursor-sampler")
    private let timer: any DispatchSourceTimer
    private let intervalUs: Int64
    // Instantaneous backpressure: 240 / 60 = four seconds of in-flight readings.
    private let pendingLimit: Int
    private let target: DispatchQueue
    private let deliver: @Sendable (CursorReading) -> Void
    private let refused = Atomic<Int>(0)
    private let pending = Atomic<Int>(0)
    private let running = Atomic<Bool>(false)
    private let stopped = Atomic<Bool>(false)
    private let lastTickUs = Atomic<Int64>(0)

    /// Starts or resumes the cadence. Sampling exists only while a take is actually recording.
    public func start() {
        guard !running.exchange(true, ordering: .sequentiallyConsistent) else { return }
        lastTickUs.store(0, ordering: .sequentiallyConsistent)
        timer.schedule(
            deadline: .now(), repeating: .microseconds(Int(intervalUs)),
            leeway: .milliseconds(2))
        timer.activate()
    }

    /// Stops the cadence without cancelling the source, so a resumed take keeps one sampler.
    public func suspend() {
        guard running.exchange(false, ordering: .sequentiallyConsistent) else { return }
        timer.suspend()
    }

    public func resume() {
        guard !running.exchange(true, ordering: .sequentiallyConsistent) else { return }
        lastTickUs.store(0, ordering: .sequentiallyConsistent)
        timer.resume()
    }

    /// Ends the cadence for good. A take seals once and then finishes, so stopping twice must not
    /// over-resume the suspended source.
    public func stop() {
        guard !stopped.exchange(true, ordering: .sequentiallyConsistent) else { return }
        if !running.exchange(false, ordering: .sequentiallyConsistent) { timer.resume() }
        timer.cancel()
    }

    /// Readings the bounded handoff refused because the capture queue was that far behind.
    public var refusedReadings: Int { refused.load(ordering: .sequentiallyConsistent) }

    private func tick() {
        let hostUs = CaptureHostTime.nowUs()
        let previous = lastTickUs.exchange(hostUs, ordering: .sequentiallyConsistent)
        let skipped = previous == 0 ? 0 : CursorSampler.skippedTicks(
            elapsedUs: hostUs - previous, intervalUs: intervalUs)
        guard
            pending.wrappingAdd(1, ordering: .sequentiallyConsistent).oldValue < pendingLimit
        else {
            pending.wrappingSubtract(1, ordering: .sequentiallyConsistent)
            refused.wrappingAdd(1, ordering: .sequentiallyConsistent)
            return
        }
        let height = GlobalPointSpace.zeroOriginHeight()
        let reading = CursorReading(
            hostUs: hostUs,
            global: GlobalPointSpace.flip(appKit: NSEvent.mouseLocation, zeroOriginHeight: height),
            buttons: NSEvent.pressedMouseButtons, zeroOriginHeight: height, skippedTicks: skipped,
            shift: NSEvent.modifierFlags.contains(.shift),
            otherModifiers: !NSEvent.modifierFlags.subtracting(.shift).isEmpty)
        target.async { [self] in
            deliver(reading)
            pending.wrappingSubtract(1, ordering: .sequentiallyConsistent)
        }
    }

    /// Ticks the cadence owed but did not deliver. A late tick is a gap in evidence, and the gap is
    /// reported rather than filled with movement nobody observed.
    public static func skippedTicks(elapsedUs: Int64, intervalUs: Int64) -> Int {
        guard intervalUs > 0, elapsedUs > intervalUs + intervalUs / 2 else { return 0 }
        return Int((elapsedUs + intervalUs / 2) / intervalUs) - 1
    }
}

public enum CaptureHostTime {
    public static func nowUs() -> Int64 {
        CMTimeConvertScale(
            CMClockGetTime(CMClockGetHostTimeClock()), timescale: 1_000_000,
            method: .roundHalfAwayFromZero
        ).value
    }
}
