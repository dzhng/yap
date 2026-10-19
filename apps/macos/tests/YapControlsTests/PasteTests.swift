import AppKit
import YapControls

@MainActor
func runPasteTests() {
    // A named pasteboard of this run's own, so the check never replaces what the person copied.
    let pasteboard = NSPasteboard(name: .init("yap-paste-\(UUID().uuidString)"))
    defer { pasteboard.releaseGlobally() }

    var posted: [CGEvent] = []
    let trusted = Paster(pasteboard: pasteboard, trusted: { true }, post: { posted.append($0) })
    precondition(trusted.paste("first prompt") == .pasted, "With Accessibility, the prompt is pasted")
    precondition(pasteboard.string(forType: .string) == "first prompt", "A paste goes through the pasteboard")
    precondition(posted.map { $0.type } == [.keyDown, .keyUp], "One ⌘V is pressed and released")
    for event in posted {
        precondition(event.getIntegerValueField(.keyboardEventKeycode) == 9, "The keystroke is physical V")
        // The person is still holding ⌥⇧ from the shortcut; ⌥⇧⌘V is Paste and Match Style.
        let held = event.flags.intersection([.maskCommand, .maskAlternate, .maskShift, .maskControl, .maskSecondaryFn, .maskAlphaShift])
        precondition(held == .maskCommand, "The paste carries Command and no other modifier")
    }

    posted.removeAll()
    let untrusted = Paster(pasteboard: pasteboard, trusted: { false }, post: { posted.append($0) })
    precondition(untrusted.paste("second prompt") == .copied, "Without Accessibility, the prompt is only copied")
    precondition(pasteboard.string(forType: .string) == "second prompt", "The copied prompt replaces the last one")
    precondition(posted.isEmpty, "Nothing is typed into another app without Accessibility")
    precondition(Paster.copiedNotice == "Copied, press ⌘V", "The notice says what to press")
    print("PASS ⌥⇧V pastes with Command only, or copies and says to press ⌘V")
}

func runAccessibilityPermissionTests() {
    let permissions = ControlsState.Permissions(screen: .granted, microphone: .granted, camera: .granted)
    precondition(permissions.access(to: .accessibility) == .denied,
                 "Accessibility is untrusted until a person allows it in System Settings")
    precondition(PermissionKind.accessibility.isOptional && !PermissionKind.screen.isOptional,
                 "Accessibility only lets a paste happen for you; nothing needs it to record")
    precondition(PermissionKind.accessibility.allowTitle(for: .denied) == "Allow in System Settings…",
                 "Accessibility is never prompted for; its button opens the privacy pane")
    precondition(PermissionKind.accessibility.settingsURL.absoluteString.hasSuffix("Privacy_Accessibility"),
                 "The button opens the Accessibility pane")
    print("PASS Accessibility is optional and only granted in System Settings")
}
