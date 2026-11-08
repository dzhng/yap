import AppKit
import Combine
import YapControls
import SwiftUI

/**
 The floating controls a take carries while it runs.

 They are the menu's transport row in a window a person can reach without opening the menu: pause
 or resume, finish, cancel, and the take's own elapsed playback time. Every button sends the same
 action the menu sends, so there is no second device state machine here and no clock of its own —
 what to show, and whether to show anything at all, is decided from the one controls state.
 A take that records a camera also carries its live picture above the row. Minimizing the picture
 hides it without stopping the camera; the camera button in the row turns a reserved camera on or
 off, and a camera that is off has no picture at all.

 No capture sees the controls, so they never appear in the take they run, nor in screenshots or
 screen sharing.
 */
@MainActor
final class RecordingOverlayPanel {
    static let title = "Yap Controls"
    /// How far above the bottom of the screen a take's controls first appear.
    private static let margin: CGFloat = 72

    private let preferences: Preferences
    private let perform: (ControlsAction) -> Void
    private let model = RecordingOverlayModel()
    private var panel: OverlayPanel?
    private var moved: NSObjectProtocol?
    private var changes: AnyCancellable?

    init(preferences: Preferences, perform: @escaping (ControlsAction) -> Void) {
        self.preferences = preferences
        self.perform = perform
    }

    /// What the controls state says these controls are: on screen saying this, or not on screen.
    func update(_ presentation: RecordingOverlay.Presentation?) {
        guard let presentation else { return hide() }
        model.presentation = presentation
        show()
    }

    /// The take's camera, and whether its live picture is shown or minimized.
    func updateCamera(_ camera: RecordingOverlay.Camera, previewShown: Bool) {
        model.camera = camera
        model.previewShown = previewShown
    }

    func updatePreview(_ image: NSImage?) { model.preview = image }

    /// Settings' choice of glass, which a running take picks up as soon as it changes.
    func updateGlass(_ glass: ControlsGlass) {
        if model.glass != glass { model.glass = glass }
    }

    private func show() {
        guard panel == nil else { return }
        let content = NSHostingView(
            rootView: RecordingOverlayView(model: model, perform: { [weak self] in self?.perform($0) }))
        // The row decides how wide the controls are, so the space around it is the padding it
        // asked for rather than whatever is left over inside a fixed panel, and a take that runs
        // past an hour widens the panel instead of crowding its own clock.
        content.sizingOptions = [.intrinsicContentSize]
        let size = content.fittingSize
        let panel = OverlayPanel(
            contentRect: NSRect(origin: startingOrigin(size), size: size), level: .floating,
            title: Self.title)
        panel.isMovableByWindowBackground = true
        panel.contentView = content
        // Where a person leaves the controls is where the next take finds them.
        moved = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: panel, queue: .main
        ) { [weak self, weak panel] _ in
            MainActor.assumeIsolated {
                guard let self, let panel else { return }
                self.preferences.overlayOrigin = panel.frame.origin
            }
        }
        self.panel = panel
        // The picture above the controls comes and goes, and a take that runs past an hour widens
        // the row, so the panel follows what the controls ask for once they have laid themselves
        // out again. The bottom edge holds still: that is where the person's hand is.
        changes = model.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.fit() } }
        }
        panel.present()
        describe(panel)
    }

    private func fit() {
        guard let panel, let content = panel.contentView else { return }
        content.layoutSubtreeIfNeeded()
        let size = content.fittingSize
        guard size != panel.frame.size else { return }
        let old = panel.frame
        panel.setFrame(NSRect(x: old.midX - size.width / 2, y: old.minY, width: size.width, height: size.height),
                       display: true)
    }

    private func hide() {
        guard let panel else { return }
        if let moved { NotificationCenter.default.removeObserver(moved) }
        moved = nil
        changes = nil
        self.panel = nil
        panel.close()
    }

    /// Where the controls were last left, if that is still somewhere a person can see, and the
    /// bottom of the screen they are working on otherwise.
    private func startingOrigin(_ size: NSSize) -> NSPoint {
        if let saved = preferences.overlayOrigin,
            NSScreen.screens.contains(where: {
                $0.visibleFrame.intersects(NSRect(origin: saved, size: size))
            }) {
            return saved
        }
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: size.width, height: size.height)
        return NSPoint(x: visible.midX - size.width / 2, y: visible.minY + Self.margin)
    }

    /// Where these controls are on the display a take of that display would record them, so a
    /// check can look at exactly that part of a recorded frame.
    private func describe(_ panel: OverlayPanel) {
        guard let screen = panel.screen ?? NSScreen.main, let id = screen.captureDisplayID,
            let rect = screen.displayLocal(panel.frame)
        else { return }
        diagnostic(
            "recording overlay display=\(id) rect=\(Int(rect.minX)),\(Int(rect.minY)),"
                + "\(Int(rect.width)),\(Int(rect.height))")
    }
}

@MainActor
final class RecordingOverlayModel: ObservableObject {
    @Published var presentation = RecordingOverlay.Presentation(
        elapsed: "0:00", paused: false, symbol: "record.circle.fill")
    /// The take's camera: whether it can be turned on and off, and whether it has a picture.
    @Published var camera = RecordingOverlay.Camera.none {
        didSet { if !camera.recording { preview = nil } }
    }
    /// Whether that picture is shown or minimized; the camera records either way.
    @Published var previewShown = true
    @Published var glass = ControlsGlass.clear
    /// The camera's latest picture. A camera that is off has none, so no held picture is shown
    /// and turning it back on waits for a new one.
    @Published var preview: NSImage? {
        didSet { if !camera.recording, preview != nil { preview = nil } }
    }
}

/// The controls themselves: the camera's live picture when the take records one, then a row with
/// a state mark, the take's playback time and the transport actions, each sending the action the
/// menu sends.
struct RecordingOverlayView: View {
    @ObservedObject var model: RecordingOverlayModel
    let perform: (ControlsAction) -> Void

    private var paused: Bool { model.presentation.paused }

    var body: some View {
        PictureAboveRow {
            if model.camera.recording && model.previewShown {
                preview
            }
            controls
        }
    }

    /// The picture fills its card and is cropped from its centre, never squeezed.
    private var preview: some View {
        let card = RoundedRectangle(cornerRadius: 14, style: .continuous)
        return Color.black
            .overlay {
                if let image = model.preview {
                    Image(nsImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Image(systemName: "video")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
            .clipShape(card)
            .overlay(card.strokeBorder(.white.opacity(0.14), lineWidth: 0.5))
            .overlay(alignment: .topTrailing) {
                Button { perform(.showCameraPreview(false)) } label: {
                    Image(systemName: "minus")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 22, height: 22)
                        .background(.black.opacity(0.5), in: Circle())
                        .overlay(Circle().strokeBorder(.white.opacity(0.25), lineWidth: 0.5))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .padding(8)
                .help("Minimize camera preview")
                .accessibilityLabel("Minimize camera preview")
            }
    }

    private var controls: some View {
        Glass(kind: model.glass, content: row())
            .overlay {
                row(lit: true)
                    .environment(\.colorScheme, model.glass == .dark ? .dark : .light)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
    }

    /// The controls, or with `lit` the copy that draws only their glow.
    private func row(lit: Bool = false) -> some View {
        HStack(spacing: 10) {
            Image(systemName: model.presentation.symbol)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(paused ? AnyShapeStyle(.primary) : AnyShapeStyle(Color.red))
                .glow(paused ? .primary : .red)
                .frame(width: 15)
                .accessibilityLabel(paused ? "Paused" : "Recording")
            // The clock keeps the width of the longest one a take shows, so the row does not change
            // shape as a take passes an hour, or ten.
            ZStack(alignment: .leading) {
                Text("00:00:00").hidden().accessibilityHidden(true)
                Text(model.presentation.elapsed)
                    .foregroundStyle(paused ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
            }
            .font(.system(size: 15, weight: .medium))
            .monospacedDigit()
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .unlit()
            separator
            HStack(spacing: 2) {
                button(paused ? "play.fill" : "pause.fill",
                    paused ? "Resume Recording" : "Pause Recording", .pauseOrResume)
                button("stop.fill", "Finish Recording", .startOrStop, tint: .red)
            }
            if case .companion(let on) = model.camera {
                separator
                HStack(spacing: 2) {
                    cameraSwitch(on, lit: lit)
                    if on && !model.previewShown { restore }
                }
            } else if model.camera.recording && !model.previewShown {
                separator
                restore
            }
            separator
            button("trash.fill", "Cancel Take", .cancel)
        }
        // A button's tappable box reaches past the mark it draws, so the trailing edge needs less
        // room than the leading one for the two to look the same.
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
        .environment(\.glowLayer, lit)
    }

    /// The camera's state twice over, so neither colour nor a thin slash has to carry it alone: on
    /// is an engaged toggle showing a camera, off a plain one showing the camera struck through.
    /// Off keeps full contrast: it is a state to change, not an unavailable control.
    private func cameraSwitch(_ on: Bool, lit: Bool = false) -> some View {
        let name = on ? "Turn Camera Off" : "Turn Camera On"
        // The engaged toggle's backing is drawn once, by the controls, not again by their glow.
        return Toggle(isOn: Binding(get: { on && !lit }, set: { perform(.setCamera($0)) })) {
            Image(systemName: on ? "video.fill" : "video.slash.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .glow(.primary)
                .frame(width: 30, height: 30)
                .contentShape(Circle())
        }
        .toggleStyle(.button)
        .buttonStyle(.accessoryBar)
        .clipShape(Circle())
        .help(name)
        .accessibilityLabel(name)
    }

    private var restore: some View {
        button("pip.exit", "Show camera preview", .showCameraPreview(true))
    }

    private var separator: some View {
        Rectangle().fill(.separator).frame(width: 1, height: 20).unlit()
    }

    private func button(
        _ symbol: String, _ name: String, _ action: ControlsAction, tint: Color? = nil
    ) -> some View {
        Button { perform(action) } label: {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint ?? .primary)
                .glow(tint ?? .primary)
                .frame(width: 30, height: 30)
                .contentShape(Circle())
        }
        .buttonStyle(.accessoryBar)
        .clipShape(Circle())
        .help(name)
        .accessibilityLabel(name)
    }
}

/// Whether this copy of the row draws only the glow. A blur among the marks costs the whole row
/// the glass's automatic contrast, so the glow is a copy of the row in a layer of its own over the
/// glass.
private struct GlowLayerKey: EnvironmentKey { static let defaultValue = false }
private extension EnvironmentValues {
    var glowLayer: Bool {
        get { self[GlowLayerKey.self] }
        set { self[GlowLayerKey.self] = newValue }
    }
}

private struct Glow: ViewModifier {
    @Environment(\.glowLayer) private var glowLayer
    @Environment(\.colorScheme) private var scheme
    let color: Color
    func body(content: Content) -> some View {
        // Coloured marks always glow, and plain marks only on dark glass, where they are light. On
        // light glass they are dark, and clear glass turns them dark or light to suit what is behind
        // without saying which, so there they don't glow.
        if glowLayer {
            content.foregroundStyle(color).blur(radius: 5).opacity(color == .primary && scheme == .light ? 0 : 1)
        } else {
            content
        }
    }
}

/// What the glow layer leaves out: everything but the glows themselves.
private struct Unlit: ViewModifier {
    @Environment(\.glowLayer) private var glowLayer
    func body(content: Content) -> some View { content.opacity(glowLayer ? 0 : 1) }
}

private extension View {
    /// A mark lit in its own colour.
    func glow(_ color: Color) -> some View { modifier(Glow(color: color)) }
    func unlit() -> some View { modifier(Unlit()) }
}

/// The system's Liquid Glass behind the controls: frosted, light or dark, or in its clearest form.
/// Frosted glass normally follows what is behind it, turning light over a light page; light and
/// dark hold their appearance wherever the controls are, and it reaches the controls inside the
/// glass, so their marks are dark on light glass and light on dark glass. Clear has no frosting,
/// just the rim and the bend at the edge, so whatever is behind the controls shows through. The
/// public styles stop at a frosted clear and always follow the backdrop, so the clearer material
/// and the held appearance are chosen through the glass's private settings; if a later macOS drops
/// them, the controls keep the public glass. The controls sit inside the glass, which keeps their
/// marks legible over a light page as well as a dark one.
private struct Glass<Content: View>: NSViewRepresentable {
    /// The see-through lens AppKit draws for bubbles: a bright rim and refraction at the edge.
    fileprivate static var clearVariant: Int { 11 }
    /// Glass that keeps its own appearance instead of following its backdrop's.
    fileprivate static var heldAppearance: Int { 1 }
    let kind: ControlsGlass
    let content: Content

    func makeNSView(context: Context) -> NSGlassEffectView {
        let glass = CapsuleGlass()
        glass.followingAppearance = glass.privateValue("_adaptiveAppearance")
        glass.show(kind)
        let host = NSHostingView(rootView: content)
        host.sizingOptions = [.intrinsicContentSize]
        glass.contentView = host
        return glass
    }

    func updateNSView(_ glass: NSGlassEffectView, context: Context) {
        if let glass = glass as? CapsuleGlass, glass.kind != kind { glass.show(kind) }
        (glass.contentView as? NSHostingView<Content>)?.rootView = content
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView glass: NSGlassEffectView, context: Context) -> CGSize? {
        glass.contentView?.fittingSize
    }

    /// Round ends at whatever height the row lays itself out to.
    private final class CapsuleGlass: NSGlassEffectView {
        private(set) var kind: ControlsGlass?
        /// The appearance setting the glass starts with, which follows its backdrop.
        var followingAppearance: Int?

        /// Choosing a public style resets the variant, so clear sets its lens after the style.
        func show(_ kind: ControlsGlass) {
            self.kind = kind
            switch kind {
            case .light, .dark:
                style = .regular
                appearance = NSAppearance(named: kind == .light ? .aqua : .darkAqua)
                setPrivate("set_adaptiveAppearance:", Glass.heldAppearance)
            case .clear:
                style = .clear
                appearance = nil
                if let followingAppearance { setPrivate("set_adaptiveAppearance:", followingAppearance) }
                setPrivate("set_variant:", Glass.clearVariant)
            }
        }

        private var windowChanges: [NSObjectProtocol] = []

        /// Glass given its look before it is in a window can stay dark on screen, while
        /// screenshots show it right; choosing the look again in Settings puts it right. So once
        /// the glass is on screen, its look is chosen again by way of another one, as Settings does.
        /// The window can be drawn anew after that, and clear glass has still been seen black
        /// mid-take, so the look is chosen again each time: when the window resizes (a camera
        /// picture arriving grows it), comes back on screen or moves to another display. Whether
        /// that cures every black capsule is not yet confirmed on a real display.
        /// This is a workaround, confirmed on a real display in v0.1.57; screenshots can't show the
        /// bug, so no check here catches it. Removing it brings back clear glass that opens black.
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            windowChanges.forEach(NotificationCenter.default.removeObserver)
            windowChanges = []
            guard let window else { return }
            let redrawn: [Notification.Name] = [
                NSWindow.didResizeNotification, NSWindow.didChangeOcclusionStateNotification,
                NSWindow.didChangeScreenNotification,
            ]
            windowChanges = redrawn.map {
                NotificationCenter.default.addObserver(forName: $0, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, self.window?.occlusionState.contains(.visible) == true else { return }
                        self.chooseLookAgain()
                    }
                }
            }
            chooseLookAgain()
        }

        private func chooseLookAgain() {
            guard window != nil, let kind else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.window != nil, self.kind == kind else { return }
                let other: ControlsGlass = kind == .clear ? .dark : .clear
                self.show(other)
                // Settings may have chosen another look in between; that one stands.
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.window != nil, self.kind == other else { return }
                    self.show(kind)
                }
            }
        }

        func setPrivate(_ name: String, _ value: Int) {
            let select = NSSelectorFromString(name)
            guard responds(to: select) else { return }
            typealias Setter = @convention(c) (AnyObject, Selector, Int) -> Void
            unsafeBitCast(method(for: select), to: Setter.self)(self, select, value)
        }

        func privateValue(_ name: String) -> Int? {
            let select = NSSelectorFromString(name)
            guard responds(to: select) else { return nil }
            typealias Getter = @convention(c) (AnyObject, Selector) -> Int
            return unsafeBitCast(method(for: select), to: Getter.self)(self, select)
        }

        override func layout() {
            super.layout()
            cornerRadius = bounds.height / 2
        }
    }
}

/// The row of controls decides the width; a picture above it takes that width at 16:9.
private struct PictureAboveRow: Layout {
    private static let spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let row = subviews.last else { return .zero }
        let size = row.sizeThatFits(.unspecified)
        let pictures = CGFloat(subviews.count - 1)
        return CGSize(width: size.width, height: size.height + pictures * (size.width * 9 / 16 + Self.spacing))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let row = subviews.last else { return }
        let size = row.sizeThatFits(.unspecified)
        var y = bounds.minY
        for picture in subviews.dropLast() {
            let height = size.width * 9 / 16
            picture.place(at: CGPoint(x: bounds.minX, y: y), proposal: ProposedViewSize(width: size.width, height: height))
            y += height + Self.spacing
        }
        row.place(at: CGPoint(x: bounds.minX, y: y), proposal: ProposedViewSize(size))
    }
}
