import AppKit
import YapControls
import SwiftUI

/**
 The count a start shows before capture begins.

 It appears on the display the take will record, counts down, and only then answers that capture
 should begin — so the take never contains the count, and abandoning the count allocates nothing:
 no recording, no directory, no service call. Escape abandons it wherever the person is working,
 which is why the count holds that one key for exactly as long as it is on screen and gives it
 straight back.
 */
@MainActor
final class StartCountdown {
    static let title = "Yap Countdown"
    private let shortcuts: GlobalShortcuts
    private let model = CountdownModel()
    private var panel: CountdownPanel?
    private var ticker: Timer?
    private var releaseEscape: (() -> Void)?
    private var answer: ((Bool) -> Void)?

    init(shortcuts: GlobalShortcuts) {
        self.shortcuts = shortcuts
    }

    var isCounting: Bool { panel != nil }

    /// Counts on the given screen and answers whether capture should begin. A count already
    /// running is left alone: asking to start again while it counts asks for nothing new.
    func run(_ countdown: Countdown, on screen: NSScreen?, then began: @escaping (Bool) -> Void) {
        guard panel == nil else { return }
        var counting = countdown
        model.remaining = counting.remaining
        answer = began
        let content = NSHostingView(rootView: CountdownView(model: model))
        content.sizingOptions = [.intrinsicContentSize]
        // The count is as big as what it has to say, centred on the display it belongs to.
        let size = content.fittingSize
        let frame = (screen ?? NSScreen.main ?? NSScreen.screens.first)?.frame
            ?? NSRect(origin: .zero, size: size)
        let panel = CountdownPanel(
            contentRect: NSRect(
                x: frame.midX - size.width / 2, y: frame.midY - size.height / 2,
                width: size.width, height: size.height),
            abandon: { [weak self] in self?.finish(began: false) })
        panel.contentView = content
        self.panel = panel
        panel.present()
        // Escape belongs to the count while it runs, whichever app the person is looking at.
        releaseEscape = shortcuts.hold(Shortcut(keyCode: 53, modifiers: 0, label: "Escape")) { [weak self] in
            self?.finish(began: false)
        }
        diagnostic(
            "countdown \(counting.remaining) seconds on display "
                + "\(screen?.captureDisplayID.map(String.init) ?? "unknown")"
                + (releaseEscape == nil ? ", escape unavailable" : ", escape abandons it"))
        let ticker = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if counting.tick() {
                    self.model.remaining = counting.remaining
                } else {
                    self.finish(began: true)
                }
            }
        }
        RunLoop.main.add(ticker, forMode: .common)
        self.ticker = ticker
    }

    /// Ends the count exactly once, however it ended, and gives Escape back to whoever else wants
    /// it before anything else happens.
    /// Ends a running count without starting anything. Harmless when nothing is counting.
    func abandon() { finish(began: false) }

    private func finish(began: Bool) {
        guard let answered = answer else { return }
        answer = nil
        ticker?.invalidate()
        ticker = nil
        releaseEscape?()
        releaseEscape = nil
        panel?.close()
        panel = nil
        diagnostic(began ? "countdown finished" : "countdown abandoned")
        answered(began)
    }
}

/// The count's own panel. Nothing reaches it but Escape: a person clicking through it is clicking
/// on whatever they were about to record.
@MainActor
private final class CountdownPanel: OverlayPanel {
    private let abandon: () -> Void

    init(contentRect: NSRect, abandon: @escaping () -> Void) {
        self.abandon = abandon
        super.init(contentRect: contentRect, level: .screenSaver, title: StartCountdown.title)
        ignoresMouseEvents = true
    }

    /// Escape, whether it arrives as the key this count holds or as the cancel action itself.
    override func cancelOperation(_ sender: Any?) { abandon() }
}

@MainActor
private final class CountdownModel: ObservableObject {
    @Published var remaining = Countdown.defaultSeconds
}

private struct CountdownView: View {
    @ObservedObject var model: CountdownModel

    var body: some View {
        VStack(spacing: 4) {
            // Nothing here is recording yet, so nothing here wears the red a running take does.
            Text("Recording starts in")
                .font(.system(size: 13, weight: .medium))
            Text("\(model.remaining)")
                .font(.system(size: 96, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.primary)
                .contentTransition(.numericText(countsDown: true))
                .animation(.snappy, value: model.remaining)
                // A numeral this size carries more line than digit, and the room that leaves
                // above and below is space the panel does not need.
                .frame(height: 96)
            // Both lines are ordinary label colour: the one way out of the count has to be as
            // readable as the count, and size and weight carry the order to read them in.
            Text("Press Esc to cancel")
                .font(.system(size: 12))
        }
        .padding(.horizontal, 36)
        .padding(.vertical, 22)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(.separator, lineWidth: 0.5))
        .accessibilityLabel("Recording starts in \(model.remaining) seconds. Press Escape to cancel.")
    }
}
