import AppKit
import YapControls

/// One independent retained window; closing it preserves browsing presentation for reopening.
@MainActor
final class LibraryWindow {
    let view: LibraryView
    private let window: NSWindow
    var isVisible: Bool { window.isVisible }
    /// Where the delete question is asked, as a sheet.
    var sheetParent: NSWindow { window }

    init(perform: @escaping (ControlsAction) -> Void) {
        view = LibraryView(state: ControlsState(), exports: ExportsState(), perform: perform)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 768, height: 476),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Library"
        // One surface from the title bar down, rather than a separately tinted strip.
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.contentMinSize = NSSize(width: 566, height: 280)
        window.collectionBehavior = [.managed, .fullScreenAuxiliary]
        // Library is an ordinary user-facing window; allow screenshots and screen recording so
        // bugs can be reported. The preview window remains excluded from capture separately.
        window.sharingType = .readOnly
        window.center()
    }

    func update(state: ControlsState, exports: ExportsState) { view.update(state: state, exports: exports) }

    /// Activation belongs to the person's explicit request, never an observation refresh.
    func show() {
        WindowMenu.install()
        if window.isMiniaturized { window.deminiaturize(nil) }
        if ControlsProbe.observed { window.orderBack(nil) }
        else {
            NSApplication.shared.activate()
            window.makeKeyAndOrderFront(nil)
        }
    }
}
