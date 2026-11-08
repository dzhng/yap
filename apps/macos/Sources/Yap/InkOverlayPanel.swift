import AppKit
import YapCapture
import YapInk

/**
 The ink a person draws and the pins they drop during a screen take, shown over every display.

 It draws what the capture's mark stream says and nothing else: the stroke under the pointer while
 ⇧ is held, and each recorded stroke and pin for the window capture stamped on it, until it fades
 or undo clears it. Which input is a stroke, a pin or a click is the recognizer's decision, and
 when each mark leaves the screen is capture's, never this one's. How the ink looks is [Ink]'s,
 which review frames of the recording draw it with too.

 The person sees the ink and the recording never does: each display's panel is unshared from the
 moment it opens, so no capture sees it.
 */
@MainActor
final class InkOverlayPanel {
    static let title = "Yap Ink"

    private struct Screen {
        let display: CGDirectDisplayID
        let panel: OverlayPanel
        let view: InkView
    }

    private var screens: [Screen] = []
    private var live: [MarkPoint] = []
    /// The recorded strokes and pins still on screen.
    private var marks: [JournalMark] = []
    /// Runs while any ink is on screen, and stops once none is left.
    private var fadeTimer: Timer?
    /// A fixture's stopped clock, so a check sees the same picture however long it takes.
    private var heldAt: Int64?
    private var now: Int64 { heldAt ?? CaptureHostTime.nowUs() }

    /// Opens a panel on each display while a take is live and takes them all down, ink and all,
    /// when it is not.
    func update(active: Bool) {
        if active { show() } else { hide() }
    }

    /// A mark that arrives before the panels open is kept and drawn once they do.
    func receive(_ update: CaptureMarkUpdate) {
        switch update {
        case .liveStroke(let points):
            live = points
        case .committed(let mark) where mark.onScreen != nil:
            marks.append(mark)
            startFading()
        case .committed:
            return
        case .cleared(let id):
            marks.removeAll { $0.id == id }
        }
        redraw()
    }

    private func show() {
        guard screens.isEmpty else { return }
        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            else { continue }
            let panel = OverlayPanel(contentRect: screen.frame, level: .floating, title: Self.title)
            panel.hasShadow = false
            panel.ignoresMouseEvents = true
            let view = InkView()
            panel.contentView = view
            panel.present()
            screens.append(Screen(display: CGDirectDisplayID(number.uint32Value), panel: panel, view: view))
        }
        guard !screens.isEmpty else { return }
        redraw()
    }

    private func hide() {
        fadeTimer?.invalidate()
        fadeTimer = nil
        heldAt = nil
        for screen in screens { screen.panel.close() }
        screens.removeAll()
        live.removeAll()
        marks.removeAll()
    }

    private func startFading() {
        guard fadeTimer == nil, heldAt == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.fade() }
        }
        RunLoop.main.add(timer, forMode: .common)
        fadeTimer = timer
    }

    private func fade() {
        let now = now
        marks.removeAll { ($0.onScreen?.untilHostUs ?? 0) <= now }
        if marks.isEmpty {
            fadeTimer?.invalidate()
            fadeTimer = nil
        }
        redraw()
    }

    private func redraw() {
        let now = now
        let shown = marks.compactMap { mark in
            mark.onScreen
                .flatMap { Ink.opacity(atUs: now, fadeFromUs: $0.fadeHostUs, untilUs: $0.untilHostUs) }
                .map { (mark, CGFloat($0)) }
        }
        for screen in screens {
            // Global points are top-left based; each panel draws in its own display's corner.
            let frame = screen.panel.frame
            let top = GlobalPointSpace.zeroOriginHeight()
            func local(_ point: JournalMarkPoint) -> NSPoint {
                NSPoint(x: point.globalX - frame.minX, y: top - point.globalY - frame.minY)
            }
            let drawing = live.map { NSPoint(x: $0.x - frame.minX, y: top - $0.y - frame.minY) }
            screen.view.content = InkView.Content(
                strokes: shown.filter { $0.0.kind == "stroke" }.map { ($0.0.points.map(local), $0.1) }
                    + (drawing.isEmpty ? [] : [(drawing, 1)]),
                pins: shown.compactMap { mark, opacity in
                    guard let number = mark.pin, let point = mark.points.first else { return nil }
                    return (local(point), number, opacity)
                })
        }
    }

    // MARK: fixture

    /// Scenes for a check that looks at the ink without anyone drawing. Each one goes through the
    /// same stream a take sends, onto the display at the global origin, and answers that display
    /// and where each mark landed on it, in top-left points.
    func showFixture(_ scene: String, front: Bool) -> (display: CGDirectDisplayID, marks: [CGRect])? {
        hide()
        show()
        guard let screen = screens.first(where: { $0.panel.frame.origin == .zero }) ?? screens.first
        else { return nil }
        let frame = screen.panel.frame
        let top = GlobalPointSpace.zeroOriginHeight()
        let center = CGPoint(x: frame.midX, y: top - frame.midY)
        func point(_ dx: Double, _ dy: Double) -> JournalMarkPoint {
            JournalMarkPoint(globalX: center.x + dx, globalY: center.y + dy, x: nil, y: nil, hostUs: 1)
        }
        let shown = CaptureHostTime.nowUs()
        heldAt = shown
        // The windows capture stamps: a pin shows 5 s, fading over its last 1.2 s; a released
        // stroke fades over 1.2 s.
        func mark(_ id: String, _ kind: String, pin: Int? = nil, _ points: [JournalMarkPoint]) -> JournalMark {
            let screen = kind == "pin"
                ? JournalMarkScreen(fadeHostUs: shown + 3_800_000, untilHostUs: shown + 5_000_000)
                : JournalMarkScreen(fadeHostUs: shown, untilHostUs: shown + 1_200_000)
            return JournalMark(
                hostUs: 1, sourceUs: 1, epoch: 0, id: id, kind: kind, pin: pin, points: points,
                onScreen: screen)
        }
        // A loose loop around something, the way a person circles what they mean.
        let loop = (0...48).map { step -> JournalMarkPoint in
            let angle = Double(step) / 48 * 2.15 * .pi - 0.6
            return point(cos(angle) * (150 + Double(step) * 0.8), sin(angle) * 62 + Double(step) * 0.6)
        }
        let firstPin = mark("fixture-pin-1", "pin", pin: 1, [point(-120, 0)])
        let secondPin = mark("fixture-pin-2", "pin", pin: 2, [point(120, -40)])
        var marks: [JournalMark] = []
        switch scene {
        case "stroke":
            // ⇧ still held: the stroke is live and at full strength.
            receive(.liveStroke(loop.map { MarkPoint(x: $0.globalX, y: $0.globalY, hostUs: $0.hostUs) }))
            marks = [mark("fixture-stroke", "stroke", loop)]
        case "stroke-fading":
            receive(.committed(mark("fixture-stroke", "stroke", loop)))
            // Halfway through its 1.2 s fade, at three-quarters strength.
            heldAt = shown + 600_000
            marks = [mark("fixture-stroke", "stroke", loop)]
        case "two-pins":
            receive(.committed(firstPin))
            receive(.committed(secondPin))
            marks = [firstPin, secondPin]
        case "after-undo":
            receive(.committed(firstPin))
            receive(.committed(secondPin))
            receive(.cleared(secondPin.id))
            marks = [firstPin, secondPin]
        default:
            return nil
        }
        redraw()
        if front {
            // A check of what a take records needs the ink where a person would see it.
            screen.panel.level = .floating
            screen.panel.orderFrontRegardless()
        }
        return (screen.display, marks.map { mark in
            let xs = mark.points.map(\.globalX), ys = mark.points.map(\.globalY)
            let pad = mark.kind == "pin" ? Ink.pinRadius : Ink.lineWidth / 2
            return CGRect(
                x: xs.min()! - frame.minX - pad, y: ys.min()! - (top - frame.maxY) - pad,
                width: xs.max()! - xs.min()! + pad * 2, height: ys.max()! - ys.min()! + pad * 2)
        })
    }
}

/// One display's ink, drawn from the content its owner hands it.
@MainActor
private final class InkView: NSView {
    struct Content {
        var strokes: [(points: [NSPoint], opacity: CGFloat)] = []
        var pins: [(center: NSPoint, number: Int, opacity: CGFloat)] = []
    }

    var content = Content() {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        for stroke in content.strokes {
            Ink.drawStroke(stroke.points, opacity: stroke.opacity, in: context)
        }
        for pin in content.pins {
            Ink.drawPin(pin.number, at: pin.center, opacity: pin.opacity, in: context)
        }
    }
}
