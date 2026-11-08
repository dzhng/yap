import AppKit

/// A scroll view whose scroller floats over its content. These surfaces are laid out to a fixed
/// width, and a reserved scroller would narrow them and clip their right edge. AppKit puts every
/// scroll view back on the system's preferred scrollers whenever that preference changes, as it
/// does while a mouse is connected, so the style is held here rather than set once.
final class OverlayScrollView: NSScrollView {
    override var scrollerStyle: NSScroller.Style {
        get { super.scrollerStyle }
        set { super.scrollerStyle = .overlay }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        scrollerStyle = .overlay
    }

    required init?(coder: NSCoder) { nil }
}
