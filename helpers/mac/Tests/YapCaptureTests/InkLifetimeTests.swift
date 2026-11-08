import Foundation
import YapCapture

/// When a stroke or pin leaves the person's screen, as the window each mark is stamped with.
func runInkLifetimeTests() {
    func mark(_ id: String, _ kind: String, _ screen: JournalMarkScreen?) -> JournalMark {
        JournalMark(
            hostUs: 0, sourceUs: 0, epoch: 1, id: id, kind: kind, pin: kind == "pin" ? 1 : nil,
            points: [JournalMarkPoint(globalX: 0, globalY: 0, x: nil, y: nil, hostUs: 0)],
            onScreen: screen)
    }
    func s(_ seconds: Double) -> Int64 { Int64(seconds * 1_000_000) }

    var ink = InkLifetimes()
    let pin = ink.window(for: "pin", committedAt: 0)
    precondition(
        pin == JournalMarkScreen(fadeHostUs: s(3.8), untilHostUs: s(5)),
        "A pin shows 5 s, fading over its last 1.2 s, got \(String(describing: pin))")
    precondition(ink.window(for: "click", committedAt: 0) == nil, "A click is never drawn")

    let first = ink.window(for: "stroke", committedAt: s(1))
    ink.show(mark("first", "stroke", first))
    let second = ink.window(for: "stroke", committedAt: s(2))
    precondition(
        first == JournalMarkScreen(fadeHostUs: s(1), untilHostUs: s(2.2)) && second == first,
        "Strokes on screen together fade together, got \(String(describing: first)) and \(String(describing: second))")
    let later = ink.window(for: "stroke", committedAt: s(3))
    precondition(
        later == JournalMarkScreen(fadeHostUs: s(3), untilHostUs: s(4.2)),
        "A stroke drawn after the others left starts its own fade, got \(String(describing: later))")

    // Undo clears only what a person can still see, newest first.
    var shown = InkLifetimes()
    shown.show(mark("pin-1", "pin", shown.window(for: "pin", committedAt: 0)))
    shown.show(mark("pin-2", "pin", shown.window(for: "pin", committedAt: s(0.5))))
    shown.show(mark("stroke", "stroke", shown.window(for: "stroke", committedAt: s(1))))
    var early = shown
    precondition(early.clearLatest(at: s(1.5), sourceUs: 0, epoch: 1)?.retracts == "stroke", "Undo clears the stroke while it shows")
    precondition(
        shown.clearLatest(at: s(2.5), sourceUs: 0, epoch: 1)?.retracts == "pin-2",
        "Once the stroke has faded on its own, undo clears the latest pin still on screen")
    precondition(shown.clearLatest(at: s(2.5), sourceUs: 0, epoch: 1)?.retracts == "pin-1", "The next undo clears the pin before it")
    precondition(shown.clearLatest(at: s(2.5), sourceUs: 0, epoch: 1) == nil, "With everything cleared, undo has nothing to clear")
    print("PASS ink leaves the screen on its own and undo clears only what is still on it")
}
