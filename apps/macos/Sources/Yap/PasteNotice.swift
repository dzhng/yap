import AppKit
import SwiftUI
import YapControls

/**
 The brief line that says the prompt was copied, not pasted, and what to press: the paster's
 notice for what happened.

 It floats over whatever the person was typing into without taking focus from it, so their ⌘V
 lands where they meant it to. It appears on the display under the pointer, low and centred like
 the system's own volume and brightness notices, and leaves on its own; another copy while it is
 up restarts its time rather than stacking a second one.
 */
@MainActor
final class PasteNotice {
    static let title = "Yap Paste Notice"
    /// Long enough to read the notice and reach for ⌘V, short enough not to sit over their work:
    /// 2 s for a few words, more for a longer one.
    private static func shown(_ text: String) -> TimeInterval {
        max(2, 0.4 * Double(text.split(separator: " ").count))
    }
    private var panel: (text: String, panel: OverlayPanel)?
    private var dismissal: Timer?

    func show(_ text: String) {
        if let shown = self.panel, shown.text != text { shown.panel.close() }
        let panel = self.panel.flatMap { $0.text == text ? $0.panel : nil } ?? Self.makePanel(text)
        self.panel = (text, panel)
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            let size = panel.frame.size
            panel.setFrameOrigin(NSPoint(
                x: visible.midX - size.width / 2, y: visible.minY + visible.height * 0.18))
        }
        panel.alphaValue = 1
        panel.present()
        dismissal?.invalidate()
        let dismissal = Timer(timeInterval: Self.shown(text), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.hide() }
        }
        RunLoop.main.add(dismissal, forMode: .common)
        self.dismissal = dismissal
    }

    private func hide() {
        guard let panel = panel?.panel else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.25
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                // A copy that arrived during the fade brought it back; leave that one up.
                guard self?.dismissal?.isValid != true else { return }
                panel.orderOut(nil)
            }
        })
    }

    static func makePanel(_ text: String) -> OverlayPanel {
        let content = NSHostingView(rootView: PasteNoticeView(text: text))
        content.sizingOptions = [.intrinsicContentSize]
        let panel = OverlayPanel(
            contentRect: NSRect(origin: .zero, size: content.fittingSize), level: .statusBar,
            title: title)
        // A click on it would land on nothing; let it fall through to the app underneath.
        panel.ignoresMouseEvents = true
        panel.contentView = content
        return panel
    }
}

struct PasteNoticeView: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "doc.on.clipboard")
            .font(.system(size: 13, weight: .medium))
            // Material vibrancy dims plain text; the one line this notice says must read at a glance.
            .foregroundStyle(Color(nsColor: .labelColor))
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(.separator, lineWidth: 0.5))
            .accessibilityLabel(text.replacingOccurrences(of: "⌘V", with: "Command V"))
    }
}
