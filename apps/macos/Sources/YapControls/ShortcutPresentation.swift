import Foundation

/// The states a Settings shortcut field can explain without knowing how the field is drawn.
public enum ShortcutPresentation {
    public enum State: Equatable, Sendable {
        case active
        case refusedByMacOS
        case duplicateInYap
    }

    /// Registration is observed from the app. A recording-lifetime binding is intentionally
    /// described separately while idle: it is valid, but there is no reason to claim it yet.
    public static func state(
        for binding: ShortcutBindings.Binding,
        registered: Bool,
        recording: Bool,
        unavailable: Bool,
        duplicate: Bool = false
    ) -> State {
        if duplicate { return .duplicateInYap }
        if unavailable { return .refusedByMacOS }
        if binding.lifetime == .recording && !recording { return .active }
        if registered { return .active }
        return .refusedByMacOS
    }

    public static func statusTitle(_ state: State) -> String {
        switch state {
        case .active: "Active"
        case .refusedByMacOS: "Refused by macOS"
        case .duplicateInYap: "Duplicate in Yap"
        }
    }

    /// Formats the physical key and Carbon modifier mask captured by the native field.
    public static func label(keyCode: UInt32, modifiers: UInt32, key: String) -> String {
        var result = ""
        if modifiers & 0x1000 != 0 { result += "⌃" }
        if modifiers & 0x0800 != 0 { result += "⌥" }
        if modifiers & 0x0200 != 0 { result += "⇧" }
        if modifiers & 0x0100 != 0 { result += "⌘" }
        let named: [UInt32: String] = [
            36: "Return", 48: "Tab", 49: "Space", 51: "Delete", 53: "Escape",
            115: "Home", 116: "Page Up", 117: "Forward Delete", 119: "End",
            121: "Page Down", 123: "←", 124: "→", 125: "↓", 126: "↑",
        ]
        let keyLabel = key.isEmpty ? (named[keyCode] ?? "Key \(keyCode)") : key.uppercased()
        return result + keyLabel
    }
}
