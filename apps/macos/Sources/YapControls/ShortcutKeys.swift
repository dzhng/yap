import Foundation

/// What the current keyboard layout types for each physical key, without modifiers.
public struct KeyboardLayout: Sendable {
    public init(characters: [UInt32: String]) {
        self.characters = characters
    }

    public let characters: [UInt32: String]
}

/**
 The one owner of how a shortcut is written down. A person or agent names keys the way they type
 them, `ctrl+cmd+r`; the app registers a physical key and a Carbon modifier mask. A character means
 the key the current layout types it with, so `z` on a German keyboard is the key labelled Z there.
 Keys that type nothing are named (`return`, `f5`, `keypad1`), and `key50` names any physical key.
 */
public enum ShortcutKeys {
    /// macOS's order, which names and labels follow.
    private static let modifiers: [(name: String, mask: UInt32, glyph: String)] = [
        ("ctrl", 0x1000, "⌃"), ("option", 0x0800, "⌥"), ("shift", 0x0200, "⇧"), ("cmd", 0x0100, "⌘"),
    ]
    private static let aliases = ["control": "ctrl", "opt": "option", "alt": "option", "command": "cmd"]
    /// Keys a layout does not decide: their name and the label Settings shows.
    private static let named: [(code: UInt32, name: String, label: String)] = [
        (36, "return", "Return"), (48, "tab", "Tab"), (49, "space", "Space"),
        (51, "delete", "Delete"), (53, "escape", "Escape"), (117, "forwarddelete", "Forward Delete"),
        (115, "home", "Home"), (119, "end", "End"), (116, "pageup", "Page Up"),
        (121, "pagedown", "Page Down"), (123, "left", "←"), (124, "right", "→"),
        (125, "down", "↓"), (126, "up", "↑"),
        (122, "f1", "F1"), (120, "f2", "F2"), (99, "f3", "F3"), (118, "f4", "F4"),
        (96, "f5", "F5"), (97, "f6", "F6"), (98, "f7", "F7"), (100, "f8", "F8"),
        (101, "f9", "F9"), (109, "f10", "F10"), (103, "f11", "F11"), (111, "f12", "F12"),
        (105, "f13", "F13"), (107, "f14", "F14"), (113, "f15", "F15"), (106, "f16", "F16"),
        (64, "f17", "F17"), (79, "f18", "F18"), (80, "f19", "F19"), (90, "f20", "F20"),
        (82, "keypad0", "Keypad 0"), (83, "keypad1", "Keypad 1"), (84, "keypad2", "Keypad 2"),
        (85, "keypad3", "Keypad 3"), (86, "keypad4", "Keypad 4"), (87, "keypad5", "Keypad 5"),
        (88, "keypad6", "Keypad 6"), (89, "keypad7", "Keypad 7"), (91, "keypad8", "Keypad 8"),
        (92, "keypad9", "Keypad 9"), (65, "keypaddecimal", "Keypad ."),
        (67, "keypadmultiply", "Keypad *"), (69, "keypadplus", "Keypad +"),
        (71, "keypadclear", "Keypad Clear"), (75, "keypaddivide", "Keypad /"),
        (76, "keypadenter", "Keypad Enter"), (78, "keypadminus", "Keypad -"),
        (81, "keypadequals", "Keypad ="),
    ]
    /// Modifier keys themselves, which identify no shortcut.
    private static let modifierCodes: Set<UInt32> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]
    private static let functionKeys = Set(named.filter { $0.name.hasPrefix("f") }.map(\.code))
    /// Without one of these, a typing key bound globally would take that key from every app.
    private static let commandMask: UInt32 = 0x1000 | 0x0800 | 0x0100

    public static func isModifier(_ keyCode: UInt32) -> Bool { modifierCodes.contains(keyCode) }

    /// Whether binding this key globally would take it from every app: anything but a function
    /// key needs ctrl, option or cmd.
    public static func stealsKey(keyCode: UInt32, modifiers mask: UInt32) -> Bool {
        mask & commandMask == 0 && !functionKeys.contains(keyCode)
    }

    /// `ctrl+cmd+r` as the physical key, Carbon mask and label Settings would record for it.
    public static func shortcut(
        _ text: String, layout: KeyboardLayout
    ) throws(ShortcutBindings.InvalidBinding) -> Shortcut {
        let spelled = text.lowercased().filter { !$0.isWhitespace }
        // A key that is itself "+" ends the text with "++".
        var parts = spelled.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        if spelled.hasSuffix("++") { parts.removeLast(2); parts.append("+") }
        guard let key = parts.popLast(), !key.isEmpty else {
            throw .init(message: "Name a key, such as ctrl+cmd+r; got \"\(text)\".")
        }
        var mask: UInt32 = 0
        for part in parts {
            let name = aliases[part] ?? part
            guard let modifier = modifiers.first(where: { $0.name == name }) else {
                throw .init(message: "\"\(part)\" in \"\(text)\" is not a modifier (ctrl, option, shift, cmd) or the last key.")
            }
            guard mask & modifier.mask == 0 else {
                throw .init(message: "\"\(text)\" names \(name) twice.")
            }
            mask |= modifier.mask
        }
        let keyCode = try code(of: key, in: text, layout: layout)
        guard !stealsKey(keyCode: keyCode, modifiers: mask) else {
            throw .init(message: "\"\(text)\" needs ctrl, option or cmd, or every app would lose that key.")
        }
        return Shortcut(keyCode: keyCode, modifiers: mask, label: label(keyCode: keyCode, modifiers: mask, layout: layout))
    }

    private static func code(
        of key: String, in text: String, layout: KeyboardLayout
    ) throws(ShortcutBindings.InvalidBinding) -> UInt32 {
        if let entry = named.first(where: { $0.name == key }) { return entry.code }
        if key.hasPrefix("key"), let number = UInt32(key.dropFirst(3)) {
            guard number < 128, !modifierCodes.contains(number) else {
                throw .init(message: "\(key) in \"\(text)\" is not a key on a Mac keyboard.")
            }
            return number
        }
        let typed = layout.characters
            .filter { !isNamed($0.key) && $0.value.lowercased() == key }
            .map(\.key).min()
        guard key.count == 1, let typed else {
            throw .init(message: "\"\(key)\" in \"\(text)\" is not a key this keyboard types, or a named key such as return, space, left or f5.")
        }
        return typed
    }

    private static func isNamed(_ keyCode: UInt32) -> Bool { named.contains { $0.code == keyCode } }

    /// The name `shortcut(_:layout:)` reads back as this same key and mask.
    public static func name(keyCode: UInt32, modifiers mask: UInt32, layout: KeyboardLayout) -> String {
        (modifiers.filter { mask & $0.mask != 0 }.map(\.name) + [keyName(keyCode, layout: layout)])
            .joined(separator: "+")
    }

    private static func keyName(_ keyCode: UInt32, layout: KeyboardLayout) -> String {
        if let entry = named.first(where: { $0.code == keyCode }) { return entry.name }
        guard let typed = layout.characters[keyCode]?.lowercased(), typed.count == 1,
            !typed.first!.isWhitespace,
            // A character another key types first would name that key instead.
            (try? code(of: typed, in: typed, layout: layout)) == keyCode
        else { return "key\(keyCode)" }
        return typed
    }

    /// What Settings and the menu show for a physical key and Carbon mask.
    public static func label(keyCode: UInt32, modifiers mask: UInt32, layout: KeyboardLayout) -> String {
        let glyphs = modifiers.filter { mask & $0.mask != 0 }.map(\.glyph).joined()
        if let entry = named.first(where: { $0.code == keyCode }) { return glyphs + entry.label }
        let name = keyName(keyCode, layout: layout)
        return glyphs + (name.count == 1 ? name.uppercased() : "Key \(keyCode)")
    }
}
