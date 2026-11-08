import Foundation

/// What a live take tells the person drawing on it, in the order it happened: the stroke still
/// being drawn, each mark once it is recorded with the window it shows for, and each mark undo
/// clears early. It carries the recognizer's and the lifetimes' decisions, so whoever draws them
/// decides nothing.
public enum CaptureMarkUpdate: Equatable, Sendable {
    case liveStroke([MarkPoint])
    case committed(JournalMark)
    case cleared(String)
}
