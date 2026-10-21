import Foundation

/// What a live take tells the person drawing on it, in the order it happened: the stroke still
/// being drawn and each mark once it is recorded. It carries the recognizer's decisions, so
/// whoever draws them classifies nothing.
public enum CaptureMarkUpdate: Equatable, Sendable {
    case liveStroke([MarkPoint])
    case committed(JournalMark)
}
