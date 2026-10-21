import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
@preconcurrency import ScreenCaptureKit
import YapCapture

/// Marks a person makes during a screen take, from the writer's pointer readings and button edges
/// to the journal and the overlay's stream.
func runLiveMarkJournalTests() throws {
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
    var expectedTrack = CursorTrack()
    _ = expectedTrack.observe(geometry, hostUs: origin, sourceUs: 0, usable: true)
    _ = expectedTrack.accept(
        CursorReading(hostUs: origin + 10, global: CGPoint(x: 105, y: 105), buttons: 0,
            zeroOriginHeight: 800), sourceUs: 10)
    let expectedInside = expectedTrack.flush(through: 10).first
    _ = expectedTrack.accept(
        CursorReading(hostUs: origin + 20, global: CGPoint(x: 120, y: 105), buttons: 0,
            zeroOriginHeight: 800), sourceUs: 20)
    let expectedOutside = expectedTrack.flush(through: 20).first
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
    print("PASS replayed cursor readings produce a source-timed journal mark and the overlay's stream")
    try runButtonMarksTest()
}

/// Every press the mouse monitor sees is evidence: a ⇧-click is a pin and a plain click a click,
/// and both reach the journal.
private func runButtonMarksTest() throws {
    let directory = RecoveryFixture.directory("button-marks")
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try CaptureWriter(
        request: CaptureRequest(
            source: CaptureSource(kind: "window", windowID: 1),
            outputDirectory: directory.path, microphone: false, systemAudio: false),
        width: 32, height: 32, sessionID: "button-marks", requestedSourceRect: nil,
        onFailure: { _ in })
    defer { writer.cancel() }
    let origin = CaptureHostTime.nowUs()
    let geometry = CaptureGeometry(
        outputWidth: 32, outputHeight: 32,
        contentRect: GeometryRect(x: 0, y: 0, width: 16, height: 16), contentScale: 1,
        scaleFactor: 1, screenRect: GeometryRect(x: 100, y: 100, width: 16, height: 16),
        boundingRect: nil, requestedSourceRect: nil)
    writer.queue.sync {
        writer.ingest(liveMarkFrame(atHostUs: origin, geometry: geometry), of: .screen)
        let point = CGPoint(x: 105, y: 105)
        writer.acceptButton(down: true, shift: true, point: point, hostUs: origin + 10)
        writer.acceptButton(down: false, shift: true, point: point, hostUs: origin + 20)
        writer.acceptButton(down: true, shift: false, point: point, hostUs: origin + 30)
        writer.acceptButton(down: false, shift: false, point: point, hostUs: origin + 40)
    }
    var marks: [JournalMark] = []
    _ = try CaptureJournal.streamEvidence(directory: directory.path, mark: { marks.append($0) })
    precondition(
        marks.map(\.kind) == ["pin", "click"] && marks[0].pin == 1,
        "A ⇧-click journals pin 1 and a plain click a click, got \(marks)")
    print("PASS a ⇧-click and a plain click both reach the journal")
    try runClearedMarkTest()
}

/// Each pin is journaled with when it shows on screen, and an undo journals when it cleared the
/// newest one early, leaving both pins in the journal.
private func runClearedMarkTest() throws {
    let directory = RecoveryFixture.directory("cleared-marks")
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = try CaptureWriter(
        request: CaptureRequest(
            source: CaptureSource(kind: "window", windowID: 1),
            outputDirectory: directory.path, microphone: false, systemAudio: false),
        width: 32, height: 32, sessionID: "cleared-marks", requestedSourceRect: nil,
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
    writer.queue.sync {
        writer.ingest(liveMarkFrame(atHostUs: origin, geometry: geometry), of: .screen)
        let point = CGPoint(x: 105, y: 105)
        writer.acceptButton(down: true, shift: true, point: point, hostUs: origin + 10)
        writer.acceptButton(down: false, shift: true, point: point, hostUs: origin + 20)
        writer.acceptButton(down: true, shift: true, point: point, hostUs: origin + 30)
        writer.acceptButton(down: false, shift: true, point: point, hostUs: origin + 40)
    }
    writer.clearLatestMark(at: origin + 1_000_000)
    var marks: [JournalMark] = []
    _ = try CaptureJournal.streamEvidence(directory: directory.path, mark: { marks.append($0) })
    precondition(
        marks.count == 3 && marks[0].kind == "pin" && marks[1].kind == "pin"
            && marks[0].onScreen == JournalMarkScreen(fadeHostUs: origin + 3_800_010, untilHostUs: origin + 5_000_010)
            && marks[1].onScreen == JournalMarkScreen(fadeHostUs: origin + 3_800_030, untilHostUs: origin + 5_000_030),
        "Each pin is journaled with the 5 s it shows for, got \(marks)")
    precondition(
        marks[2].retracts == marks[1].id && marks[2].points.isEmpty && marks[2].onScreen == nil
            && marks[2].hostUs == origin + 1_000_000,
        "Undo journals when it cleared the newest pin, got \(marks[2])")
    precondition(
        updates.list.last == .cleared(marks[1].id),
        "The overlay is told which pin undo cleared, got \(updates.list)")
    print("PASS marks are journaled with when they show, and an undo with when it cleared one")
}

/// What the writer told the overlay, in order. The writer calls it on its own queue, which the
/// test drives synchronously.
private final class MarkUpdates: @unchecked Sendable {
    var list: [CaptureMarkUpdate] = []
}

func liveMarkFrame(atHostUs hostUs: Int64, geometry: CaptureGeometry) -> CMSampleBuffer {
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
