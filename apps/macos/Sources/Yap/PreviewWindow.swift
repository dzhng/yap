import AppKit
import AVKit

/// Native presentation only. The preview controller owns readiness, identity and the delivery lease.
@MainActor
final class PreviewWindow: NSObject, PreviewPresenting, NSWindowDelegate {
    private var window: NSWindow?
    private var playerView: AVPlayerView?
    private var playerObservation: NSKeyValueObservation?
    private var playerEndedObservation: NSObjectProtocol?
    private var compositionTask: Task<Void, Never>?
    private var message: NSTextField?
    private var retry: NSButton?
    private var onRetry: (@MainActor () -> Void)?
    private var onClose: (@MainActor () -> Void)?
    private var timelineBar: NSStackView?
    private var exportButton: NSButton?
    /// Pushes Export to the right edge; kept with it when the timeline is rebuilt.
    private var exportSpacer: NSView?
    /// The strip above the video, holding revision history and Export; hidden while empty.
    private static let barHeight: CGFloat = 36
    private var timelineControl: NSView?
    private var timelineChoices: [String] = []
    private var timelineSelect: (@MainActor (String) -> Void)?
    private var exportAction: (@MainActor () -> Void)?

    /// While a take records, previews stay out of every capture: a display take leaves out this
    /// app's windows only if one was on screen when it began, and a preview may open after. At any
    /// other time people can screenshot and share them.
    static var takeInProgress = false {
        didSet { for preview in shown.allObjects { preview.applySharing() } }
    }
    private static let shown = NSHashTable<PreviewWindow>.weakObjects()
    private func applySharing() { window?.sharingType = Self.takeInProgress ? .none : .readOnly }

    /// Checks that intentionally exercise real windows keep them behind the person's work.
    private static let observed = !(ProcessInfo.processInfo.environment["YAP_FIXTURE_CONTROLS"] ?? "")
        .isEmpty

    func open(title: String, retry onRetry: @escaping @MainActor () -> Void,
        closed onClose: @escaping @MainActor () -> Void)
    {
        self.onRetry = onRetry
        self.onClose = onClose
        // Recordings are usually 16:9; a window of that shape shows one without letterboxing.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 450),
            styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.title = title
        // The header strip and the title bar read as one surface above the video.
        window.titlebarAppearsTransparent = true
        let container = NSView(frame: window.contentView!.bounds)
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor
        window.contentView = container
        let view = AVPlayerView(frame: container.bounds)
        view.autoresizingMask = [.width, .height]
        view.controlsStyle = .floating
        view.showsSharingServiceButton = false
        view.allowsVideoFrameAnalysis = false
        container.addSubview(view)
        let bar = NSStackView(frame: NSRect(x: 0, y: container.bounds.height - Self.barHeight,
            width: container.bounds.width, height: Self.barHeight))
        bar.autoresizingMask = [.width, .minYMargin]
        bar.orientation = .horizontal
        bar.alignment = .centerY
        bar.spacing = 6
        bar.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
        bar.wantsLayer = true
        bar.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        bar.isHidden = true
        container.addSubview(bar)
        timelineBar = bar
        let label = NSTextField(wrappingLabelWithString: "Preparing preview…")
        label.frame = NSRect(x: 24, y: 205, width: 752, height: 60)
        label.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        label.alignment = .center
        label.textColor = .white
        view.addSubview(label)
        let button = NSButton(title: "Retry Preview", target: self, action: #selector(retryPreview))
        button.frame = NSRect(x: 330, y: 165, width: 140, height: 32)
        button.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        button.isHidden = true
        view.addSubview(button)
        self.window = window
        Self.shown.add(self)
        applySharing()
        playerView = view
        message = label
        retry = button
        window.center()
        // An ordinary user preview comes forward; an explicit window check never takes focus.
        if Self.observed {
            window.orderBack(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func show(title: String, message: String, canRetry: Bool) {
        window?.title = title
        self.message?.stringValue = message
        self.message?.isHidden = false
        retry?.isHidden = !canRetry
    }

    /// Revision history as one control with the shown revision selected: segments while there are
    /// few, a menu once there are more than fit.
    func showTimeline(_ items: [PreviewTimelineItem], selected: String, select: @escaping @MainActor (String) -> Void) {
        guard let bar = timelineBar else { return }
        if let old = timelineControl {
            bar.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        timelineControl = nil
        timelineChoices = items.map(\.id)
        timelineSelect = select
        guard !items.isEmpty else { return layoutBar() }
        let index = items.firstIndex { $0.id == selected } ?? 0
        let control: NSView
        if items.count <= 5 {
            // Drawn, not system segments: the shown revision stays visibly selected even while the
            // window is in the background, where AppKit greys system controls.
            let pills = NSStackView()
            pills.orientation = .horizontal
            pills.spacing = 4
            pills.setAccessibilityElement(true)
            pills.setAccessibilityRole(.radioGroup)
            for (offset, item) in items.enumerated() {
                let pill = PreviewPill(title: item.label, style: offset == index ? .selected : .plain)
                pill.toolTip = item.operation
                pill.tag = offset
                pill.target = self
                pill.action = #selector(chooseRevision(_:))
                pill.identifier = .init("preview.revision.\(offset)")
                pills.addArrangedSubview(pill)
            }
            control = pills
        } else {
            let menu = NSPopUpButton(frame: .zero, pullsDown: false)
            menu.addItems(withTitles: items.map(\.label))
            menu.selectItem(at: index)
            menu.target = self
            menu.action = #selector(chooseRevision(_:))
            control = menu
        }
        control.identifier = .init("preview.revisions")
        control.setAccessibilityLabel("Revision")
        bar.insertArrangedSubview(control, at: 0)
        timelineControl = control
        layoutBar()
    }

    func showExport(_ action: @escaping @MainActor () -> Void) {
        exportAction = action
        guard let bar = timelineBar, exportButton == nil else { return }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        bar.addArrangedSubview(spacer)
        exportSpacer = spacer
        let button = PreviewPill(title: "Export", style: .prominent, symbol: "square.and.arrow.up")
        button.target = self
        button.action = #selector(exportPreview(_:))
        button.keyEquivalent = "e"
        button.keyEquivalentModifierMask = .command
        button.identifier = .init("inspector.export")
        bar.addArrangedSubview(button)
        exportButton = button
        layoutBar()
    }

    /// Shows the strip only when it holds something, above the video rather than over it. The
    /// window grows by the strip's height so the video keeps its shape.
    private func layoutBar() {
        guard let bar = timelineBar, let view = playerView, let window,
            let container = window.contentView else { return }
        let showing = timelineControl != nil || exportButton != nil
        guard showing == bar.isHidden else { return }
        bar.isHidden = !showing
        var frame = window.frame
        let change = showing ? Self.barHeight : -Self.barHeight
        frame.size.height += change
        frame.origin.y -= change
        window.setFrame(frame, display: true)
        view.frame = NSRect(x: 0, y: 0, width: container.bounds.width,
            height: container.bounds.height - (showing ? Self.barHeight : 0))
        bar.frame = NSRect(x: 0, y: container.bounds.height - Self.barHeight,
            width: container.bounds.width, height: Self.barHeight)
    }

    func play(title: String, file: String, mediaType: String, startAtUs: Int64?,
        failed: @escaping @MainActor (String) -> Void, ended: @escaping @MainActor () -> Void)
    {
        window?.title = title
        message?.isHidden = true
        retry?.isHidden = true
        // Cache names describe ownership, not containers; use the validated receipt's MIME type.
        let asset = AVURLAsset(url: URL(fileURLWithPath: file),
            options: [AVURLAssetOverrideMIMETypeKey: mediaType])
        let item = AVPlayerItem(asset: asset)
        playerObservation = item.observe(\.status, options: [.new]) { item, _ in
            guard item.status == .failed else { return }
            let reason = item.error?.localizedDescription ?? "Preview playback failed."
            Task { @MainActor in failed(reason) }
        }
        if let playerEndedObservation { NotificationCenter.default.removeObserver(playerEndedObservation) }
        playerEndedObservation = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { _ in
            Task { @MainActor in ended() }
        }
        let player = AVPlayer(playerItem: item)
        playerView?.player = player
        if let startAtUs { player.seek(to: CMTime(value: startAtUs, timescale: 1_000_000)) { _ in player.play() } }
        else { player.play() }
    }

    func playLocalFile(title: String, file: String, mediaType: String) {
        close()
        open(title: title, retry: {}, closed: {})
        play(title: title, file: file, mediaType: mediaType, startAtUs: nil, failed: { _ in }, ended: {})
    }

    /// A captured take stores picture and microphone narration as separate canonical members.
    /// AVPlayer accepts an in-memory composition, so the library can preview both without
    /// manufacturing a derived file or changing the retained source.
    func playLocalRecording(title: String, video: String, narration: String) {
        close()
        open(title: title, retry: {}, closed: {})
        let picture = AVURLAsset(url: URL(fileURLWithPath: video),
            options: [AVURLAssetOverrideMIMETypeKey: "video/quicktime"])
        let voice = AVURLAsset(url: URL(fileURLWithPath: narration),
            options: [AVURLAssetOverrideMIMETypeKey: "video/quicktime"])
        let composition = AVMutableComposition()
        compositionTask = Task { @MainActor [weak self] in
          do {
            let pictureTracks = try await picture.loadTracks(withMediaType: .video)
            let voiceTracks = try await voice.loadTracks(withMediaType: .audio)
            guard let pictureTrack = pictureTracks.first, let voiceTrack = voiceTracks.first else {
                throw NSError(domain: "YapPreview", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Recording media has no playable tracks."])
            }
            guard let composedPicture = composition.addMutableTrack(withMediaType: .video,
                preferredTrackID: kCMPersistentTrackID_Invalid),
                let composedVoice = composition.addMutableTrack(withMediaType: .audio,
                    preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw NSError(domain: "YapPreview", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Could not create preview tracks."])
            }
            try composedPicture.insertTimeRange(pictureTrack.timeRange, of: pictureTrack, at: .zero)
            try composedVoice.insertTimeRange(voiceTrack.timeRange, of: voiceTrack, at: .zero)
            // Closed while the tracks were loading: nothing may start playing now.
            guard !Task.isCancelled else { return }
            let item = AVPlayerItem(asset: composition)
            self?.playerObservation = item.observe(\.status, options: [.new]) { item, _ in
                guard item.status == .failed else { return }
            }
            self?.message?.isHidden = true
            self?.retry?.isHidden = true
            self?.playerView?.player = AVPlayer(playerItem: item)
            self?.playerView?.player?.play()
          } catch {
            guard !Task.isCancelled else { return }
            self?.show(title: title, message: error.localizedDescription, canRetry: false)
          }
        }
    }

    func close() {
        stopPlayback()
        playerObservation = nil
        if let playerEndedObservation { NotificationCenter.default.removeObserver(playerEndedObservation) }
        playerEndedObservation = nil
        playerView?.player = nil
        window?.delegate = nil
        window?.close()
        window = nil
        playerView = nil
        message = nil
        retry = nil
        onRetry = nil
        onClose = nil
        timelineBar = nil
        exportButton = nil
        exportSpacer = nil
        timelineControl = nil
        timelineChoices = []
        timelineSelect = nil
        exportAction = nil
    }

    /// A closed window never keeps playing, whoever opened it: a Library recording has no owner
    /// that would stop it.
    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSWindow === window else { return }
        stopPlayback()
        onClose?()
    }

    private func stopPlayback() {
        compositionTask?.cancel()
        compositionTask = nil
        playerView?.player?.pause()
        playerView?.player?.replaceCurrentItem(with: nil)
    }

    @objc private func retryPreview() { onRetry?() }
    @objc private func chooseRevision(_ sender: NSControl) {
        let index = (sender as? NSPopUpButton)?.indexOfSelectedItem ?? sender.tag
        guard timelineChoices.indices.contains(index) else { return }
        timelineSelect?(timelineChoices[index])
    }
    @objc private func exportPreview(_ sender: NSButton) { exportAction?() }
}

/// A header button drawn by the preview itself, so its state reads the same whether or not the
/// window is in front: the shown revision and Export are filled with the accent colour.
@MainActor
final class PreviewPill: NSButton {
    enum Style { case plain, selected, prominent }
    private let style: Style
    private let symbol: String?
    private var hovering = false { didSet { needsDisplay = true } }
    init(title: String, style: Style, symbol: String? = nil) {
        self.style = style
        self.symbol = symbol
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        setButtonType(.momentaryChange)
        if style != .prominent {
            setAccessibilityRole(.radioButton)
            setAccessibilityValue(NSNumber(value: style == .selected))
        }
        let width = (title as NSString).size(withAttributes: [.font: Self.font]).width + (symbol == nil ? 24 : 42)
        widthAnchor.constraint(equalToConstant: ceil(width)).isActive = true
        heightAnchor.constraint(equalToConstant: 26).isActive = true
    }
    required init?(coder: NSCoder) { nil }
    private static let font = NSFont.systemFont(ofSize: 12, weight: .medium)
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func draw(_ dirtyRect: NSRect) {
        let filled = style != .plain
        let fill: NSColor = filled ? .controlAccentColor : .labelColor.withAlphaComponent(hovering ? 0.10 : 0)
        (isHighlighted ? fill.blended(withFraction: 0.2, of: .black) ?? fill : fill).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 7, yRadius: 7).fill()
        let color: NSColor = filled ? .white : .secondaryLabelColor
        var x: CGFloat = 12
        if let symbol, let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .medium).applying(.init(paletteColors: [color])))
        {
            image.draw(in: NSRect(x: x, y: (bounds.height - 15) / 2, width: 13, height: 15))
            x += 19
        }
        let text = title as NSString
        let size = text.size(withAttributes: [.font: Self.font])
        text.draw(at: NSPoint(x: x, y: (bounds.height - size.height) / 2), withAttributes: [.font: Self.font, .foregroundColor: color])
    }
}
