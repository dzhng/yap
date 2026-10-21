import AppKit
import YapCapture
import YapControls

/**
 The ink a person draws and the pins they drop during a screen take, shown over every display.

 It draws what the capture's mark stream says and nothing else: the stroke under the pointer while
 ⇧ is held, each recorded stroke and pin, and the absence of whatever undo took back. Which input
 is a stroke, a pin or a click is the recognizer's decision, never this one's. When each mark
 leaves the screen is [InkLifetimes]'s, and so is which mark undo can still take back.

 The person sees the ink and the recording never does: each display's panel is unshared from the
 moment it opens, so no capture sees it.
 */
@MainActor
final class InkOverlayPanel {
    static let title = "Yap Ink"
    private static let ink = NSColor(srgbRed: 1, green: 0x3b / 255, blue: 0x30 / 255, alpha: 1)

    private struct Screen {
        let display: CGDirectDisplayID
        let panel: OverlayPanel
        let view: InkView
    }

    private var screens: [Screen] = []
    private var live: [MarkPoint] = []
    private var strokes: [(id: String, points: [MarkPoint])] = []
    private var pins: [(id: String, number: Int, point: MarkPoint)] = []
    private var lifetimes = InkLifetimes()
    /// Runs while any ink is on screen, and stops once none is left.
    private var fadeTimer: Timer?
    /// A fixture's stopped clock, so a check sees the same picture however long it takes.
    private var heldAt: Date?
    private var now: Date { heldAt ?? Date() }

    /// Opens a panel on each display while a take is live and takes them all down, ink and all,
    /// when it is not.
    func update(active: Bool) {
        if active { show() } else { hide() }
    }

    /// Takes back the most recent mark still on screen; with nothing on screen, undo does nothing.
    func undo(_ capture: CaptureController?) throws {
        guard let id = lifetimes.latestOnScreen(at: now) else { return }
        try capture?.undoMark(id)
    }

    /// A mark that arrives before the panels open is kept and drawn once they do.
    func receive(_ update: CaptureMarkUpdate) {
        switch update {
        case .liveStroke(let points):
            live = points
        case .committed(let mark) where mark.kind == "stroke":
            strokes.append((mark.id, mark.points.map(Self.global)))
            lifetimes.add(mark.id, .stroke, at: now)
            startFading()
        case .committed(let mark) where mark.kind == "pin":
            guard let number = mark.pin, let point = mark.points.first else { return }
            pins.append((mark.id, number, Self.global(point)))
            lifetimes.add(mark.id, .pin, at: now)
            startFading()
        case .committed:
            return
        case .retracted(let id):
            strokes.removeAll { $0.id == id }
            pins.removeAll { $0.id == id }
            lifetimes.remove(id)
        }
        redraw()
    }

    private static func global(_ point: JournalMarkPoint) -> MarkPoint {
        MarkPoint(x: point.globalX, y: point.globalY, hostUs: point.hostUs)
    }

    private func show() {
        guard screens.isEmpty else { return }
        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            else { continue }
            let panel = OverlayPanel(contentRect: screen.frame, level: .floating, title: Self.title)
            panel.hasShadow = false
            panel.ignoresMouseEvents = true
            let view = InkView(ink: Self.ink)
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
        strokes.removeAll()
        pins.removeAll()
        lifetimes = InkLifetimes()
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
        if !lifetimes.expire(at: now) {
            fadeTimer?.invalidate()
            fadeTimer = nil
        }
        redraw()
    }

    private func redraw() {
        let now = now
        func shown(_ id: String) -> CGFloat? { lifetimes.opacity(of: id, at: now).map { CGFloat($0) } }
        for screen in screens {
            // Global points are top-left based; each panel draws in its own display's corner.
            let frame = screen.panel.frame
            let top = GlobalPointSpace.zeroOriginHeight()
            func local(_ point: MarkPoint) -> NSPoint {
                NSPoint(x: point.x - frame.minX, y: top - point.y - frame.minY)
            }
            screen.view.content = InkView.Content(
                strokes: strokes.compactMap { stroke in shown(stroke.id).map { (stroke.points.map(local), $0) } }
                    + (live.isEmpty ? [] : [(live.map(local), 1)]),
                pins: pins.compactMap { pin in shown(pin.id).map { (local(pin.point), pin.number, $0) } })
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
        func mark(_ id: String, _ kind: String, pin: Int? = nil, _ points: [JournalMarkPoint]) -> JournalMark {
            JournalMark(hostUs: 1, sourceUs: 1, epoch: 0, id: id, kind: kind, pin: pin, points: points)
        }
        // A loose loop around something, the way a person circles what they mean.
        let loop = (0...48).map { step -> JournalMarkPoint in
            let angle = Double(step) / 48 * 2.15 * .pi - 0.6
            return point(cos(angle) * (150 + Double(step) * 0.8), sin(angle) * 62 + Double(step) * 0.6)
        }
        heldAt = Date()
        let firstPin = mark("fixture-pin-1", "pin", pin: 1, [point(-120, 0)])
        let secondPin = mark("fixture-pin-2", "pin", pin: 2, [point(120, -40)])
        var marks: [JournalMark] = []
        switch scene {
        case "stroke":
            // ⇧ still held: the stroke is live and at full strength.
            receive(.liveStroke(loop.map(Self.global)))
            marks = [mark("fixture-stroke", "stroke", loop)]
        case "stroke-fading":
            receive(.committed(mark("fixture-stroke", "stroke", loop)))
            // Halfway through its 1.2 s fade, at three-quarters strength.
            heldAt = heldAt?.addingTimeInterval(0.6)
            marks = [mark("fixture-stroke", "stroke", loop)]
        case "two-pins":
            receive(.committed(firstPin))
            receive(.committed(secondPin))
            marks = [firstPin, secondPin]
        case "after-undo":
            receive(.committed(firstPin))
            receive(.committed(secondPin))
            receive(.retracted(secondPin.id))
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
            let pad = mark.kind == "pin" ? InkView.pinRadius : InkView.lineWidth / 2
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

    static let lineWidth: CGFloat = 5
    static let pinRadius: CGFloat = 16

    static let edgeShadow: NSShadow = {
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
        shadow.shadowBlurRadius = 3
        shadow.shadowOffset = .zero
        return shadow
    }()

    var content = Content() {
        didSet { needsDisplay = true }
    }
    private let ink: NSColor

    init(ink: NSColor) {
        self.ink = ink
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("The ink is never decoded") }

    override func draw(_ dirtyRect: NSRect) {
        for stroke in content.strokes where stroke.opacity > 0 {
            guard let first = stroke.points.first else { continue }
            let path = NSBezierPath()
            path.move(to: first)
            for point in stroke.points.dropFirst() { path.line(to: point) }
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            // A white edge under the ink separates it from red or busy content beneath, and a soft
            // shadow carries that edge onto light backgrounds where white alone disappears.
            NSGraphicsContext.saveGraphicsState()
            Self.edgeShadow.set()
            path.lineWidth = Self.lineWidth + 3
            NSColor.white.withAlphaComponent(0.85 * stroke.opacity).setStroke()
            path.stroke()
            NSGraphicsContext.restoreGraphicsState()
            path.lineWidth = Self.lineWidth
            ink.withAlphaComponent(stroke.opacity).setStroke()
            path.stroke()
        }
        let label: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 17, weight: .heavy),
            .foregroundColor: NSColor.white,
        ]
        for pin in content.pins where pin.opacity > 0 {
            // The badge fades as one picture, so its number never shows through a faded fill.
            let context = NSGraphicsContext.current?.cgContext
            context?.saveGState()
            context?.setAlpha(pin.opacity)
            context?.beginTransparencyLayer(auxiliaryInfo: nil)
            defer {
                context?.endTransparencyLayer()
                context?.restoreGState()
            }
            let r = Self.pinRadius
            let badge = NSBezierPath(ovalIn: NSRect(x: pin.center.x - r, y: pin.center.y - r, width: r * 2, height: r * 2))
            // The same white edge and shadow as the strokes, so a badge keeps its outline on red,
            // busy or light content alike.
            NSGraphicsContext.saveGraphicsState()
            Self.edgeShadow.set()
            ink.setFill()
            badge.fill()
            NSGraphicsContext.restoreGraphicsState()
            NSColor.white.setStroke()
            badge.lineWidth = 2
            badge.stroke()
            let number = NSAttributedString(string: String(pin.number), attributes: label)
            let size = number.size()
            number.draw(at: NSPoint(x: pin.center.x - size.width / 2, y: pin.center.y - size.height / 2))
        }
    }
}
