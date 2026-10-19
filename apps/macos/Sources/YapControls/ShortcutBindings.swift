import Foundation

/// The lifetime of a global shortcut claim.
public enum ShortcutLifetime: String, Codable, Equatable, Sendable {
    case app
    case recording
}

/// One physical key and its Carbon modifier mask. The label is the text shown to a person.
public struct Shortcut: Codable, Equatable, Hashable, Sendable {
    public init(keyCode: UInt32, modifiers: UInt32, label: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.label = label
    }

    public let keyCode: UInt32
    public let modifiers: UInt32
    public let label: String
}

/// The one action-to-binding catalog shared by Settings, registration and app operations.
public enum ShortcutBindings {
    public struct Binding: Codable, Equatable, Sendable {
        public init(shortcut: Shortcut, lifetime: ShortcutLifetime) {
            self.shortcut = shortcut
            self.lifetime = lifetime
        }

        public let shortcut: Shortcut
        public let lifetime: ShortcutLifetime
    }

    /// One action Settings and the app operations list, with D6's physical-key default.
    public struct Entry: Sendable {
        public let action: ControlsAction
        public let name: String
        public let binding: Binding
    }

    /// The single catalog, in the order Settings shows it. Carbon's modifier values are stable
    /// key-registration values.
    public static let catalog: [Entry] = [
        .init(action: .startOrStop, name: "Start or Finish Recording",
              binding: .init(shortcut: .init(keyCode: 1, modifiers: 2_560, label: "⌥⇧S"), lifetime: .app)),
        .init(action: .pastePrompt, name: "Paste Prompt",
              binding: .init(shortcut: .init(keyCode: 9, modifiers: 2_560, label: "⌥⇧V"), lifetime: .app)),
        .init(action: .undoMark, name: "Undo Mark",
              binding: .init(shortcut: .init(keyCode: 6, modifiers: 2_560, label: "⌥⇧Z"), lifetime: .recording)),
        .init(action: .cancel, name: "Cancel Take",
              binding: .init(shortcut: .init(keyCode: 7, modifiers: 2_560, label: "⌥⇧X"), lifetime: .recording)),
        .init(action: .pauseOrResume, name: "Pause or Resume Recording",
              binding: .init(shortcut: .init(keyCode: 35, modifiers: 2_560, label: "⌥⇧P"), lifetime: .recording)),
        .init(action: .restart, name: "Restart Take",
              binding: .init(shortcut: .init(keyCode: 15, modifiers: 2_560, label: "⌥⇧R"), lifetime: .recording)),
    ]

    public static var defaults: [ControlsAction: Binding] {
        Dictionary(uniqueKeysWithValues: catalog.map { ($0.action, $0.binding) })
    }

    public struct InvalidBinding: Error, Equatable, Sendable {
        public let message: String
    }

    /// Applies stated bindings, keyed by action id, over `current`. Actions it does not name keep
    /// their binding, and one invalid entry refuses the whole statement, so nothing is half-set.
    public static func merging(
        _ stated: [String: Any], into current: [ControlsAction: Binding]
    ) throws(InvalidBinding) -> [ControlsAction: Binding] {
        var result = current
        for (id, value) in stated {
            guard let entry = catalog.first(where: { $0.action.id == id }) else {
                throw InvalidBinding(message: "Unknown shortcut action \(id).")
            }
            guard let fields = value as? [String: Any],
                let keyCode = (fields["keyCode"] as? NSNumber)?.uint32Value,
                let modifiers = (fields["modifiers"] as? NSNumber)?.uint32Value,
                let label = fields["label"] as? String, !label.isEmpty
            else {
                throw InvalidBinding(message: "Shortcut \(id) needs a keyCode, modifiers and a label.")
            }
            result[entry.action] = Binding(
                shortcut: Shortcut(keyCode: keyCode, modifiers: modifiers, label: label),
                lifetime: entry.binding.lifetime)
        }
        return result
    }

    /// Reads only version 2 over the defaults. An invalid or legacy file states nothing.
    public static func decode(_ data: Data?) -> [ControlsAction: Binding] {
        guard let data,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["version"] as? Int == 2,
            let stated = object["bindings"] as? [String: Any],
            let bindings = try? merging(stated, into: defaults)
        else { return defaults }
        return bindings
    }

    public static func encode(_ bindings: [ControlsAction: Binding]) -> Data? {
        let values = Dictionary(uniqueKeysWithValues: bindings.compactMap { action, binding in
            (action.id, ["keyCode": binding.shortcut.keyCode, "modifiers": binding.shortcut.modifiers,
                         "label": binding.shortcut.label] as [String: Any])
        })
        return try? JSONSerialization.data(withJSONObject: ["version": 2, "bindings": values])
    }
}
