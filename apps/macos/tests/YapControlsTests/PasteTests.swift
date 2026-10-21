import AppKit
import YapControls

@MainActor
func runPasteTests() async {
    // A named pasteboard of this run's own, so the check never replaces what the person copied.
    let pasteboard = NSPasteboard(name: .init("yap-paste-\(UUID().uuidString)"))
    defer { pasteboard.releaseGlobally() }

    // The person lets go of the shortcut's ⌥⇧ a moment after pressing it. An app that reads the
    // keyboard as it is would take a ⌘V sent before then for ⌥⇧⌘V, and paste nothing.
    var posted: [CGEvent] = []
    var reads = 0
    var heldWhenPosted: [CGEventFlags] = []
    func letGo(after count: Int) -> () -> CGEventFlags {
        reads = 0
        return {
            reads += 1
            return reads > count ? [] : [.maskAlternate, .maskShift]
        }
    }
    var held = letGo(after: 3)
    let trusted = Paster(
        pasteboard: pasteboard, trusted: { true }, held: { held() },
        post: { posted.append($0); heldWhenPosted.append(held()) })
    let first = await trusted.paste("first prompt")
    precondition(first == .pasted, "With Accessibility, the prompt is pasted")
    precondition(pasteboard.string(forType: .string) == "first prompt", "A paste goes through the pasteboard")
    precondition(posted.map { $0.type } == [.keyDown, .keyUp], "One ⌘V is pressed and released")
    precondition(heldWhenPosted.allSatisfy(\.isEmpty), "⌘V is pressed only once the shortcut is let go")
    for event in posted {
        precondition(event.getIntegerValueField(.keyboardEventKeycode) == 9, "The keystroke is physical V")
        let modifiers = event.flags.intersection([.maskCommand, .maskAlternate, .maskShift, .maskControl, .maskSecondaryFn, .maskAlphaShift])
        precondition(modifiers == .maskCommand, "The paste carries Command and no other modifier")
        precondition(event.flags.rawValue & 0x8 != 0, "Command is the left ⌘ key, as a person presses it")
    }

    // Someone still holding the keys a second later gets the prompt copied, and is told.
    posted.removeAll()
    held = { [.maskAlternate, .maskShift] }
    let holding = Paster(
        pasteboard: pasteboard, trusted: { true }, held: { held() }, release: .milliseconds(100),
        post: { posted.append($0) })
    let kept = await holding.paste("held prompt")
    precondition(kept == .copied, "Keys held past the wait leave the prompt copied")
    precondition(pasteboard.string(forType: .string) == "held prompt" && posted.isEmpty,
                 "Nothing is typed while the shortcut is still held")
    held = { [] }

    posted.removeAll()
    let untrusted = Paster(pasteboard: pasteboard, trusted: { false }, held: { [] }, post: { posted.append($0) })
    let second = await untrusted.paste("second prompt")
    precondition(second == .copied, "Without Accessibility, the prompt is only copied")
    precondition(pasteboard.string(forType: .string) == "second prompt", "The copied prompt replaces the last one")
    precondition(posted.isEmpty, "Nothing is typed into another app without Accessibility")
    precondition(Paster.Outcome.copied.notice == "Copied, press ⌘V", "The notice says what to press")

    // macOS reports a grant made while Yap runs at once, but drops the keystrokes Yap sends
    // until Yap reopens: until then the prompt is copied, and the notice says how to finish.
    posted.removeAll()
    var allowed = false
    let grantedLater = Paster(pasteboard: pasteboard, trusted: { allowed }, held: { [] }, post: { posted.append($0) })
    allowed = true
    precondition(grantedLater.access == .reopenToUse, "A grant made while Yap runs waits for Yap to reopen")
    let third = await grantedLater.paste("third prompt")
    precondition(third == .copiedUntilReopen, "Until then the prompt is only copied")
    precondition(pasteboard.string(forType: .string) == "third prompt" && posted.isEmpty,
                 "Nothing is typed that macOS would drop")
    precondition(Paster.Outcome.copiedUntilReopen.notice == "Copied, press ⌘V (reopen Yap to auto-paste)",
                 "The notice says what to press now and how to have Yap paste")
    precondition(trusted.access == .granted && Paster.Outcome.pasted.notice == nil,
                 "Trusted from the start, Yap pastes and says nothing")
    print("PASS ⌥⇧V pastes ⌘V once the shortcut is let go, or copies and says to press ⌘V")
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
    precondition(PermissionKind.accessibility.statusTitle(for: .reopenToUse) == "Reopen Yap to finish",
                 "A grant that waits on Yap reopening says so, not that it is optional")
    print("PASS Accessibility is optional and only granted in System Settings")
}
