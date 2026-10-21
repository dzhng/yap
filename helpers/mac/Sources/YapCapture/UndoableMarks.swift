import Foundation

/// The marks a take has recorded and which of them undo has taken back, so each mark is taken back
/// at most once. Undo appends a retraction; the recorded mark itself is never rewritten.
struct UndoableMarks {
    private var recorded: [(id: String, kind: String, pin: Int?)] = []
    private var retracted = Set<String>()

    mutating func record(_ mark: JournalMark) {
        recorded.append((mark.id, mark.kind, mark.pin))
    }

    /// The mark that takes back the named stroke or pin, or nil when it is not one this take
    /// recorded or it was already undone. A person undoes what they drew, never what they clicked.
    func retraction(of id: String, hostUs: Int64, sourceUs: Int64, epoch: Int) -> JournalMark? {
        guard !retracted.contains(id),
            let target = recorded.first(where: { $0.id == id && $0.kind != MarkEvent.Kind.click.rawValue })
        else { return nil }
        return JournalMark(
            hostUs: hostUs, sourceUs: sourceUs, epoch: epoch,
            id: UUID().uuidString, kind: target.kind, pin: target.pin, points: [], retracts: target.id)
    }

    mutating func retract(_ id: String) {
        retracted.insert(id)
    }
}
