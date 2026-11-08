import AppKit
import SwiftUI
import YapControls

/// The floating take controls, drawn by the production view from synthetic facts: no device,
/// service or permission is touched.
@main struct RecordingOverlayCheck {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let output = CommandLine.arguments[1]
        var performed: [ControlsAction] = []
        let model = RecordingOverlayModel()
        model.presentation = .init(elapsed: "0:42", paused: false, symbol: "record.circle.fill")
        model.camera = .companion(on: true)
        model.preview = cameraFrame()
        let host = NSHostingView(rootView: RecordingOverlayView(model: model, perform: { performed.append($0) }))
        host.sizingOptions = [.intrinsicContentSize]
        // Liquid Glass is composited by the window server, so the controls are drawn by it too: the
        // window sits on a screen, behind everything, and is captured from there.
        let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 10, height: 10),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = host
        window.orderBack(nil)

        func settle() {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
            host.layoutSubtreeIfNeeded()
            window.setContentSize(host.fittingSize)
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        // Checked before anything is drawn: without it the capture is empty, not wrong.
        precondition(CGPreflightScreenCaptureAccess(),
                     "The controls must be captured; allow screen recording for this terminal")
        func capture() -> NSBitmapImageRep {
            let file = NSTemporaryDirectory() + "overlay-\(UUID().uuidString).png"
            let shot = Process()
            shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            shot.arguments = ["-x", "-o", "-l\(window.windowNumber)", file]
            try! shot.run()
            shot.waitUntilExit()
            defer { try? FileManager.default.removeItem(atPath: file) }
            guard let data = FileManager.default.contents(atPath: file), let bitmap = NSBitmapImageRep(data: data) else {
                preconditionFailure("The controls must be captured; allow screen recording for this terminal")
            }
            return bitmap
        }
        /// Every action a sweep of clicks across a strip of the controls sends, in order.
        func offered(y: CGFloat, from: CGFloat = 0, to: CGFloat? = nil) -> [ControlsAction] {
            performed.removeAll()
            var x = from
            while x < (to ?? host.bounds.width) {
                let point = host.convert(NSPoint(x: x, y: y), to: nil)
                for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                    window.sendEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: 0,
                        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!)
                }
                RunLoop.current.run(until: Date().addingTimeInterval(0.01))
                x += 4
            }
            var unique: [ControlsAction] = []
            for action in performed where unique.last != action { unique.append(action) }
            return unique
        }
        /// The row of controls sits at the bottom of the panel.
        func row() -> CGFloat { host.isFlipped ? host.bounds.height - 22 : 22 }

        settle()
        let shown = capture()
        // Retain the picture before an assertion can stop the run.
        save(shown, "\(output)/camera-preview.png")
        // The synthetic camera frame carries a yellow border, so it marks the preview's edges.
        guard let frame = bounds(of: shown, where: isFrameBorder) else { preconditionFailure("The camera preview must be drawn") }
        let left = frame.minX, right = shown.pixelsWide - 1 - frame.maxX
        precondition(abs(left - right) <= 2, "The preview must be centred over the controls: \(left) vs \(right) px")
        for (x, y) in [(frame.minX, frame.minY), (frame.maxX, frame.minY), (frame.minX, frame.maxY), (frame.maxX, frame.maxY)] {
            precondition(!isFrameBorder(shown.colorAt(x: x, y: y)), "The preview's corners must be rounded, not square")
        }
        // A 4:3 camera fills the 16:9 card from its centre: its sides reach the card's edges, its
        // top and bottom are cropped.
        let middle = (frame.minY + frame.maxY) / 2
        precondition(isFrameBorder(shown.colorAt(x: frame.minX + 2, y: middle)) && isFrameBorder(shown.colorAt(x: frame.maxX - 2, y: middle)),
                     "The camera picture must fill the card from side to side")
        precondition(!isFrameBorder(shown.colorAt(x: (frame.minX + frame.maxX) / 2, y: frame.minY + 2)),
                     "The camera picture is cropped from its centre, not squeezed into the card")
        let scale = CGFloat(shown.pixelsWide) / host.bounds.width
        let rowPixel = Int((host.isFlipped ? host.bounds.height - 22 : 22) * scale)
        let rowY = shown.pixelsHigh - 1 - rowPixel
        let drawn = (0..<shown.pixelsWide).filter { (shown.colorAt(x: $0, y: rowY)?.alphaComponent ?? 0) > 0.5 }
        precondition(abs((drawn.first ?? 0) - frame.minX) <= 2 && abs((drawn.last ?? 0) - frame.maxX) <= 2,
                     "The picture is exactly as wide as the controls beneath it: \(frame.minX)...\(frame.maxX) vs \(drawn.first ?? -1)...\(drawn.last ?? -1)")

        let cardTop = CGFloat(frame.minY) / scale + 12
        let previewActions = offered(y: host.isFlipped ? cardTop : host.bounds.height - cardTop)
        precondition(previewActions == [.showCameraPreview(false)],
                     "The preview offers only Minimize, which hides the picture without stopping the camera: \(previewActions)")
        let shownRow = offered(y: row())
        precondition(shownRow == [.pauseOrResume, .startOrStop, .setCamera(false), .cancel],
                     "A camera that is on offers Turn Camera Off beside the take controls: \(shownRow)")
        model.previewShown = false
        settle()
        let minimized = capture()
        precondition(bounds(of: minimized, where: isFrameBorder) == nil, "A minimized preview draws no camera picture")
        precondition(minimized.pixelsHigh < shown.pixelsHigh, "Minimizing the preview shrinks the controls")
        save(minimized, "\(output)/camera-preview-minimized.png")
        let minimizedRow = offered(y: row())
        precondition(minimizedRow == [.pauseOrResume, .startOrStop, .setCamera(false), .showCameraPreview(true), .cancel],
                     "The minimized preview can be brought back from the controls: \(minimizedRow)")

        // Turned off, the camera has no picture: no card, no restore, and the last picture is gone
        // rather than held, even with the preview preference still on.
        model.previewShown = true
        model.camera = .companion(on: false)
        settle()
        let offAfterOn = capture()
        precondition(model.preview == nil, "Turning the camera off forgets its last picture")
        precondition(bounds(of: offAfterOn, where: isFrameBorder) == nil && offAfterOn.pixelsHigh == minimized.pixelsHigh,
                     "A camera that is off shows no picture card")
        save(offAfterOn, "\(output)/camera-off-after-on.png")
        let offRow = offered(y: row())
        precondition(offRow == [.pauseOrResume, .startOrStop, .setCamera(true), .cancel],
                     "A camera that is off offers Turn Camera On and nothing to restore: \(offRow)")
        model.camera = .companion(on: true)
        settle()
        let waiting = capture()
        precondition(bounds(of: waiting, where: isFrameBorder) == nil && waiting.pixelsHigh == shown.pixelsHigh,
                     "Turned back on, the card waits for a new picture instead of showing the old one")

        model.camera = .companion(on: false)
        model.preview = cameraFrame()
        settle()
        precondition(model.preview == nil, "A late picture for a camera that is off is not kept")
        save(capture(), "\(output)/camera-off.png")

        model.camera = .primary
        model.preview = cameraFrame()
        settle()
        let primaryRow = offered(y: row())
        precondition(primaryRow == [.pauseOrResume, .startOrStop, .cancel],
                     "A camera-only take shows its picture and offers no way to turn its source off: \(primaryRow)")

        model.camera = .none
        settle()
        let noCameraRow = offered(y: row())
        precondition(noCameraRow == [.pauseOrResume, .startOrStop, .cancel], "A take without a camera offers no camera controls: \(noCameraRow)")
        save(capture(), "\(output)/no-camera.png")

        // Every state in both appearances, for review.
        for (appearance, prefix) in [(NSAppearance.Name.aqua, ""), (.darkAqua, "dark-")] {
            window.appearance = NSAppearance(named: appearance)
            for (name, camera, previewShown, paused) in [
                ("camera-preview", RecordingOverlay.Camera.companion(on: true), true, false),
                ("camera-preview-paused", .companion(on: true), true, true),
                ("camera-preview-minimized", .companion(on: true), false, false),
                ("camera-off", .companion(on: false), true, false),
                ("no-camera", .none, true, false),
            ] {
                model.camera = camera
                model.preview = cameraFrame()
                model.previewShown = previewShown
                model.presentation = paused ? .init(elapsed: "0:42", paused: true, symbol: "pause.circle.fill")
                    : .init(elapsed: "0:42", paused: false, symbol: "record.circle.fill")
                settle()
                save(capture(), "\(output)/\(prefix)\(name).png")
            }
        }
        window.orderOut(nil)
    }

    /// A 4:3 camera picture: a yellow border marks its edges, crosshairs mark its centre.
    @MainActor static func cameraFrame() -> NSImage {
        NSImage(size: NSSize(width: 1440, height: 1080), flipped: false) { rect in
            NSColor(calibratedRed: 0.25, green: 0.45, blue: 0.6, alpha: 1).setFill()
            rect.fill()
            NSColor.systemOrange.setFill()
            NSBezierPath(ovalIn: NSRect(x: rect.midX - 200, y: rect.midY - 200, width: 400, height: 400)).fill()
            let cross = NSBezierPath()
            cross.lineWidth = 10
            cross.move(to: NSPoint(x: rect.midX, y: 0)); cross.line(to: NSPoint(x: rect.midX, y: rect.maxY))
            cross.move(to: NSPoint(x: 0, y: rect.midY)); cross.line(to: NSPoint(x: rect.maxX, y: rect.midY))
            NSColor.white.setStroke()
            cross.stroke()
            let border = NSBezierPath(rect: rect.insetBy(dx: 30, dy: 30))
            border.lineWidth = 60
            NSColor(calibratedRed: 1, green: 1, blue: 0, alpha: 1).setStroke()
            border.stroke()
            return true
        }
    }

    static func isFrameBorder(_ color: NSColor?) -> Bool {
        // The capture's own components: converting them between colour spaces moves a saturated
        // yellow past the limits that tell it apart.
        guard let c = color, c.type == .componentBased, c.colorSpace.colorSpaceModel == .rgb else { return false }
        return c.redComponent > 0.8 && c.greenComponent > 0.8 && c.blueComponent < 0.35 && c.alphaComponent > 0.9
    }

    static func bounds(of bitmap: NSBitmapImageRep, where match: (NSColor?) -> Bool) -> (minX: Int, minY: Int, maxX: Int, maxY: Int)? {
        var box: (minX: Int, minY: Int, maxX: Int, maxY: Int)?
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide where match(bitmap.colorAt(x: x, y: y)) {
                box = (min(box?.minX ?? x, x), min(box?.minY ?? y, y), max(box?.maxX ?? x, x), max(box?.maxY ?? y, y))
            }
        }
        return box
    }

    static func save(_ bitmap: NSBitmapImageRep, _ path: String) {
        try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    }
}

func diagnostic(_ message: String) {}
enum ControlsProbe { static let observed = true }
