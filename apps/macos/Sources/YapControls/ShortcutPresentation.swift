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
}
