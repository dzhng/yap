import AppKit
import Foundation

/// What a screen take keeps about the marks a person makes: the recognizer that tells strokes,
/// pins and clicks apart, the global mouse monitor that feeds it button edges, and how much of
/// the live stroke the overlay has been told.
struct LiveMarks {
    var recognizer: MarkRecognizer?
    var monitorTokens: [Any] = []
    /// Points of the live stroke the overlay was last told about. A stroke only grows until it
    /// ends, so its length is enough to know whether there is anything new to say.
    var publishedStrokePoints = 0
}

/// Marks a person makes during a screen take, from button edges and pointer readings to the
/// journal and the overlay's stream.
extension CaptureWriter {
    func installMarkMonitors() {
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp]
        let register = { [weak self] in
            NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
                guard let self else { return }
                let isDown = event.type == .leftMouseDown
                let shift = event.modifierFlags.contains(.shift)
                let point = GlobalPointSpace.flip(
                    appKit: NSEvent.mouseLocation, zeroOriginHeight: GlobalPointSpace.zeroOriginHeight())
                let hostUs = nowUs()
                self.queue.async {
                    self.acceptButton(down: isDown, shift: shift, point: point, hostUs: hostUs)
                }
            }
        }
        let token: Any? = Thread.isMainThread ? register() : DispatchQueue.main.sync(execute: register)
        if let token { marks.monitorTokens = [token] }
    }

    /// Feeds one left-button edge from the global monitor to the recognizer, on the writer queue.
    package func acceptButton(down: Bool, shift: Bool, point: CGPoint, hostUs: Int64) {
        guard !finishing, failure == nil, var recognizer = marks.recognizer else { return }
        guard clock.sourceTime(for: hostUs) != nil else { return }
        recognizer.updateCaptureState(paused: clock.isPaused, hasFirstFrame: clock.originUs != nil)
        let events = down
            ? recognizer.feed(press: MarkPress(hostUs: hostUs, point: point, shift: shift))
            : recognizer.feed(release: MarkRelease(hostUs: hostUs, point: point))
        marks.recognizer = recognizer
        append(events)
        publishActiveStroke(recognizer)
    }

    func removeMarkMonitors() {
        let tokens = marks.monitorTokens
        let remove = { for token in tokens { NSEvent.removeMonitor(token) } }
        if Thread.isMainThread { remove() } else { DispatchQueue.main.sync(execute: remove) }
        marks.monitorTokens.removeAll()
    }

    func append(_ events: [MarkEvent]) {
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
            onMarkUpdate?(.committed(mark))
        }
    }

    /// Tells the overlay about the live stroke only when it changed. It follows any mark the same
    /// reading recorded, so an ended stroke is drawn as its mark before its live line goes.
    func publishActiveStroke(_ recognizer: MarkRecognizer) {
        let stroke = recognizer.activeStroke
        guard stroke.count != marks.publishedStrokePoints else { return }
        marks.publishedStrokePoints = stroke.count
        onMarkUpdate?(.liveStroke(stroke))
    }
}
