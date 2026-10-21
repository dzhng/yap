import Foundation
import YapControls

func runInkLifetimeTests() {
    let start = Date(timeIntervalSinceReferenceDate: 0)
    func at(_ seconds: TimeInterval) -> Date { start.addingTimeInterval(seconds) }

    var pin = InkLifetimes()
    pin.add("pin-1", .pin, at: start)
    precondition(pin.opacity(of: "pin-1", at: at(3)) == 1, "A pin reads at full strength for its first seconds")
    let fading = pin.opacity(of: "pin-1", at: at(4.5)) ?? 0
    precondition(fading > 0 && fading < 1, "A pin fades on its way out, got \(fading)")
    precondition(pin.opacity(of: "pin-1", at: at(5)) == nil, "A pin is gone 5 s after it is dropped")
    precondition(!pin.expire(at: at(5)), "Nothing is left on screen once the pin has gone")

    var strokes = InkLifetimes()
    strokes.add("first", .stroke, at: start)
    strokes.add("second", .stroke, at: at(1))
    precondition(
        strokes.opacity(of: "first", at: at(1.1)) == strokes.opacity(of: "second", at: at(1.1)),
        "Strokes on screen together fade together")
    precondition(strokes.opacity(of: "second", at: at(1.2)) == nil, "A stroke is gone 1.2 s after the fade starts")

    // Undo clears only what a person can still see, newest first.
    var ink = InkLifetimes()
    ink.add("pin-1", .pin, at: start)
    ink.add("pin-2", .pin, at: at(0.5))
    ink.add("stroke", .stroke, at: at(1))
    var early = ink
    precondition(early.clearLatest(at: at(1.5)) == "stroke", "Undo clears the stroke while it shows")
    precondition(early.opacity(of: "stroke", at: at(1.5)) == nil, "A cleared mark leaves the screen at once")
    precondition(
        ink.clearLatest(at: at(2.5)) == "pin-2",
        "Once the stroke has faded on its own, undo clears the latest pin still on screen")
    precondition(ink.clearLatest(at: at(2.5)) == "pin-1", "The next undo clears the pin before it")
    precondition(ink.clearLatest(at: at(2.5)) == nil, "With everything cleared, undo has nothing to clear")
    print("PASS ink leaves the screen on its own and undo clears only what is still on it")
}
