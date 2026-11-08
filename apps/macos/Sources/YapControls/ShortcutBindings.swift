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

    /// Applies stated key names (`ctrl+cmd+r`), keyed by action id, over `current`. Actions it
    /// does not name keep their binding, and one invalid entry refuses the whole statement, so
    /// nothing is half-set.
    public static func merging(
        _ stated: [String: Any], into current: [ControlsAction: Binding], layout: KeyboardLayout
    ) throws(InvalidBinding) -> [ControlsAction: Binding] {
        var result = current
        for (id, value) in stated {
            let entry = try entry(id)
            guard let keys = value as? String else {
                throw InvalidBinding(message: "Shortcut \(id) takes key names, such as \"ctrl+cmd+r\".")
            }
            result[entry.action] = Binding(
                shortcut: try ShortcutKeys.shortcut(keys, layout: layout), lifetime: entry.binding.lifetime)
        }
        return result
    }

    private static func entry(_ id: String) throws(InvalidBinding) -> Entry {
        guard let entry = catalog.first(where: { $0.action.id == id }) else {
            throw InvalidBinding(message: "Unknown shortcut action \(id).")
        }
        return entry
    }

    /// What `shortcuts.get` and `shortcuts.set` answer: every action's name, keys, label, when it
    /// is held and whether macOS took it.
    public static func describe(
        _ bindings: [ControlsAction: Binding], layout: KeyboardLayout,
        state: (ControlsAction) -> ShortcutPresentation.State
    ) -> Data {
        let values = Dictionary(uniqueKeysWithValues: catalog.compactMap { entry -> (String, [String: String])? in
            guard let binding = bindings[entry.action] else { return nil }
            let shortcut = binding.shortcut
            let held: String = switch state(entry.action) {
            case .active: "active"
            case .refusedByMacOS: "refused_by_macos"
            case .duplicateInYap: "duplicate_in_yap"
            }
            return (entry.action.id, [
                "name": entry.name,
                "keys": ShortcutKeys.name(keyCode: shortcut.keyCode, modifiers: shortcut.modifiers, layout: layout),
                "label": shortcut.label, "during": binding.lifetime.rawValue, "state": held,
            ])
        })
        return try! JSONSerialization.data(withJSONObject: ["bindings": values], options: [.sortedKeys])
    }

    /// One stored entry: the physical key, Carbon mask and label the file keeps.
    private static func stored(_ id: String, _ value: Any) throws(InvalidBinding) -> (ControlsAction, Binding) {
        let entry = try entry(id)
        guard let fields = value as? [String: Any],
            let keyCode = whole32(fields["keyCode"]),
            let modifiers = whole32(fields["modifiers"]),
            let label = fields["label"] as? String, !label.isEmpty
        else {
            throw InvalidBinding(message: "Shortcut \(id) needs a keyCode, modifiers and a label.")
        }
        return (entry.action, Binding(
            shortcut: Shortcut(keyCode: keyCode, modifiers: modifiers, label: label),
            lifetime: entry.binding.lifetime))
    }

    /// A JSON whole number that fits 32 bits. Booleans, fractions and negatives are refused rather
    /// than coerced into some other key.
    private static func whole32(_ value: Any?) -> UInt32? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
            let whole = UInt32(exactly: number.doubleValue)
        else { return nil }
        return whole
    }

    /// Reads only version 2 over the defaults; a missing, unreadable or legacy file states nothing.
    /// A version 2 file with an invalid entry is refused, so the caller can say why it holds the
    /// defaults instead.
    public static func decode(_ data: Data?) throws(InvalidBinding) -> [ControlsAction: Binding] {
        guard let data,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["version"] as? Int == 2
        else { return defaults }
        guard let stated = object["bindings"] as? [String: Any] else {
            throw InvalidBinding(message: "The shortcuts file has no bindings.")
        }
        var result = defaults
        for (id, value) in stated {
            let (action, binding) = try stored(id, value)
            result[action] = binding
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
