import Foundation

/// When each mark leaves the person's screen during a take: the one owner of how long ink stays.
/// A released stroke fades over 1.2 s, and strokes on screen together fade together. A pin stays
/// 5 s, its last 1.2 s fading the same way. Undo clears the newest mark still showing, and a mark
/// that already left on its own is never the one an undo spends itself on.
///
/// Only the screen forgets: the journal keeps every mark with the window it was shown for, and
/// when an undo cleared it.
package struct InkLifetimes {
    package static let fadeUs: Int64 = 1_200_000
    package static let pinUs: Int64 = 5_000_000

    private var shown: [JournalMark] = []
    /// When the strokes now on screen began fading; a stroke committed meanwhile joins that fade.
    private var strokeFadeUs: Int64?

    package init() {}

    /// The window a stroke or pin committed at `hostUs` is shown for. Clicks are never drawn.
    package mutating func window(for kind: String, committedAt hostUs: Int64) -> JournalMarkScreen? {
        expire(at: hostUs)
        switch kind {
        case "stroke":
            let fade = strokeFadeUs ?? hostUs
            return JournalMarkScreen(fadeHostUs: fade, untilHostUs: fade + Self.fadeUs)
        case "pin":
            return JournalMarkScreen(
                fadeHostUs: hostUs + Self.pinUs - Self.fadeUs, untilHostUs: hostUs + Self.pinUs)
        default:
            return nil
        }
    }

    /// Puts a recorded mark on screen for the window it was stamped with.
    package mutating func show(_ mark: JournalMark) {
        guard let screen = mark.onScreen else { return }
        if mark.kind == "stroke" { strokeFadeUs = screen.fadeHostUs }
        shown.append(mark)
    }

    /// Undo: takes the newest mark still on screen off it, and answers the row that journals
    /// when it left. The row names the mark in `retracts` and carries no points.
    package mutating func clearLatest(at hostUs: Int64, sourceUs: Int64, epoch: Int) -> JournalMark? {
        expire(at: hostUs)
        guard let mark = shown.popLast() else { return nil }
        expire(at: hostUs)
        return JournalMark(
            hostUs: hostUs, sourceUs: sourceUs, epoch: epoch, id: UUID().uuidString,
            kind: mark.kind, pin: mark.pin, points: [], retracts: mark.id)
    }

    private mutating func expire(at hostUs: Int64) {
        shown.removeAll { ($0.onScreen?.untilHostUs ?? 0) <= hostUs }
        if !shown.contains(where: { $0.kind == "stroke" }) { strokeFadeUs = nil }
    }
}
