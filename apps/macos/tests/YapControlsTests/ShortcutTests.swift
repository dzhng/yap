import Foundation
import YapControls

func runShortcutTests() {
    let defaults = ShortcutBindings.defaults
    precondition(defaults[.startOrStop]?.shortcut == Shortcut(keyCode: 1, modifiers: 2560, label: "⌥⇧S"), "Start uses physical S")
    precondition(defaults[.pastePrompt]?.shortcut.keyCode == 9, "Paste uses physical V")
    precondition(defaults[.undoMark]?.shortcut.keyCode == 6, "Undo uses physical Z")
    precondition(defaults[.cancel]?.shortcut.keyCode == 7, "Cancel uses physical X")
    precondition(defaults[.pauseOrResume]?.shortcut.keyCode == 35, "Pause uses physical P")
    precondition(defaults[.restart]?.shortcut.keyCode == 15, "Restart uses physical R")
    precondition(defaults[.startOrStop]?.lifetime == .app && defaults[.pastePrompt]?.lifetime == .app, "Start and paste live for the app")
    precondition(defaults[.undoMark]?.lifetime == .recording && defaults[.restart]?.lifetime == .recording, "In-take actions live for the recording")

    let encoded = Data(#"{"version":2,"bindings":{"capture.startOrStop":{"keyCode":1,"modifiers":2560,"label":"⌥⇧S"}}}"#.utf8)
    let decoded = try? ShortcutBindings.decode(encoded)
    precondition(decoded?[.startOrStop]?.shortcut.keyCode == 1, "Version 2 stores a physical key code")
    precondition((try? ShortcutBindings.decode(Data(#"{"version":1,"bindings":{"capture.startOrStop":{"keyCode":2,"modifiers":2560,"label":"⌥⇧D"}}}"#.utf8))) == defaults, "Version 1 overrides are ignored")
    // A version 2 file with a bad entry is refused out loud, so the person learns why their
    // bindings are not in effect before a later change overwrites the file.
    do {
        let accepted = try ShortcutBindings.decode(Data(#"{"version":2,"bindings":{"capture.startOrStop":{"keyCode":1,"modifiers":2560,"label":"⌥⇧S"},"capture.unknown":{"keyCode":2,"modifiers":2560,"label":"⌥⇧D"}}}"#.utf8))
        preconditionFailure("A version 2 file with an invalid entry is adopted silently, got \(accepted)")
    } catch {
        precondition(!error.message.isEmpty, "The refused file says why")
    }
    print("PASS shortcut bindings carry D6 defaults and version 2 persistence")
}

/// `shortcuts.set` changes only the actions it names, and refuses the whole call for one bad entry.
func runShortcutSetTests() {
    var current = ShortcutBindings.defaults
    current[.startOrStop] = .init(shortcut: .init(keyCode: 2, modifiers: 2_560, label: "⌥⇧D"), lifetime: .app)
    let paste: [String: Any] = ["keyCode": 11, "modifiers": 2_560, "label": "⌥⇧B"]

    let merged = try? ShortcutBindings.merging([ControlsAction.pastePrompt.id: paste], into: current)
    precondition(merged?[.pastePrompt]?.shortcut.keyCode == 11, "The named action takes its new key")
    precondition(merged?[.startOrStop] == current[.startOrStop],
        "Setting one action keeps every other custom binding, got \(String(describing: merged?[.startOrStop]))")
    precondition(merged?[.pastePrompt]?.lifetime == .app, "An action keeps its own lifetime")

    for (stated, why) in [
        ([ControlsAction.pastePrompt.id: paste, ControlsAction.undoMark.id: ["modifiers": 2_560, "label": "⌥⇧U"]],
            "an entry with no key code"),
        ([ControlsAction.pastePrompt.id: paste, ControlsAction.cancel.id: ["keyCode": 7, "modifiers": 2_560, "label": ""]],
            "an entry with no label"),
        ([ControlsAction.pastePrompt.id: paste, ControlsAction.restart.id: "⌥⇧R"], "an entry that is not an object"),
        (["capture.unknown": paste], "an unknown action"),
        ([ControlsAction.pastePrompt.id: ["keyCode": true, "modifiers": 2_560, "label": "⌥⇧B"]],
            "a boolean key code"),
        ([ControlsAction.pastePrompt.id: ["keyCode": 11.5, "modifiers": 2_560, "label": "⌥⇧B"]],
            "a fractional key code"),
        ([ControlsAction.pastePrompt.id: ["keyCode": 11, "modifiers": -1, "label": "⌥⇧B"]],
            "negative modifiers"),
        ([ControlsAction.pastePrompt.id: ["keyCode": 4_294_967_296, "modifiers": 2_560, "label": "⌥⇧B"]],
            "a key code past 32 bits"),
    ] as [([String: Any], String)] {
        do {
            let accepted = try ShortcutBindings.merging(stated, into: current)
            preconditionFailure("shortcuts.set accepts \(why), got \(accepted)")
        } catch {
            precondition(!error.message.isEmpty, "The refusal of \(why) says why")
        }
    }
    print("PASS shortcuts.set merges into the current bindings and refuses any invalid entry")
}

func runShortcutPresentationTests() {
    let recording = ShortcutBindings.defaults[.undoMark]!
    precondition(
        ShortcutPresentation.state(for: recording, registered: false, recording: false, unavailable: false)
            == .active,
        "An idle recording-lifetime shortcut has no warning state")
    precondition(
        ShortcutPresentation.state(for: recording, registered: false, recording: false, unavailable: true)
            == .refusedByMacOS,
        "An unavailable shortcut says macOS refused it")
    precondition(
        ShortcutPresentation.state(for: recording, registered: true, recording: true, unavailable: false)
            == .active,
        "A registered shortcut says it is active")
    precondition(
        ShortcutPresentation.label(keyCode: 1, modifiers: 2_560, key: "s") == "⌥⇧S",
        "A captured key gets the same modifier glyphs as the defaults")
    precondition(
        ShortcutPresentation.label(keyCode: 42, modifiers: 0, key: "") == "Key 42",
        "An unnamed captured key includes its physical key code")
    precondition(
        ShortcutPresentation.statusTitle(.duplicateInYap) == "Duplicate in Yap"
            && ShortcutPresentation.statusTitle(.refusedByMacOS) == "Refused by macOS",
        "Rejected shortcut states use their Settings wording")
    print("PASS shortcut presentation distinguishes active, refused and duplicate states")
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
