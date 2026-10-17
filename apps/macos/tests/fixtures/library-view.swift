import AppKit
import YapControls

@main struct LibraryViewCheck {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        var state = ControlsState()
        state.service = .ready
        state.library.recent = [.init(recordingId: "fixture-recording", createdAt: "2026-10-05T19:18:00Z", state: "complete", sourceDurationUs: 154_000_000, interruptionReason: nil)]
        var actions: [ControlsAction] = []
        let view = LibraryView(state: state, exports: ExportsState()) { actions.append($0) }
        view.appearance = NSAppearance(named: .darkAqua)
        view.layoutSubtreeIfNeeded()
        let sidebar = view.subviews.first { $0.frame.width == 146 }
        precondition(sidebar?.layer?.backgroundColor != NSColor.white.cgColor,
            "Dark-mode library sidebar must not resolve to a white surface")
        func choose(_ item: NSMenuItem) { NSApplication.shared.sendAction(item.action!, to: item.target, from: item) }
        guard let play = view.actionItem(identifier: ControlsAction.playRecording("fixture-recording").id),
              let copy = view.actionItem(identifier: ControlsAction.copyRecordingPrompt("fixture-recording").id) else {
            preconditionFailure("The recording offers play and copy-agent-prompt actions")
        }
        choose(play)
        choose(copy)
        precondition(actions == [.playRecording("fixture-recording"), .copyRecordingPrompt("fixture-recording")], "The native Library preserves shared recording actions")
        let denied = LibraryView(state: ControlsState(), exports: ExportsState()) { actions.append($0) }
        denied.update(state: { var locked = state; locked.service = .unavailable("fixture service failure"); return locked }(), exports: ExportsState())
        let deniedPlay = denied.actionItem(identifier: ControlsAction.playRecording("fixture-recording").id)!
        let deniedCopy = denied.actionItem(identifier: ControlsAction.copyRecordingPrompt("fixture-recording").id)!
        precondition(!deniedPlay.isEnabled && deniedCopy.isEnabled, "Playback needs media service while prompt copying remains local")
        choose(deniedPlay)
        choose(deniedCopy)
        precondition(actions == [.playRecording("fixture-recording"), .copyRecordingPrompt("fixture-recording"), .copyRecordingPrompt("fixture-recording")], "Inapplicable playback cannot escape while local copying remains available")
        let menu = view.control(identifier: "actions.fixture-recording")!
        guard let row = view.control(identifier: "open.fixture-recording") as? NSButton else {
            preconditionFailure("A ready recording's whole row opens it")
        }
        let document = menu.superview!
        let center = document.convert(NSPoint(x: menu.frame.midX, y: menu.frame.midY), to: document.superview)
        let hit = document.hitTest(center)
        precondition(hit === menu || hit?.isDescendant(of: menu) == true,
                     "The row's actions menu stays above its click target")
        // A click on the row's title, not just its gaps, opens it.
        let titlePoint = document.convert(NSPoint(x: row.frame.minX + 110, y: row.frame.minY + 22), to: document.superview)
        let onTitle = document.hitTest(titlePoint)
        precondition(onTitle === row || onTitle?.isDescendant(of: row) == true,
                     "Clicking a row's title opens it, not a text selection: \(String(describing: onTitle))")
        row.performClick(nil)
        precondition(actions.last == .playRecording("fixture-recording"), "Clicking a recording's row plays it")
        precondition(denied.control(identifier: "open.fixture-recording") == nil,
                     "A row whose playback is unavailable is not clickable")
        let output = CommandLine.arguments[1]
        let labelled = CommandLine.arguments[2] != "omit"
        var observations: [[String: Any]] = []
        for (name, facts, deliveries, tab, height) in [
            ("recordings", fixture(), ExportsState(), LibraryView.Tab.recordings, CGFloat(476)),
            ("projects", fixture(), ExportsState(), .projects, CGFloat(476)),
            ("exports", fixture(), exportFixture(), .exports, CGFloat(476)),
            ("empty", ControlsState(), ExportsState(), .recordings, CGFloat(476)),
            ("deletion", deletionFixture(), ExportsState(), .recordings, CGFloat(476)),
            ("long-details", fixture(long: true), ExportsState(), .recordings, CGFloat(476)),
            ("short-screen", fixture(long: true), ExportsState(), .recordings, CGFloat(280)),
        ] {
            let content = LibraryView(state: facts, exports: deliveries) { actions.append($0) }
            content.frame.size = NSSize(width: 768, height: height)
            let shot = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 768, height: height), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            shot.title = labelled ? "Library · Synthetic presentation fixture" : "Library"
            shot.isReleasedWhenClosed = false
            shot.appearance = name == "recordings" ? NSAppearance(named: .darkAqua) : NSAppearance(named: .aqua)
            shot.contentView = content
            shot.orderBack(nil)
            (content.control(identifier: "tab.\(tab.rawValue.lowercased())") as! NSButton).performClick(nil)
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
            content.layoutSubtreeIfNeeded()
            func save(_ suffix: String) {
                let frame = content.superview!
                let bitmap = frame.bitmapImageRepForCachingDisplay(in: frame.bounds)!
                frame.cacheDisplay(in: frame.bounds, to: bitmap)
                try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(output)/\(name)\(suffix).png"))
            }
            save("")
            let doc = content.scrollView.documentView!
            var controlFrames: [String: [Double]] = [:]
            var ids = ["library.filter"]
            switch tab {
            case .recordings: ids += facts.library.recent.map { "actions.\($0.recordingId)" }
            case .projects: ids += ["library.projects.previous", "library.projects.next"] + facts.library.projects.map { "actions.\($0.projectId)" }
            case .exports: ids += deliveries.records.map { "actions.\($0.exportId)" }
            }
            for id in ids {
                if let control = content.control(identifier: id) {
                    let rect = control.convert(control.bounds, to: doc)
                    controlFrames[id] = [rect.minX, rect.minY, rect.width, rect.height]
                }
            }
            observations.append(["fixture": name, "facts": "synthetic", "contentWidthPoints": 768, "contentHeightPoints": height, "backingScale": shot.backingScaleFactor, "appearance": name == "recordings" ? "darkAqua" : "aqua", "controls": controlFrames])
            try! JSONSerialization.data(withJSONObject: observations, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: "\(output)/native-metadata.json"))
            for id in ids {
                if let control = content.control(identifier: id) {
                    let rect = control.convert(control.bounds, to: doc)
                    doc.scrollToVisible(rect)
                    content.scrollView.reflectScrolledClipView(content.scrollView.contentView)
                    precondition(content.scrollView.contentView.bounds.contains(rect), "Full action menu must be reachable: \(id)")
                }
            }
            if name == "short-screen" {
                doc.scrollToVisible(NSRect(x: 0, y: doc.bounds.height - 1, width: 1, height: 1))
                content.scrollView.reflectScrolledClipView(content.scrollView.contentView)
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                save("-bottom")
                precondition(content.scrollView.contentView.bounds.minY > 0, "Long details scroll at native control size")
            }
            if name == "recordings" {
                let field = content.control(identifier: "library.filter") as! NSSearchField
                field.stringValue = "fixture-recording-two"
                content.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
                content.clearPageFilter()
            }
            if name == "exports" {
                let retry = content.actionItem(identifier: "export.jobRetry.fixture-export")!
                precondition(retry.title == "Retry Cleanup", "Committed export actions retain cleanup meaning")
                NSApplication.shared.sendAction(retry.action!, to: retry.target, from: retry)
                precondition(actions.last == .retryExport("fixture-export"))
            }
            shot.orderOut(nil)
            shot.close()
        }
    }
    @MainActor static func fixture(long: Bool = false) -> ControlsState {
        var state = ControlsState()
        state.service = .ready
        state.storage = .init(totalBytes: 2_400_000_000, observedAt: "2026-10-05T19:18:00Z")
        state.library.recent = [
            .init(recordingId: "fixture-recording-one", createdAt: "2026-10-05T19:18:00Z", state: "complete", sourceDurationUs: 154_000_000, interruptionReason: nil),
            .init(recordingId: long ? "recording-with-a-very-long-identity-for-a-camera-and-narration-observation-that-must-wrap" : "fixture-recording-two", createdAt: "2026-10-05T17:42:00Z", state: "finalizing", sourceDurationUs: 48_000_000, interruptionReason: nil, finalizationError: long ? .init(code: "FIXTURE_FINALIZATION", message: "A selected conference room camera source remains unavailable while the recording's publication is being inspected. Retry belongs to its existing owner.", retryable: true) : nil, sourceId: long ? "source-with-a-very-long-identity-that-remains-visible-without-displacing-the-action-menu" : nil),
            .init(recordingId: "fixture-recording-three", createdAt: "2026-10-04T23:06:00Z", state: "complete", sourceDurationUs: 312_000_000, interruptionReason: nil),
        ]
        if long {
            let admissions = """
            [{"kind":"camera","sourceId":"fixture-camera-source","publication":{"state":"unavailable","error":{"code":"FIXTURE_PUBLICATION","message":"Selected conference camera publication remains unavailable."}}}]
            """
            let sources = try! JSONDecoder().decode([LibraryState.SourceAdmission].self, from: Data(admissions.utf8))
            let last = state.library.recent[1]
            state.library.recent[1] = .init(recordingId: last.recordingId, createdAt: last.createdAt, state: last.state, sourceDurationUs: last.sourceDurationUs, interruptionReason: last.interruptionReason, finalizationError: last.finalizationError, sourceId: last.sourceId, sourceAdmissions: sources)
        }
        let projectJSON = """
        [{"projectId":"fixture-project","title":"Product demonstration","createdAt":"2026-10-05T19:18:00Z","currentRevisionId":"fixture-revision"}]
        """
        state.library.projects = try! JSONDecoder().decode([LibraryState.Project].self, from: Data(projectJSON.utf8))
        return state
    }
    @MainActor static func deletionFixture() -> ControlsState {
        var state = fixture()
        _ = state.library.beginDelete(.recording("fixture-recording-one"))
        state.library.finishDelete(.recording("fixture-recording-one"), failure: "Fixture request was not confirmed; original source remains intact.")
        return state
    }
    static func exportFixture() -> ExportsState {
        var state = ExportsState()
        state.records = [.init(exportId: "fixture-export", target: .project("fixture-project"), kind: .video, revisionId: "fixture-revision", state: "committed", directory: "/Synthetic/Exports", leaf: "Product demonstration.mp4", output: "/Synthetic/Exports/Product demonstration.mp4", reason: "Committed output is intact; private cleanup still needs retry.", retryable: true, abandoning: false, cleanupPending: true)]
        return state
    }

}
