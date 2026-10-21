import Foundation

/// The marks a take has recorded and which of them undo has taken back, so each undo knows its
/// target. Undo appends a retraction; the recorded mark itself is never rewritten.
struct UndoableMarks {
    private var recorded: [(id: String, kind: String, pin: Int?)] = []
    private var retracted = Set<String>()

    mutating func record(_ mark: JournalMark) {
        recorded.append((mark.id, mark.kind, mark.pin))
    }

    /// The mark that takes back the most recent stroke or pin not already undone, or nil when none
    /// is left. A click is never the target: a person undoes what they drew, not what they clicked.
    func retraction(hostUs: Int64, sourceUs: Int64, epoch: Int) -> JournalMark? {
        guard let target = recorded.last(where: {
            $0.kind != MarkEvent.Kind.click.rawValue && !retracted.contains($0.id)
        }) else { return nil }
        return JournalMark(
            hostUs: hostUs, sourceUs: sourceUs, epoch: epoch,
            id: UUID().uuidString, kind: target.kind, pin: target.pin, points: [], retracts: target.id)
    }

    mutating func retract(_ id: String) {
        retracted.insert(id)
    }
}
