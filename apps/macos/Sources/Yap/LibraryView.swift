import AppKit
import YapControls

/// Saved media presentation with only session-local tab/filter/scroll state. LibraryController
/// supplies observations; all explicit actions travel through the same ControlsAction dispatcher.
@MainActor
final class LibraryView: NSView, NSSearchFieldDelegate {
    enum Tab: String, CaseIterable { case recordings = "Recordings", projects = "Projects", exports = "Exports" }
    private var state: ControlsState
    private var exports: ExportsState
    private let perform: (ControlsAction) -> Void
    private(set) var tab: Tab = .recordings
    private var filter = ""
    private var scrollPositions: [Tab: NSPoint] = [:]
    let scrollView = OverlayScrollView()
    private let document = LibraryDocument()
    private var controls: [String: NSControl] = [:]
    private var actions: [ObjectIdentifier: ControlsAction] = [:]
    private var actionItems: [String: NSMenuItem] = [:]
    private var tabActions: [ObjectIdentifier: Tab] = [:]
    private let filterField = NSSearchField()
    override var isFlipped: Bool { true }

    init(state: ControlsState, exports: ExportsState, perform: @escaping (ControlsAction) -> Void) {
        self.state = state
        self.exports = exports
        self.perform = perform
        super.init(frame: NSRect(x: 0, y: 0, width: 768, height: 476))
        wantsLayer = true
        updateSurfaceColors()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.documentView = document
        addSubview(scrollView)
        filterField.placeholderString = "Filter this page"
        filterField.font = .systemFont(ofSize: 10)
        filterField.delegate = self
        filterField.identifier = .init("library.filter")
        render()
    }
    required init?(coder: NSCoder) { nil }

    func update(state: ControlsState, exports: ExportsState) {
        let changed = state.library != self.state.library || state.service != self.state.service
            || state.storage != self.state.storage || state.storageRefreshing != self.state.storageRefreshing
            || state.storageFailure != self.state.storageFailure || exports != self.exports
            || state.libraryFailure != self.state.libraryFailure
        self.state = state
        self.exports = exports
        guard changed else { return }
        scrollPositions[tab] = scrollView.contentView.bounds.origin
        render()
    }
    /// The paging owner explicitly tells presentation when its page changes.
    func clearPageFilter() {
        filter = ""
        filterField.stringValue = ""
        scrollPositions[tab] = .zero
        scrollView.contentView.scroll(to: .zero)
        renderContent()
    }
    func control(identifier: String) -> NSControl? { controls[identifier] }
    func actionItem(identifier: String) -> NSMenuItem? { actionItems[identifier] }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        effectiveAppearance.performAsCurrentDrawingAppearance {
            updateSurfaceColors()
            render()
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            updateSurfaceColors()
            render()
        }
    }

    private func updateSurfaceColors() {
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    override func layout() {
        super.layout()
        render()
    }

    func controlTextDidChange(_ notification: Notification) {
        filter = filterField.stringValue
        renderContent()
    }

    /// The height a wrapping label really takes at this width: measured by the same cell that
    /// draws it, so its last line is never clipped by a narrower text container.
    private func wrappedHeight(_ text: String, size: CGFloat, width: CGFloat) -> CGFloat {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size)
        return ceil(field.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width, height: .greatestFiniteMagnitude)).height ?? 0)
    }

    @discardableResult
    private func label(_ text: String, frame: NSRect, size: CGFloat, weight: NSFont.Weight = .regular,
                       color: NSColor = .labelColor, in parent: NSView, wrap: Bool = false, passive: Bool = false) -> NSTextField {
        let field = passive ? PassiveLabel(wrappingLabelWithString: text) : NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.frame = frame
        field.lineBreakMode = wrap ? .byWordWrapping : .byTruncatingTail
        field.maximumNumberOfLines = wrap ? 0 : 1
        parent.addSubview(field)
        return field
    }
    private func button(_ title: String, id: String, frame: NSRect, action: ControlsAction?, enabled: Bool = true, in parent: NSView) {
        let button = NSButton(title: title, target: self, action: #selector(activate(_:)))
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.font = .systemFont(ofSize: 10)
        button.frame = frame
        button.isEnabled = enabled
        button.identifier = .init(id)
        parent.addSubview(button)
        controls[id] = button
        if let action { actions[ObjectIdentifier(button)] = action }
    }
    private func render() {
        for view in subviews where view !== scrollView { view.removeFromSuperview() }
        controls = [:]
        actions = [:]
        tabActions = [:]
        actionItems = [:]
        let sidebar = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 146, height: bounds.height))
        sidebar.material = .sidebar
        sidebar.blendingMode = .behindWindow
        sidebar.state = .followsWindowActiveState
        addSubview(sidebar)
        let divider = NSBox(frame: NSRect(x: 145, y: 0, width: 1, height: bounds.height))
        divider.boxType = .separator
        addSubview(divider)
        label("Your library", frame: NSRect(x: 20, y: 21, width: 116, height: 20), size: 12, weight: .semibold, in: self)
        for (index, value) in Tab.allCases.enumerated() {
            let button = LibraryTabButton(title: value.rawValue, selected: value == tab,
                symbol: value == .recordings ? "play.rectangle.on.rectangle" : value == .projects ? "doc.on.doc" : "square.and.arrow.up")
            button.frame = NSRect(x: 11, y: 54 + CGFloat(index) * 41, width: 124, height: 35)
            button.identifier = .init("tab.\(value.rawValue.lowercased())")
            button.target = self
            button.action = #selector(selectTab(_:))
            addSubview(button)
            controls["tab.\(value.rawValue.lowercased())"] = button
            tabActions[ObjectIdentifier(button)] = value
        }
        let storage = state.storage.map(LibraryPresentation.storage)
        let footerY = max(200, bounds.height - 34)
        label(storage?.total ?? "Not measured", frame: NSRect(x: 20, y: footerY - 22, width: 92, height: 16), size: 10, color: .secondaryLabelColor, in: self)
        // The same total, split: what is media and what is prepared models.
        if let storage {
            label(storage.media, frame: NSRect(x: 20, y: footerY - 6, width: 116, height: 15), size: 10, color: .tertiaryLabelColor, in: self)
            label(storage.models, frame: NSRect(x: 20, y: footerY + 8, width: 116, height: 15), size: 10, color: .tertiaryLabelColor, in: self)
        }
        let refresh = NSButton(image: NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Refresh storage")!, target: self, action: #selector(activate(_:)))
        refresh.isBordered = false
        refresh.contentTintColor = .secondaryLabelColor
        refresh.toolTip = "Refresh storage"
        refresh.frame = NSRect(x: 114, y: footerY - 25, width: 22, height: 22)
        refresh.isEnabled = state.service == .ready && !state.storageRefreshing
        refresh.identifier = .init("storage.refresh")
        addSubview(refresh)
        controls["storage.refresh"] = refresh
        actions[ObjectIdentifier(refresh)] = .refreshStorage
        renderContent()
    }

    private func renderContent() {
        let oldOrigin = scrollView.contentView.bounds.origin
        for view in document.subviews where view !== filterField { view.removeFromSuperview() }
        controls = controls.filter { $0.key.hasPrefix("tab.") || $0.key == "storage.refresh" }
        let retained = Set(controls.values.map(ObjectIdentifier.init))
        actions = actions.filter { retained.contains($0.key) }
        actionItems = [:]
        let width = max(420, bounds.width - 146)
        scrollView.frame = NSRect(x: 146, y: 0, width: bounds.width - 146, height: bounds.height)
        label(tab.rawValue, frame: NSRect(x: 22, y: 23, width: width - 200, height: 29), size: 21, weight: .semibold, in: document)
        filterField.frame = NSRect(x: width - 154, y: 25, width: 132, height: 25)
        if filterField.superview !== document { document.addSubview(filterField) }
        controls["library.filter"] = filterField
        let subtitle = tab == .recordings ? "Your original captures. Always kept intact." : tab == .projects ? "Projects you explicitly created." : "Tracked deliveries and unfinished recovery."
        label(subtitle, frame: NSRect(x: 22, y: 55, width: width - 44, height: 20), size: 11, color: .secondaryLabelColor, in: document)
        let page: SavedPage
        switch tab {
        case .recordings: page = LibraryPresentation.recordings(for: state)
        case .projects: page = LibraryPresentation.projects(for: state, exports: exports)
        case .exports: page = ExportPresentation.items(for: state, exports: exports)
        }
        var y: CGFloat = 88
        for failure in [state.libraryFailure, state.storageFailure].compactMap({ $0 }) {
            let height = max(38, wrappedHeight(failure, size: 12, width: width - 44))
            label(failure, frame: NSRect(x: 22, y: y, width: width - 44, height: height), size: 12, color: .secondaryLabelColor, in: document, wrap: true)
            y += height + 6
        }
        let firstRow = y
        for row in page.items {
            guard row.kind != .message else {
                label(row.title, frame: NSRect(x: 22, y: y, width: width - 44, height: 38), size: 12, color: .secondaryLabelColor, in: document, wrap: true)
                y += 44
                continue
            }
            let details = row.details
            // Everything the row shows can be filtered on, its state included.
            guard filter.isEmpty || ([row.title] + (row.status.map { [$0] } ?? []) + details)
                .contains(where: { $0.localizedCaseInsensitiveContains(filter) }) else { continue }
            let id = row.id
            let top = y
            let textX: CGFloat = 76
            let textWidth = width - textX - 72
            let subtitle = ((row.status.map { [$0] } ?? []) + details).joined(separator: " · ")
            let subtitleHeight = subtitle.isEmpty ? 0 : wrappedHeight(subtitle, size: 11, width: textWidth)
            let height = max(60, 33 + subtitleHeight + 13)
            // The row is its own button: the whole card opens it, with its text and icon passing clicks through.
            let card = LibraryRowButton(frame: NSRect(x: 12, y: top + 2, width: width - 24, height: height - 4), clickable: row.open != nil)
            card.setAccessibilityLabel(row.open == nil ? row.title : "Open \(row.title)")
            if let open = row.open {
                card.target = self
                card.action = #selector(activate(_:))
                card.identifier = .init("open.\(id)")
                controls["open.\(id)"] = card
                actions[ObjectIdentifier(card)] = open
            }
            document.addSubview(card)
            // Colour means something: a problem row is the only one that stands out.
            let attention = row.attention
            let tint: NSColor = attention ? .systemOrange : row.kind == .project ? .systemBlue : .secondaryLabelColor
            let symbol = attention ? "exclamationmark.triangle.fill" : row.kind == .recording ? "video.fill" : row.kind == .imported ? "film" : row.kind == .project ? "square.stack.3d.up.fill" : "square.and.arrow.up.fill"
            let tile = PassiveImage(frame: NSRect(x: 28, y: top + 12, width: 36, height: 36))
            tile.wantsLayer = true
            tile.layer?.cornerRadius = 9
            tile.layer?.backgroundColor = (attention || row.kind == .project ? tint.withAlphaComponent(0.16) : NSColor.labelColor.withAlphaComponent(0.07)).cgColor
            tile.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 15, weight: .medium))
            tile.imageScaling = .scaleNone
            tile.contentTintColor = tint
            document.addSubview(tile)
            // A badge sits right after the title and keeps its room; a long title gives way to it.
            let badgeWidth = row.badge.map { ceil(($0 as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 10, weight: .medium)]).width) + 12 } ?? 0
            let titleRoom = row.badge == nil ? textWidth : textWidth - badgeWidth - 6
            let titleWidth = min(titleRoom, ceil((row.title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold)]).width) + 4)
            let title = label(row.title, frame: NSRect(x: textX, y: top + 12, width: row.badge == nil ? textWidth : titleWidth, height: 18), size: 13, weight: .semibold, in: document, passive: true)
            // A filename's end (its version and extension) is what tells two imports apart.
            if row.kind == .imported { title.lineBreakMode = .byTruncatingMiddle }
            if let badge = row.badge {
                let chip = PassiveLabel(labelWithString: badge)
                chip.font = .systemFont(ofSize: 10, weight: .medium)
                // Light text on a muted accent reads in dark mode; the accent itself reads in light mode.
                chip.textColor = NSColor(name: nil) { appearance in
                    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                        ? NSColor.controlAccentColor.blended(withFraction: 0.6, of: .white) ?? .white
                        : .controlAccentColor
                }
                chip.alignment = .center
                chip.wantsLayer = true
                chip.layer?.cornerRadius = 4
                chip.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.16).cgColor
                chip.frame = NSRect(x: textX + titleWidth + 6, y: top + 13, width: badgeWidth, height: 16)
                document.addSubview(chip)
            }
            if !subtitle.isEmpty {
                label(subtitle, frame: NSRect(x: textX, y: top + 32, width: textWidth, height: subtitleHeight), size: 11, color: attention ? .systemOrange : .secondaryLabelColor, in: document, wrap: true, passive: true)
            }
            if !row.actions.isEmpty {
                let more = NSPopUpButton(frame: NSRect(x: width - 56, y: top + 8, width: 30, height: 26), pullsDown: true)
                more.isBordered = false
                (more.cell as? NSPopUpButtonCell)?.arrowPosition = .noArrow
                let menu = NSMenu()
                menu.autoenablesItems = false
                let handle = NSMenuItem(title: "", action: nil, keyEquivalent: "")
                handle.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: "Actions")
                menu.addItem(handle)
                for command in row.actions {
                    let action = command.action
                    let item = NSMenuItem(title: command.title, action: #selector(activateItem(_:)), keyEquivalent: "")
                    item.target = self
                    item.isEnabled = command.enabled
                    item.representedObject = action
                    actionItems[action.id] = item
                    menu.addItem(item)
                }
                more.menu = menu
                more.contentTintColor = .secondaryLabelColor
                more.setAccessibilityLabel("Actions for \(row.title)")
                more.identifier = .init("actions.\(id)")
                document.addSubview(more)
                controls["actions.\(id)"] = more
            }
            y += height
        }
        if y == firstRow {
            label(filter.isEmpty ? "No tracked deliveries." : "No items match this page filter.", frame: NSRect(x: 22, y: y, width: width - 44, height: 44), size: 12, color: .secondaryLabelColor, in: document, wrap: true)
            y += 50
        }
        // The page's actions sit small, at the right; paging is offered only where another page exists.
        let shown = page.actions
        if !shown.isEmpty {
            y += 10
            var x = width - 22
            for command in shown.reversed() {
                let title = command.title as NSString
                let buttonWidth = ceil(title.size(withAttributes: [.font: NSFont.systemFont(ofSize: 11)]).width) + 28
                x -= buttonWidth
                button(command.title, id: command.action.id, frame: NSRect(x: x, y: y, width: buttonWidth, height: 24), action: command.action, enabled: command.enabled, in: document)
                x -= 8
            }
            y += 30
        }
        if tab == .recordings && page.items.contains(where: { $0.kind == .recording }) {
            y += 14
            label("Choose a recording, then ask your agent for the edit you want.", frame: NSRect(x: 22, y: y, width: width - 44, height: 16), size: 11, color: .tertiaryLabelColor, in: document)
            y += 20
        }
        document.frame = NSRect(x: 0, y: 0, width: width, height: max(bounds.height, y + 22))
        scrollView.contentView.scroll(to: oldOrigin)
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }
    @objc private func activate(_ sender: NSControl) {
        guard sender.isEnabled, let action = actions[ObjectIdentifier(sender)] else { return }
        perform(action)
    }
    @objc private func activateItem(_ sender: NSMenuItem) {
        guard sender.isEnabled, let action = sender.representedObject as? ControlsAction else { return }
        perform(action)
    }
    @objc private func selectTab(_ sender: NSButton) {
        guard let value = tabActions[ObjectIdentifier(sender)] else { return }
        scrollPositions[tab] = scrollView.contentView.bounds.origin
        tab = value
        filter = ""
        filterField.stringValue = ""
        render()
        scrollView.contentView.scroll(to: scrollPositions[tab] ?? .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }
}

@MainActor
private final class LibraryDocument: NSView { override var isFlipped: Bool { true } }

@MainActor
private final class LibraryTabButton: NSButton {
    private let selected: Bool
    private let symbol: String
    override var isFlipped: Bool { true }
    init(title: String, selected: Bool, symbol: String) {
        self.selected = selected
        self.symbol = symbol
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        setButtonType(.momentaryChange)
        setAccessibilityElement(true)
        setAccessibilityRole(.radioButton)
        setAccessibilityLabel(title)
        setAccessibilityValue(NSNumber(value: selected))
    }
    required init?(coder: NSCoder) { nil }
    override func draw(_ dirtyRect: NSRect) {
        if selected {
            NSColor.systemBlue.withAlphaComponent(0.12).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 7, yRadius: 7).fill()
        }
        let color: NSColor = selected ? .systemBlue : .secondaryLabelColor
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(.init(paletteColors: [color])) {
            image.draw(in: NSRect(x: 10, y: 9, width: 17, height: 17))
        }
        (title as NSString).draw(at: NSPoint(x: 35, y: 10), withAttributes: [.font: NSFont.systemFont(ofSize: 11, weight: selected ? .semibold : .regular), .foregroundColor: color])
    }
}

/// A row's text and picture are part of the row: a click on them reaches the row's open target
/// beneath, instead of starting a text selection or stopping at the picture.
private final class PassiveLabel: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
private final class PassiveImage: NSImageView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// A saved item's card. When it can be opened it highlights under the pointer and opens on click;
/// the row's text and icon pass clicks through to it, and its actions menu sits above it.
@MainActor
private final class LibraryRowButton: NSButton {
    private let clickable: Bool
    private var hovering = false { didSet { needsDisplay = true } }
    init(frame: NSRect, clickable: Bool) {
        self.clickable = clickable
        super.init(frame: frame)
        title = ""
        isBordered = false
        setButtonType(.momentaryChange)
        isEnabled = clickable
    }
    required init?(coder: NSCoder) { nil }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        guard clickable else { return }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func draw(_ dirtyRect: NSRect) {
        let alpha: CGFloat = isHighlighted ? 0.10 : hovering ? 0.06 : 0
        guard alpha > 0 else { return }
        NSColor.labelColor.withAlphaComponent(alpha).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10).fill()
    }
    override func resetCursorRects() {
        if clickable { addCursorRect(bounds, cursor: .pointingHand) }
    }
}
