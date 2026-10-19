import AppKit
import ApplicationServices

/**
 Puts a prompt where the person is typing: the one owner of copying a prompt.

 Copying always writes the pasteboard. Pasting copies, then presses ⌘V in the front app when
 Accessibility lets this app type there. Without it the prompt is still copied, and the caller
 says to press ⌘V; nothing here asks macOS for that access.
 */
@MainActor
public struct Paster {
    public enum Outcome: Equatable, Sendable {
        case pasted
        case copied
    }

    /// What a person reads when the prompt was copied but could not be pasted for them.
    public static let copiedNotice = "Copied, press ⌘V"

    private static let vKey: CGKeyCode = 9

    private let pasteboard: NSPasteboard
    private let trusted: () -> Bool
    private let post: (CGEvent) -> Void

    public init(
        pasteboard: NSPasteboard = .general,
        trusted: @escaping () -> Bool = { AXIsProcessTrusted() },
        post: @escaping (CGEvent) -> Void = { $0.post(tap: .cgSessionEventTap) }
    ) {
        self.pasteboard = pasteboard
        self.trusted = trusted
        self.post = post
    }

    public func copy(_ text: String) {
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    public func paste(_ text: String) -> Outcome {
        copy(text)
        guard trusted() else { return .copied }
        let source = CGEventSource(stateID: .combinedSessionState)
        let keystroke = [true, false].compactMap {
            CGEvent(keyboardEventSource: source, virtualKey: Self.vKey, keyDown: $0)
        }
        guard keystroke.count == 2 else { return .copied }
        for event in keystroke {
            // Set, not added: the person is still holding the shortcut's ⌥⇧, and ⌥⇧⌘V is
            // Paste and Match Style in most apps.
            event.flags = .maskCommand
            post(event)
        }
        return .pasted
    }
}
