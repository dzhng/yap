import Foundation
import YapControls

func runShortcutTests() {
    let defaults = ShortcutBindings.defaults
    precondition(defaults[.startOrStop]?.shortcut == ShortcutBindings.Shortcut(keyCode: 1, modifiers: 2560, label: "⌥⇧S"), "Start uses physical S")
    precondition(defaults[.pastePrompt]?.shortcut.keyCode == 9, "Paste uses physical V")
    precondition(defaults[.undoMark]?.shortcut.keyCode == 6, "Undo uses physical Z")
    precondition(defaults[.cancel]?.shortcut.keyCode == 7, "Cancel uses physical X")
    precondition(defaults[.pauseOrResume]?.shortcut.keyCode == 35, "Pause uses physical P")
    precondition(defaults[.restart]?.shortcut.keyCode == 15, "Restart uses physical R")
    precondition(defaults[.startOrStop]?.lifetime == .app && defaults[.pastePrompt]?.lifetime == .app, "Start and paste live for the app")
    precondition(defaults[.undoMark]?.lifetime == .recording && defaults[.restart]?.lifetime == .recording, "In-take actions live for the recording")

    let encoded = Data(#"{"version":2,"bindings":{"capture.startOrStop":{"keyCode":1,"modifiers":2560,"label":"⌥⇧S"}}}"#.utf8)
    let decoded = ShortcutBindings.decode(encoded)
    precondition(decoded[.startOrStop]?.shortcut.keyCode == 1, "Version 2 stores a physical key code")
    precondition(ShortcutBindings.decode(Data(#"{"version":1,"bindings":{}}"#.utf8)).isEmpty, "Version 1 overrides are ignored")
    print("PASS shortcut bindings carry D6 defaults and version 2 persistence")
}

/// What macOS itself holds, read the way it stores it.
func runSystemShortcutTests() {
    // Spotlight as this Mac writes it: command-space, switched on.
    let spotlight: [String: Any] = [
        "64": [
            "enabled": true,
            "value": ["parameters": [32, 49, 1_048_576], "type": "standard"],
        ]
    ]
    let held = SystemShortcuts.taken(from: spotlight)
    precondition(
        held.contains(
            SystemShortcuts.Combination(
                keyCode: 49, control: false, option: false, command: true, shift: false)),
        "A switched-on system shortcut is held, got \(held)")
    precondition(
        !held.contains(
            SystemShortcuts.Combination(
                keyCode: 49, control: true, option: true, command: true, shift: false)),
        "A different combination on the same key is not held")

    // Switched off, recorded with no key, and malformed: none of these may refuse anybody.
    let ignorable: [String: Any] = [
        "10": ["enabled": false, "value": ["parameters": [32, 49, 1_048_576]]],
        "11": ["enabled": true, "value": ["parameters": [65535, -1, 1_048_576]]],
        "12": ["enabled": true, "value": ["parameters": [32]]],
        "13": ["enabled": true],
        "14": "not a shortcut at all",
    ]
    precondition(
        SystemShortcuts.taken(from: ignorable).isEmpty,
        "Only a switched-on shortcut with a key holds anything, got \(SystemShortcuts.taken(from: ignorable))")

    // Every modifier, so a mask read one bit wrong cannot pass.
    let everything: [String: Any] = [
        "7": [
            "enabled": true,
            "value": ["parameters": [97, 0, 1_048_576 + 524_288 + 262_144 + 131_072]],
        ]
    ]
    precondition(
        SystemShortcuts.taken(from: everything) == [
            SystemShortcuts.Combination(
                keyCode: 0, control: true, option: true, command: true, shift: true)
        ],
        "All four modifiers read individually")
    print("PASS the shortcuts macOS holds are read from its own table")
}
