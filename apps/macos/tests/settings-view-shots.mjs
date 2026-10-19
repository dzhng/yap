import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

// Render the production SettingsView without a service, permission reads or desktop capture.
const output = resolve(
  process.env.SHOTS ?? "specs/done/auto-update/assets/update-settings/candidate",
);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "yap-settings-view-"));
try {
  const executable = compileControlsCheck(
    scratch,
    ["SettingsWindow", "WindowMenu"],
    String.raw`
import AppKit
import SwiftUI
import YapControls

enum ControlsProbe { static let observed = true }
@MainActor final class ShotAgentSetup: AgentSetup {
    func setEnabled(_ enabled: Bool) {}
    func summary() -> String { "yap command + skill, kept current. All good ✓" }
}
@main struct Shots {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let output = CommandLine.arguments[1]
        let scratch = CommandLine.arguments[2]
        let states: [(String, UpdateControls)] = [
            ("enabled", .init(available: true, enabled: true, canCheck: true)),
            ("disabled", .init(available: true, enabled: false, canCheck: true)),
            ("checking", .init(available: true, enabled: false, status: "Checking for updates…")),
            ("up-to-date", .init(available: true, enabled: false, status: "You’re up to date.", canCheck: true)),
            ("waiting", .init(available: true, enabled: true, status: "An update is waiting for recording and background work to finish.")),
            ("failure", .init(available: true, enabled: true, status: "Update failed: the download could not be verified. Your current version is unchanged.", canCheck: true)),
            ("manual", .init()),
            ("notice", .init(available: true, enabled: true, canCheck: true)),
        ]
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            for (name, updates) in states {
                let preferences = Preferences(defaults: UserDefaults(suiteName: "\(scratch)/\(theme)-\(name)")!)
                let model = SettingsModel(preferences: preferences, perform: { _ in }, update: { _, _ in }, agentSetup: ShotAgentSetup())
                model.registered = [ControlsAction.startOrStop.id, ControlsAction.pastePrompt.id]
                model.state.permissions = ControlsState.Permissions(screen: .granted, microphone: .granted)
                model.state.updates = updates
                if name == "notice" {
                    model.state.adminMessage = "Yap 0.1.41 cannot update itself. Back up ~/.yap, then reinstall Yap from justyap.io."
                }
                let content = NSHostingView(rootView: SettingsView(model: model))
                content.sizingOptions = []
                content.appearance = NSAppearance(named: appearance)
                let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 560, height: 780),
                    styleMask: .borderless, backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = content
                window.appearance = content.appearance
                window.orderBack(nil)
                RunLoop.current.run(until: Date().addingTimeInterval(0.6))
                content.layoutSubtreeIfNeeded()
                let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds)!
                content.cacheDisplay(in: content.bounds, to: bitmap)
                try! bitmap.representation(using: .png, properties: [:])!.write(to:
                    URL(fileURLWithPath: "\(output)/\(theme)-\(name).png"))
                do {
                    func scrollView(_ view: NSView) -> NSScrollView? {
                        if let scroll = view as? NSScrollView { return scroll }
                        return view.subviews.lazy.compactMap { scrollView($0) }.first
                    }
                    guard let scroll = scrollView(content), let document = scroll.documentView else {
                        preconditionFailure("The settings form must remain scrollable")
                    }
                    scroll.contentView.scroll(to: NSPoint(x: 0, y: document.bounds.height - scroll.contentView.bounds.height))
                    scroll.reflectScrolledClipView(scroll.contentView)
                    RunLoop.current.run(until: Date().addingTimeInterval(0.2))
                    let bottom = content.bitmapImageRepForCachingDisplay(in: content.bounds)!
                    content.cacheDisplay(in: content.bounds, to: bottom)
                    try! bottom.representation(using: .png, properties: [:])!.write(to:
                        URL(fileURLWithPath: "\(output)/\(theme)-\(name)-bottom.png"))
                    precondition(scroll.contentView.bounds.minY > 0, "Scrolling reaches lower settings")
                }
                window.orderOut(nil)
                window.close()
            }
        }

        let shortcutStates = [
            "active", "refused-by-macos", "duplicate-in-yap",
            "recording-in-progress", "field-recording",
        ]
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            for name in shortcutStates {
                let preferences = Preferences(defaults: UserDefaults(suiteName: "\(scratch)/shortcuts-\(theme)-\(name)")!)
                let model = SettingsModel(preferences: preferences, perform: { _ in }, update: { _, _ in }, agentSetup: ShotAgentSetup())
                model.shortcuts = ShortcutBindings.defaults
                model.registered = [ControlsAction.startOrStop.id, ControlsAction.pastePrompt.id]
                switch name {
                case "refused-by-macos":
                    model.state.unavailableShortcuts = [ShortcutBindings.defaults[.undoMark]!.shortcut.display]
                case "duplicate-in-yap":
                    model.shortcutErrorAction = .cancel
                case "recording-in-progress":
                    model.state.service = .ready
                    model.state.device = .init(state: .recording, recordingId: "shot", elapsedUs: 1_000_000)
                    model.registered = Set(ShortcutBindings.actions.map { $0.action.id })
                case "field-recording":
                    model.recordingAction = .startOrStop
                default: break
                }
                let content = NSHostingView(rootView: SettingsView(model: model))
                content.sizingOptions = []
                content.appearance = NSAppearance(named: appearance)
                let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 560, height: 780),
                    styleMask: .borderless, backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = content
                window.appearance = content.appearance
                window.orderBack(nil)
                RunLoop.current.run(until: Date().addingTimeInterval(0.6))
                content.layoutSubtreeIfNeeded()
                let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds)!
                content.cacheDisplay(in: content.bounds, to: bitmap)
                try! bitmap.representation(using: .png, properties: [:])!.write(to:
                    URL(fileURLWithPath: "\(output)/\(theme)-shortcuts-\(name).png"))
                func scrollView(_ view: NSView) -> NSScrollView? {
                    if let scroll = view as? NSScrollView { return scroll }
                    return view.subviews.lazy.compactMap { scrollView($0) }.first
                }
                guard let scroll = scrollView(content), let document = scroll.documentView else {
                    preconditionFailure("The settings form must remain scrollable")
                }
                scroll.contentView.scroll(to: NSPoint(x: 0, y: document.bounds.height - scroll.contentView.bounds.height))
                scroll.reflectScrolledClipView(scroll.contentView)
                RunLoop.current.run(until: Date().addingTimeInterval(0.2))
                let bottom = content.bitmapImageRepForCachingDisplay(in: content.bounds)!
                content.cacheDisplay(in: content.bounds, to: bottom)
                try! bottom.representation(using: .png, properties: [:])!.write(to:
                    URL(fileURLWithPath: "\(output)/\(theme)-shortcuts-\(name)-bottom.png"))
                window.orderOut(nil)
                window.close()
            }
        }
    }
}
`,
  );
  execFileSync(executable, [output, scratch], { timeout: 60_000 });
  console.log(output);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
