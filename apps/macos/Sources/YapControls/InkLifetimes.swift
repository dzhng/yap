import Foundation

/// How long each mark stays on screen during a take: the one owner of when ink leaves the screen,
/// and so of which mark undo can still take back. A released stroke fades over 1.2 s, and strokes
/// on screen together fade together. A pin stays 5 s, its last 1.2 s fading the same way. Only the
/// screen forgets: the recording keeps every mark.
public struct InkLifetimes: Sendable {
    public enum Kind: Sendable { case stroke, pin }

    static let fadeSeconds: TimeInterval = 1.2
    static let pinSeconds: TimeInterval = 5

    private var marks: [(id: String, kind: Kind, added: Date)] = []
    /// When the strokes now on screen began fading; a stroke drawn meanwhile joins that fade.
    private var strokeFade: Date?

    public init() {}

    public mutating func add(_ id: String, _ kind: Kind, at now: Date) {
        if kind == .stroke, strokeFade == nil { strokeFade = now }
        marks.append((id, kind, now))
    }

    public mutating func remove(_ id: String) {
        marks.removeAll { $0.id == id }
        if !marks.contains(where: { $0.kind == .stroke }) { strokeFade = nil }
    }

    /// How strongly the mark shows at `now`, from 1 down; nil once it has left the screen.
    public func opacity(of id: String, at now: Date) -> Double? {
        guard let mark = marks.first(where: { $0.id == id }) else { return nil }
        let fading = switch mark.kind {
        case .stroke: now.timeIntervalSince(strokeFade ?? mark.added)
        case .pin: now.timeIntervalSince(mark.added) - (Self.pinSeconds - Self.fadeSeconds)
        }
        // Readable for a moment, then faster as it ends.
        let progress = min(1, max(0, fading / Self.fadeSeconds))
        let opacity = 1 - progress * progress
        return opacity > 0 ? opacity : nil
    }

    /// Forgets the marks that have left the screen, and answers whether any are still on it.
    public mutating func expire(at now: Date) -> Bool {
        for mark in marks where opacity(of: mark.id, at: now) == nil { remove(mark.id) }
        return !marks.isEmpty
    }

    /// The most recent mark still on screen: what undo takes back, so a mark that already cleared
    /// on its own is never the one an undo spends itself on.
    public func latestOnScreen(at now: Date) -> String? {
        marks.last { opacity(of: $0.id, at: now) != nil }?.id
    }
}
