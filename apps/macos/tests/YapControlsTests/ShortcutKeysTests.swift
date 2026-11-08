import Foundation
import YapControls

/// The unshifted characters of a US keyboard's physical keys.
private let us = KeyboardLayout(characters: [
    0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c", 9: "v", 11: "b",
    12: "q", 13: "w", 14: "e", 15: "r", 16: "y", 17: "t", 18: "1", 19: "2", 20: "3", 21: "4",
    22: "6", 23: "5", 24: "=", 25: "9", 26: "7", 27: "-", 28: "8", 29: "0", 30: "]", 31: "o",
    32: "u", 33: "[", 34: "i", 35: "p", 37: "l", 38: "j", 39: "'", 40: "k", 41: ";", 42: "\\",
    43: ",", 44: "/", 45: "n", 46: "m", 47: ".", 50: "`",
    // The keypad types digits too; it is named on its own so "1" means the top row.
    82: "0", 83: "1", 84: "2", 92: "9", 69: "+",
])
/// A German keyboard: Z and Y trade places and "+" is typed without shift.
private let german = KeyboardLayout(characters: [
    1: "s", 6: "y", 15: "r", 16: "z", 30: "+", 18: "1", 44: "-",
])

func runShortcutKeyTests() {
    func shortcut(_ text: String, _ layout: KeyboardLayout = us) -> Shortcut? {
        try? ShortcutKeys.shortcut(text, layout: layout)
    }
    precondition(shortcut("ctrl+cmd+r") == Shortcut(keyCode: 15, modifiers: 4_352, label: "⌃⌘R"),
        "A named key resolves to its physical key, Carbon mask and Settings label, got \(String(describing: shortcut("ctrl+cmd+r")))")
    precondition(shortcut(" Command + Control + R ") == shortcut("ctrl+cmd+r"),
        "Modifier aliases, case, spacing and order do not change the binding")
    precondition(shortcut("option+shift+s") == ShortcutBindings.defaults[.startOrStop]?.shortcut,
        "The default start binding is named option+shift+s")
    precondition(shortcut("alt+z") == shortcut("option+z") && shortcut("alt+opt+z") == nil,
        "alt and opt are option, named once")
    precondition(shortcut("ctrl+option+z", german)?.keyCode == 16,
        "A character means the key the current layout types it with, got \(String(describing: shortcut("ctrl+option+z", german)))")
    precondition(shortcut("ctrl++", german)?.keyCode == 30, "A layout that types + unshifted can bind it")
    precondition(shortcut("cmd+1")?.keyCode == 18 && shortcut("cmd+keypad1")?.keyCode == 83,
        "A digit is the top row; the keypad is named")
    precondition(shortcut("f5") == Shortcut(keyCode: 96, modifiers: 0, label: "F5"),
        "A function key needs no modifier")
    precondition(shortcut("ctrl+option+space")?.label == "⌃⌥Space"
        && shortcut("cmd+shift+left")?.label == "⇧⌘←", "Named keys have their Settings labels")
    precondition(shortcut("ctrl+option+key50")?.keyCode == 50, "keyNN names any physical key")

    for (text, why) in [
        ("", "an empty binding"), ("r", "a typing key with no modifier"),
        ("shift+r", "a typing key with only shift"), ("ctrl+cmd", "modifiers with no key"),
        ("hyper+r", "an unknown modifier"), ("ctrl+cmd+notakey", "an unknown key"),
        ("ctrl+cmd+é", "a character this layout cannot type"), ("ctrl+ctrl+r", "a repeated modifier"),
        ("ctrl+key200", "a key code past the keyboard"), ("ctrl+r+s", "two keys"),
    ] {
        do {
            let accepted = try ShortcutKeys.shortcut(text, layout: us)
            preconditionFailure("\(why) is accepted as \(accepted)")
        } catch {
            precondition(!error.message.isEmpty, "The refusal of \(why) says why")
        }
    }

    // Every key Settings can record has a name that sets that same key again, on either layout.
    for layout in [us, german] {
        for code in UInt32(0)..<128 where !ShortcutKeys.isModifier(code) {
            let recorded = Shortcut(keyCode: code, modifiers: 4_352,
                label: ShortcutKeys.label(keyCode: code, modifiers: 4_352, layout: layout))
            let name = ShortcutKeys.name(keyCode: code, modifiers: 4_352, layout: layout)
            precondition(shortcut(name, layout) == recorded,
                "Key \(code) is named \(name), which sets \(String(describing: shortcut(name, layout)))")
        }
    }
    precondition(ShortcutKeys.name(keyCode: 15, modifiers: 4_352, layout: us) == "ctrl+cmd+r"
        && ShortcutKeys.name(keyCode: 1, modifiers: 2_560, layout: us) == "option+shift+s",
        "Names put modifiers in macOS's order")
    print("PASS shortcut keys are named the way a person types them, through the current layout")
}

/// `shortcuts.set` takes key names, changes only the actions it names and refuses the whole call
/// for one bad entry.
func runShortcutSetTests() {
    var current = ShortcutBindings.defaults
    current[.startOrStop] = .init(shortcut: .init(keyCode: 2, modifiers: 2_560, label: "⌥⇧D"), lifetime: .app)

    let merged = try? ShortcutBindings.merging(
        [ControlsAction.pastePrompt.id: "option+shift+b"], into: current, layout: us)
    precondition(merged?[.pastePrompt]?.shortcut == Shortcut(keyCode: 11, modifiers: 2_560, label: "⌥⇧B"),
        "The named action takes its new key")
    precondition(merged?[.startOrStop] == current[.startOrStop],
        "Setting one action keeps every other custom binding, got \(String(describing: merged?[.startOrStop]))")
    precondition(merged?[.pastePrompt]?.lifetime == .app, "An action keeps its own lifetime")

    for (stated, why) in [
        ([ControlsAction.pastePrompt.id: "option+shift+b", ControlsAction.undoMark.id: "shift+u"],
            "an entry a typing key would steal"),
        ([ControlsAction.pastePrompt.id: ["keyCode": 11, "modifiers": 2_560, "label": "⌥⇧B"]],
            "a raw key code"),
        (["capture.unknown": "option+shift+b"], "an unknown action"),
    ] as [([String: Any], String)] {
        do {
            let accepted = try ShortcutBindings.merging(stated, into: current, layout: us)
            preconditionFailure("shortcuts.set accepts \(why), got \(accepted)")
        } catch {
            precondition(!error.message.isEmpty, "The refusal of \(why) says why")
        }
    }

    let answer = ShortcutBindings.describe(merged!, layout: us) { action in
        action == .undoMark ? .refusedByMacOS : .active
    }
    let object = (try? JSONSerialization.jsonObject(with: answer)) as? [String: Any]
    let bindings = object?["bindings"] as? [String: [String: String]]
    precondition(bindings?[ControlsAction.pastePrompt.id] == [
        "name": "Paste Prompt", "keys": "option+shift+b", "label": "⌥⇧B", "during": "app",
        "state": "active",
    ], "An answer names each action's keys, label, lifetime and state, got \(String(describing: bindings))")
    precondition(bindings?[ControlsAction.undoMark.id]?["during"] == "recording"
        && bindings?[ControlsAction.undoMark.id]?["state"] == "refused_by_macos",
        "A recording-only binding macOS refused says so")
    precondition(bindings?.count == ShortcutBindings.catalog.count, "Every action is answered")
    print("PASS shortcuts.set takes key names and answers what each action is bound to")
}
