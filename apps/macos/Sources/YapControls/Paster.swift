import AppKit
import ApplicationServices

/**
 Puts a prompt where the person is typing: the one owner of copying a prompt.

 Copying always writes the pasteboard. Pasting copies, then presses ⌘V in the front app when
 Accessibility lets this app type there, once the person has let go of the shortcut: an app that
 reads the keyboard as it is would take ⌘V pressed under a held ⌥⇧ for ⌥⇧⌘V, and paste nothing.
 Without that access, or with the keys still held, the prompt is still copied and the caller says
 to press ⌘V; nothing here asks macOS for that access. It is also the one owner of what that
 access is: macOS reports a grant made while the app runs at once, yet drops the keystrokes the
 app sends until it reopens, so a grant counts only if the app was trusted when this was made.
 */
@MainActor
public struct Paster {
    public enum Outcome: Equatable, Sendable {
        case pasted
        case copied
        /// Accessibility was allowed while the app ran; pasting waits for it to reopen.
        case copiedUntilReopen

        /// What a person reads when the prompt was copied but could not be pasted for them.
        public var notice: String? {
            switch self {
            case .pasted: nil
            case .copied: "Copied, press ⌘V"
            case .copiedUntilReopen: "Copied, press ⌘V (reopen Yap to auto-paste)"
            }
        }
    }

    private static let vKey: CGKeyCode = 9
    /// The left ⌘ key's own flag, beside Command itself, as a person's ⌘V carries it.
    private static let leftCommand = CGEventFlags(rawValue: 0x8)
    private static let modifiers: CGEventFlags = [.maskCommand, .maskAlternate, .maskShift, .maskControl]

    private let pasteboard: NSPasteboard
    private let trusted: () -> Bool
    private let held: () -> CGEventFlags
    private let release: Duration
    private let post: (CGEvent) -> Void
    private let trustedAtOpen: Bool

    /// `held` reads the modifier keys down on the keyboard now, and `release` is how long a paste
    /// waits for them to come up.
    public init(
        pasteboard: NSPasteboard = .general,
        trusted: @escaping () -> Bool = { AXIsProcessTrusted() },
        held: @escaping () -> CGEventFlags = { CGEventSource.flagsState(.hidSystemState) },
        release: Duration = .seconds(1),
        post: @escaping (CGEvent) -> Void = { $0.post(tap: .cgSessionEventTap) }
    ) {
        self.pasteboard = pasteboard
        self.trusted = trusted
        self.held = held
        self.release = release
        self.post = post
        trustedAtOpen = trusted()
    }

    public var access: ControlsState.Access {
        guard trusted() else { return .denied }
        return trustedAtOpen ? .granted : .reopenToUse
    }

    public func copy(_ text: String) {
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    public func paste(_ text: String) async -> Outcome {
        copy(text)
        switch access {
        case .granted: break
        case .reopenToUse: return .copiedUntilReopen
        case .denied, .undetermined: return .copied
        }
        let deadline = ContinuousClock.now + release
        while !held().intersection(Self.modifiers).isEmpty {
            guard ContinuousClock.now < deadline else { return .copied }
            try? await Task.sleep(for: .milliseconds(20))
        }
        let source = CGEventSource(stateID: .combinedSessionState)
        let keystroke = [true, false].compactMap {
            CGEvent(keyboardEventSource: source, virtualKey: Self.vKey, keyDown: $0)
        }
        guard keystroke.count == 2 else { return .copied }
        for event in keystroke {
            // Set, not added: nothing the event source remembers rides along.
            event.flags = [.maskCommand, Self.leftCommand]
            post(event)
        }
        return .pasted
    }
}
