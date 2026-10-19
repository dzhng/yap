import Foundation

/// The states a Settings shortcut field can explain without knowing how the field is drawn.
public enum ShortcutPresentation {
    public enum State: Equatable, Sendable {
        case active
        case refusedByMacOS
        case duplicateInYap
    }

    /// What a binding's status says. Refusal is what the last registration reported, so a
    /// binding released while Settings records a key, or an in-take one while idle, is not refused.
    public static func state(unavailable: Bool, duplicate: Bool = false) -> State {
        if duplicate { return .duplicateInYap }
        if unavailable { return .refusedByMacOS }
        return .active
    }

    public static func statusTitle(_ state: State) -> String {
        switch state {
        case .active: "Active"
        case .refusedByMacOS: "Refused by macOS"
        case .duplicateInYap: "Duplicate in Yap"
        }
    }
}
