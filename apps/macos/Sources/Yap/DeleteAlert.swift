import AppKit
import YapControls

/// Presents the one delete question as a standard alert: the action on the right and destructive,
/// Cancel on Escape. Its wording is all `DeleteConfirmation`'s.
@MainActor
enum DeleteAlert {
    static func alert(for dialog: DeleteConfirmation) -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = dialog.title
        alert.informativeText = dialog.users.isEmpty ? dialog.message : ""
        if !dialog.users.isEmpty { alert.accessoryView = body(dialog) }
        let confirm = alert.addButton(withTitle: dialog.confirm)
        confirm.hasDestructiveAction = true
        let cancel = alert.addButton(withTitle: "Cancel")
        cancel.keyEquivalent = "\u{1b}"
        return alert
    }

    /// The users list needs a hanging indent, which plain informative text cannot give: a wrapped
    /// project line continues under its own text, not under the bullet.
    private static func body(_ dialog: DeleteConfirmation) -> NSView {
        let font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let text = NSMutableAttributedString()
        func paragraph(_ string: String, bullet: Bool = false, after: CGFloat = 0) {
            let style = NSMutableParagraphStyle()
            style.paragraphSpacing = after
            if bullet {
                style.tabStops = [NSTextTab(textAlignment: .left, location: 12)]
                style.headIndent = 12
            }
            if text.length > 0 { text.append(NSAttributedString(string: "\n")) }
            text.append(NSAttributedString(string: bullet ? "•\t\(string)" : string,
                attributes: [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: style]))
        }
        if let lead = dialog.lead { paragraph(lead, after: 2) }
        for (index, user) in dialog.users.enumerated() {
            // "— 3 revisions" moves down whole, so a count never strands apart from its project.
            let kept = user.range(of: " — ", options: .backwards).map {
                user[..<$0.lowerBound] + "\u{00A0}—\u{00A0}" + user[$0.upperBound...].replacingOccurrences(of: " ", with: "\u{00A0}")
            } ?? user
            paragraph(kept, bullet: true, after: index == dialog.users.count - 1 ? 8 : 2)
        }
        paragraph(dialog.message)
        let field = NSTextField(labelWithAttributedString: text)
        field.preferredMaxLayoutWidth = 220
        field.frame.size = NSSize(width: 220, height: field.fittingSize.height)
        return field
    }

    /// Asks on `window` as a sheet when it is showing, otherwise as a window of its own.
    static func ask(_ dialog: DeleteConfirmation, on window: NSWindow?) async -> Bool {
        let alert = alert(for: dialog)
        guard let window, window.isVisible else { return alert.runModal() == .alertFirstButtonReturn }
        return await withCheckedContinuation { answer in
            alert.beginSheetModal(for: window) { answer.resume(returning: $0 == .alertFirstButtonReturn) }
        }
    }
}
