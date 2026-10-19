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

    public var display: String { label }
}

/// The one action-to-binding catalog shared by Settings, registration and app operations.
public enum ShortcutBindings {
    public typealias Shortcut = YapControls.Shortcut

    public struct Binding: Codable, Equatable, Sendable {
        public init(shortcut: Shortcut, lifetime: ShortcutLifetime) {
            self.shortcut = shortcut
            self.lifetime = lifetime
        }

        public let shortcut: Shortcut
        public let lifetime: ShortcutLifetime
    }

    /// D6's physical-key defaults. Carbon's modifier values are stable key-registration values.
    public static let defaults: [ControlsAction: Binding] = [
        .startOrStop: Binding(shortcut: .init(keyCode: 1, modifiers: 2_560, label: "⌥⇧S"), lifetime: .app),
        .pastePrompt: Binding(shortcut: .init(keyCode: 9, modifiers: 2_560, label: "⌥⇧V"), lifetime: .app),
        .undoMark: Binding(shortcut: .init(keyCode: 6, modifiers: 2_560, label: "⌥⇧Z"), lifetime: .recording),
        .cancel: Binding(shortcut: .init(keyCode: 7, modifiers: 2_560, label: "⌥⇧X"), lifetime: .recording),
        .pauseOrResume: Binding(shortcut: .init(keyCode: 35, modifiers: 2_560, label: "⌥⇧P"), lifetime: .recording),
        .restart: Binding(shortcut: .init(keyCode: 15, modifiers: 2_560, label: "⌥⇧R"), lifetime: .recording),
    ]

    /// The single display order used by Settings and app-operation responses.
    public static let actions: [(action: ControlsAction, name: String)] = [
        (.startOrStop, "Start or Finish Recording"), (.pastePrompt, "Paste Prompt"),
        (.undoMark, "Undo Mark"), (.cancel, "Cancel Take"),
        (.pauseOrResume, "Pause or Resume Recording"), (.restart, "Restart Take"),
    ]

    /// Reads only version 2. Invalid and legacy files are ignored by returning no overrides.
    public static func decode(_ data: Data?) -> [ControlsAction: Binding] {
        guard let data,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["version"] as? Int == 2,
            let stated = object["bindings"] as? [String: Any]
        else { return [:] }

        var result = defaults
        for (id, value) in stated {
            guard let action = actions.first(where: { $0.action.id == id })?.action,
                let fields = value as? [String: Any],
                let keyCode = (fields["keyCode"] as? NSNumber)?.uint32Value,
                let modifiers = (fields["modifiers"] as? NSNumber)?.uint32Value,
                let label = fields["label"] as? String, !label.isEmpty
            else { continue }
            result[action] = Binding(
                shortcut: Shortcut(keyCode: keyCode, modifiers: modifiers, label: label),
                lifetime: defaults[action]?.lifetime ?? .app)
        }
        return result
    }

    public static func encode(_ bindings: [ControlsAction: Binding]) -> Data? {
        let values = Dictionary(uniqueKeysWithValues: bindings.compactMap { action, binding in
            (action.id, ["keyCode": binding.shortcut.keyCode, "modifiers": binding.shortcut.modifiers,
                         "label": binding.shortcut.label] as [String: Any])
        })
        return try? JSONSerialization.data(withJSONObject: ["version": 2, "bindings": values])
    }
}
