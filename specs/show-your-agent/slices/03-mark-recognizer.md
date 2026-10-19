# 03 Mark recognizer: the Q6 rules, pure

**Contract unlocked:** deterministic gesture semantics, testable without AppKit or a recording.

**Seam:** `MarkRecognizer` in `helpers/mac/Sources/YapCapture/`:

```
feed(sample: { hostUs, shift: Bool, otherModifiers: Bool, point, buttonDown: Bool }) -> [MarkEvent]
feed(press: { hostUs, point }) -> [MarkEvent]       // from the global monitor
feed(release: { hostUs, point }) -> [MarkEvent]
```

Window lookup is injected (`WindowUnderPoint` protocol); the live implementation reuses the
own-window filter of `WindowSource` (`apps/macos/Sources/Yap/CaptureController.swift:178-185`).
The recognizer assigns pin numbers (1, 2, 3… per take; a retracted pin's number is not reused).

**Rules (Q6, verbatim):** a stroke is ⇧ held alone (no other modifier) with at least 8 pt of
travel and no button down; a pin is a button press while ⇧ is held, at the press point, and it
ends any stroke; a press-drag-release without ⇧ records one click at the press point; a plain
click records a click (P2). Nothing is emitted while paused, before the first frame, or on a
camera-only take (the caller says which).

**Verify:** new `helpers/mac/Tests/YapCaptureTests/MarkRecognizerTests.swift`, table driven:
⇧ + 8 pt → stroke; ⇧ + 7.9 pt → nothing; ⌥⇧ + travel → nothing (a hotkey never draws); press
with ⇧ → pin at the press point, ending the stroke; pins numbered across a retraction; plain
click → click; drag → one click; paused → nothing; a dropped 60 Hz tick (`CursorGeometry.swift:394-399`)
does not split a stroke.

**Delegated:** internal state machine, stroke smoothing (none required).
**Firewall:** no AppKit, no journal writes, no drawing.
