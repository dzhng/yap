import AppKit
import YapControls
import YapMedia

@main struct CaptureViewCheck {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        var regions: [CGRect?] = []
        let regionView = RegionSelectionView(frame: NSRect(x: 0, y: 0, width: 200, height: 200)) { regions.append($0) }
        func mouse(_ type: NSEvent.EventType, _ x: CGFloat, _ y: CGFloat) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: y), modifierFlags: [],
                              timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0,
                              clickCount: 1, pressure: 1)!
        }
        regionView.mouseDown(with: mouse(.leftMouseDown, 10, 20))
        regionView.mouseUp(with: mouse(.leftMouseUp, 10, 20))
        precondition(regions.isEmpty, "A simple click must leave the area chooser open for a drag")
        regionView.mouseDown(with: mouse(.leftMouseDown, 10, 20))
        regionView.mouseUp(with: mouse(.leftMouseUp, 70, 100))
        precondition(regions == [CGRect(x: 10, y: 100, width: 60, height: 80)], "A drag completes selection in display-local coordinates")
        var recorded: [CaptureViewIntent] = []
        let input = fixture()
        let appIcon = NSImage(contentsOfFile: CommandLine.arguments[2])!
        let view = CaptureView(appIcon: appIcon, input: input) { recorded.append($0) }
        // AppKit puts a scroll view back on the system's preferred scrollers whenever that
        // preference changes, as it does while a mouse is connected. A reserved scroller would
        // narrow the menu and clip its right edge.
        view.scrollView.scrollerStyle = .legacy
        precondition(view.scrollView.scrollerStyle == .overlay,
                     "The capture menu keeps overlay scrollers whatever the system prefers")
        var withLastRecording = input
        withLastRecording.lastRecording = .init(recordingId: "fixture-recording", title: "Today — 0:12", canPlay: true, canCopyPrompt: true)
        let recent = CaptureView(appIcon: appIcon, input: withLastRecording) { recorded.append($0) }
        precondition(recent.control(identifier: "recording.play.fixture-recording") != nil,
                     "The capture menu places the last recording's Play action below the controls")
        precondition(recent.control(identifier: "recording.copyPrompt.fixture-recording") != nil,
                     "The capture menu places the last recording's prompt action below the controls")
        (recent.control(identifier: "recording.play.fixture-recording") as! NSButton).performClick(nil)
        precondition(recorded.last == .controls(.playRecording("fixture-recording")),
                     "The capture menu dispatches the same Play action as Library")
        (recent.control(identifier: "recording.copyPrompt.fixture-recording") as! NSButton).performClick(nil)
        precondition(recorded.last == .controls(.copyRecordingPrompt("fixture-recording")),
                     "The capture menu dispatches the same prompt action as Library")
        let failed = CaptureView(appIcon: appIcon, input: failureFixture()) { recorded.append($0) }
        let retry = failed.control(identifier: ControlsAction.retryFailure.id)!
        let dismiss = failed.control(identifier: ControlsAction.dismissFailure.id)!
        let start = failed.control(identifier: "capture.start")!
        precondition(retry.frame.minY == dismiss.frame.minY && retry.frame.maxX < dismiss.frame.minX,
                     "Retry and Dismiss must share one row, with Retry first")
        precondition(retry.frame.width < start.frame.width / 2 && retry.frame.height < start.frame.height,
                     "Failure actions stay compact beside the primary recording action")
        func pixels(_ button: NSButton) -> Data {
            let bitmap = button.bitmapImageRepForCachingDisplay(in: button.bounds)!
            button.cacheDisplay(in: button.bounds, to: bitmap)
            return bitmap.tiffRepresentation!
        }
        for id in ["recording.play.fixture-recording", "recording.copyPrompt.fixture-recording"] {
            let button = recent.control(identifier: id) as! NSButton
            let resting = pixels(button)
            button.cell!.highlight(true, withFrame: button.bounds, in: button)
            precondition(pixels(button) != resting, "A pressed recording action must look pressed: \(id)")
            button.cell!.highlight(false, withFrame: button.bounds, in: button)
            precondition(pixels(button) == resting, "A released recording action returns to rest: \(id)")
        }
        recorded.removeAll()
        let rowIcons = view.scrollView.documentView!.subviews.compactMap { $0 as? NSImageView }.filter { $0.frame.width == 16 }
        for icon in rowIcons {
            let bitmap = NSBitmapImageRep(data: icon.image!.tiffRepresentation!)!
            var brightest: CGFloat = 0
            for y in 0..<bitmap.pixelsHigh {
                for x in 0..<bitmap.pixelsWide {
                    if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), color.alphaComponent > 0.2 {
                        brightest = max(brightest, max(color.redComponent, color.greenComponent, color.blueComponent))
                    }
                }
            }
            precondition(brightest > 0.4, "Row icons must contrast with the dark surface on initial construction")
        }
        precondition(view.control(identifier: "library.open") == nil, "Library has one entry point in the header")
        let library = view.control(identifier: "header.library") as! NSButton
        library.performClick(nil)
        precondition(recorded == [.openLibrary], "Header library action reaches the caller")
        recorded.removeAll()
        view.frame.size = NSSize(width: CaptureView.preferredWidth, height: view.contentHeight)
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: CaptureView.preferredWidth, height: view.contentHeight),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.orderBack(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        let popover = CapturePopover { recorded.append($0) }
        popover.update(input)
        popover.toggle(relativeTo: view)
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        precondition(popover.view?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua,
                     "First popover presentation must use dark appearance")
        precondition(!NSApp.isActive, "The prohibited offscreen fixture must not activate the desktop")
        popover.close()
        popover.toggle(relativeTo: view)
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        precondition(popover.isShown, "The explicit dismissal panel must reopen cleanly")
        NotificationCenter.default.post(name: NSApplication.didResignActiveNotification, object: NSApp)
        precondition(!popover.isShown, "Switching applications must dismiss the recording panel")
        popover.close()
        guard let button = view.control(identifier: "source.cameraOnly") as? NSButton else {
            preconditionFailure("Camera Only must be an explicit source choice")
        }
        button.performClick(nil)
        precondition(recorded == [.chooseSource(.cameraOnly)], "Source choice reaches caller unchanged")
        guard let microphone = view.control(identifier: "microphone.toggle") as? NSSwitch else {
            preconditionFailure("Microphone uses the native macOS switch")
        }
        precondition(microphone.state == .on, "Assistive clients can read the supplied microphone on state")
        microphone.performClick(nil)
        let camera = view.control(identifier: "camera.device") as! NSPopUpButton
        camera.selectItem(at: 0)
        _ = camera.sendAction(camera.action!, to: camera.target)
        precondition(recorded == [.chooseSource(.cameraOnly), .controls(.disableMicrophone), .camera("fixture-camera")])
        window.orderOut(nil)
        window.close()
        // A Mac with no camera or microphone shows both rows disabled and off.
        let bare = CaptureView(appIcon: appIcon, input: fixture(noDevices: true)) { recorded.append($0) }
        for id in ["camera.device", "camera.toggle", "microphone.device", "microphone.toggle"] {
            precondition(bare.control(identifier: id)?.isEnabled == false, "\(id) is disabled when the Mac has no such device")
        }
        for id in ["camera.toggle", "microphone.toggle"] {
            precondition((bare.control(identifier: id) as? NSSwitch)?.state == .off, "\(id) is off when the Mac has no such device")
        }
        let selectedSource = CaptureView(appIcon: appIcon, input: fixture(secondSource: true)) { recorded.append($0) }
        let sourcePopup = selectedSource.control(identifier: "source.device") as! SourcePickerButton
        precondition(sourcePopup.title == "Studio Display", "Rebuilding preserves the owner-selected source device")
        let restingSource = pixels(sourcePopup)
        sourcePopup.cell!.highlight(true, withFrame: sourcePopup.bounds, in: sourcePopup)
        precondition(pixels(sourcePopup) != restingSource, "A pressed source chooser must look pressed")
        sourcePopup.cell!.highlight(false, withFrame: sourcePopup.bounds, in: sourcePopup)
        precondition(pixels(sourcePopup) == restingSource, "A released source chooser returns to rest")
        sourcePopup.choose(at: 0)
        precondition(recorded.last == .controls(.selectDisplay(1)), "Choosing a source card sends that source's intent")
        // The chooser draws each source's picture whole, at its own shape, with its title, on the
        // menu's dark surface. A portrait window is red so its drawn shape can be measured.
        let portrait = NSImage(size: NSSize(width: 60, height: 160), flipped: false) { rect in
            NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1).setFill(); rect.fill(); return true
        }
        func redBox(_ bitmap: NSBitmapImageRep) -> NSRect? {
            var box: NSRect?
            for y in 0..<bitmap.pixelsHigh { for x in 0..<bitmap.pixelsWide {
                guard let c = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB),
                      c.redComponent > 0.85, c.greenComponent < 0.2, c.blueComponent < 0.2 else { continue }
                box = box.map { $0.union(NSRect(x: x, y: y, width: 1, height: 1)) } ?? NSRect(x: x, y: y, width: 1, height: 1)
            } }
            return box
        }
        // Drawn over the dark material a dark popover puts behind its content, so a chooser that
        // paints its own light sheet shows up as one.
        func render(_ view: NSView) -> NSBitmapImageRep {
            let stage = NSView(frame: NSRect(origin: .zero, size: view.frame.size))
            stage.wantsLayer = true
            stage.layer?.backgroundColor = NSColor(white: 0.16, alpha: 1).cgColor
            view.frame.origin = .zero
            stage.addSubview(view)
            let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: view.frame.width, height: view.frame.height),
                                  styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .darkAqua)
            window.contentView = stage
            window.orderBack(nil)
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            let bitmap = stage.bitmapImageRepForCachingDisplay(in: stage.bounds)!
            stage.cacheDisplay(in: stage.bounds, to: bitmap)
            window.orderOut(nil)
            view.removeFromSuperview()
            // Measure in sRGB whatever the display: a wide-gamut screen backs the bitmap in Display P3.
            return bitmap.converting(to: .sRGB, renderingIntent: .default)!
        }
        let chooserSources: [CaptureViewInput.Choice] = [
            .init(title: "Notes — Portrait window", intent: .controls(.selectWindow(7)), preview: portrait),
            .init(title: "Studio Display", intent: .controls(.selectDisplay(2)), preview: fixture().sourceChoices[0].preview),
            .init(title: "Untitled window", intent: .controls(.selectWindow(8))),
        ]
        sourcePopup.configure(values: chooserSources, selected: 0) { recorded.append($0) }
        let chooser = sourcePopup.chooserView()
        precondition(chooser.appearance?.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua,
                     "The source chooser uses the menu's dark appearance")
        let drawn = render(chooser)
        try! drawn.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(CommandLine.arguments[1])/source-chooser.png"))
        var luminance: CGFloat = 0
        for y in stride(from: 0, to: drawn.pixelsHigh, by: 4) { for x in stride(from: 0, to: drawn.pixelsWide, by: 4) {
            let c = drawn.colorAt(x: x, y: y)!.usingColorSpace(.sRGB)!
            luminance += 0.2126 * c.redComponent + 0.7152 * c.greenComponent + 0.0722 * c.blueComponent
        } }
        luminance /= CGFloat((drawn.pixelsHigh / 4 + 1) * (drawn.pixelsWide / 4 + 1))
        precondition(luminance < 0.35, "The source chooser is dark like the menu, not a light sheet: \(luminance)")
        guard let card = redBox(drawn) else { preconditionFailure("The portrait source's picture must be drawn") }
        precondition(card.height >= 40 && abs(card.width / card.height - 60.0 / 160.0) < 0.08,
                     "A source picture keeps its shape: \(card.size)")
        let cards = chooser.subviews.compactMap { $0 as? NSButton }
        precondition(cards.map(\.title) == chooserSources.map(\.title), "Every source card carries its title")
        for card in cards {
            let lower = card.convert(NSRect(x: 0, y: card.bounds.height - 24, width: card.bounds.width, height: 20), to: chooser)
            var bright = 0
            let scale = CGFloat(drawn.pixelsWide) / chooser.bounds.width
            for y in Int(lower.minY * scale)..<Int(lower.maxY * scale) { for x in Int(lower.minX * scale)..<Int(lower.maxX * scale) {
                let row = chooser.isFlipped ? y : drawn.pixelsHigh - 1 - y
                if let c = drawn.colorAt(x: x, y: row)?.usingColorSpace(.sRGB), c.redComponent > 0.75, c.greenComponent > 0.75, c.blueComponent > 0.75 { bright += 1 }
            } }
            precondition(bright > 20, "Source card \(card.title) shows its title: \(bright) light pixels")
        }
        // Many windows scroll inside a chooser no taller than four and a half rows, opened at the
        // chosen one; a long name is shortened on its card rather than spilling over.
        let many: [CaptureViewInput.Choice] = (0..<12).map {
            .init(title: $0 == 11 ? "Google Chrome — A very long document title that cannot fit on one card at all" : "Window \($0)",
                  intent: .controls(.selectWindow($0)), preview: portrait)
        }
        sourcePopup.configure(values: many, selected: 11) { recorded.append($0) }
        guard let scroller = sourcePopup.chooserView() as? NSScrollView, let cardsView = scroller.documentView else {
            preconditionFailure("A long source list scrolls")
        }
        precondition(scroller.frame.height <= 4.5 * 140 + 8, "The chooser stays a bounded height: \(scroller.frame.height)")
        precondition(cardsView.subviews.count == 12, "Every source is in the scrolling chooser")
        let longCard = cardsView.subviews.last!
        precondition(scroller.contentView.documentVisibleRect.contains(longCard.frame), "The chooser opens showing the chosen source")
        let longDrawn = render(scroller)
        try! longDrawn.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(CommandLine.arguments[1])/source-chooser-many.png"))
        sourcePopup.configure(values: chooserSources, selected: 0) { recorded.append($0) }
        let field = render({ sourcePopup.frame = NSRect(x: 0, y: 0, width: 306, height: 28); return sourcePopup }())
        guard let thumb = redBox(field) else { preconditionFailure("The source field shows the chosen source's picture") }
        precondition(abs(thumb.width / thumb.height - 60.0 / 160.0) < 0.15, "The field's thumbnail keeps its shape: \(thumb.size)")
        // Source pictures arrive after the menu is drawn. The chooser shows them when they do, and
        // the field it replaces leaves instead of staying behind it.
        func sourceFields(_ capture: CaptureView) -> Int {
            capture.scrollView.documentView!.subviews.filter { $0.identifier?.rawValue == "source.device" }.count
        }
        let arriving = CaptureView(appIcon: appIcon, input: fixture(secondSource: true, previews: false)) { recorded.append($0) }
        precondition(arriving.control(identifier: "source.device") is NSPopUpButton, "Sources without pictures use the menu field")
        arriving.update(fixture(secondSource: true))
        precondition(arriving.control(identifier: "source.device") is SourcePickerButton && sourceFields(arriving) == 1,
                     "Pictures that arrive after the menu is drawn replace the menu field: \(sourceFields(arriving)) fields")
        arriving.update(fixture(secondSource: true, previews: false))
        precondition(arriving.control(identifier: "source.device") is NSPopUpButton && sourceFields(arriving) == 1,
                     "Sources that lose their pictures return to one menu field: \(sourceFields(arriving)) fields")
        let duplicate = CaptureView(appIcon: appIcon, input: fixture(duplicateNames: true)) { recorded.append($0) }
        let duplicateCamera = duplicate.control(identifier: "camera.device") as! NSPopUpButton
        duplicateCamera.selectItem(at: duplicateCamera.numberOfItems - 1)
        _ = duplicateCamera.sendAction(duplicateCamera.action!, to: duplicateCamera.target)
        precondition(duplicateCamera.titleOfSelectedItem == "Another camera")
        precondition(recorded.last == .camera("fixture-camera-third"), "A chooser preserves identity when device labels repeat")
        let silentMic = CaptureView(appIcon: appIcon, input: fixture(microphoneOn: false)) { recorded.append($0) }
        let micEnable = silentMic.control(identifier: "microphone.toggle") as! NSSwitch
        precondition(micEnable.state == .off, "Assistive clients can read the supplied microphone off state")
        micEnable.performClick(nil)
        precondition(recorded.last == .controls(.selectMicrophone("fixture-mic")), "Enabling a named microphone preserves its displayed identity")
        var lockedActions: [CaptureViewIntent] = []
        let locked = CaptureView(appIcon: appIcon, input: fixture(locked: true)) { lockedActions.append($0) }
        for id in ["source.cameraOnly", "microphone.toggle", "capture.start"] {
            let control = locked.control(identifier: id)!
            precondition(!control.isEnabled, "Locked take inputs and unavailable Start cannot accept actions")
            if let button = control as? NSButton { button.performClick(nil) }
            if let toggle = control as? NSSwitch { toggle.performClick(nil) }
        }
        precondition(lockedActions.isEmpty, "Inapplicable actions cannot escape the view")
        let idleSwitch = view.control(identifier: "camera.toggle") as! NSSwitch
        idleSwitch.performClick(nil)
        precondition(recorded.last == .controls(.setCamera(true)),
                     "Before a take the camera switch sends the shared camera action: \(String(describing: recorded.last))")
        var reserved = fixture(locked: true)
        reserved.cameraOn = true
        reserved.liveCamera = true
        let live = CaptureView(appIcon: appIcon, input: reserved) { lockedActions.append($0) }
        let liveSwitch = live.control(identifier: "camera.toggle") as! NSSwitch
        precondition(liveSwitch.isEnabled && liveSwitch.state == .on && !live.control(identifier: "camera.device")!.isEnabled,
                     "During a take that reserved a camera, its switch stays usable and its device stays fixed")
        liveSwitch.performClick(nil)
        precondition(lockedActions == [.controls(.setCamera(false))],
                     "The live camera switch sends the same action as the floating controls: \(lockedActions)")
        lockedActions.removeAll()
        let permissions = CaptureView(appIcon: appIcon, input: permissionFixture()) { recorded.append($0) }
        for id in ["source.display", "source.window", "source.area", "source.device"] {
            precondition(!permissions.control(identifier: id)!.isEnabled, "Screen selection must be disabled without permission: \(id)")
        }
        precondition(permissions.control(identifier: "source.cameraOnly")!.isEnabled,
                     "Missing screen access must not disable camera-only capture")
        precondition((permissions.control(identifier: "source.device") as! NSPopUpButton).titleOfSelectedItem == "Screen Recording access required",
                     "The disabled source chooser must explain the missing permission")
        let screenAccess = permissions.control(identifier: "permission.screen") as! NSButton
        screenAccess.performClick(nil)
        precondition(recorded.last == .controls(.requestScreenPermission), "Permission rows dispatch the supplied access request")
        precondition(screenAccess.frame.height <= 30, "Permission actions fit a compact single-line row")
        var authorized = permissionFixture()
        authorized.screenSourcesEnabled = true
        authorized.permissionActions = []
        authorized.notices = []
        permissions.update(authorized)
        for id in ["source.display", "source.window", "source.area", "source.device"] {
            precondition(permissions.control(identifier: id)!.isEnabled, "Granting access must re-enable screen selection: \(id)")
        }
        let output = CommandLine.arguments[1]
        let labelled = CommandLine.arguments[3] != "omit"
        var observations: [[String: Any]] = []
        for (name, facts, limit) in [
            ("failure", failureFixture(), CGFloat(0)),
            ("idle", fixture(), CGFloat(0)),
            ("camera-only", fixture(cameraOnly: true), CGFloat(0)),
            ("recording", recordingFixture(), CGFloat(0)),
            ("last-recording", fixture(lastRecording: true), CGFloat(0)),
            ("maximum-duration", maximumDurationFixture(), CGFloat(0)),
            ("paused", recordingFixture(paused: true), CGFloat(0)),
            ("admin-notice", adminNoticeFixture(), CGFloat(0)),
            ("admin-notice-dark", adminNoticeFixture(), CGFloat(0)),
            ("permissions", permissionFixture(), CGFloat(0)),
            ("permissions-dark", permissionFixture(), CGFloat(0)),
            ("dark", fixture(), CGFloat(0)),
            ("long-names", fixture(longNames: true), CGFloat(0)),
            ("no-devices", fixture(noDevices: true), CGFloat(0)),
            ("short-screen", fixture(longNames: true), CGFloat(440)),
        ] {
            let capture = CaptureView(appIcon: appIcon, input: facts) { recorded.append($0) }
            let height = limit > 0 ? limit : capture.contentHeight
            let stage = NSView(frame: NSRect(x: 0, y: 0, width: CaptureView.preferredWidth + 40, height: height + 40))
            stage.wantsLayer = true
            // Layout shots supply a dark backing; they do not verify composited native glass.
            stage.layer?.backgroundColor = NSColor(white: 0.10, alpha: 1).cgColor
            capture.frame = NSRect(x: 20, y: 20, width: CaptureView.preferredWidth, height: height)
            stage.addSubview(capture)
            if labelled {
                let caption = NSTextField(labelWithString: "Synthetic facts · presentation fixture")
                caption.font = .systemFont(ofSize: 9)
                caption.textColor = .secondaryLabelColor
                caption.frame = NSRect(x: 20, y: 2, width: CaptureView.preferredWidth, height: 14)
                stage.addSubview(caption)
            }
            let shotWindow = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: CaptureView.preferredWidth + 40, height: height + 40), styleMask: .borderless, backing: .buffered, defer: false)
            shotWindow.isReleasedWhenClosed = false
            shotWindow.appearance = NSAppearance(named: name.contains("dark") ? .darkAqua : .aqua)
            shotWindow.contentView = stage
            shotWindow.orderBack(nil)
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
            capture.layoutSubtreeIfNeeded()
            if limit == 0 {
                let start = capture.control(identifier: "capture.start")!
                let rect = start.convert(start.bounds, to: capture.scrollView.documentView!)
                precondition(capture.scrollView.contentView.bounds.contains(rect), "The full-height view must show the complete Start button without scrolling")
            }
            func save(_ suffix: String) {
                let bitmap = stage.bitmapImageRepForCachingDisplay(in: stage.bounds)!
                stage.cacheDisplay(in: stage.bounds, to: bitmap)
                try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(output)/\(name)\(suffix).png"))
            }
            save("")
            let scroll = capture.scrollView
            let doc = scroll.documentView!
            let quit = capture.control(identifier: "app.quit")!
            let anchoredQuit = quit.convert(quit.bounds, to: capture)
            let ids = ["header.library", "header.settings", "source.display", "source.window", "source.area", "source.cameraOnly", "camera.device", "microphone.device", "microphone.toggle", "systemAudio.toggle", "countdown.toggle", "capture.start", "app.quit"] + (facts.selectedSource == .cameraOnly ? [] : ["source.device", "camera.toggle"])
            var frames: [String: [Double]] = [:]
            for id in ids {
                let control = capture.control(identifier: id)!
                let rect = control.convert(control.bounds, to: doc)
                frames[id] = [rect.minX, rect.minY, rect.width, rect.height]
            }
            observations.append(["fixture": name, "facts": "synthetic; no service/devices/permissions", "appearance": name.contains("dark") ? "darkAqua" : "aqua", "widthPoints": CaptureView.preferredWidth, "heightPoints": height, "contentHeightPoints": capture.contentHeight, "backingScale": shotWindow.backingScaleFactor, "controls": frames])
            // Retain the complete operands before a reachability assertion can stop the run.
            let report = try! JSONSerialization.data(withJSONObject: observations, options: [.prettyPrinted, .sortedKeys])
            try! report.write(to: URL(fileURLWithPath: "\(output)/native-metadata.json"))
            for id in ids {
                let control = capture.control(identifier: id)!
                let rect = control.convert(control.bounds, to: doc)
                // The status footer is fixed to the capture surface rather than part of the
                // scrolling document. It is reachable without moving the document.
                if id == "app.quit" {
                    precondition(capture.bounds.contains(control.convert(control.bounds, to: capture)), "Fixed footer action must remain visible: \(id)")
                    continue
                }
                doc.scrollToVisible(rect)
                scroll.reflectScrolledClipView(scroll.contentView)
                precondition(scroll.contentView.bounds.contains(rect), "Scrolling must reveal the complete action: \(id)")
                precondition(quit.convert(quit.bounds, to: capture) == anchoredQuit, "Scrolling must not move the status footer")
            }
            if name == "short-screen" {
                doc.scrollToVisible(NSRect(x: 0, y: doc.bounds.height - 1, width: 1, height: 1))
                scroll.reflectScrolledClipView(scroll.contentView)
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                save("-bottom")
                precondition(scroll.contentView.bounds.minY > 0, "Short-screen fixture must scroll")
                let start = capture.control(identifier: "capture.start") as! NSButton
                start.performClick(nil)
                precondition(recorded.last == .controls(.startOrStop), "Scrolled Start remains actionable")
            }
            shotWindow.orderOut(nil)
            shotWindow.close()
        }
        let running = CaptureView(appIcon: appIcon, input: recordingFixture()) { recorded.append($0) }
        let actionFrames = ["capture.start", ControlsAction.pauseOrResume.id, ControlsAction.cancel.id, ControlsAction.restart.id].map {
            running.control(identifier: $0)!.frame
        }
        precondition(actionFrames.allSatisfy { $0.minX == actionFrames[0].minX && $0.width == actionFrames[0].width },
                     "Recording actions must share aligned left and right edges")
        let actionGaps = zip(actionFrames, actionFrames.dropFirst()).map { $1.minY - $0.maxY }
        precondition(actionGaps.allSatisfy { $0 > 0 && $0 == actionGaps[0] },
                     "Recording actions need equal positive gaps, including beneath Finish")

    }

    @MainActor static func maximumDurationFixture() -> CaptureViewInput {
        var state = ControlsState()
        state.take = .init(id: "twelve-hour-take", state: "complete", interruptionReason: nil,
            sourceDurationUs: 43_200_000_000, completionReason: "maximumDuration")
        var input = fixture(lastRecording: true)
        input.notices = CapturePresentation.noticeLines(for: state)
        return input
    }

    @MainActor static func adminNoticeFixture() -> CaptureViewInput {
        var input = fixture()
        input.adminMessage = "Yap 0.1.41 cannot update itself. Back up ~/.yap, then reinstall Yap from justyap.io."
        return input
    }

    @MainActor static func permissionFixture() -> CaptureViewInput {
        var input = fixture(startEnabled: false, status: "Idle")
        input.screenSourcesEnabled = false
        input.notices = [CapturePresentation.screenSelectionPermissionNotice]
        input.permissionActions = [.init(.requestScreenPermission, "Allow in System Settings…", enabled: true), .init(.requestMicrophonePermission, "Allow Microphone Access…", enabled: true)]
        return input
    }

    @MainActor static func recordingFixture(paused: Bool = false) -> CaptureViewInput {
        var input = fixture(locked: true, cameraOnly: true, startEnabled: true, status: paused ? "Paused — 0:04" : "Recording — 0:04")
        input.startTitle = "Finish Recording"
        input.startShortcut = "⌃⌥⌘R"
        input.transport = [
            .init(.pauseOrResume, paused ? "Resume Recording" : "Pause Recording", enabled: true),
            .init(.cancel, "Cancel Take", enabled: true),
            .init(.restart, "Restart Take", enabled: true),
        ]
        return input
    }

    @MainActor static func failureFixture() -> CaptureViewInput {
        var input = fixture()
        var state = ControlsState()
        state.service = .ready
        state.selection.source = .display(.init(id: 1, name: "Studio Display", width: 2560, height: 1440))
        let request = state.beginStart(newRequestId: "fixture-start")!
        state.failure = .init(RefusalLedger.cause("TIMEOUT")!, request: "fixture-start", action: .start(request), operation: "capture.start")
        input.failureMessage = state.failure?.message
        input.notices = CapturePresentation.noticeLines(for: state)
        input.failureAction = CapturePresentation.failureAction(for: state)
        return input
    }
    @MainActor static func fixture(locked: Bool = false, cameraOnly: Bool = false, longNames: Bool = false, duplicateNames: Bool = false, microphoneOn: Bool = true, secondSource: Bool = false, startEnabled: Bool? = nil, status: String = "Ready to record", lastRecording: Bool = false, previews: Bool = true, noDevices: Bool = false) -> CaptureViewInput {
        let preview = !previews ? nil : NSImage(size: NSSize(width: 160, height: 90), flipped: false) { rect in
            NSColor(calibratedWhite: 0.12, alpha: 1).setFill(); rect.fill()
            NSColor(calibratedRed: 0.24, green: 0.48, blue: 0.78, alpha: 1).setFill()
            NSBezierPath(rect: rect.insetBy(dx: 10, dy: 9)).fill()
            NSColor.white.withAlphaComponent(0.65).setFill()
            NSBezierPath(rect: NSRect(x: 20, y: 47, width: 54, height: 5)).fill()
            NSBezierPath(rect: NSRect(x: 20, y: 36, width: 92, height: 4)).fill()
            return true
        }
        var input = CaptureViewInput(selectedSource: cameraOnly ? .cameraOnly : .display, selectedSourceChoice: secondSource ? 1 : 0, sourceChoices: [.init(title: longNames ? "A very long external display name for a conference studio · 5120 × 2880" : "Built-in Retina Display · 3024 × 1964", intent: .controls(.selectDisplay(1)), preview: preview)] + (secondSource ? [.init(title: "Studio Display", intent: .controls(.selectDisplay(2)), preview: preview)] : []),
            cameraChoices: noDevices ? [.init(title: "No camera", intent: .controls(.setCamera(false)))] : [.init(title: longNames ? "Conference room camera with an unusually long name" : "FaceTime HD Camera", intent: .camera("fixture-camera"))] + (duplicateNames ? [.init(title: "FaceTime HD Camera", intent: .camera("fixture-camera-second")), .init(title: "Another camera", intent: .camera("fixture-camera-third"))] : []),
            selectedCamera: 0, cameraOn: !noDevices && (cameraOnly || longNames), cameraAvailable: !noDevices,
            microphoneChoices: noDevices ? [.init(title: "No microphone", intent: .controls(.disableMicrophone))] : [.init(title: longNames ? "Conference room microphone with an unusually long name" : "MacBook Pro Microphone", intent: .controls(.selectMicrophone("fixture-mic")))],
            selectedMicrophone: 0, microphoneOn: microphoneOn && !noDevices, microphoneAvailable: !noDevices, systemAudio: true, countdown: true,
            inputsEnabled: !locked, startEnabled: startEnabled ?? !locked, status: status)
        if lastRecording { input.lastRecording = .init(recordingId: "fixture-recording", title: "Today — 0:12", canPlay: true, canCopyPrompt: true) }
        return input
    }
}
