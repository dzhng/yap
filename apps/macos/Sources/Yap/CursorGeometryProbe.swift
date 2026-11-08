import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import YapCapture
import UniformTypeIdentifiers
import VideoToolbox

struct ProbeRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    init(_ rect: CGRect) {
        x = rect.origin.x
        y = rect.origin.y
        width = rect.size.width
        height = rect.size.height
    }
    var nsRect: NSRect { NSRect(x: x, y: y, width: width, height: height) }
}

struct ProbePoint: Codable {
    let x: Double
    let y: Double
    init(_ point: CGPoint) {
        x = point.x
        y = point.y
    }
}

/// One timed action against this process's own fixture window.
private struct ProbeStep: Decodable {
    let atSeconds: Double
    /// `place`, `coverPointer`, `placeOnOtherDisplay`, `calibrate`, `pause` or `resume`.
    let action: String
    /// Full window frame in AppKit global points, required by `place`.
    let frame: ProbeRect?
    let label: String?
}

private struct CursorGeometryProbeRequest: Decodable {
    let capture: CaptureRequest
    let durationSeconds: Double
    let windowFrame: ProbeRect?
    let steps: [ProbeStep]
}

/// Where the fixture window was, and where its fiducials were onscreen, while a step ran.
/// `movedAtHostUs` is when the window was told to move and `hostUs` when it had settled: frames
/// delivered between the two belong to neither placement, so evidence never credits a landmark
/// position to a frame taken while the window was still travelling.
private struct FixturePlacement: Codable {
    let label: String
    let movedAtHostUs: Int64
    let hostUs: Int64
    var movedAtSourceUs: Int64?
    var settledSourceUs: Int64?
    let windowFrameAppKit: ProbeRect
    let contentFrameAppKit: ProbeRect
    let screenAppKitFrame: ProbeRect
    let backingScaleFactor: Double
    let zeroOriginHeight: Double
    /// Fiducial centers in global display points, top-left origin.
    let fiducials: [ProbePoint]
}

/// A pair of one-shot captures of the same fixture window taken microseconds apart, one drawing
/// the pointer and one not, beside the pointer reading for that instant. The difference between
/// the two images is the only ground truth available for where the system drew the pointer,
/// because recorded takes never draw it. A one-shot capture carries no frame metadata of its own,
/// so its prediction comes from the take's journaled geometry at the same host time; the fiducials
/// visible in both prove the two surfaces agree.
private struct CursorCalibration: Codable {
    let label: String
    let hostUs: Int64
    let placementIndex: Int
    let pointerAppKit: ProbePoint
    /// `pointerAppKit` flipped through `zeroOriginHeight`, the height read live at this instant.
    let pointerGlobal: ProbePoint
    let zeroOriginHeight: Double
    /// The height the take itself was converting readings through at `hostUs`, from its journal.
    /// The prediction below uses this one: a display arrangement that changed mid-take would
    /// otherwise be validated against a height the recording never used. A disagreement with
    /// `zeroOriginHeight` is the evidence that it changed.
    var journaledZeroOriginHeight: Double?
    let buttons: Int
    let cursorHotSpot: ProbePoint?
    /// The pointer image in points, and the same image written out, so a measurement can find the
    /// offset from its hot spot to the first pixel it actually draws.
    let cursorImageSize: ProbeRect?
    let cursorImagePixels: ProbeRect?
    let cursorImageFile: String?
    let withPointerFile: String
    let withoutPointerFile: String
    /// How long the pointer had already been still when the pair was taken, or nil when it never
    /// settled within the bounded wait. A moving pointer cannot be compared to one reading.
    let stillForMs: Int?
    /// Where this instant sits on the take's own timeline, so the recorded video can be inspected
    /// at the moment the pointer was known to be there.
    var sourceUs: Int64?
    var geometryEpoch: Int?
    var geometry: CaptureGeometry?
    var predictedPointer: ProbePoint?
    var predictedEligibility = "unknownGeometry"
    var predictedFiducials: [ProbePoint?] = []
}

private struct EpochEvidence: Codable {
    let epoch: Int
    let hostUs: Int64
    let sourceUs: Int64?
    let placementIndex: Int?
    let settled: Bool
    let geometry: CaptureGeometry
    let predictedFiducials: [ProbePoint?]
}

private struct SampleEvidence: Codable {
    var count = 0
    var inside = 0
    var outside = 0
    var unknownGeometry = 0
    var firstSourceUs: Int64?
    var lastSourceUs: Int64?
    var maxGapUs: Int64?
    var medianGapUs: Int64?
    /// The journaled sample nearest each calibration instant, with its distance in source time and
    /// how far the pointer travelled within 150ms of it. A pointer that moved while the pair of
    /// images was taken cannot be compared to a single reading.
    var atCalibrations: [CursorSample?] = []
    var calibrationDistanceUs: [Int64?] = []
    /// Absent when no sample fell within 150ms of the calibration, which is different from a
    /// pointer that was measured and did not move.
    var calibrationDriftPoints: [Double?] = []
}

private struct CursorGeometryEvidence: Codable {
    let outputWidth: Int
    let outputHeight: Int
    let videoFile: String
    let capture: CaptureResult
    let journal: CaptureJournalSummary
    let placements: [FixturePlacement]
    let calibrations: [CursorCalibration]
    let epochs: [EpochEvidence]
    /// Every zero-origin display height the take converted readings through, in journal order.
    let displaySpaces: [JournalDisplaySpace]
    let samples: SampleEvidence
    let displays: [ProbeRect]
}

@MainActor
func runCursorGeometryProbe(configPath: String) async throws {
    let probe = try JSONDecoder().decode(
        CursorGeometryProbeRequest.self, from: Data(contentsOf: URL(fileURLWithPath: configPath)))
    guard probe.capture.source.kind == "fixture", !probe.capture.microphone,
        !probe.capture.systemAudio
    else {
        throw CaptureFailure(
            "INVALID_REQUEST",
            "The cursor geometry probe records this process's own fixture window with both audio inputs disabled."
        )
    }
    guard probe.durationSeconds.isFinite, probe.durationSeconds > 0, probe.durationSeconds <= 300,
        probe.steps.allSatisfy({ $0.atSeconds > 0 && $0.atSeconds < probe.durationSeconds })
    else {
        throw CaptureFailure(
            "INVALID_REQUEST", "Probe steps must fall inside a duration of up to five minutes.")
    }
    guard NativeCapture.screenPermission else {
        throw CaptureFailure(
            "PERMISSION_REQUIRED",
            "Screen recording permission is not authorized. No recording started.")
    }
    let directory = URL(fileURLWithPath: probe.capture.outputDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let window = makeCaptureFixtureWindow(frame: probe.windowFrame?.nsRect, activate: false)
    defer { window.close() }
    try await Task.sleep(for: .milliseconds(600))

    var request = probe.capture
    let windowID = UInt32(window.windowNumber)
    request.source = CaptureSource(kind: "window", windowID: windowID)
    let content = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: true)
    guard let fixture = content.windows.first(where: { $0.windowID == windowID }) else {
        throw CaptureFailure("FIXTURE_FAILED", "The fixture window is not capturable.")
    }
    let filter = SCContentFilter(desktopIndependentWindow: fixture)

    let capture = NativeCapture()
    try await capture.start(request)
    guard let outputSize = capture.outputSize else {
        throw CaptureFailure("FIXTURE_FAILED", "A started take must report its output dimensions.")
    }
    // The take began with the window already where it is, so its first placement covers every
    // frame up to the first move.
    var placements = [placement(label: "start", movedAtHostUs: 0, of: window)]
    var calibrations: [CursorCalibration] = []
    let began = Date()
    for step in probe.steps.sorted(by: { $0.atSeconds < $1.atSeconds }) {
        let wait = step.atSeconds - Date().timeIntervalSince(began)
        if wait > 0 { try await Task.sleep(for: .seconds(wait)) }
        switch step.action {
        case "place":
            guard let frame = step.frame else {
                throw CaptureFailure("INVALID_REQUEST", "A place step needs a window frame.")
            }
            let movedAt = CaptureHostTime.nowUs()
            window.setFrame(frame.nsRect, display: true)
            try await Task.sleep(for: .milliseconds(250))
            placements.append(
                placement(label: step.label ?? "place", movedAtHostUs: movedAt, of: window))
        case "coverPointer":
            let pointer = NSEvent.mouseLocation
            let size = window.frame.size
            let movedAt = CaptureHostTime.nowUs()
            window.setFrame(
                NSRect(
                    x: pointer.x - size.width / 2, y: pointer.y - size.height / 2,
                    width: size.width, height: size.height), display: true)
            try await Task.sleep(for: .milliseconds(250))
            placements.append(
                placement(label: step.label ?? "coverPointer", movedAtHostUs: movedAt, of: window))
        case "placeOnOtherDisplay":
            // Real coverage of a display whose global origin is not zero, using only this
            // process's own window. Without a second display the step records its absence.
            let others = NSScreen.screens.filter { $0.frame.origin != .zero }
            guard let other = others.first else {
                placements.append(
                    placement(
                        label: step.label ?? "otherDisplayUnavailable",
                        movedAtHostUs: CaptureHostTime.nowUs(), of: window))
                continue
            }
            let size = window.frame.size
            let movedAt = CaptureHostTime.nowUs()
            window.setFrame(
                NSRect(
                    x: other.frame.midX - size.width / 2, y: other.frame.midY - size.height / 2,
                    width: size.width, height: size.height), display: true)
            try await Task.sleep(for: .milliseconds(300))
            placements.append(
                placement(label: step.label ?? "otherDisplay", movedAtHostUs: movedAt, of: window))
        case "calibrate":
            calibrations.append(
                try await calibrate(
                    label: step.label ?? "calibrate", filter: filter, size: outputSize,
                    directory: directory, index: calibrations.count,
                    placementIndex: placements.count - 1))
        case "pause": try capture.pause()
        case "resume": try capture.resume()
        default:
            throw CaptureFailure("INVALID_REQUEST", "Unknown probe step: \(step.action).")
        }
    }
    let remaining = probe.durationSeconds - Date().timeIntervalSince(began)
    if remaining > 0 { try await Task.sleep(for: .seconds(remaining)) }
    let result = try await capture.stop()

    var epochs: [EpochEvidence] = []
    var displaySpaces: [JournalDisplaySpace] = []
    var samples = SampleEvidence()
    var gaps: [Int64] = []
    // Matching samples to calibrations needs the take's origin and pauses, which the same pass is
    // still reading, so the samples are held until it finishes. A probe take is capped at five
    // minutes, so this is bounded by that cap at the sampler's cadence.
    var recorded: [CursorSample] = []
    let summary = try CaptureJournal.streamEvidence(
        directory: directory.path,
        geometry: { event in
            let index = placementIndex(at: event.hostUs, in: placements)
            epochs.append(
                EpochEvidence(
                    epoch: event.epoch, hostUs: event.hostUs, sourceUs: event.sourceUs,
                    placementIndex: index,
                    settled: index.map { event.hostUs >= placements[$0].hostUs } ?? false,
                    geometry: event.geometry,
                    predictedFiducials: index.map { placement in
                        placements[placement].fiducials.map {
                            event.geometry.outputPixel(
                                forGlobalPoint: CGPoint(x: $0.x, y: $0.y)
                            ).map(ProbePoint.init)
                        }
                    } ?? []))
        },
        samples: { batch in
            for sample in batch {
                if let last = samples.lastSourceUs { gaps.append(sample.sourceUs - last) }
                samples.count += 1
                samples.firstSourceUs = samples.firstSourceUs ?? sample.sourceUs
                samples.lastSourceUs = sample.sourceUs
                switch sample.eligibility {
                case "inside": samples.inside += 1
                case "outside": samples.outside += 1
                default: samples.unknownGeometry += 1
                }
            }
            recorded.append(contentsOf: batch)
        },
        displaySpace: { displaySpaces.append($0) })
    samples.atCalibrations = Array(repeating: nil, count: calibrations.count)
    samples.calibrationDistanceUs = Array(repeating: nil, count: calibrations.count)
    samples.calibrationDriftPoints = Array(repeating: nil, count: calibrations.count)
    let holds = summary.header.map { JournalSchema.cursorSampling($0).holds } ?? false
    for index in calibrations.indices {
        let target = sourceTime(
            forHostUs: calibrations[index].hostUs, origin: summary.originHostUs,
            pauses: summary.pauses)
        calibrations[index].sourceUs = target
        // A calibration inside a pause has no source time at all, so no sample can be near it.
        if let target {
            let pointer = calibrations[index].pointerGlobal
            for (sampleIndex, sample) in recorded.enumerated() {
                let distance = abs(sample.sourceUs - target)
                if holds ? sample.sourceUs <= target
                    : (samples.calibrationDistanceUs[index].map({ distance < $0 }) ?? true) {
                    samples.atCalibrations[index] = sample
                    samples.calibrationDistanceUs[index] = distance
                }
                let holdsIntoWindow = holds && sample.sourceUs <= target + 150_000
                    && (sampleIndex + 1 == recorded.count || recorded[sampleIndex + 1].sourceUs > target - 150_000)
                if holds ? holdsIntoWindow : distance <= 150_000 {
                    samples.calibrationDriftPoints[index] = max(
                        samples.calibrationDriftPoints[index] ?? 0,
                        hypot(sample.globalX - pointer.x, sample.globalY - pointer.y))
                }
            }
        }
        // Flip through the height the take was using at this instant, not the one this process can
        // read now: the recording's own transform is what the prediction has to be checked against.
        let height =
            displaySpaces.last(where: { $0.hostUs <= calibrations[index].hostUs })?.zeroOriginHeight
        calibrations[index].journaledZeroOriginHeight = height
        guard
            let event = epochs.last(where: { $0.hostUs <= calibrations[index].hostUs })
                ?? epochs.first
        else { continue }
        let pointer = GlobalPointSpace.flip(
            appKit: CGPoint(
                x: calibrations[index].pointerAppKit.x, y: calibrations[index].pointerAppKit.y),
            zeroOriginHeight: height ?? calibrations[index].zeroOriginHeight)
        let predicted = event.geometry.outputPixel(forGlobalPoint: pointer)
        calibrations[index].geometryEpoch = event.epoch
        calibrations[index].geometry = event.geometry
        calibrations[index].predictedPointer = predicted.map(ProbePoint.init)
        calibrations[index].predictedEligibility =
            predicted.map { event.geometry.contains(outputPixel: $0) ? "inside" : "outside" }
            ?? "unknownGeometry"
        calibrations[index].predictedFiducials = placements[
            calibrations[index].placementIndex
        ].fiducials.map {
            event.geometry.outputPixel(forGlobalPoint: CGPoint(x: $0.x, y: $0.y)).map(ProbePoint.init)
        }
    }
    for index in placements.indices {
        placements[index].movedAtSourceUs = sourceTime(
            forHostUs: placements[index].movedAtHostUs, origin: summary.originHostUs,
            pauses: summary.pauses)
        placements[index].settledSourceUs = sourceTime(
            forHostUs: placements[index].hostUs, origin: summary.originHostUs,
            pauses: summary.pauses)
    }
    gaps.sort()
    samples.maxGapUs = gaps.last
    samples.medianGapUs = gaps.isEmpty ? nil : gaps[gaps.count / 2]

    var active = [CGDirectDisplayID](repeating: 0, count: 16)
    var displayCount: UInt32 = 0
    _ = CGGetActiveDisplayList(UInt32(active.count), &active, &displayCount)
    let evidence = CursorGeometryEvidence(
        outputWidth: outputSize.width, outputHeight: outputSize.height, videoFile: "video.mov",
        capture: result, journal: summary, placements: placements, calibrations: calibrations,
        epochs: epochs, displaySpaces: displaySpaces, samples: samples,
        displays: active.prefix(Int(displayCount)).map { ProbeRect(CGDisplayBounds($0)) })
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
    try encoder.encode(result).write(
        to: directory.appendingPathComponent("capture.json"), options: .atomic)
    let evidenceData = try encoder.encode(evidence)
    try evidenceData.write(
        to: directory.appendingPathComponent("cursor-geometry.json"), options: .atomic)
    FileHandle.standardOutput.write(evidenceData + Data([10]))
    if result.failure != nil { throw result.failure! }
}

@MainActor
private func placement(label: String, movedAtHostUs: Int64, of window: NSWindow) -> FixturePlacement
{
    let view = window.contentView
    let content = view.map { window.convertToScreen($0.convert($0.bounds, to: nil)) } ?? window.frame
    return FixturePlacement(
        label: label, movedAtHostUs: movedAtHostUs, hostUs: CaptureHostTime.nowUs(),
        windowFrameAppKit: ProbeRect(window.frame),
        contentFrameAppKit: ProbeRect(content),
        screenAppKitFrame: ProbeRect(window.screen?.frame ?? .zero),
        backingScaleFactor: Double(window.screen?.backingScaleFactor ?? 1),
        zeroOriginHeight: GlobalPointSpace.zeroOriginHeight(),
        fiducials: fiducialGlobalPoints(of: window).map(ProbePoint.init))
}

/// Where each fiducial sits in global display points with a top-left origin: the same space the
/// pointer is sampled in, so a measured fiducial pixel and a sampled pointer pixel are comparable.
@MainActor
private func fiducialGlobalPoints(of window: NSWindow) -> [CGPoint] {
    guard let view = window.contentView else { return [] }
    let height = GlobalPointSpace.zeroOriginHeight()
    return CaptureFixtureView.fiducialCenters(in: view.bounds).map { local in
        let onScreen = window.convertPoint(toScreen: view.convert(local, to: nil))
        return GlobalPointSpace.flip(appKit: onScreen, zeroOriginHeight: height)
    }
}

/// The placement a frame's host time belongs to: the most recent window position asked for at that
/// moment. A frame delivered while the window was still travelling belongs to its destination, and
/// `settled` marks whether the window had stopped by then.
private func placementIndex(at hostUs: Int64, in placements: [FixturePlacement]) -> Int? {
    var found: Int?
    for (index, placement) in placements.enumerated() where placement.movedAtHostUs <= hostUs {
        found = index
    }
    return found
}

/// Places a host time on the take's source timeline the way its clock did, using the boundaries
/// the journal recorded. A host time inside a pause has no source time at all: the take does not
/// contain that moment, and pretending otherwise would point evidence at unrelated video.
private func sourceTime(forHostUs hostUs: Int64, origin: Int64?, pauses: [PauseEvent]) -> Int64? {
    guard let origin, hostUs >= origin else { return nil }
    var removed: Int64 = 0
    for pause in pauses {
        let began = origin + pause.atSourceUs + removed
        if hostUs < began { break }
        if hostUs < began + pause.elapsedPauseUs { return nil }
        removed += pause.elapsedPauseUs
    }
    return hostUs - origin - removed
}

@MainActor
private func calibrate(
    label: String, filter: SCContentFilter, size: (width: Int, height: Int), directory: URL,
    index: Int, placementIndex: Int
) async throws -> CursorCalibration {
    let without = directory.appendingPathComponent("calibration-\(index)-clean.png")
    let with = directory.appendingPathComponent("calibration-\(index)-pointer.png")
    // Wait, briefly and without demanding it, for the pointer to stop: the recorder does not move
    // the pointer, so a run during ordinary use may never get a still one.
    var stillForMs: Int?
    var settled = NSEvent.mouseLocation
    var waited = 0
    while waited < 2000 {
        try await Task.sleep(for: .milliseconds(50))
        waited += 50
        let now = NSEvent.mouseLocation
        if now == settled {
            stillForMs = (stillForMs ?? 0) + 50
            if stillForMs! >= 300 { break }
        } else {
            settled = now
            stillForMs = nil
        }
    }
    try await screenshot(filter: filter, size: size, showsCursor: false, to: without)
    let hostUs = CaptureHostTime.nowUs()
    let appKit = NSEvent.mouseLocation
    let buttons = NSEvent.pressedMouseButtons
    let height = GlobalPointSpace.zeroOriginHeight()
    let pointer = GlobalPointSpace.flip(appKit: appKit, zeroOriginHeight: height)
    try await screenshot(filter: filter, size: size, showsCursor: true, to: with)
    let cursor = NSCursor.currentSystem
    var imageFile: String?
    var imagePixels: ProbeRect?
    if let image = cursor?.image, let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:])
    {
        let url = directory.appendingPathComponent("calibration-\(index)-cursor.png")
        try png.write(to: url, options: .atomic)
        imageFile = url.lastPathComponent
        imagePixels = ProbeRect(
            CGRect(x: 0, y: 0, width: bitmap.pixelsWide, height: bitmap.pixelsHigh))
    }
    return CursorCalibration(
        label: label, hostUs: hostUs, placementIndex: placementIndex,
        pointerAppKit: ProbePoint(appKit), pointerGlobal: ProbePoint(pointer),
        zeroOriginHeight: height, buttons: buttons,
        cursorHotSpot: cursor.map { ProbePoint($0.hotSpot) },
        cursorImageSize: cursor.map { ProbeRect(CGRect(origin: .zero, size: $0.image.size)) },
        cursorImagePixels: imagePixels, cursorImageFile: imageFile,
        withPointerFile: with.lastPathComponent, withoutPointerFile: without.lastPathComponent,
        stillForMs: stillForMs)
}

/// One-shot capture of the same fixture window through the same content filter.
@MainActor
private func screenshot(
    filter: SCContentFilter, size: (width: Int, height: Int), showsCursor: Bool, to url: URL
) async throws {
    let config = SCStreamConfiguration()
    config.width = size.width
    config.height = size.height
    config.showsCursor = showsCursor
    config.showMouseClicks = false
    config.captureDynamicRange = .SDR
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.colorSpaceName = CGColorSpace.sRGB
    config.preservesAspectRatio = true
    config.ignoreShadowsSingleWindow = true
    config.shouldBeOpaque = true
    let sample = try await SCScreenshotManager.captureSampleBuffer(
        contentFilter: filter, configuration: config)
    guard let buffer = sample.imageBuffer else {
        throw CaptureFailure("FIXTURE_FAILED", "A calibration image carried no pixels.")
    }
    var image: CGImage?
    guard VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &image) == noErr,
        let image,
        let destination = CGImageDestinationCreateWithURL(
            url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw CaptureFailure("FIXTURE_FAILED", "Cannot encode a calibration image.") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw CaptureFailure("FIXTURE_FAILED", "Cannot write a calibration image.")
    }
}
